import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_TAIL_MARGIN, STDERR_TAIL_CHARS, type Launched, type Launcher } from './launcher.js';
import {
  MAX_NAME_LENGTH, MAX_VARIABLES, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, isLoaderVariable, isRefusedVariable, readList, type ModelChoice, type RequestReason,
} from './request.js';
import { createSession, report, type FaultEntry, type Session, type SessionFailure } from './session.js';
import { isTerminal, type SessionState } from './states.js';
import { escapeText, hasUnsafeChar } from './text.js';
import { BILLING_SOURCES, KEEP_ENDED_SESSIONS, MAX_START_GROUP, type Billing, type NotFoundReason, type StartFailedReason } from './vocab.js';

export { BILLING_SOURCES };
export type { Billing };

/** The cap on sessions when none is given. */
export const DEFAULT_SESSION_CAP = 4;
/** How long a stop waits for the engine to go, in milliseconds, when none is given. */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;
/** How long a session may stay `starting`, in milliseconds, when none is given. After it the session fails with `start_failed` and its program is killed. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;
/** How long `killAll` waits for the programs to go after the kill signal, in milliseconds, when none is given. */
export const DEFAULT_KILL_WAIT_MS = 5000;
const MAX_CAP = 64;
const MAX_STOP_TIMEOUT_MS = 600_000;
const MAX_START_TIMEOUT_MS = 600_000;
const MAX_KILL_WAIT_MS = 60_000;
const MAX_ENGINES = 16;
export { MAX_START_GROUP };

/**
 * What the host knows about one engine. The five built-in adapters of the Engine Host spec are later work, and the fake engines of the tests use this shape.
 * `env` names the variables that the engine needs: they pass from the core to the program when they are set. `signalOf` reads one line of standard output and says which state
 * the engine claims, or `null` for a line that claims none. The machine decides whether the claim is a legal move.
 * `modelArgs` is the delivery path of a main-model choice: an engine that has none cannot take one, and a choice for it is refused.
 * The only claims that a line may make are `running` and `waiting`. Any other claim is a fault, and a throw from `signalOf` is a fault too.
 */
export interface EngineSpec {
  readonly id: string;
  readonly title: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly billing: Billing;
  readonly signalOf: (line: string) => string | null;
  readonly modelArgs?: (choice: ModelChoice) => readonly string[];
}

export interface HostOptions {
  readonly engines: readonly EngineSpec[];
  readonly launcher: Launcher;
  /** The most sessions that have not ended, at once. A whole number from 1 to 64. 4 by default. */
  readonly cap?: number;
  /** How long a stop waits for the engine to go, in milliseconds: a whole number from 1 to 600,000. 5,000 by default. A test passes a short one. */
  readonly stopTimeoutMs?: number;
  /** The environment the core passes variables from. The environment of this process by default. */
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
  /**
   * Finds the real path of a program. It gives `undefined` or `{ error: 'missing' }` when the program is not on this computer, and `{ error: 'not_executable' }` when it is there and cannot run (or a folder on the way
   * cannot be searched). The default reads the path, and the folders of PATH for a bare name, and it tells a permission problem from a missing file.
   */
  readonly locate?: (program: string) => string | undefined | { readonly error: 'missing' | 'not_executable' };
  /**
   * Gives the real path of a folder for display, and a key that names the folder itself, or `undefined` when it is not a folder. The pair rule and the shared folder rule compare keys, so two spellings of one folder
   * are one folder. The default key is the device and the inode of the real directory, which no spelling, link, case, or normal form changes.
   */
  readonly canonical?: (folder: string) => { readonly path: string; readonly key: string } | undefined;
  /** How long a session may stay `starting`, in milliseconds: a whole number from 1 to 600,000. 30,000 by default. */
  readonly startTimeoutMs?: number;
  /** Runs a callback after a delay and gives the function that cancels it. An unref-ed timer by default, so a pending start timeout never holds the process open. A test passes a clock that it moves by hand. It times the start only. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /** How long `killAll` waits for the programs to go after the kill signal, in milliseconds: a whole number from 1 to 60,000. 5,000 by default. */
  readonly killWaitMs?: number;
  /** Receives each fault and each notable end of a session: an illegal move, an adapter that threw, a start that failed, a program that ended in error. Standard error by default. */
  readonly log?: (entry: FaultEntry) => void;
  /** Makes a session id. A random one by default. A bad or repeated id is a bug, and throws. */
  readonly newId?: () => string;
}

/** What a start plan holds. `variables` are those the engine declares and those the person allowed, sorted. `sharedWith` are the engines that already run in the folder, sorted. */
export interface StartPlanContent {
  readonly engine: string;
  readonly title: string;
  readonly program: string;
  readonly folder: string;
  readonly model: ModelChoice | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly sharedWith: readonly string[];
}

/** What a stop plan holds. `force` is true when the session is stopping already, and the stop sends the signal that cannot be ignored. */
export interface StopPlanContent {
  readonly session: string;
  readonly engine: string;
  readonly folder: string;
  readonly force: boolean;
}

/** What a read of a session gives. It holds no output of the engine. */
export interface SessionInfo {
  readonly id: string;
  readonly engine: string;
  readonly folder: string;
  readonly state: SessionState;
  readonly billing: Billing;
  readonly model: ModelChoice | null;
  readonly failure: SessionFailure | null;
}

export type HostRefusal =
  | { readonly ok: false; readonly code: 'ENGINE_REQUEST_INVALID'; readonly reason: RequestReason }
  | { readonly ok: false; readonly code: 'ENGINE_NOT_FOUND'; readonly reason: NotFoundReason }
  | { readonly ok: false; readonly code: 'ENGINE_START_FAILED'; readonly reason: StartFailedReason }
  | {
    readonly ok: false;
    readonly code: 'MODEL_NOT_FOR_ENGINE' | 'ENGINE_LIMIT' | 'ENGINE_PAIR_BUSY' | 'ENGINE_FOLDER_SHARED' | 'ENGINE_SESSION_UNKNOWN' | 'ENGINE_SESSION_ENDED' | 'ENGINE_STOP_TIMEOUT';
    readonly reason?: undefined;
  };

/** A start that began: the session exists and the program was asked to run. `settled` resolves when the program runs, or when it could not start. */
export interface BegunStart {
  readonly ok: true;
  readonly session: string;
  readonly settled: Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
  /**
   * Resolves when the session has left `starting`, and says how: `ok` with the session in `running` or `waiting`, or `ENGINE_START_FAILED` with a reason of its own (`exited`: the program ended before it said it runs, `timed_out`,
   * `adapter_error`, `illegal_claim`, `stopped` for a stop of the person or the end of the host, or the reason of a launch that failed). It is the answer that matters for a run, since `settled` resolves at the spawn of the program.
   * It resolves once and keeps its answer. It is bounded by the start timeout of the host, which fails a session that does not say it runs.
   */
  readonly started: Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
}
/** A stop that began: the session is stopping and the signal is sent. `settled` resolves when the engine has gone, or refuses with `ENGINE_STOP_TIMEOUT` and leaves the session stopping. */
export interface BegunStop {
  readonly ok: true;
  readonly settled: Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
}

/** A refusal of one member of a group: the refusal of the host, and the index of the member (the first is 0) that it is for. */
export type GroupRefusal = HostRefusal & { readonly index: number };

/** A group start that began: every member exists and its program was asked to run, in the order of the plans. Each member settles on its own. */
export interface BegunGroup {
  readonly ok: true;
  readonly members: readonly BegunStart[];
}

export interface EngineHost {
  /** Plans a start from live state. It changes nothing. Every check of the start runs here, so the plan is one that can be started. */
  planStart(request: unknown): { readonly ok: true; readonly plan: StartPlanContent } | HostRefusal;
  /**
   * Begins a start. It plans again from live state, and the plan given must be the plan that comes out: a plan that no longer matches is a bug in the caller, and throws.
   * A plan with `sharedWith` needs `sharedApproved`. The session is made, and the program is asked to run, before this returns, so a second call sees the first.
   * The host never asks the person: the core checks every approval first and says so here.
   */
  beginStart(plan: StartPlanContent, options: { readonly sharedApproved: boolean }): BegunStart | HostRefusal;
  /**
   * Plans several starts as one group, from live state, and changes nothing. Each member is planned as if the members before it had started: the cap, the pair rule, and the shared folder count them, so a group that
   * is planned is a group that can begin. The first member that is refused gives its refusal and its `index`. The requests are a plain list of 1 to `MAX_START_GROUP` (a list of another shape is a bug of the caller, and throws).
   */
  planStartGroup(requests: unknown): { readonly ok: true; readonly plans: readonly StartPlanContent[] } | GroupRefusal;
  /**
   * Begins a group: reads each plan once, from own data properties (a plan that is not a plan is a bug of the caller, and throws), plans the group again from live state, and the plans given must be the plans that come out, in the
   * same order (a plan that differs throws too). A group with a member that shares its folder needs `sharedApproved`. Every member is made, and its program asked to run, before this returns, from the plans that the host
   * checked, so a member whose launch fails at once frees no place that another member counted on. If a step throws part way (a bad session id), the members that began are stopped, with the kill signal when the stop
   * times out, each is logged with its session id, and the throw goes on unchanged. The member that threw made no session, so it holds no place.
   */
  beginStartGroup(plans: readonly StartPlanContent[], options: { readonly sharedApproved: boolean }): BegunGroup | GroupRefusal;
  /** Plans a stop from live state. It changes nothing. */
  planStop(sessionId: unknown): { readonly ok: true; readonly plan: StopPlanContent } | HostRefusal;
  /** Begins a stop: the first stop asks the engine to go (SIGTERM), and a stop of a session that is stopping already kills it (SIGKILL). */
  beginStop(sessionId: unknown): BegunStop | HostRefusal;
  /** Begins a stop and waits for it. The app uses it for "Stop all". */
  stop(sessionId: unknown): Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
  /** The sessions, oldest first, as new frozen copies: every live session and the newest 256 that have ended. With an engine id, the sessions of that engine. */
  list(engine?: string): readonly SessionInfo[];
  /** One session as a new frozen copy, or `undefined`. */
  get(sessionId: string): SessionInfo | undefined;
  /**
   * Kills every process that is still running and waits for it to go. This is the end of the app, and the clean-up of a test. It changes no state by itself: the exits move the sessions.
   * It gives the number of programs that were still alive when the wait ended, so a caller can tell that a kill did not work. After it, the host is shutting down: no further start is planned or begun.
   */
  killAll(): Promise<number>;
  /** The number of processes the host has asked the launcher to start since it was made. */
  readonly launched: number;
  /** How long a stop waits for the engine to go, in milliseconds. A stop plan tells the person. */
  readonly stopTimeoutMs: number;
}

interface Tracked {
  readonly session: Session;
  readonly engine: EngineSpec;
  readonly folder: string;
  readonly model: ModelChoice | null;
  /** The key of the folder, which the pair rule and the shared folder rule compare. `folder` is for display. */
  readonly key: string;
  handle: Launched | undefined;
  exited: boolean;
  /** Cancels the start timeout. Safe to call again. */
  cancelStart: () => void;
  /** The values of the variables that the program was given (6 characters or more, not the paths), and their escaped forms, longest first. They are cut out of any text of the program before it is logged. Emptied when the program has gone. */
  readonly secrets: string[];
  /** How many characters of standard error the launcher keeps before the tail: the longest value minus one, so a value that crosses the cut is whole in the buffer. */
  readonly tailMargin: number;
  /** Writes an entry to the log with every secret cut out of it. The session and the host use only this. It never throws. */
  readonly sink: (entry: FaultEntry) => void;
  /** True once the host has sent the kill signal to a session that it failed or ended itself, so the end of its standard error is worth a log line. */
  killedByHost: boolean;
  readonly endWaiters: (() => void)[];
  /** Why the start failed, when the host knows it better than the failure of the session says. Set before the session changes state. */
  startReason: StartFailedReason | undefined;
  /** Resolves `started`. It does nothing the second time. */
  resolveStarted: (result: { readonly ok: true; readonly info: SessionInfo } | HostRefusal) => void;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The error codes of the system that mean it is out of something: argument space, open files, processes, or memory. */
const RESOURCE_CODES: ReadonlySet<string> = new Set(['E2BIG', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM']);

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();
const refusal = (code: Extract<HostRefusal, { readonly reason?: undefined }>['code']): HostRefusal => ({ ok: false, code });
const notFound = (reason: NotFoundReason): HostRefusal => ({ ok: false, code: 'ENGINE_NOT_FOUND', reason });
const startFailed = (reason: StartFailedReason): HostRefusal => ({ ok: false, code: 'ENGINE_START_FAILED', reason });
/** The code of an error of the operating system, when it has one. */
const errorCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined);
const REDACTED = '[redacted]';
const REFUSED_KILL = 'the kill signal was refused; stop the session again';
const MIN_SECRET_LENGTH = 6;
/** The variables whose values are paths and plain names. They are not hidden, so the path in a crash stays readable. Redaction is a match of the value, as it is, and of its escaped form: no encoded form, and nothing under 6 characters. */
const OPEN_VARIABLES: ReadonlySet<string> = new Set(['HOME', 'PATH', 'PWD', 'TMPDIR', 'SHELL', 'USER', 'LANG', 'LOGNAME']);

/**
 * Cuts every secret out of a text and gives the text. Every place where any secret occurs is a range, and ranges that overlap are merged, so two secrets where one ends inside the other leave no tail of either.
 * Each merged range is replaced once by a mark. When `dropBefore` is given, everything that came from before that index of the text is left out of the answer as well, and a range that crosses the index is
 * kept as its mark. It is how the part of a secret that the launcher cut at the start of its buffer, and a secret that crosses the start of the tail, never reach the log.
 */
function redactText(secrets: readonly string[], text: string, dropBefore = 0): string {
  const found: [number, number][] = [];
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) found.push([at, at + secret.length]);
  }
  found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  let out = '', pos = 0, cut = dropBefore > 0 ? -1 : 0;
  const plain = (to: number): void => {
    if (cut === -1 && dropBefore >= pos && dropBefore <= to) {
      out += text.slice(pos, dropBefore);
      cut = out.length;
      out += text.slice(dropBefore, to);
    } else {
      out += text.slice(pos, to);
    }
    pos = to;
  };
  for (const [start, end] of ranges) {
    plain(start);
    // A range that crosses the index stays in the answer as its mark, and the part before it goes.
    if (cut === -1 && start < dropBefore && end > dropBefore) cut = out.length;
    out += REDACTED;
    pos = end;
  }
  plain(text.length);
  if (cut === -1) cut = out.length;
  return out.slice(cut);
}
const invalid = (reason: RequestReason): HostRefusal => ({ ok: false, code: 'ENGINE_REQUEST_INVALID', reason });

/** Reads one own data property of a request without running a getter. */
function field(request: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(request, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * The default `locate`: a path must be an executable file, and a bare name is searched in the folders of PATH. The answer is the real path. A file that is not there, or that is not a file, is missing.
 * A file that is there and cannot run, or cannot be read for lack of permission, is `not_executable`, and never missing. A given absolute path whose folders cannot be searched is `not_executable` too, since the program was named.
 * A folder of PATH that cannot be searched is skipped: it says nothing about a program that may be nowhere.
 */
function locateProgram(program: string, onError: (folder: string, code: string) => void): string | { readonly error: 'missing' | 'not_executable' } {
  const absolute = path.isAbsolute(program);
  const candidates = absolute ? [program] : (process.env['PATH'] ?? '').split(path.delimiter).filter(dir => dir !== '').map(dir => path.join(dir, program));
  let blocked = false;
  for (const candidate of candidates) {
    let isFile = false;
    try {
      isFile = fs.statSync(candidate).isFile();
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // A folder that says anything but "not there" is looked for in the log, since the program may be in it.
        onError(path.dirname(candidate), code ?? 'unknown');
        if (absolute) blocked = true;
      }
      continue;
    }
    if (!isFile) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync.native(candidate);
    } catch {
      blocked = true;
    }
  }
  return { error: blocked ? 'not_executable' : 'missing' };
}

/**
 * The default `canonical`: the real path of a folder that exists, and its device and inode as the key. The key is read from the real directory, so no spelling of the path changes it. The numbers are read as big integers,
 * so an inode above 2^53 is not rounded into another folder's number. There is a window between `realpath` and `stat`, in which the folder can be replaced: the plan is made again when the start begins, which reads both again,
 * and a folder that changed in between gives another key and so a changed plan. The window cannot be closed without opening the folder, which a core with no right to read it must not do.
 */
function canonicalFolder(folder: string, onError: (code: string) => void): { readonly path: string; readonly key: string } | undefined {
  try {
    const real = fs.realpathSync.native(folder);
    const stat = fs.statSync(real, { bigint: true });
    return stat.isDirectory() ? { path: real, key: `${stat.dev}:${stat.ino}` } : undefined;
  } catch (error) {
    // A folder that is not there is the plain answer. Any other code (a folder that cannot be searched, a loop of links) is a reason that a person looks for in the log.
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') onError(code ?? 'unknown');
    return undefined;
  }
}

/** True when the system says that the folder cannot be searched. It is how a start that failed with EACCES is told from a program that cannot run. */
function folderBlocked(folder: string): boolean {
  try {
    fs.accessSync(folder, fs.constants.X_OK);
    return false;
  } catch (error) {
    return errorCode(error) === 'EACCES';
  }
}

function checkSpec(spec: EngineSpec): EngineSpec {
  const id = checkEngineId(spec.id);
  if (!id.ok) throw new RangeError('an engine id is lower-case words joined by single hyphens, at most 64 characters');
  if (typeof spec.title !== 'string' || spec.title === '' || spec.title.length > MAX_NAME_LENGTH || hasUnsafeChar(spec.title)) throw new RangeError(`the engine ${id.value} needs a title of 1 to 64 plain characters`);
  if (typeof spec.program !== 'string' || spec.program === '') throw new RangeError(`the engine ${id.value} needs a program`);
  if (!Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) throw new RangeError(`the arguments of the engine ${id.value} are a list of text`);
  if (!Array.isArray(spec.env) || !spec.env.every(name => typeof name === 'string' && VARIABLE_NAME.test(name) && !isLoaderVariable(name)) || spec.env.length > MAX_VARIABLES) throw new RangeError(`the variables of the engine ${id.value} are a list of plain names`);
  if (!(BILLING_SOURCES as readonly string[]).includes(spec.billing)) throw new RangeError(`the billing source of the engine ${id.value} is engine-plan or local: a provider key waits for the keys and spend work`);
  // The adapter is code of the app: `signalOf` and `modelArgs` are plain functions that do not use `this`, and the host keeps them as given.
  if (typeof spec.signalOf !== 'function') throw new RangeError(`the engine ${id.value} needs a signalOf function`);
  if (spec.modelArgs !== undefined && typeof spec.modelArgs !== 'function') throw new RangeError(`the modelArgs of the engine ${id.value} is a function`);
  return Object.freeze({
    id: id.value, title: spec.title, program: spec.program, args: Object.freeze([...spec.args]), env: Object.freeze(sorted(spec.env)), billing: spec.billing, signalOf: spec.signalOf,
    ...(spec.modelArgs === undefined ? {} : { modelArgs: spec.modelArgs }),
  });
}

/** Makes the host: the one place that starts, watches, and stops engine sessions. Only the core calls it. A Gauge reaches it through the Core API, with a plan and an approval. */
export function createEngineHost(options: HostOptions): EngineHost {
  const cap = options.cap ?? DEFAULT_SESSION_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_CAP) throw new RangeError(`the session cap is a whole number from 1 to ${MAX_CAP}`);
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > MAX_STOP_TIMEOUT_MS) throw new RangeError(`the stop timeout is a whole number of milliseconds from 1 to ${MAX_STOP_TIMEOUT_MS}`);
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > MAX_START_TIMEOUT_MS) throw new RangeError(`the start timeout is a whole number of milliseconds from 1 to ${MAX_START_TIMEOUT_MS}`);
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
  if (!Number.isSafeInteger(killWaitMs) || killWaitMs < 1 || killWaitMs > MAX_KILL_WAIT_MS) throw new RangeError(`the kill wait is a whole number of milliseconds from 1 to ${MAX_KILL_WAIT_MS}`);
  if (!Array.isArray(options.engines) || options.engines.length > MAX_ENGINES) throw new RangeError(`the host holds at most ${MAX_ENGINES} engines`);
  const engines = new Map<string, EngineSpec>();
  for (const spec of options.engines) {
    const checked = checkSpec(spec);
    if (engines.has(checked.id)) throw new RangeError(`two engines have the id ${checked.id}`);
    engines.set(checked.id, checked);
  }
  const launcher = options.launcher;
  const environment = options.environment ?? ((): Readonly<Record<string, string | undefined>> => process.env);
  /** A line about the host itself, with no session. Each folder and code is logged once, so a Gauge that plans again and again against a bad folder cannot flood the log. The record is bounded: when it is full it starts again. */
  const logged = new Set<string>();
  const logOnce = (key: string, message: string): void => {
    if (logged.has(key)) return;
    if (logged.size >= 1024) logged.clear();
    logged.add(key);
    report(log, { session: '', from: 'detected', to: 'detected', message: `engine host: ${message}` });
  };
  const locate = options.locate ?? ((program: string) => locateProgram(program, (folder, code) => logOnce(`program\u0000${folder}\u0000${code}`, `could not search the folder ${escapeText(folder)} for the program: ${escapeText(code)}`)));
  const canonical = options.canonical ?? ((folder: string) => canonicalFolder(folder, code => logOnce(`folder\u0000${folder}\u0000${code}`, `could not read the folder ${escapeText(folder)}: ${escapeText(code)}`)));
  const log = options.log;
  const schedule = options.schedule ?? ((run: () => void, ms: number): (() => void) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); });
  const newId = options.newId ?? ((): string => `s-${randomBytes(8).toString('hex')}`);
  /** Every session ever made, in the order they were made. A Map, so an id such as `__proto__` is only a key. */
  const records = new Map<string, Tracked>();
  let launched = 0;
  /** True once `killAll` has run: the host is shutting down, so no start is planned or begun. */
  let closed = false;

  const info = (record: Tracked): SessionInfo => Object.freeze({
    id: record.session.id, engine: record.engine.id, folder: record.folder, state: record.session.state, billing: record.engine.billing,
    model: record.model === null ? null : Object.freeze({ provider: record.model.provider, model: record.model.model }), failure: record.session.failure,
  });
  /** The sessions that hold a place: those that have not ended, and those that have ended in state while their process still lives, because a process that lives is a process that runs. */
  const active = (): Tracked[] => [...records.values()].filter(record => !isTerminal(record.session.state) || !record.exited);

  /** The ids of the sessions that have ended and whose program has gone, in the order they ended. */
  const ended: string[] = [];
  /**
   * The host keeps every session that is live and the newest 256 that have ended, so its memory and the list that a read gives stay bounded. A session that has ended but whose program has not been seen to go is not ended
   * for this purpose. The one that ended first is dropped first, whatever order the sessions began in: a session that lived long and ended last is the newest.
   */
  const prune = (): void => {
    while (ended.length > KEEP_ENDED_SESSIONS) {
      const oldest = ended.shift();
      if (oldest !== undefined) records.delete(oldest);
    }
  };

  const endOf = (record: Tracked): void => {
    const first = !record.exited;
    record.exited = true;
    // The program has gone, so nothing more of it is logged and no value needs to be hidden any longer.
    record.secrets.length = 0;
    for (const resolve of record.endWaiters.splice(0)) resolve();
    if (first) { ended.push(record.session.id); prune(); }
  };
  /** Resolves true when the program has gone, and false when `ms` milliseconds pass first. */
  const waitForEnd = (record: Tracked, ms: number): Promise<boolean> => new Promise(resolve => {
    if (record.exited) { resolve(true); return; }
    const timer = setTimeout(() => { const at = record.endWaiters.indexOf(done); if (at !== -1) record.endWaiters.splice(at, 1); resolve(false); }, ms);
    // A wait that is pending never holds the process open: the programs themselves do that for as long as they live.
    timer.unref();
    function done(): void { clearTimeout(timer); resolve(true); }
    record.endWaiters.push(done);
  });

  /** A session marked failed while its program still runs gets the signal that cannot be ignored, so a failed session never has a live process. */
  const killIfRunning = (record: Tracked): void => {
    if (record.exited) return;
    record.killedByHost = true;
    if (record.handle?.signal('kill') === false) say(record, record.session.state, REFUSED_KILL);
  };

  /**
   * The end of the standard error of a program, as it is logged: every secret cut out of it first, and only then cut to its last 2,048 characters, so a value that crosses the cut leaves no part of itself.
   * When the launcher's buffer was full, the first characters of it (the margin) may hold the end of a value that began before the buffer, so they are left out.
   */
  const tailOf = (record: Tracked, raw: string): string => {
    // The launcher drops a low half of a pair at the start of its buffer, so a full buffer may be one character short.
    const full = record.tailMargin > 0 && raw.length >= STDERR_TAIL_CHARS + record.tailMargin - 1;
    const text = redactText(record.secrets, raw, full ? record.tailMargin : 0).slice(-STDERR_TAIL_CHARS);
    const first = text.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
  };

  const say = (record: Tracked, from: SessionState, message: string): void => {
    record.sink({ session: record.session.id, from, to: record.session.state, message: `engine session ${record.session.id}: ${message}` });
  };

  /** A fault of the adapter: the first throw fails the session, and the program is killed. The message of the throw is escaped before it is logged. */
  function adapterFault(record: Tracked, error: unknown): void {
    const from = record.session.state;
    record.cancelStart();
    record.session.fail('adapter_error');
    say(record, from, `the adapter of ${escapeText(record.engine.id)} threw: ${escapeText(error instanceof Error ? error.message : String(error))}`);
    killIfRunning(record);
  }

  /**
   * A line of the engine may move a session only to `running` or `waiting`. Every other claim is a fault, whatever the table of moves says: the session fails with `illegal_move`, the fault is logged,
   * and the process group is killed. A session ends only by the exit of its program, by the host's own stop, or by a fault, so no line of an engine can free a place while its process lives.
   */
  function claim(record: Tracked, line: string): void {
    const state = record.session.state;
    // A stopping session ignores what the engine still says, and so does a session that has ended.
    if (state === 'stopping' || isTerminal(state)) return;
    let claimed: unknown;
    try {
      claimed = record.engine.signalOf(line);
    } catch (error) {
      adapterFault(record, error);
      return;
    }
    if (claimed === null || claimed === undefined || claimed === state) return;
    if (claimed === 'running' || claimed === 'waiting') {
      record.cancelStart();
      // The move is legal from every state that a claim can reach. If it is ever refused, the machine has failed the session, so the process is killed all the same.
      if (!record.session.move(claimed).ok) killIfRunning(record);
      return;
    }
    record.cancelStart();
    record.session.fault(claimed);
    killIfRunning(record);
  }

  function describeEnd(code: number | null, signal: string | null): string {
    return `the program ended with ${code === null ? 'no code' : `code ${code}`} and ${signal === null ? 'no signal' : `the signal ${escapeText(signal)}`}`;
  }

  function onExited(record: Tracked, code: number | null, signal: string | null, stderrTail: string): void {
    const before = record.session.state;
    record.cancelStart();
    const readable = tailOf(record, stderrTail);
    const tail = readable === '' ? '' : `; the end of its standard error: "${escapeText(readable)}"`;
    const killed = record.killedByHost && tail !== '';
    const oddStop = before === 'stopping' && !(code === 0 && signal === null) && signal !== 'SIGTERM' && signal !== 'SIGKILL';
    if (before === 'starting') record.session.fail('start_failed');
    else if (before === 'running' || before === 'waiting') {
      if (code === 0 && signal === null) record.session.move('stopped');
      else record.session.fail('crashed');
    } else if (before === 'stopping') {
      record.session.move('stopped');
    }
    if (record.session.state === 'failed' && (before === 'starting' || before === 'running' || before === 'waiting')) say(record, before, `${describeEnd(code, signal)}${tail}`);
    // A session that the host failed, killed, or stopped itself has its end logged too, with what the program last wrote, so the cause is not lost.
    else if (killed && (before === 'failed' || before === 'stopped' || before === 'stopping')) say(record, before, `${describeEnd(code, signal)} after the host killed it${tail}`);
    // A stop ends the program with the signal it sent, or with a clean exit. Any other end is logged, and the session is stopped all the same.
    else if (oddStop) say(record, before, `${describeEnd(code, signal)} while it was stopping${tail}`);
    endOf(record);
  }

  /** A member of a group that is planned but has not begun: its engine and folder key, which count against the cap, the pair rule, and the shared folder of the members after it. */
  interface Pending { readonly engine: string; readonly key: string }

  function planWithKey(request: unknown, pending: readonly Pending[] = []): { readonly ok: true; readonly plan: StartPlanContent; readonly key: string } | HostRefusal {
    if (closed) return startFailed('shutting_down');
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return invalid('engine');
    const id = checkEngineId(field(request, 'engine'));
    if (!id.ok) return invalid(id.reason);
    const folder = checkFolder(field(request, 'folder'));
    if (!folder.ok) return invalid(folder.reason);
    const model = checkModel(field(request, 'model'));
    if (!model.ok) return invalid(model.reason);
    const allowed = checkVariables(field(request, 'variables'), { denylist: false });
    if (!allowed.ok) return invalid(allowed.reason);
    const spec = engines.get(id.value);
    if (!spec) return notFound('engine');
    // The denylist is for the names that a caller asks for. A name that the engine declares itself passes, since the plan lists it and a plan that is planned again must be accepted.
    if (allowed.value.some(name => isRefusedVariable(name) && !spec.env.includes(name))) return invalid('variables');
    const located = locate(spec.program);
    if (located === undefined) return notFound('program_missing');
    if (typeof located !== 'string') {
      if (located.error === 'missing') return notFound('program_missing');
      if (located.error === 'not_executable') return notFound('program_not_executable');
      throw new Error('engine host: locate gave an answer that is neither a path nor a known error');
    }
    const program = located;
    // A program whose path holds a control or separator character is not offered to the person: the plan shows the real path as it is.
    if (hasUnsafeChar(program)) return notFound('program_missing');
    const real = canonical(folder.value);
    if (real === undefined || !checkFolder(real.path).ok) return invalid('folder');
    if (typeof real.key !== 'string' || real.key === '') throw new Error('engine host: canonical gave a folder with no key');
    // The core never picks another model on its own: a choice for an engine that cannot take one is refused, and is never dropped.
    if (model.value !== null && spec.modelArgs === undefined) return refusal('MODEL_NOT_FOR_ENGINE');
    const live: readonly { readonly engine: string; readonly key: string }[] = [...active().map(record => ({ engine: record.engine.id, key: record.key })), ...pending];
    // The variables of the plan, those of the engine and those allowed together, are at most 32, so no approved plan fails to start for a count.
    const variables = sorted([...spec.env, ...allowed.value]);
    if (variables.length > MAX_VARIABLES) return invalid('variables');
    if (live.some(record => record.engine === spec.id && record.key === real.key)) return refusal('ENGINE_PAIR_BUSY');
    if (live.length >= cap) return refusal('ENGINE_LIMIT');
    return {
      ok: true,
      key: real.key,
      plan: Object.freeze({
        engine: spec.id, title: spec.title, program, folder: real.path, model: model.value, billing: spec.billing,
        variables: Object.freeze(variables),
        sharedWith: Object.freeze(sorted(live.filter(record => record.key === real.key).map(record => record.engine))),
      }),
    };
  }

  function planStart(request: unknown): { readonly ok: true; readonly plan: StartPlanContent } | HostRefusal {
    const planned = planWithKey(request);
    return planned.ok ? { ok: true, plan: planned.plan } : planned;
  }

  /** The environment of the program: the variables the plan lists, when they are set, and nothing else. Built so a name such as `__proto__` is an ordinary variable. */
  function environmentOf(variables: readonly string[]): Record<string, string> {
    const source = environment();
    const entries: [string, string][] = [];
    for (const name of variables) {
      const value = Object.hasOwn(source, name) ? source[name] : undefined;
      if (typeof value === 'string') entries.push([name, value]);
    }
    return Object.fromEntries(entries);
  }

  /** The request that makes a plan again. */
  const requestOf = (plan: StartPlanContent): unknown => ({ engine: plan.engine, folder: plan.folder, model: plan.model, variables: plan.variables });

  function beginStart(plan: StartPlanContent, approvals: { readonly sharedApproved: boolean }): BegunStart | HostRefusal {
    // The caller's objects are read once. Everything below runs from the plan that the host made itself and checked, and never from a second read of the caller's plan.
    const sharedApproved = approvals.sharedApproved;
    const fresh = planWithKey(requestOf(plan));
    if (!fresh.ok) return fresh;
    const verified = fresh.plan;
    // The core plans again from live state, in the same tick, before it calls this. A plan that differs here is a bug in the caller, so it throws.
    if (JSON.stringify(verified) !== JSON.stringify(plan)) throw new Error('engine host: the plan does not match the state now, so the core must plan again before it begins a start');
    // Only the value true is the second approval: a truthy value of another kind is not.
    if (verified.sharedWith.length > 0 && sharedApproved !== true) return refusal('ENGINE_FOLDER_SHARED');
    return startVerified(verified, fresh.key);
  }

  /** The answer of `started` for a session that has left `starting`. A reason that the host set wins. Otherwise the cause is read from the state and the failure of the session. */
  function startedResult(record: Tracked): { readonly ok: true; readonly info: SessionInfo } | HostRefusal {
    const state = record.session.state;
    if (state === 'running' || state === 'waiting') return { ok: true, info: info(record) };
    if (record.startReason !== undefined) return startFailed(record.startReason);
    if (state === 'stopping') return startFailed('stopped');
    const failure = record.session.failure;
    return startFailed(failure === 'adapter_error' ? 'adapter_error' : failure === 'illegal_move' ? 'illegal_claim' : 'exited');
  }

  /** Called after every change of state of a session: the first change out of the start resolves `started`, and it keeps that answer. */
  function leftStarting(record: Tracked): void {
    const state = record.session.state;
    if (state === 'detected' || state === 'ready' || state === 'starting') return;
    record.resolveStarted(startedResult(record));
  }

  /** Makes the session and asks the launcher for the program, from a plan that the host made and checked itself. */
  function startVerified(verified: StartPlanContent, key: string): BegunStart {
    const spec = engines.get(verified.engine);
    if (!spec) throw new Error('engine host: an engine that was planned is gone');
    const id = newId();
    if (!checkSessionId(id).ok || records.has(id)) throw new Error('engine host: newId gave a session id that is malformed or already used');
    const env = environmentOf(verified.variables);
    // The values to hide: those of 6 characters or more, except the paths and plain names. A value that holds a character that the log escapes is hidden in its escaped form too, longest first.
    const values = Object.entries(env).filter(([name, value]) => !OPEN_VARIABLES.has(name) && value.length >= MIN_SECRET_LENGTH).map(([, value]) => value);
    const secrets = [...new Set(values.flatMap(value => [value, escapeText(value)]))].sort((a, b) => b.length - a.length);
    const tailMargin = Math.min(MAX_TAIL_MARGIN, Math.max(0, ...values.map(value => value.length - 1)));
    const sink = (entry: FaultEntry): void => report(log, { ...entry, to: redactText(secrets, entry.to), message: redactText(secrets, entry.message) });
    let resolveStarted: Tracked['resolveStarted'] = () => undefined;
    const started = new Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>(resolve => { resolveStarted = resolve; });
    const record: Tracked = {
      session: createSession(id, sink, () => leftStarting(record)), engine: spec, folder: verified.folder, key, model: verified.model, handle: undefined, exited: false, cancelStart: () => undefined, endWaiters: [], secrets, tailMargin, sink,
      killedByHost: false, startReason: undefined, resolveStarted,
    };
    records.set(id, record);
    // The program was found when the start was planned, and the session is checked ready, so the session walks detected, ready, starting before the program runs.
    record.session.move('ready');
    record.session.move('starting');
    const settled = new Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>(resolve => {
      /**
       * The program could not be started, or a step after it was made threw. The cause goes to the log with the session id and the real state, and the person sees a closed reason. A session that is stopping stays stopped,
       * since the person asked for that. When no program was made, nothing can live and the place is freed. When one was made, it is killed, and the place is held until its exit is seen.
       */
      const failed = (error: unknown, programMade: boolean, forced?: StartFailedReason): void => {
        const from = record.session.state;
        const code = errorCode(error);
        record.cancelStart();
        const folderThere = ((): boolean => { try { return canonical(verified.folder) !== undefined; } catch { return false; } })();
        // The reason is a closed word taken from the error code. A folder that cannot be searched also gives EACCES, so the folder is looked at before the program is blamed.
        const reason: StartFailedReason = forced ?? (code === 'ENOENT' ? (folderThere ? 'program_missing' : 'folder_unusable')
          : code === 'ENOTDIR' ? 'folder_unusable'
          : code === 'EACCES' ? (folderBlocked(verified.folder) ? 'folder_unusable' : 'not_executable')
          : code === 'EPERM' || code === 'ENOEXEC' ? 'not_executable'
          : code !== undefined && RESOURCE_CODES.has(code) ? 'resource_limit'
          : 'other');
        // The reason for `started` is set before the session changes state. (A session that is stopping has left `starting` already, so `started` has its answer, `stopped`.)
        record.startReason = reason;
        if (from === 'stopping') record.session.move('stopped');
        else record.session.fail('start_failed');
        say(record, from, `the program could not be started: ${code === undefined ? '' : `${escapeText(code)} `}${escapeText(error instanceof Error ? error.message : String(error))}`);
        killIfRunning(record);
        if (!programMade) endOf(record);
        resolve(startFailed(reason));
      };
      let args: string[];
      try {
        args = [...spec.args, ...(verified.model !== null && spec.modelArgs !== undefined ? spec.modelArgs(verified.model) : [])];
      } catch (error) {
        // The adapter threw while it built the arguments: no program was asked for.
        failed(error, false, 'adapter_error');
        return;
      }
      try {
        launched += 1;
        const handle = launcher.launch({ program: verified.program, args, cwd: verified.folder, env, label: id, tailMargin });
        record.handle = handle;
        // The exit is registered first, so that whatever throws after this, the exit of the program is seen and its place is freed only then.
        handle.onExit((code, signal, stderrTail) => onExited(record, code, signal, stderrTail));
        handle.onSpawn(() => resolve({ ok: true, info: info(record) }));
        handle.onError(error => failed(error, false));
        record.cancelStart = schedule(() => {
          if (record.session.state !== 'starting') return;
          record.startReason = 'timed_out';
          record.session.fail('start_failed');
          say(record, 'starting', `the program did not say it runs within ${startTimeoutMs} ms`);
          killIfRunning(record);
          resolve(startFailed('timed_out'));
        }, startTimeoutMs);
        handle.onLine(line => claim(record, line));
      } catch (error) {
        failed(error, record.handle !== undefined);
      }
    });
    return { ok: true, session: id, settled, started };
  }

  /** Reads the requests or plans of a group: a plain list of 1 to `MAX_START_GROUP`. Anything else is a bug of the caller. */
  function groupOf(value: unknown): unknown[] {
    const items = readList(value, MAX_START_GROUP);
    if (items === undefined || items.length === 0) throw new TypeError(`engine host: a group is a plain list of 1 to ${MAX_START_GROUP} members`);
    return items;
  }

  /** Plans each member as if the members before it had started. The first refusal gives its index. */
  function planGroup(requests: readonly unknown[]): { readonly ok: true; readonly plans: readonly StartPlanContent[]; readonly keys: readonly string[] } | GroupRefusal {
    const plans: StartPlanContent[] = [];
    const keys: string[] = [];
    const pending: Pending[] = [];
    for (const [index, request] of requests.entries()) {
      const planned = planWithKey(request, pending);
      if (!planned.ok) return { ...planned, index };
      plans.push(planned.plan);
      keys.push(planned.key);
      pending.push({ engine: planned.plan.engine, key: planned.key });
    }
    return { ok: true, plans: Object.freeze(plans), keys };
  }

  function planStartGroup(requests: unknown): { readonly ok: true; readonly plans: readonly StartPlanContent[] } | GroupRefusal {
    const planned = planGroup(groupOf(requests));
    return planned.ok ? { ok: true, plans: planned.plans } : planned;
  }

  /** Reads a plan of a caller once, from own data properties, into a new frozen plan. Anything that is not a whole plan is a bug of the caller, and throws. */
  function readPlan(value: unknown): StartPlanContent {
    const bad = (): never => { throw new TypeError('engine host: a member of a group is a start plan'); };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad();
    const own = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined; };
    const texts = (item: unknown): string[] => { const list = readList(item, MAX_VARIABLES); return list !== undefined && list.every((entry): entry is string => typeof entry === 'string') ? list : bad(); };
    const engine = own('engine'), title = own('title'), program = own('program'), folder = own('folder'), billing = own('billing'), model = checkModel(own('model'));
    if (typeof engine !== 'string' || typeof title !== 'string' || typeof program !== 'string' || typeof folder !== 'string' || !model.ok || own('model') === undefined) return bad();
    if (typeof billing !== 'string' || !(BILLING_SOURCES as readonly string[]).includes(billing)) return bad();
    return Object.freeze({
      engine, title, program, folder, model: model.value, billing: billing as Billing, variables: Object.freeze(texts(own('variables'))), sharedWith: Object.freeze(texts(own('sharedWith'))),
    });
  }

  /**
   * A member of a group that began and must be stopped, because a later member could not begin. It is logged with its session id, stopped, and stopped again with the kill signal when the first stop times out.
   * A stop that throws is logged and never replaces the error that caused the cleanup. The work runs on, and every step of it is caught, so no rejection goes unhandled.
   */
  function abandon(sessionId: string): void {
    const record = records.get(sessionId);
    if (record === undefined) return;
    say(record, record.session.state, 'the start of its group failed, so it is stopped');
    void (async (): Promise<void> => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const stopped = await stopAndWait(sessionId);
          if (stopped.ok || stopped.code === 'ENGINE_SESSION_ENDED' || stopped.code === 'ENGINE_SESSION_UNKNOWN') return;
        }
        say(record, record.session.state, 'it could not be stopped after the start of its group failed');
      } catch (error) {
        say(record, record.session.state, `the stop of its group failed to run: ${escapeText(error instanceof Error ? error.message : String(error))}`);
      }
    })();
  }

  function beginStartGroup(plans: readonly StartPlanContent[], approvals: { readonly sharedApproved: boolean }): BegunGroup | GroupRefusal {
    const given = groupOf(plans).map(readPlan);
    const sharedApproved = approvals.sharedApproved;
    const fresh = planGroup(given.map(requestOf));
    if (!fresh.ok) return fresh;
    // The caller plans again in the same tick, before it calls this. Plans that differ here, or that come in another order, are a bug in the caller, so it throws.
    if (JSON.stringify(fresh.plans) !== JSON.stringify(given)) throw new Error('engine host: the plans do not match the state now, so the core must plan again before it begins a group');
    const unapproved = fresh.plans.findIndex(plan => plan.sharedWith.length > 0);
    if (unapproved !== -1 && sharedApproved !== true) return { ok: false, code: 'ENGINE_FOLDER_SHARED', index: unapproved };
    const members: BegunStart[] = [];
    try {
      for (const [index, plan] of fresh.plans.entries()) {
        const key = fresh.keys[index];
        if (key === undefined) throw new Error('engine host: a planned member has no folder key');
        members.push(startVerified(plan, key));
      }
    } catch (error) {
      // A member could not even begin. The members that began are stopped, so no session is left running that nothing will ever read, and the error that caused it goes on as it was.
      for (const member of members) abandon(member.session);
      throw error;
    }
    return { ok: true, members: Object.freeze(members) };
  }

  function planStop(sessionId: unknown): { readonly ok: true; readonly plan: StopPlanContent } | HostRefusal {
    const id = checkSessionId(sessionId);
    if (!id.ok) return invalid(id.reason);
    const record = records.get(id.value);
    if (!record) return refusal('ENGINE_SESSION_UNKNOWN');
    // A session that has ended but whose program has not been seen to go still holds its place, and its kill may have been refused. A stop of it is the kill again, and it is a forced stop.
    if (isTerminal(record.session.state) && record.exited) return refusal('ENGINE_SESSION_ENDED');
    return { ok: true, plan: Object.freeze({ session: id.value, engine: record.engine.id, folder: record.folder, force: record.session.state === 'stopping' || isTerminal(record.session.state) }) };
  }

  function beginStop(sessionId: unknown): BegunStop | HostRefusal {
    const planned = planStop(sessionId);
    if (!planned.ok) return planned;
    const record = records.get(planned.plan.session);
    if (!record) throw new Error('engine host: a session that was planned is gone');
    const state = record.session.state;
    if (state === 'stopping') {
      if (record.handle?.signal('kill') === false) say(record, state, REFUSED_KILL);
    } else if (isTerminal(state)) {
      // Ended, but the program has not gone: the first kill did not land. The state is not rewritten, and the place is freed when the exit is seen.
      record.killedByHost = true;
      if (record.handle?.signal('kill') === false) say(record, state, REFUSED_KILL);
    } else if (state === 'starting' || state === 'running' || state === 'waiting') {
      record.cancelStart();
      record.session.move('stopping');
      record.handle?.signal('term');
    } else {
      // A session is detected or ready only inside `beginStart`, which never returns in that state, so no caller can see one. Reaching this is a bug.
      throw new Error(`engine host: a session cannot be stopped in the state ${state}`);
    }
    const settled = waitForEnd(record, stopTimeoutMs).then((gone): { readonly ok: true; readonly info: SessionInfo } | HostRefusal => (gone ? { ok: true, info: info(record) } : refusal('ENGINE_STOP_TIMEOUT')));
    return { ok: true, settled };
  }

  /** Begins a stop and waits for it. */
  async function stopAndWait(sessionId: unknown): Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal> {
    const begun = beginStop(sessionId);
    return begun.ok ? begun.settled : begun;
  }

  return {
    planStart,
    beginStart,
    planStartGroup,
    beginStartGroup,
    planStop,
    beginStop,
    stop: stopAndWait,
    list: engine => Object.freeze([...records.values()].filter(record => engine === undefined || record.engine.id === engine).map(info)),
    get: sessionId => { const record = records.get(sessionId); return record ? info(record) : undefined; },
    async killAll() {
      closed = true;
      const running = [...records.values()].filter(record => !record.exited);
      for (const record of running) {
        // A program that the host ends is stopped, not crashed: the session moves to stopping first, so the exit makes it stopped.
        const state = record.session.state;
        if (state === 'starting' || state === 'running' || state === 'waiting') {
          record.cancelStart();
          record.session.move('stopping');
        }
        record.killedByHost = true;
        record.handle?.signal('kill');
      }
      const gone = await Promise.all(running.map(record => waitForEnd(record, killWaitMs)));
      const survivors = running.filter((_record, index) => gone[index] === false);
      for (const record of survivors) say(record, record.session.state, `the program was still running ${killWaitMs} ms after the kill signal`);
      return survivors.length;
    },
    get launched() { return launched; },
    get stopTimeoutMs() { return stopTimeoutMs; },
  };
}
