import { fileURLToPath } from 'node:url';
import type { EngineSpec } from './host.js';
import type { ModelChoice } from './request.js';
import { isSessionState } from './states.js';

/** The program of the fake engine. It is built beside this file, in `dist`, so a test starts it with `node`. */
export const FAKE_ENGINE_PROGRAM: string = fileURLToPath(new URL('./fake-engine-program.js', import.meta.url));

/**
 * One step of a fake engine's script. The engine runs the steps in order and then exits with code 0.
 * `say` prints a line. `sleep` waits that many milliseconds. `exit` ends with that code. `ignoreTerm` makes it ignore SIGTERM, as a stuck engine does. `spawnChild` starts a helper in
 * its own process group, which lives until a signal ends it. `printEnv`, `printArgs`, and `printCwd` print what the engine got. `readStdin` prints how many bytes it could read from its input.
 * `hold` waits for ever. `crash` ends the engine with a signal. `spawnEscaped` starts a helper in a process group of its own, which no signal to the engine's group reaches. `spawnEscapedHolding` is the same helper, and it also
 * holds the output pipe of the engine open. `stderr` writes the text to standard error, and `stderrBytes` writes that many bytes to it.
 */
export type FakeStep =
  | { readonly say: string }
  | { readonly sleep: number }
  | { readonly exit: number }
  | { readonly ignoreTerm: true }
  | { readonly spawnChild: true }
  | { readonly printEnv: true }
  | { readonly printArgs: true }
  | { readonly printCwd: true }
  | { readonly readStdin: true }
  | { readonly hold: true }
  | { readonly crash: 'SIGSEGV' | 'SIGABRT' }
  | { readonly spawnEscaped: true }
  | { readonly spawnEscapedHolding: true }
  | { readonly stderr: string }
  | { readonly stderrBytes: number };

/** The adapter of the fake engine: a line `state:<name>` claims that state, and any other line claims none. A name that is not a state is passed on, so the machine can refuse it. */
export const fakeSignal = (line: string): string | null => (line.startsWith('state:') ? line.slice('state:'.length) : null);

export interface FakeEngineOptions {
  readonly id: string;
  /** Goes in the argument list of the engine and of every helper it starts, so a test can find the processes it left behind. */
  readonly tag: string;
  readonly steps: readonly FakeStep[];
  readonly env?: readonly string[];
  readonly billing?: 'engine-plan' | 'local';
  /** When true, the engine takes a model choice, and the choice reaches it as `--model <provider>/<model>`. */
  readonly takesModel?: boolean;
}

/** An engine spec whose program is the fake engine, started with `node`. Its script and tag travel in the argument list. */
export function fakeEngine(options: FakeEngineOptions): EngineSpec {
  return {
    id: options.id,
    title: `Fake ${options.id}`,
    program: process.execPath,
    args: [FAKE_ENGINE_PROGRAM, '--tag', options.tag, '--script', JSON.stringify(options.steps)],
    env: options.env ?? [],
    billing: options.billing ?? 'engine-plan',
    signalOf: fakeSignal,
    ...(options.takesModel === true ? { modelArgs: (choice: ModelChoice): readonly string[] => ['--model', `${choice.provider}/${choice.model}`] } : {}),
  };
}

/** True when the text is a state name, for a test that reads the claims of a fake engine. */
export const claimsState = (line: string): boolean => isSessionState(fakeSignal(line));
