import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Launched, LaunchSpec, Launcher, StopSignal } from './launcher.js';

/** The longest line a program can hand to the host. The rest of a longer line is dropped, so a program cannot fill memory with one line. */
export const MAX_LINE_CHARS = 4096;

/** How much of the end of standard error comes with the exit, in characters. */
export const STDERR_TAIL_CHARS = 2048;

/**
 * The process groups of the programs that are running now, by the pid of their leader. When this process ends, each is killed, so a core that exits or is stopped leaves no engine in its own group behind.
 * A core that is killed with SIGKILL cannot do this, and a helper that left the group of its engine is out of reach: those are known limits.
 */
const liveGroups = new Set<number>();

/** Kills every process group that a program of this launcher leads and that is still running. It is synchronous and never throws, so it can run while the process exits. */
export function killLiveGroups(): void {
  for (const pid of [...liveGroups]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is gone, or the platform has no groups.
    }
    liveGroups.delete(pid);
  }
}

const COVERED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let exitHandlerInstalled = false;

/**
 * Installs the handlers that kill the groups when this process exits, and when it gets SIGINT, SIGTERM, SIGHUP, or SIGQUIT. It is called at every launch and installs whatever is missing, so the cover is there for every engine.
 * A signal handler stays installed when something else listens for the signal: the process lives on, and an engine that starts later needs the cover too. When it is the only listener, it removes itself and sends the signal
 * again, so the process ends as it would have without it, and the next launch installs it again.
 */
function installHandlers(): void {
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', killLiveGroups);
  }
  for (const signal of COVERED_SIGNALS) {
    const existing = signalHandlers.get(signal);
    if (existing !== undefined && process.listeners(signal).includes(existing)) continue;
    const handler = (): void => {
      killLiveGroups();
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

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

export interface ProcessLauncherOptions {
  /** Receives a line when a signal could not be sent for a reason other than that the group is gone, or when a pipe or a program reports an error. Standard error by default. */
  readonly log?: (message: string) => void;
}

const toStandardError = (message: string): void => { process.stderr.write(`engine launcher: ${message}\n`); };

/** The last `STDERR_TAIL_CHARS` characters of a text, never starting with the low half of a surrogate pair. */
function endOf(text: string): string {
  const tail = text.slice(-STDERR_TAIL_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * Starts real programs. The program is started with an argument list and never through a shell, in the folder, with exactly the environment it is given, and with no standard input
 * (`/dev/null`), so the host can never answer a prompt of the engine. It leads its own process group, so one signal reaches it and everything it started in that group. When it has gone, whatever it left
 * behind in the group is killed. A helper that left the group is out of reach, and so is everything when this process is killed with SIGKILL: those are known limits.
 */
export function createProcessLauncher(options: ProcessLauncherOptions = {}): Launcher {
  const log = options.log ?? toStandardError;
  return {
    launch(spec: LaunchSpec): Launched {
      installHandlers();
      const spawnListeners: (() => void)[] = [], errorListeners: ((error: Error) => void)[] = [], lineListeners: ((line: string) => void)[] = [];
      const exitListeners: ((code: number | null, signal: string | null, stderrTail: string) => void)[] = [];
      const child = spawn(spec.program, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      // The group exists from the moment the program is made, and not from the later spawn event, so a process that exits in the same tick still takes the engine with it.
      if (child.pid !== undefined) liveGroups.add(child.pid);
      let spawned = false, groupGone = false, finished = false;
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined || groupGone) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          // ESRCH is the group being gone, and there is nothing left to signal. Any other error means a program may still run, so it is reported.
          const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
          if (code !== 'ESRCH') log(`could not send ${signal} to the group of the program: ${code === '' ? String(error) : code}`);
        }
      };
      const stdout = lineSplitter(line => { for (const listener of lineListeners) listener(line); });
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stdout?.on('error', error => log(`the output of the program failed: ${error.message}`));
      // Standard error is read so that the pipe never fills. No state is read from it. Its last characters are kept for the log of a failed session.
      let stderrTail = '';
      const stderrDecoder = new StringDecoder('utf8');
      child.stderr?.on('data', (chunk: Buffer) => { stderrTail = endOf(stderrTail + stderrDecoder.write(chunk)); });
      child.stderr?.on('error', error => log(`the standard error of the program failed: ${error.message}`));
      child.on('spawn', () => { spawned = true; for (const listener of spawnListeners) listener(); });
      child.on('error', error => {
        if (!spawned && !finished) { finished = true; if (child.pid !== undefined) liveGroups.delete(child.pid); for (const listener of errorListeners) listener(error); return; }
        log(`the program reported an error: ${error.message}`);
      });
      let result: { code: number | null; signal: string | null } | undefined;
      const finish = (): void => {
        if (finished || result === undefined) return;
        finished = true;
        stdout.end();
        stderrTail = endOf(stderrTail + stderrDecoder.end());
        for (const listener of exitListeners) listener(result.code, result.signal, stderrTail);
      };
      child.on('exit', (code, signal) => {
        result = { code, signal };
        // Whatever the program left in its group is killed now: the pipes close, and no process is left behind. The group is gone from this moment, so no later signal can reach a group id that was reused.
        killGroup('SIGKILL');
        groupGone = true;
        if (child.pid !== undefined) liveGroups.delete(child.pid);
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
