// A scriptable fake engine, for tests. It is a program that the process launcher starts, as a real engine would be started: `node fake-engine-program.js --tag <tag> --script <json>`.
// It is never imported. The script is a list of steps that it runs in order, and then it exits with code 0 unless a step says otherwise. See `fixtures.ts` for the types and the specs.
// It reads the script from its own argument list, so no file is written and no folder is left behind.
import { spawn } from 'node:child_process';

type Step =
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

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const tag = flag('--tag') ?? 'no-tag';
const steps = JSON.parse(flag('--script') ?? '[]') as readonly Step[];

const out = (line: string): Promise<void> => new Promise(resolve => { process.stdout.write(`${line}\n`, () => resolve()); });
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function run(): Promise<void> {
  // The default answer to a stop request: leave at once, as a polite engine does. A step can change this.
  process.on('SIGTERM', () => process.exit(0));
  for (const step of steps) {
    if ('say' in step) await out(step.say);
    else if ('sleep' in step) await pause(step.sleep);
    else if ('exit' in step) process.exit(step.exit);
    else if ('ignoreTerm' in step) { process.removeAllListeners('SIGTERM'); process.on('SIGTERM', () => undefined); }
    else if ('spawnChild' in step) {
      // A helper in the same process group, as a real engine starts for a tool. It lives until a signal ends it. Its argument list holds the tag, so a test can find it.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--tag=${tag}`], { stdio: 'ignore' });
      await out(`child:${child.pid ?? 0}`);
    } else if ('spawnEscaped' in step || 'spawnEscapedHolding' in step) {
      // A helper that leaves the group of the engine, as a daemon does. A signal to the group of the engine never reaches it. The holding kind also keeps the output pipe of the engine open.
      const holding = 'spawnEscapedHolding' in step;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--tag=${tag}`], { stdio: holding ? ['ignore', 'inherit', 'inherit'] : 'ignore', detached: true });
      child.unref();
      await out(`escaped:${child.pid ?? 0}`);
    } else if ('stderr' in step) {
      await new Promise<void>(resolve => { process.stderr.write(step.stderr, () => resolve()); });
    } else if ('stderrBytes' in step) {
      const chunk = 'e'.repeat(65_536);
      for (let sent = 0; sent < step.stderrBytes; sent += chunk.length) await new Promise<void>(resolve => { process.stderr.write(chunk.slice(0, Math.min(chunk.length, step.stderrBytes - sent)), () => resolve()); });
    } else if ('printEnv' in step) {
      // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts, so the program leaves it out: it is not a variable that the host passed.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== '__CF_USER_TEXT_ENCODING').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      await out(`env:${JSON.stringify(env)}`);
    } else if ('printArgs' in step) await out(`args:${JSON.stringify(argv)}`);
    else if ('printCwd' in step) await out(`cwd:${process.cwd()}`);
    else if ('readStdin' in step) {
      let bytes = 0;
      for await (const chunk of process.stdin) bytes += (chunk as Buffer).length;
      await out(`stdin:${bytes}`);
    } else if ('hold' in step) await new Promise<never>(() => setInterval(() => undefined, 1000));
    else if ('crash' in step) process.kill(process.pid, step.crash);
  }
}

run().catch((error: unknown) => { process.stderr.write(`fake engine broke: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(70); });
