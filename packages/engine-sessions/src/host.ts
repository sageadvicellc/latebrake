import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Launched, Launcher } from './launcher.js';
import {
  MAX_NAME_LENGTH, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, type ModelChoice, type RequestReason,
} from './request.js';
import { createSession, type FaultEntry, type Session, type SessionFailure } from './session.js';
import { isTerminal, type SessionState } from './states.js';

/** Where a session's tokens are billed. A provider key joins when the keys and spend work is built: a spec that names it is refused when the host is made. */
export const BILLING_SOURCES = Object.freeze(['engine-plan', 'local'] as const);
export type Billing = (typeof BILLING_SOURCES)[number];

/** The cap on sessions when none is given. */
export const DEFAULT_SESSION_CAP = 4;
/** How long a stop waits for the engine to go, in milliseconds, when none is given. */
export const DEFAULT_STOP_TIMEOUT_MS = 5000;
const MAX_CAP = 64;
const MAX_STOP_TIMEOUT_MS = 600_000;
const MAX_ENGINES = 16;

/**
 * What the host knows about one engine. The five built-in adapters of the Engine Host spec are later work, and the fake engines of the tests use this shape.
 * `env` names the variables that the engine needs: they pass from the core to the program when they are set. `signalOf` reads one line of standard output and says which state
 * the engine claims, or `null` for a line that claims none. The machine decides whether the claim is a legal move.
 * `modelArgs` is the delivery path of a main-model choice: an engine that has none cannot take one, and a choice for it is refused.
 */
export interface EngineSpec {
  readonly id: string;
  readonly title: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly billing: Billing;
  readonly signalOf: (line: string) => SessionState | null;
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
  /** Finds the real path of a program, or `undefined` when it is not on this computer. The default reads the path, and the folders of PATH for a bare name. */
  readonly locate?: (program: string) => string | undefined;
  /** Gives the real path of a folder, or `undefined` when it is not a folder. The default is `realpath`, so two names for one folder are one folder. */
  readonly canonical?: (folder: string) => string | undefined;
  /** Receives each fault: an illegal move. Standard error by default. */
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
  | {
    readonly ok: false;
    readonly code: 'ENGINE_NOT_FOUND' | 'MODEL_NOT_FOR_ENGINE' | 'ENGINE_LIMIT' | 'ENGINE_PAIR_BUSY' | 'ENGINE_FOLDER_SHARED' | 'ENGINE_START_FAILED' | 'ENGINE_SESSION_UNKNOWN' | 'ENGINE_SESSION_ENDED' | 'ENGINE_STOP_TIMEOUT';
    readonly reason?: undefined;
  };

/** A start that began: the session exists and the program was asked to run. `settled` resolves when the program runs, or when it could not start. */
export interface BegunStart {
  readonly ok: true;
  readonly session: string;
  readonly settled: Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
}
/** A stop that began: the session is stopping and the signal is sent. `settled` resolves when the engine has gone, or refuses with `ENGINE_STOP_TIMEOUT` and leaves the session stopping. */
export interface BegunStop {
  readonly ok: true;
  readonly settled: Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
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
  /** Plans a stop from live state. It changes nothing. */
  planStop(sessionId: unknown): { readonly ok: true; readonly plan: StopPlanContent } | HostRefusal;
  /** Begins a stop: the first stop asks the engine to go (SIGTERM), and a stop of a session that is stopping already kills it (SIGKILL). */
  beginStop(sessionId: unknown): BegunStop | HostRefusal;
  /** Begins a stop and waits for it. The app uses it for "Stop all". */
  stop(sessionId: unknown): Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>;
  /** The sessions, oldest first, as new frozen copies. With an engine id, the sessions of that engine. */
  list(engine?: string): readonly SessionInfo[];
  /** One session as a new frozen copy, or `undefined`. */
  get(sessionId: string): SessionInfo | undefined;
  /** Kills every process that is still running and waits for it to go. This is the end of the app, and the clean-up of a test. It changes no state by itself: the exits move the sessions. */
  killAll(): Promise<void>;
  /** The number of processes the host has asked the launcher to start since it was made. */
  readonly launched: number;
}

interface Tracked {
  readonly session: Session;
  readonly engine: EngineSpec;
  readonly folder: string;
  readonly model: ModelChoice | null;
  handle: Launched | undefined;
  exited: boolean;
  readonly endWaiters: (() => void)[];
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOADER_NAME = /^(?:LD_|DYLD_)|^NODE_OPTIONS$/;

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();
const refusal = (code: Exclude<HostRefusal['code'], 'ENGINE_REQUEST_INVALID'>): HostRefusal => ({ ok: false, code });
const invalid = (reason: RequestReason): HostRefusal => ({ ok: false, code: 'ENGINE_REQUEST_INVALID', reason });

/** Reads one own data property of a request without running a getter. */
function field(request: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(request, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** The default `locate`: a path must be an executable file, and a bare name is searched in the folders of PATH. The answer is the real path. */
function locateProgram(program: string): string | undefined {
  const candidates = path.isAbsolute(program) ? [program] : (process.env['PATH'] ?? '').split(path.delimiter).filter(dir => dir !== '').map(dir => path.join(dir, program));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Not here: try the next folder.
    }
  }
  return undefined;
}

/** The default `canonical`: the real path of a folder that exists. */
function canonicalFolder(folder: string): string | undefined {
  try {
    const real = fs.realpathSync(folder);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function checkSpec(spec: EngineSpec): EngineSpec {
  const id = checkEngineId(spec.id);
  if (!id.ok) throw new RangeError('an engine id is lower-case words joined by single hyphens, at most 64 characters');
  if (typeof spec.title !== 'string' || spec.title === '' || spec.title.length > MAX_NAME_LENGTH) throw new RangeError(`the engine ${id.value} needs a title of 1 to 64 characters`);
  if (typeof spec.program !== 'string' || spec.program === '') throw new RangeError(`the engine ${id.value} needs a program`);
  if (!Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) throw new RangeError(`the arguments of the engine ${id.value} are a list of text`);
  if (!Array.isArray(spec.env) || !spec.env.every(name => typeof name === 'string' && VARIABLE_NAME.test(name) && !LOADER_NAME.test(name))) throw new RangeError(`the variables of the engine ${id.value} are a list of plain names`);
  if (!(BILLING_SOURCES as readonly string[]).includes(spec.billing)) throw new RangeError(`the billing source of the engine ${id.value} is engine-plan or local: a provider key waits for the keys and spend work`);
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
  if (!Array.isArray(options.engines) || options.engines.length > MAX_ENGINES) throw new RangeError(`the host holds at most ${MAX_ENGINES} engines`);
  const engines = new Map<string, EngineSpec>();
  for (const spec of options.engines) {
    const checked = checkSpec(spec);
    if (engines.has(checked.id)) throw new RangeError(`two engines have the id ${checked.id}`);
    engines.set(checked.id, checked);
  }
  const launcher = options.launcher;
  const environment = options.environment ?? ((): Readonly<Record<string, string | undefined>> => process.env);
  const locate = options.locate ?? locateProgram;
  const canonical = options.canonical ?? canonicalFolder;
  const log = options.log;
  const newId = options.newId ?? ((): string => `s-${randomBytes(8).toString('hex')}`);
  /** Every session ever made, in the order they were made. A Map, so an id such as `__proto__` is only a key. */
  const records = new Map<string, Tracked>();
  let launched = 0;

  const info = (record: Tracked): SessionInfo => Object.freeze({
    id: record.session.id, engine: record.engine.id, folder: record.folder, state: record.session.state, billing: record.engine.billing, model: record.model, failure: record.session.failure,
  });
  const active = (): Tracked[] => [...records.values()].filter(record => !isTerminal(record.session.state));

  const endOf = (record: Tracked): void => {
    record.exited = true;
    for (const resolve of record.endWaiters.splice(0)) resolve();
  };
  /** Resolves true when the program has gone, and false when `ms` milliseconds pass first. */
  const waitForEnd = (record: Tracked, ms: number): Promise<boolean> => new Promise(resolve => {
    if (record.exited) { resolve(true); return; }
    const timer = setTimeout(() => { const at = record.endWaiters.indexOf(done); if (at !== -1) record.endWaiters.splice(at, 1); resolve(false); }, ms);
    function done(): void { clearTimeout(timer); resolve(true); }
    record.endWaiters.push(done);
  });

  /** A session marked failed while its program still runs gets the signal that cannot be ignored, so a failed session never has a live process. */
  const killIfRunning = (record: Tracked): void => { if (!record.exited) record.handle?.signal('kill'); };

  function claim(record: Tracked, line: string): void {
    const state = record.session.state;
    // A stopping session ignores what the engine still says, and so does a session that has ended.
    if (state === 'stopping' || isTerminal(state)) return;
    let claimed: SessionState | null | undefined;
    try {
      claimed = record.engine.signalOf(line);
    } catch (error) {
      process.stderr.write(`engine session ${record.session.id}: the adapter of ${record.engine.id} threw on a line: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    if (claimed === null || claimed === undefined || claimed === state) return;
    if (!record.session.move(claimed).ok) killIfRunning(record);
  }

  function onExited(record: Tracked, code: number | null, signal: string | null): void {
    const state = record.session.state;
    if (state === 'starting') record.session.fail('start_failed');
    else if (state === 'running' || state === 'waiting') {
      if (code === 0 && signal === null) record.session.move('stopped');
      else record.session.fail('crashed');
    } else if (state === 'stopping') record.session.move('stopped');
    endOf(record);
  }

  function planStart(request: unknown): { readonly ok: true; readonly plan: StartPlanContent } | HostRefusal {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return invalid('engine');
    const id = checkEngineId(field(request, 'engine'));
    if (!id.ok) return invalid(id.reason);
    const folder = checkFolder(field(request, 'folder'));
    if (!folder.ok) return invalid(folder.reason);
    const model = checkModel(field(request, 'model'));
    if (!model.ok) return invalid(model.reason);
    const allowed = checkVariables(field(request, 'variables'));
    if (!allowed.ok) return invalid(allowed.reason);
    const spec = engines.get(id.value);
    if (!spec) return refusal('ENGINE_NOT_FOUND');
    const program = locate(spec.program);
    if (program === undefined) return refusal('ENGINE_NOT_FOUND');
    const real = canonical(folder.value);
    if (real === undefined || !checkFolder(real).ok) return invalid('folder');
    // The core never picks another model on its own: a choice for an engine that cannot take one is refused, and is never dropped.
    if (model.value !== null && spec.modelArgs === undefined) return refusal('MODEL_NOT_FOR_ENGINE');
    const live = active();
    if (live.some(record => record.engine.id === spec.id && record.folder === real)) return refusal('ENGINE_PAIR_BUSY');
    if (live.length >= cap) return refusal('ENGINE_LIMIT');
    return {
      ok: true,
      plan: Object.freeze({
        engine: spec.id, title: spec.title, program, folder: real, model: model.value, billing: spec.billing,
        variables: Object.freeze(sorted([...spec.env, ...allowed.value])),
        sharedWith: Object.freeze(sorted(live.filter(record => record.folder === real).map(record => record.engine.id))),
      }),
    };
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

  function beginStart(plan: StartPlanContent, approvals: { readonly sharedApproved: boolean }): BegunStart | HostRefusal {
    const fresh = planStart({ engine: plan.engine, folder: plan.folder, model: plan.model, variables: plan.variables });
    if (!fresh.ok) return fresh;
    // The core plans again from live state, in the same tick, before it calls this. A plan that differs here is a bug in the caller, so it throws.
    if (JSON.stringify(fresh.plan) !== JSON.stringify(plan)) throw new Error('engine host: the plan does not match the state now, so the core must plan again before it begins a start');
    if (plan.sharedWith.length > 0 && !approvals.sharedApproved) return refusal('ENGINE_FOLDER_SHARED');
    const spec = engines.get(plan.engine);
    if (!spec) throw new Error('engine host: an engine that was planned is gone');
    const id = newId();
    if (!checkSessionId(id).ok || records.has(id)) throw new Error('engine host: newId gave a session id that is malformed or already used');
    const record: Tracked = { session: createSession(id, log), engine: spec, folder: plan.folder, model: plan.model, handle: undefined, exited: false, endWaiters: [] };
    records.set(id, record);
    // The program was found when the start was planned, and the session is checked ready, so the session walks detected, ready, starting before the program runs.
    record.session.move('ready');
    record.session.move('starting');
    const settled = new Promise<{ readonly ok: true; readonly info: SessionInfo } | HostRefusal>(resolve => {
      const failed = (): void => {
        record.session.fail('start_failed');
        endOf(record);
        resolve(refusal('ENGINE_START_FAILED'));
      };
      try {
        launched += 1;
        const args = [...spec.args, ...(plan.model !== null && spec.modelArgs !== undefined ? spec.modelArgs(plan.model) : [])];
        const handle = launcher.launch({ program: plan.program, args, cwd: plan.folder, env: environmentOf(plan.variables) });
        record.handle = handle;
        handle.onSpawn(() => resolve({ ok: true, info: info(record) }));
        handle.onError(failed);
        handle.onLine(line => claim(record, line));
        handle.onExit((code, signal) => onExited(record, code, signal));
      } catch {
        failed();
      }
    });
    return { ok: true, session: id, settled };
  }

  function planStop(sessionId: unknown): { readonly ok: true; readonly plan: StopPlanContent } | HostRefusal {
    const id = checkSessionId(sessionId);
    if (!id.ok) return invalid(id.reason);
    const record = records.get(id.value);
    if (!record) return refusal('ENGINE_SESSION_UNKNOWN');
    if (isTerminal(record.session.state)) return refusal('ENGINE_SESSION_ENDED');
    return { ok: true, plan: Object.freeze({ session: id.value, engine: record.engine.id, folder: record.folder, force: record.session.state === 'stopping' }) };
  }

  function beginStop(sessionId: unknown): BegunStop | HostRefusal {
    const planned = planStop(sessionId);
    if (!planned.ok) return planned;
    const record = records.get(planned.plan.session);
    if (!record) throw new Error('engine host: a session that was planned is gone');
    const state = record.session.state;
    if (state === 'stopping') {
      record.handle?.signal('kill');
    } else if (state === 'starting' || state === 'running' || state === 'waiting') {
      record.session.move('stopping');
      record.handle?.signal('term');
    } else {
      // A session is detected or ready only inside `beginStart`, which never returns in that state, so no caller can see one. Reaching this is a bug.
      throw new Error(`engine host: a session cannot be stopped in the state ${state}`);
    }
    const settled = waitForEnd(record, stopTimeoutMs).then((gone): { readonly ok: true; readonly info: SessionInfo } | HostRefusal => (gone ? { ok: true, info: info(record) } : refusal('ENGINE_STOP_TIMEOUT')));
    return { ok: true, settled };
  }

  return {
    planStart,
    beginStart,
    planStop,
    beginStop,
    async stop(sessionId) {
      const begun = beginStop(sessionId);
      return begun.ok ? begun.settled : begun;
    },
    list: engine => Object.freeze([...records.values()].filter(record => engine === undefined || record.engine.id === engine).map(info)),
    get: sessionId => { const record = records.get(sessionId); return record ? info(record) : undefined; },
    async killAll() {
      const running = [...records.values()].filter(record => !record.exited);
      for (const record of running) record.handle?.signal('kill');
      await Promise.all(running.map(record => waitForEnd(record, 5000)));
    },
    get launched() { return launched; },
  };
}
