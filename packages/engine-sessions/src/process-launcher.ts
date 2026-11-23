import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { MAX_TAIL_MARGIN, STDERR_TAIL_CHARS, type Launched, type LaunchSpec, type Launcher, type StopSignal } from './launcher.js';
import { escapeText } from './text.js';

/** The longest line a program can hand to the host. The rest of a longer line is dropped, so a program cannot fill memory with one line. */
export const MAX_LINE_CHARS = 4096;

export { MAX_TAIL_MARGIN, STDERR_TAIL_CHARS };

/**
 * What every copy of this module shares, held in one slot of the global object, so a second copy (a duplicate package, a bundle and a plugin) reuses the cover of the first instead of counting it as another listener.
 * The process groups of the programs that are running now are kept by the pid of their leader. When this process ends, each is killed, so a core that exits or is stopped leaves no engine in its own group behind.
 * A core that is killed with SIGKILL cannot do this, and a helper that left the group of its engine is out of reach: those are known limits.
 */
interface Shared {
  readonly liveGroups: Set<number>;
  exitHook: (() => void) | undefined;
}

const SLOT = Symbol.for('latebrake.engine-launcher');
/** The mark on a listener that is the launcher's own. A listener with the mark is not "another listener": whatever else is left is the app's. */
export const HANDLER_MARK = Symbol.for('latebrake.engine-launcher.handler');
const globals = globalThis as unknown as Record<symbol, Shared | undefined>;
const shared: Shared = (globals[SLOT] ??= { liveGroups: new Set<number>(), exitHook: undefined });
const mark = <T extends () => void>(listener: T): T => { Object.defineProperty(listener, HANDLER_MARK, { value: true }); return listener; };
const isOurs = (listener: unknown): boolean => typeof listener === 'function' && (listener as unknown as Record<symbol, unknown>)[HANDLER_MARK] === true;

/** Kills every process group that a program of this launcher leads and that is still running. It is synchronous and never throws, so it can run while the process exits. */
export function killLiveGroups(): void {
  for (const pid of [...shared.liveGroups]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is gone, or the platform has no groups.
    }
    shared.liveGroups.delete(pid);
  }
}

const COVERED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/**
 * Installs the exit hook and the signal handlers, whatever of them is missing. It is called at every launch, so the cover is there for every engine, also after something removed it.
 * The handler is put first in the list of listeners, so it runs before a listener of the app that was registered with `once`, and it still sees that listener.
 * When the app has a listener of its own for the signal, the signal is the app's: the engines are left to the app's own shutdown (its `killAll`) and to the exit hook, which kills every group when the process ends.
 * When no listener but ours is left, the handler kills the groups, removes our handlers, and sends the signal again, so the process ends as it would have without us. The next launch installs them again.
 */
function installHandlers(): void {
  shared.exitHook ??= mark(() => killLiveGroups());
  if (!process.listeners('exit').some(isOurs)) process.on('exit', shared.exitHook);
  for (const signal of COVERED_SIGNALS) {
    if (process.listeners(signal).some(isOurs)) continue;
    const handler = mark((): void => {
      if (process.listeners(signal).some(listener => !isOurs(listener))) return;
      killLiveGroups();
      for (const own of process.listeners(signal).filter(isOurs)) process.removeListener(signal, own as () => void);
      process.kill(process.pid, signal);
    });
    process.prependListener(signal, handler);
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
  /** Starts the program. `spawn` of Node by default. A test passes its own to reach the child and make its pipes fail. */
  readonly spawn?: typeof spawn;
}

const toStandardError = (message: string): void => { process.stderr.write(`engine launcher: ${message}\n`); };

/** The last `keep` characters of a text, never starting with the low half of a surrogate pair. */
function endOf(text: string, keep: number): string {
  const tail = text.slice(-keep);
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
  const start = options.spawn ?? spawn;
  return {
    launch(spec: LaunchSpec): Launched {
      const margin = spec.tailMargin ?? 0;
      if (!Number.isSafeInteger(margin) || margin < 0 || margin > MAX_TAIL_MARGIN) throw new RangeError(`the tail margin is a whole number of characters from 0 to ${MAX_TAIL_MARGIN}`);
      const keep = STDERR_TAIL_CHARS + margin;
      installHandlers();
      const spawnListeners: (() => void)[] = [], errorListeners: ((error: Error) => void)[] = [], lineListeners: ((line: string) => void)[] = [];
      const exitListeners: ((code: number | null, signal: string | null, stderrTail: string) => void)[] = [];
      const child = start(spec.program, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      // The group exists from the moment the program is made, and not from the later spawn event, so a process that exits in the same tick still takes the engine with it.
      if (child.pid !== undefined) shared.liveGroups.add(child.pid);
      // A line of the log names the session and the pid, so a person can tell which program a failure is about. The text goes through `escapeText`, since it may hold what the operating system or the program said.
      const where = `${spec.label === undefined ? '' : `session ${spec.label} `}pid ${String(child.pid)}`;
      const say = (message: string): void => {
        const line = escapeText(`${where}: ${message}`);
        try {
          log(line);
        } catch (error) {
          // A log that throws must not break a signal or a stop: the line goes to standard error instead.
          process.stderr.write(`engine launcher: ${line}\nengine launcher: the log threw: ${escapeText(error instanceof Error ? error.message : String(error))}\n`);
        }
      };
      let spawned = false, groupGone = false, finished = false;
      /** True when the signal was sent, or when there is nothing left to signal (no program, or the group is gone). False when the system refused it: the program may still run. */
      const killGroup = (signal: NodeJS.Signals): boolean => {
        if (child.pid === undefined || groupGone) return true;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          // ESRCH is the group being gone, and there is nothing left to signal. Any other error means a program may still run, so it is reported.
          const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
          if (code === 'ESRCH') return true;
          say(`could not send ${signal} to the group of the program: ${code === '' ? String(error) : code}`);
          return false;
        }
      };
      const stdout = lineSplitter(line => { for (const listener of lineListeners) listener(line); });
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stdout?.on('error', error => say(`the output of the program failed: ${error.message}`));
      // Standard error is read so that the pipe never fills. No state is read from it. Its last characters are kept for the log of a failed session.
      let stderrTail = '';
      const stderrDecoder = new StringDecoder('utf8');
      child.stderr?.on('data', (chunk: Buffer) => { stderrTail = endOf(stderrTail + stderrDecoder.write(chunk), keep); });
      child.stderr?.on('error', error => say(`the standard error of the program failed: ${error.message}`));
      child.on('spawn', () => { spawned = true; for (const listener of spawnListeners) listener(); });
      child.on('error', error => {
        if (!spawned && !finished) { finished = true; if (child.pid !== undefined) shared.liveGroups.delete(child.pid); for (const listener of errorListeners) listener(error); return; }
        say(`the program reported an error: ${error.message}`);
      });
      let result: { code: number | null; signal: string | null } | undefined;
      const finish = (): void => {
        if (finished || result === undefined) return;
        finished = true;
        stdout.end();
        stderrTail = endOf(stderrTail + stderrDecoder.end(), keep);
        for (const listener of exitListeners) listener(result.code, result.signal, stderrTail);
      };
      child.on('exit', (code, signal) => {
        result = { code, signal };
        // Whatever the program left in its group is killed now: the pipes close, and no process is left behind. The group is gone from this moment, so no later signal can reach a group id that was reused.
        killGroup('SIGKILL');
        groupGone = true;
        if (child.pid !== undefined) shared.liveGroups.delete(child.pid);
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
