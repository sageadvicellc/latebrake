import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Launched, LaunchSpec, Launcher, StopSignal } from './launcher.js';

/** The longest line a program can hand to the host. The rest of a longer line is dropped, so a program cannot fill memory with one line. */
export const MAX_LINE_CHARS = 4096;

/** How long to wait for the output to close after the program has gone, before the streams are closed by force. A helper that kept the pipe open cannot hold a session for ever. */
export const CLOSE_GRACE_MS = 500;

/** Splits a stream of text into lines of at most `MAX_LINE_CHARS`. A longer line is cut once, and the rest of it is dropped up to the next line break. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  const emit = (line: string): void => onLine(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line);
  const take = (text: string): void => {
    let rest = text;
    for (;;) {
      const at = rest.indexOf('\n');
      if (at === -1) break;
      if (!dropping) emit((pending + rest.slice(0, at)).replace(/\r$/, ''));
      pending = '';
      dropping = false;
      rest = rest.slice(at + 1);
    }
    if (dropping) return;
    pending += rest;
    if (pending.length > MAX_LINE_CHARS) {
      emit(pending);
      pending = '';
      dropping = true;
    }
  };
  return {
    push: chunk => take(decoder.write(chunk)),
    end: () => {
      const tail = decoder.end();
      if (tail !== '') take(tail);
      if (!dropping && pending !== '') emit(pending.replace(/\r$/, ''));
      pending = '';
    },
  };
}

const NAMES: Readonly<Record<StopSignal, NodeJS.Signals>> = { term: 'SIGTERM', kill: 'SIGKILL' };

/**
 * Starts real programs. The program is started with an argument list and never through a shell, in the folder, with exactly the environment it is given, and with no standard input
 * (`/dev/null`), so the host can never answer a prompt of the engine. It leads its own process group, so one signal reaches it and everything it started. When it has gone, whatever it left
 * behind in the group is killed, so a session never leaves an orphan.
 */
export function createProcessLauncher(): Launcher {
  return {
    launch(spec: LaunchSpec): Launched {
      const spawnListeners: (() => void)[] = [], errorListeners: ((error: Error) => void)[] = [], lineListeners: ((line: string) => void)[] = [];
      const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
      const child = spawn(spec.program, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let spawned = false, groupGone = false, finished = false;
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined || groupGone) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is gone (ESRCH), or the platform has no groups: there is nothing left to signal.
        }
      };
      const stdout = lineSplitter(line => { for (const listener of lineListeners) listener(line); });
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stdout?.on('error', () => undefined);
      // Standard error is read so that the pipe never fills, and dropped: no state is read from it.
      child.stderr?.on('data', () => undefined);
      child.stderr?.on('error', () => undefined);
      child.on('spawn', () => { spawned = true; for (const listener of spawnListeners) listener(); });
      child.on('error', error => { if (!spawned && !finished) { finished = true; for (const listener of errorListeners) listener(error); } });
      let result: { code: number | null; signal: string | null } | undefined;
      const finish = (): void => {
        if (finished || result === undefined) return;
        finished = true;
        groupGone = true;
        stdout.end();
        for (const listener of exitListeners) listener(result.code, result.signal);
      };
      child.on('exit', (code, signal) => {
        result = { code, signal };
        // Whatever the program left in its group is killed now: the pipes close, and no process is left behind.
        killGroup('SIGKILL');
        const timer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, CLOSE_GRACE_MS);
        timer.unref();
        child.once('close', () => { clearTimeout(timer); finish(); });
      });
      return {
        onSpawn: listener => { spawnListeners.push(listener); },
        onError: listener => { errorListeners.push(listener); },
        onLine: listener => { lineListeners.push(listener); },
        onExit: listener => { exitListeners.push(listener); },
        signal: kind => killGroup(NAMES[kind]),
      };
    },
  };
}
