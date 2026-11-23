// Helpers for the tests of the host and of the core: a polling wait with a short real timer, a launcher that records, and a tag for the processes of one test.
import { randomBytes } from 'node:crypto';
import type { Launched, LaunchSpec, Launcher, StopSignal } from '../src/launcher.js';

export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the check is true, polling every 10 ms, and fails with the label after `ms` milliseconds. */
export async function waitFor(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await pause(10);
  }
}

/** A tag that is unique to one test, so that the detector finds the processes of that test only. */
export const newTag = (): string => `fake-engine-tag-${randomBytes(6).toString('hex')}`;

export interface Recording extends Launcher {
  /** What each launch asked for, in order. */
  readonly specs: readonly LaunchSpec[];
  /** The lines each launched program wrote, in launch order. */
  readonly lines: readonly (readonly string[])[];
}

/** A launcher that passes every launch to `inner` and records what was asked and what came back. */
export function recording(inner: Launcher): Recording {
  const specs: LaunchSpec[] = [];
  const lines: string[][] = [];
  return {
    specs,
    lines,
    launch(spec): Launched {
      specs.push(spec);
      const mine: string[] = [];
      lines.push(mine);
      const handle = inner.launch(spec);
      handle.onLine(line => mine.push(line));
      return handle;
    },
  };
}

/** One program of the manual launcher. A test makes each event happen, in the order it chooses, so a state change needs no timing. */
export interface ManualProgram {
  readonly spec: LaunchSpec;
  /** The signals the host sent, in order. */
  readonly signals: StopSignal[];
  spawn(): void;
  fail(message: string, code?: string): void;
  line(text: string): void;
  exit(code: number | null, signal?: string | null, stderrTail?: string): void;
}

/** A launcher that starts no process. It gives a `ManualProgram` for each launch, for tests of the state changes. */
export function manualLauncher(options: { readonly throwOnLaunch?: boolean; readonly throwOnListen?: boolean } = {}): Launcher & { readonly programs: readonly ManualProgram[] } {
  const programs: ManualProgram[] = [];
  return {
    programs,
    launch(spec): Launched {
      if (options.throwOnLaunch === true) throw new Error('the launcher broke');
      const listeners = { spawn: [] as (() => void)[], error: [] as ((error: Error) => void)[], line: [] as ((line: string) => void)[], exit: [] as ((code: number | null, signal: string | null, stderrTail: string) => void)[] };
      const signals: StopSignal[] = [];
      programs.push({
        spec,
        signals,
        spawn: () => listeners.spawn.forEach(listener => listener()),
        fail: (message, code) => listeners.error.forEach(listener => listener(code === undefined ? new Error(message) : Object.assign(new Error(message), { code }))),
        line: text => listeners.line.forEach(listener => listener(text)),
        exit: (code, signal = null, stderrTail = '') => listeners.exit.forEach(listener => listener(code, signal, stderrTail)),
      });
      return {
        onSpawn: listener => { listeners.spawn.push(listener); },
        onError: listener => { listeners.error.push(listener); },
        onLine: listener => { if (options.throwOnListen === true) throw new Error('the listener broke'); listeners.line.push(listener); },
        onExit: listener => { listeners.exit.push(listener); },
        signal: kind => { signals.push(kind); },
      };
    },
  };
}
