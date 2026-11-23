import { isGaugeCode, type GaugeCode } from '../../gauge-errors/src/index.js';
import { isAuditReason, isGrantReason, isManifestReason, isPermission, isTracesPermission, type PermissionName } from '../../gauge-manifest/src/index.js';
import { MAX_LAYOUT_BYTES, MAX_REVISIONS, canonicalText, isLayoutReason, isProtectedReason, layoutOf, parseLayoutText, sha256Hex, type Layout } from '../../gauge-layout/src/index.js';
import { MAX_NAME_LENGTH, checkEngineId, checkFolder, checkModel, checkSessionId, isRequestReason, readList } from '../../engine-sessions/src/request.js';
import { SESSION_FAILURES, type SessionFailure } from '../../engine-sessions/src/session.js';
import { SESSION_STATES, type SessionState } from '../../engine-sessions/src/states.js';
import { hasPlanUnsafeChar, hasUnsafeChar } from '../../engine-sessions/src/text.js';
import { BILLING_SOURCES, type Billing } from '../../engine-sessions/src/vocab.js';
import {
  ENGINE_CODES, LAYOUT_KINDS, PLAN_ACTIONS, SESSION_ACTIONS,
  type AuditEntry, type AuditRead, type Core, type CoreMethod, type CoreResult, type GaugeApplied, type GaugePlan, type GaugeSummary, type GrantApplied, type GrantEntry, type GrantPlan, type GrantRevoked,
  type LayoutApplied, type LayoutKind, type LayoutPlan, type LayoutRevisionEntry, type LayoutSafe, type LayoutState, type PermissionCheck, type PlanAction,
  type SessionAction, type SessionApplied, type SessionModel, type SessionPlan, type SessionSummary,
} from './types.js';

/** The core broke the contract: a reply of the wrong shape, or a code outside the registry. This is a bug, not a refusal. It names the method that failed. */
export class CoreProtocolError extends Error {
  readonly method: CoreMethod;
  constructor(method: CoreMethod, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CoreProtocolError';
    this.method = method;
  }
}

/** The one door from a Gauge to the core. */
export interface CoreClient {
  /** Lists the Gauges the core holds. */
  listGauges(): Promise<CoreResult<readonly GaugeSummary[]>>;
  /** Reads one Gauge. Refuses with `UNKNOWN_GAUGE` when no Gauge has the id. */
  getGauge(id: string): Promise<CoreResult<GaugeSummary>>;
  /** Plans the install of the Gauge in a folder the core found. Nothing changes until the plan is applied with an approval. */
  planInstall(folder: string): Promise<CoreResult<GaugePlan>>;
  /** Plans the update of an installed Gauge from a folder that holds a new version of it. */
  planUpdate(folder: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to enable an installed Gauge. */
  planEnable(id: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to disable an installed Gauge. */
  planDisable(id: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to remove an installed Gauge. */
  planRemove(id: string): Promise<CoreResult<GaugePlan>>;
  /**
   * Applies a plan. The core applies it only when `approval` is the person's approval of this exact plan. A Gauge never makes an approval: the person
   * does, in the app. Without one the core refuses with `GAUGE_PLAN_NOT_APPROVED`, and with a changed plan with `GAUGE_PLAN_CHANGED`.
   */
  applyPlan(plan: GaugePlan, approval?: string): Promise<CoreResult<GaugeApplied>>;
  /** Lists the routes of the enabled Gauges. A disabled or removed Gauge has none. */
  listRoutes(): Promise<CoreResult<readonly string[]>>;
  /**
   * Plans a grant of permissions to an installed Gauge. Nothing changes until the plan is applied with the person's approval. The plan binds to the manifest hash and
   * the folder hash of the Gauge, so a changed manifest asks again. Traces permissions go in a plan of their own: a plan that mixes them is refused with `GAUGE_TRACES_OWN_STEP`.
   */
  planGrant(id: string, permissions: readonly string[]): Promise<CoreResult<GrantPlan>>;
  /** Applies a grant plan. Like a lifecycle plan it needs the person's approval of this exact plan: without one the core refuses with `GAUGE_PLAN_NOT_APPROVED`, with a changed plan `GAUGE_PLAN_CHANGED`. */
  applyGrant(plan: GrantPlan, approval?: string): Promise<CoreResult<GrantApplied>>;
  /**
   * Revokes permissions of a Gauge, in one action, with no plan. Access ends at once, and the audit record comes after, on a best effort. A permission that the Gauge does not hold is
   * a no-op, so a repeated revoke is not an error: `revoked` lists the permissions that were held. Only an unknown Gauge, an unknown name, and a bad request are refused.
   */
  revoke(id: string, permissions: readonly string[]): Promise<CoreResult<GrantRevoked>>;
  /** Revokes every traces permission that the Gauge holds, in one action. `revoked` may be empty when it held none. */
  revokeTraces(id: string): Promise<CoreResult<GrantRevoked>>;
  /** Lists the grants a Gauge holds, sorted by permission name, each with the two hashes it is bound to. */
  listGrants(id: string): Promise<CoreResult<readonly GrantEntry[]>>;
  /** Asks whether a Gauge may use a permission now, for an engine. The engine must be one the Gauge lists, and is left out for a permission that touches no engine. */
  checkPermission(gauge: string, permission: string, engine?: string): Promise<CoreResult<PermissionCheck>>;
  /**
   * Reads the audit file: every grant and revoke still held, oldest first, with `firstSeq` and `droppedCount` so a reader can tell that old records were dropped, and `auditFailed`,
   * true once a record could not be written. The file is not a complete history.
   */
  readAudit(): Promise<CoreResult<AuditRead>>;
  /**
   * Reads the layout in use: the 6-column bento home, with its tiles, the shelf of what is one step away, and the hidden list. `revision` is its number, and `safe` is `null`. When the saved
   * layout file was broken or invalid, the core started in safe mode: `revision` is 0, `safe` holds the code and reason of the refusal, and `layout` is the default layout, which is not saved
   * until the person makes a change.
   */
  readLayout(): Promise<CoreResult<LayoutState>>;
  /** Lists the earlier layouts that the file keeps, newest first, at most 10. The layout in use is not in the list. The list is empty in safe mode. */
  listLayoutRevisions(): Promise<CoreResult<readonly LayoutRevisionEntry[]>>;
  /** Gives the canonical text of the layout in use: one line of compact JSON and one line feed. Importing it gives the same layout. */
  exportLayout(): Promise<CoreResult<string>>;
  /**
   * Plans to use the layout in a text, which is how a person saves a layout and how a person imports one. The text is validated like a manifest: strict JSON, a size cap, no unknown field, every
   * Gauge must exist and be enabled, and no tile may overlap or leave the grid. A layout that hides, removes, or replaces a protected Gauge or Settings is refused with `GAUGE_PROTECTED`.
   * Nothing changes until the plan is applied with the person's approval.
   */
  planLayoutSet(text: string): Promise<CoreResult<LayoutPlan>>;
  /** Plans to swap which Gauge fills a place. The default Gauge of the place stays one action away (`planLayoutDefault`). */
  planLayoutSwap(place: string, gauge: string): Promise<CoreResult<LayoutPlan>>;
  /** Plans to put the default Gauge of a place back in it. */
  planLayoutDefault(place: string): Promise<CoreResult<LayoutPlan>>;
  /** Plans to restore an earlier layout of the file. It becomes the new layout in use, and the one it replaces becomes a revision. */
  planLayoutRestore(revision: number): Promise<CoreResult<LayoutPlan>>;
  /**
   * A Gauge asks to add itself to the layout. It needs the `layout.propose` grant, and the change is a plan that only the person approves: a Gauge never changes the layout. The core
   * puts the tile where it finds room, in the first size the Gauge allows.
   */
  planLayoutPropose(gauge: string): Promise<CoreResult<LayoutPlan>>;
  /** Applies a layout plan. Like every plan, it needs the person's approval of this exact plan. Without one the core refuses with `GAUGE_PLAN_NOT_APPROVED`, and with a changed plan with `GAUGE_PLAN_CHANGED`. */
  applyLayout(plan: LayoutPlan, approval?: string): Promise<CoreResult<LayoutApplied>>;
  /**
   * A Gauge asks for a plan to start a session of an engine in a folder. It needs the `sessions.start` grant for that engine. The plan lists the engine, the real program, the real folder, the model
   * choice, the billing source, and the variables that pass, and the engines already in the folder. Nothing starts until the plan is applied with the person's approval, and a plan whose folder is
   * shared with another engine needs a second approval too. A start past the session cap is refused with `ENGINE_LIMIT`.
   */
  planSessionStart(gauge: string, request: SessionStartRequest): Promise<CoreResult<SessionPlan>>;
  /** A Gauge asks for a plan to stop a session. It needs the `sessions.stop` grant for the engine of the session. A session that is stopping already gets a plan that kills it. */
  planSessionStop(gauge: string, session: string): Promise<CoreResult<SessionPlan>>;
  /**
   * Applies a session plan. It needs the person's approval of this exact plan (`approval`), and a plan with `sharedWith` needs the second approval too (`sharedApproval`).
   * A start gives the session when its program has started. A stop gives `stopped`, or refuses with `ENGINE_STOP_TIMEOUT` and leaves the session stopping.
   */
  applySession(plan: SessionPlan, approval?: string, sharedApproval?: string): Promise<CoreResult<SessionApplied>>;
  /** Lists the sessions of one engine, oldest first. It needs the `sessions.read` grant for that engine. The list holds no output of the engine. */
  listSessions(gauge: string, engine: string): Promise<CoreResult<readonly SessionSummary[]>>;
  /** Reads one session. It needs the `sessions.read` grant for the engine of the session. */
  getSession(gauge: string, session: string): Promise<CoreResult<SessionSummary>>;
}

/** What a Gauge asks for when it starts a session. `model` is `null` or left out for the engine's own default. `variables` are names the person allows to pass, besides those the engine declares. */
export interface SessionStartRequest {
  readonly engine: string;
  readonly folder: string;
  readonly model?: SessionModel | null;
  readonly variables?: readonly string[];
}

const SHOWN_LENGTH = 64;
/** One piece of JSON text that a cut must not split: a unicode escape, any other escape, or one character (a surrogate pair counts as one). */
const PIECE = /\\u[0-9a-fA-F]{4}|\\[\s\S]|[\s\S]/gu;

/** Prints any value on one line and never throws. It stringifies first, then cuts once to 64 characters between two pieces, so an escape is never cut in half. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? `<${typeof value}>`;
  } catch {
    return `<unprintable ${typeof value}>`;
  }
  if (text.length <= SHOWN_LENGTH) return text;
  let kept = '';
  for (const [piece] of text.matchAll(PIECE)) {
    if (kept.length + piece.length > SHOWN_LENGTH) break;
    kept += piece;
  }
  return `${kept}...`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads one own property, once. A property that is only inherited reads as missing. */
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/** Reads one own data property, once, and never runs a getter: an accessor reads as missing. The session readers use this one. */
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Builds a Gauge summary from a value, or gives back `undefined` when it is not one. Each of the six fields is read once, from the value's own
 * properties, and checked. The result is a new frozen object made from those six values, so a field beyond them is dropped.
 */
function summaryOf(value: unknown): GaugeSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = own(value, 'id'), title = own(value, 'title'), version = own(value, 'version');
  const kind = own(value, 'kind'), origin = own(value, 'origin'), isProtected = own(value, 'protected');
  if (typeof id !== 'string' || typeof title !== 'string' || typeof version !== 'string') return undefined;
  if (kind !== 'ui' && kind !== 'data') return undefined;
  if (origin !== 'stock' && origin !== 'third-party') return undefined;
  if (typeof isProtected !== 'boolean') return undefined;
  return Object.freeze({ id, title, version, kind, origin, protected: isProtected });
}

const ACTIONS: readonly string[] = PLAN_ACTIONS;
const HEX_64 = /^[0-9a-f]{64}$/;
const ROUTE = /^\/gauges\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;
const nullableHash = (value: unknown): string | null | undefined => (value === null || (typeof value === 'string' && HEX_64.test(value)) ? value : undefined);
const nullableText = (value: unknown): string | null | undefined => (value === null || typeof value === 'string' ? value : undefined);

/** Builds a plan from a value, or gives back `undefined` when it is not one. Each of the eleven fields is read once, from own properties. */
function planOf(value: unknown): GaugePlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), id = own(value, 'id'), folder = nullableText(own(value, 'folder')), from = nullableText(own(value, 'from')), to = nullableText(own(value, 'to'));
  const origin = own(value, 'origin'), steps = denseTexts(own(value, 'steps')), digest = own(value, 'digest');
  const manifestHash = nullableHash(own(value, 'manifestHash')), folderHash = nullableHash(own(value, 'folderHash')), nonce = own(value, 'nonce');
  if (typeof action !== 'string' || !ACTIONS.includes(action) || typeof id !== 'string' || id === '') return undefined;
  if (folder === undefined || from === undefined || to === undefined) return undefined;
  if (origin !== 'stock' && origin !== 'third-party') return undefined;
  if (!steps) return undefined;
  if (typeof digest !== 'string' || !HEX_64.test(digest)) return undefined;
  if (manifestHash === undefined || folderHash === undefined || typeof nonce !== 'string' || !HEX_64.test(nonce)) return undefined;
  return Object.freeze({ action: action as PlanAction, id, folder, from, to, origin, steps: Object.freeze(steps), digest, manifestHash, folderHash, nonce });
}

/** Builds the result of an applied plan from a value, or gives back `undefined` when it is not one. */
function appliedOf(value: unknown): GaugeApplied | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), id = own(value, 'id'), version = nullableText(own(value, 'version')), enabled = own(value, 'enabled');
  if (typeof action !== 'string' || !ACTIONS.includes(action) || typeof id !== 'string' || version === undefined || typeof enabled !== 'boolean') return undefined;
  return Object.freeze({ action: action as PlanAction, id, version, enabled });
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);
const isText = (value: unknown): value is string => typeof value === 'string';
/** Reads a list of text once, by index, from own data properties, with no hole, no accessor, no subclass, and no iterator (see `readList`). Gives a new list. */
const denseTexts = (value: unknown): string[] | undefined => { const items = readList(value); return items !== undefined && items.every(isText) ? items : undefined; };
/** True when the list is in strict order, so sorted with no repeat. Names compare by code unit, and permission names are plain ASCII. */
const isStrictlyIncreasing = (list: readonly string[]): boolean => list.every((item, index) => index === 0 || (list[index - 1] ?? '') < item);
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const isIsoTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** Reads a list of permission names from a value: names of the list, sorted, once each. Anything else reads as `undefined`. */
function permissionNames(value: unknown): readonly PermissionName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // A hole in a list is not a name: Array.from reads it as undefined, where every would skip it.
  const names = Array.from(value as unknown[]);
  if (!names.every((item): item is PermissionName => isPermission(item))) return undefined;
  return isStrictlyIncreasing(names) ? names : undefined;
}

/** Builds a grant plan from a value, or gives back `undefined` when it is not one. */
function grantPlanOf(value: unknown): GrantPlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), id = own(value, 'id'), version = own(value, 'version'), permissions = permissionNames(own(value, 'permissions')), steps = denseTexts(own(value, 'steps'));
  const digest = own(value, 'digest'), manifestHash = nullableHash(own(value, 'manifestHash')), folderHash = nullableHash(own(value, 'folderHash')), nonce = own(value, 'nonce');
  if (action !== 'grant' || typeof id !== 'string' || id === '' || typeof version !== 'string' || !permissions || permissions.length === 0) return undefined;
  const traces = permissions.filter(isTracesPermission).length;
  if (traces !== 0 && traces !== permissions.length) return undefined;
  if (!steps) return undefined;
  if (typeof digest !== 'string' || !HEX_64.test(digest) || manifestHash === undefined || folderHash === undefined || typeof nonce !== 'string' || !HEX_64.test(nonce)) return undefined;
  return Object.freeze({ action, id, version, permissions: Object.freeze(permissions), steps: Object.freeze(steps), digest, manifestHash, folderHash, nonce });
}

/** Builds one grant of a list from a value, or gives back `undefined` when it is not one. */
function grantEntryOf(value: unknown): GrantEntry | undefined {
  if (!isRecord(value)) return undefined;
  const permission = own(value, 'permission'), manifestHash = nullableHash(own(value, 'manifestHash')), folderHash = nullableHash(own(value, 'folderHash'));
  if (!isPermission(permission) || manifestHash === undefined || folderHash === undefined) return undefined;
  return Object.freeze({ permission, manifestHash, folderHash });
}

/** Builds one audit record from a value, or gives back `undefined` when it is not one. The action and the way must fit: a grant is by a plan, and a revoke is by a revoke or a removal. */
function auditEntryOf(value: unknown): AuditEntry | undefined {
  if (!isRecord(value)) return undefined;
  const seq = own(value, 'seq'), at = own(value, 'at'), action = own(value, 'action'), via = own(value, 'via'), id = own(value, 'id'), version = nullableText(own(value, 'version'));
  const permission = own(value, 'permission'), manifestHash = nullableHash(own(value, 'manifestHash')), folderHash = nullableHash(own(value, 'folderHash'));
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || !isIsoTime(at) || typeof id !== 'string' || id === '' || version === undefined) return undefined;
  if (!isPermission(permission) || manifestHash === undefined || folderHash === undefined) return undefined;
  if (action === 'grant') {
    if (via !== 'plan') return undefined;
    return Object.freeze({ seq, at, action, via, id, version, permission, manifestHash, folderHash });
  }
  if (action !== 'revoke' || !(via === 'revoke' || via === 'remove' || via === 'disable' || via === 'update')) return undefined;
  return Object.freeze({ seq, at, action, via, id, version, permission, manifestHash, folderHash });
}

const NONNEGATIVE = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const POSITIVE = (value: unknown): value is number => NONNEGATIVE(value) && value >= 1;
const KINDS: readonly string[] = LAYOUT_KINDS;

const ENGINE_CODE_SET: ReadonlySet<string> = new Set(ENGINE_CODES);
/** True for the engine codes that carry no reason. */
const isEngineCode = (code: GaugeCode): code is Extract<GaugeCode, (typeof ENGINE_CODES)[number]> => ENGINE_CODE_SET.has(code);
const SESSION_STATE_LIST: readonly string[] = SESSION_STATES;
const SESSION_ACTION_LIST: readonly string[] = SESSION_ACTIONS;
const BILLING_LIST: readonly string[] = BILLING_SOURCES;
const FAILURE_LIST: readonly string[] = SESSION_FAILURES;
/** The states a start can give back: any state past `ready`, since the program may have moved on already. */
const STARTED_STATES: readonly string[] = ['starting', 'running', 'waiting', 'stopping', 'stopped', 'failed'];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROGRAM_LENGTH = 4096;

/** Reads a model choice of a reply. A field that is missing is not `null`: the choice is `null` or an object, and anything else reads as `undefined`. */
const modelIn = (value: unknown): SessionModel | null | undefined => {
  if (value === undefined) return undefined;
  const checked = checkModel(value);
  return checked.ok ? checked.value : undefined;
};
/** A list of engine ids or of variable names that is dense, has no repeat, and is in strict order. Gives a new list, or `undefined`. */
function orderedNames(value: unknown, valid: (name: string) => boolean): string[] | undefined {
  const names = denseTexts(value);
  return names !== undefined && names.every(valid) && isStrictlyIncreasing(names) ? names : undefined;
}
const isEngineName = (name: string): boolean => checkEngineId(name).ok;
const isVariableName = (name: string): boolean => name.length <= MAX_NAME_LENGTH && VARIABLE_NAME.test(name);

/** Builds a session plan from a value, or gives back `undefined` when it is not one. Each field is read once, from own properties, and the fields of the other action must be empty. */
function sessionPlanOf(value: unknown): SessionPlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = ownData(value, 'action'), gauge = ownData(value, 'gauge'), engine = ownData(value, 'engine'), folder = ownData(value, 'folder'), session = nullableText(ownData(value, 'session')), program = nullableText(ownData(value, 'program'));
  const model = modelIn(ownData(value, 'model')), billing = ownData(value, 'billing'), variables = orderedNames(ownData(value, 'variables'), isVariableName), sharedWith = orderedNames(ownData(value, 'sharedWith'), isEngineName);
  const force = ownData(value, 'force'), steps = denseTexts(ownData(value, 'steps')), digest = ownData(value, 'digest'), nonce = ownData(value, 'nonce');
  if (typeof action !== 'string' || !SESSION_ACTION_LIST.includes(action) || !checkEngineId(gauge).ok || !checkEngineId(engine).ok || !checkFolder(folder).ok) return undefined;
  if (typeof gauge !== 'string' || typeof engine !== 'string' || typeof folder !== 'string') return undefined;
  if (session === undefined || program === undefined || model === undefined || variables === undefined || sharedWith === undefined || typeof force !== 'boolean') return undefined;
  if (typeof billing !== 'string' || !BILLING_LIST.includes(billing) || !steps || steps.length === 0 || steps.some(hasPlanUnsafeChar)) return undefined;
  if (typeof digest !== 'string' || !HEX_64.test(digest) || typeof nonce !== 'string' || !HEX_64.test(nonce)) return undefined;
  if (action === 'start') {
    if (session !== null || force || program === null || program === '' || program.length > MAX_PROGRAM_LENGTH || hasUnsafeChar(program)) return undefined;
  } else if (!checkSessionId(session).ok || program !== null || model !== null || variables.length > 0 || sharedWith.length > 0) return undefined;
  return Object.freeze({
    action: action as SessionAction, gauge, engine, folder, session, program, model, billing: billing as Billing, variables: Object.freeze(variables), sharedWith: Object.freeze(sharedWith), force, steps: Object.freeze(steps), digest, nonce,
  });
}

/** Builds one session summary from a value, or gives back `undefined` when it is not one. A session has a failure if and only if it failed. */
function sessionSummaryOf(value: unknown): SessionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = ownData(value, 'id'), engine = ownData(value, 'engine'), folder = ownData(value, 'folder'), state = ownData(value, 'state'), billing = ownData(value, 'billing'), model = modelIn(ownData(value, 'model')), failure = ownData(value, 'failure');
  if (!checkSessionId(id).ok || !checkEngineId(engine).ok || !checkFolder(folder).ok || typeof id !== 'string' || typeof engine !== 'string' || typeof folder !== 'string') return undefined;
  if (typeof state !== 'string' || !SESSION_STATE_LIST.includes(state) || typeof billing !== 'string' || !BILLING_LIST.includes(billing) || model === undefined) return undefined;
  if (failure !== null && (typeof failure !== 'string' || !FAILURE_LIST.includes(failure))) return undefined;
  if ((state === 'failed') !== (failure !== null)) return undefined;
  return Object.freeze({ id, engine, folder, state: state as SessionState, billing: billing as Billing, model, failure: failure as SessionFailure | null });
}

/** Reads a layout from a reply: own properties only, in canonical order, with the grid and the tiles checked, and no Gauge. Gives a new frozen layout, or throws a protocol error. */
function layoutIn(method: CoreMethod, value: unknown, what: string): Layout {
  const result = layoutOf(value, { requireCanonical: true });
  if (!result.ok) throw new CoreProtocolError(method, `${what} is not a layout: ${result.reason}`);
  return result.layout;
}

/** Builds the state of the layout from a value, or gives back `undefined` when it is not one. In safe mode the revision is 0, and the cause is a code of the layout with its reason. */
function safeOf(value: unknown): LayoutSafe | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const code = own(value, 'code'), reason = own(value, 'reason');
  if (code === 'GAUGE_LAYOUT_INVALID' && isLayoutReason(reason)) return Object.freeze({ code, reason });
  if (code === 'GAUGE_PROTECTED' && isProtectedReason(reason)) return Object.freeze({ code, reason });
  return undefined;
}

/** Builds a layout plan from a value, or gives back `undefined` when it is not one. Each of the eleven fields is read once, from own properties. */
function layoutPlanOf(value: unknown): LayoutPlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), kind = own(value, 'kind'), place = nullableText(own(value, 'place')), gauge = nullableText(own(value, 'gauge')), revision = own(value, 'revision'), text = nullableText(own(value, 'text'));
  const steps = denseTexts(own(value, 'steps')), digest = own(value, 'digest'), baseHash = own(value, 'baseHash'), nextHash = own(value, 'nextHash'), nonce = own(value, 'nonce');
  if (action !== 'layout' || typeof kind !== 'string' || !KINDS.includes(kind) || place === undefined || gauge === undefined || text === undefined || !steps) return undefined;
  if (revision !== null && !POSITIVE(revision)) return undefined;
  for (const hash of [digest, baseHash, nextHash, nonce]) if (typeof hash !== 'string' || !HEX_64.test(hash)) return undefined;
  if (typeof digest !== 'string' || typeof baseHash !== 'string' || typeof nextHash !== 'string' || typeof nonce !== 'string') return undefined;
  return Object.freeze({ action, kind: kind as LayoutKind, place, gauge, revision: revision, text, steps: Object.freeze(steps), digest, baseHash, nextHash, nonce });
}

/**
 * A copy of a plan to send: each own enumerable data property of the plan (`Object.keys`), read once through its descriptor, with each named list copied. A property that is an accessor, or that is not enumerable,
 * or that the plan only inherits, is not sent and is not read, so the core refuses the plan as incomplete. A plan that is `null` or `undefined` throws, as it always did.
 */
function ownLists(plan: object, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(plan)) {
    const descriptor = Object.getOwnPropertyDescriptor(plan, key);
    // `Object.keys` lists the enumerable own string keys only, so a hidden property is never seen. An accessor has no `value`, and is skipped without being read.
    if (!descriptor || !('value' in descriptor)) continue;
    const value: unknown = descriptor.value;
    // A key such as `__proto__` stays an own data property of the copy: it is defined, and not assigned, so it never changes the prototype of the copy.
    Object.defineProperty(copy, key, { value: keys.includes(key) && Array.isArray(value) ? [...(value as unknown[])] : value, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/** Builds the client on a core: the fake core now, the real core later. */
export function createCoreClient(core: Core): CoreClient {
  /** Calls the core, then reads the reply. A throw from the call itself reaches the caller unchanged. A throw while reading the reply is a protocol error. */
  async function ask<T>(method: CoreMethod, params: Record<string, unknown>, read: (method: CoreMethod, result: unknown) => T): Promise<CoreResult<T>> {
    const reply: unknown = await core.call(method, params);
    try {
      if (!isRecord(reply)) throw new CoreProtocolError(method, `reply is not an object: ${shown(reply)}`);
      const ok = own(reply, 'ok');
      if (ok === false) {
        const code = refusal(method, own(reply, 'code'));
        const reason = own(reply, 'reason');
        // The reason is typed by the code. A grant reason goes with `GAUGE_GRANT_MISSING` only, an audit reason is required with `GAUGE_AUDIT_FAILED`, and a manifest reason goes with every other code.
        if (code === 'GAUGE_GRANT_MISSING') {
          if (reason === undefined) return { ok: false, code };
          if (isGrantReason(reason)) return { ok: false, code, reason };
        } else if (code === 'GAUGE_AUDIT_FAILED') {
          if (isAuditReason(reason)) return { ok: false, code, reason };
        } else if (code === 'GAUGE_LAYOUT_INVALID') {
          if (isLayoutReason(reason)) return { ok: false, code, reason };
        } else if (code === 'GAUGE_PROTECTED') {
          if (reason === undefined) return { ok: false, code };
          if (isProtectedReason(reason)) return { ok: false, code, reason };
        } else if (code === 'ENGINE_REQUEST_INVALID') {
          if (isRequestReason(reason)) return { ok: false, code, reason };
        } else if (isEngineCode(code)) {
          if (reason === undefined) return { ok: false, code };
        } else {
          if (reason === undefined) return { ok: false, code };
          if (isManifestReason(reason)) return { ok: false, code, reason };
        }
        throw new CoreProtocolError(method, reason === undefined ? 'refusal has no reason, and its code needs one' : `refusal reason is not one of the closed set: ${shown(reason)}`);
      }
      if (ok !== true) throw new CoreProtocolError(method, 'reply has no boolean ok');
      return { ok: true, value: read(method, own(reply, 'result')) };
    } catch (error) {
      if (error instanceof CoreProtocolError) throw error;
      throw new CoreProtocolError(method, `reply could not be read: ${shown(error instanceof Error ? error.message : error)}`);
    }
  }
  function refusal(method: CoreMethod, code: unknown): GaugeCode {
    if (typeof code !== 'string') throw new CoreProtocolError(method, `refusal code is not a string: ${shown(code)}`);
    if (!isGaugeCode(code)) throw new CoreProtocolError(method, `refusal code is outside the registry: ${shown(code)}`);
    return code;
  }
  function gaugeList(method: CoreMethod, result: unknown): readonly GaugeSummary[] {
    if (!Array.isArray(result)) throw new CoreProtocolError(method, 'result is not a list');
    const gauges: GaugeSummary[] = [];
    for (let index = 0; index < result.length; index += 1) {
      const gauge = summaryOf(result[index]);
      if (!gauge) throw new CoreProtocolError(method, `result element ${index} is not a Gauge summary`);
      gauges.push(gauge);
    }
    return Object.freeze(gauges);
  }
  function revokedOf(method: CoreMethod, result: unknown, id: string): GrantRevoked {
    if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not a revoke');
    const resultId = own(result, 'id'), revoked = permissionNames(own(result, 'revoked'));
    if (typeof resultId !== 'string' || !revoked) throw new CoreProtocolError(method, 'result is not a revoke');
    if (resultId !== id) throw new CoreProtocolError(method, `result is for another Gauge: ${shown(resultId)}`);
    return Object.freeze({ id: resultId, revoked: Object.freeze(revoked) });
  }
  const planning = (action: PlanAction, target: { id: string } | { folder: string }) => ask('bowerloom.gauges.plan', { action, ...target }, (method, result) => {
    const plan = planOf(result);
    if (!plan) throw new CoreProtocolError(method, 'result is not a Gauge plan');
    if (plan.action !== action) throw new CoreProtocolError(method, `result is a plan for another step: ${shown(plan.action)}`);
    if ('folder' in target ? plan.folder !== target.folder : plan.folder !== null || plan.id !== target.id) throw new CoreProtocolError(method, 'result is a plan for another target');
    return plan;
  });
  /** A plan for a change to the layout. It must answer the request: the same kind and the same targets, and nothing else. */
  const layoutPlanning = (request: { readonly kind: LayoutKind; readonly place?: string; readonly gauge?: string; readonly revision?: number; readonly text?: string }) =>
    ask('bowerloom.layout.plan', { ...request }, (method, result) => {
      const plan = layoutPlanOf(result);
      if (!plan) throw new CoreProtocolError(method, 'result is not a layout plan');
      if (plan.kind !== request.kind) throw new CoreProtocolError(method, `result is a plan for another change: ${shown(plan.kind)}`);
      if (plan.place !== (request.place ?? null) || plan.gauge !== (request.gauge ?? null) || plan.revision !== (request.revision ?? null) || plan.text !== (request.text ?? null)) {
        throw new CoreProtocolError(method, 'result is a plan for another target');
      }
      // The last line is the one that binds the change to the two hashes, so the person reads the hashes that the plan holds.
      if (plan.steps[plan.steps.length - 1] !== `bind the change to layout ${plan.baseHash} and result ${plan.nextHash}`) throw new CoreProtocolError(method, 'result plan does not end with the line that binds it to its hashes');
      if (request.kind === 'set') {
        // The result of a layout that is set is known from the text alone, so the hash can be checked here.
        const parsed = parseLayoutText(request.text ?? '');
        if (!parsed.ok) throw new CoreProtocolError(method, `result is a plan for a text that is not a layout: ${parsed.reason}`);
        if (plan.nextHash !== sha256Hex(canonicalText(parsed.layout))) throw new CoreProtocolError(method, 'result plan holds a hash that is not the hash of the text that was sent');
      }
      return plan;
    });
  return {
    readLayout: () => ask('bowerloom.layout.read', {}, (method, result) => {
      if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not a layout state');
      const layout = layoutIn(method, own(result, 'layout'), 'result layout'), revision = own(result, 'revision'), safe = safeOf(own(result, 'safe'));
      if (!NONNEGATIVE(revision) || safe === undefined) throw new CoreProtocolError(method, 'result is not a layout state');
      // A layout in safe mode was not saved, so it has no number. A saved layout has one.
      if ((safe === null) !== (revision >= 1)) throw new CoreProtocolError(method, 'result revision does not fit the safe mode');
      return Object.freeze<LayoutState>({ layout, revision, safe });
    }),
    listLayoutRevisions: () => ask('bowerloom.layout.revisions', {}, (method, result) => {
      if (!Array.isArray(result)) throw new CoreProtocolError(method, 'result is not a list');
      if (result.length > MAX_REVISIONS) throw new CoreProtocolError(method, 'result holds more revisions than the file keeps');
      const entries: LayoutRevisionEntry[] = [];
      for (const item of Array.from(result as unknown[])) {
        if (!isRecord(item)) throw new CoreProtocolError(method, `result element ${entries.length} is not a revision`);
        const revision = own(item, 'revision');
        if (!POSITIVE(revision)) throw new CoreProtocolError(method, `result element ${entries.length} is not a revision`);
        // Newest first: each number is lower than the one before.
        if (entries.length > 0 && revision >= (entries[entries.length - 1]?.revision ?? 0)) throw new CoreProtocolError(method, 'result revisions are not newest first');
        entries.push(Object.freeze({ revision, layout: layoutIn(method, own(item, 'layout'), `result element ${entries.length}`) }));
      }
      return Object.freeze(entries);
    }),
    exportLayout: () => ask('bowerloom.layout.export', {}, (method, result) => {
      if (typeof result !== 'string' || result.length > MAX_LAYOUT_BYTES || new TextEncoder().encode(result).byteLength > MAX_LAYOUT_BYTES) throw new CoreProtocolError(method, 'result is not a layout text');
      const parsed = parseLayoutText(result);
      if (!parsed.ok) throw new CoreProtocolError(method, `result is not a layout text: ${parsed.reason}`);
      if (canonicalText(parsed.layout) !== result) throw new CoreProtocolError(method, 'result is not in the canonical form');
      return result;
    }),
    planLayoutSet: text => layoutPlanning({ kind: 'set', text }),
    planLayoutSwap: (place, gauge) => layoutPlanning({ kind: 'swap', place, gauge }),
    planLayoutDefault: place => layoutPlanning({ kind: 'default', place }),
    planLayoutRestore: revision => layoutPlanning({ kind: 'restore', revision }),
    planLayoutPropose: gauge => layoutPlanning({ kind: 'propose', gauge }),
    applyLayout: (plan, approval) => ask('bowerloom.layout.apply', { plan: ownLists(plan, ['steps']), ...(approval === undefined ? {} : { approval }) }, (method, result) => {
      if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not an applied layout change');
      const kind = own(result, 'kind'), revision = own(result, 'revision'), changed = own(result, 'changed');
      if (typeof kind !== 'string' || !KINDS.includes(kind) || !POSITIVE(revision) || typeof changed !== 'boolean') throw new CoreProtocolError(method, 'result is not an applied layout change');
      if (kind !== plan.kind) throw new CoreProtocolError(method, 'result is for another plan');
      // A plan whose result differs from the layout in use is a change, so a revision was written.
      if (plan.baseHash !== plan.nextHash && !changed) throw new CoreProtocolError(method, 'result says nothing changed for a plan that changes the layout');
      return Object.freeze({ kind: kind as LayoutKind, revision, changed });
    }),
    planSessionStart: (gauge, request) => {
      // The request is read once. The plan that comes back is checked against these values, and not against a second read of the caller's object.
      const engine = request.engine, folder = request.folder, asked = request.model, variables = request.variables;
      const model = asked === undefined ? undefined : asked === null ? null : { provider: asked.provider, model: asked.model };
      const names = variables === undefined ? undefined : [...variables];
      return ask('bowerloom.sessions.plan', {
        action: 'start', gauge, engine, folder, ...(model === undefined ? {} : { model: model === null ? null : { ...model } }), ...(names === undefined ? {} : { variables: [...names] }),
      }, (method, result) => {
        const plan = sessionPlanOf(result);
        if (!plan) throw new CoreProtocolError(method, 'result is not a session plan');
        if (plan.action !== 'start') throw new CoreProtocolError(method, `result is a plan for another action: ${shown(plan.action)}`);
        if (plan.gauge !== gauge || plan.engine !== engine) throw new CoreProtocolError(method, 'result is a plan for another Gauge or engine');
        if ((plan.model === null) !== (model === undefined || model === null) || (plan.model !== null && model !== undefined && model !== null && (plan.model.provider !== model.provider || plan.model.model !== model.model))) {
          throw new CoreProtocolError(method, 'result is a plan for another model choice');
        }
        if (!(names ?? []).every(name => plan.variables.includes(name))) throw new CoreProtocolError(method, 'result plan leaves out a variable that was asked for');
        return plan;
      });
    },
    planSessionStop: (gauge, session) => ask('bowerloom.sessions.plan', { action: 'stop', gauge, session }, (method, result) => {
      const plan = sessionPlanOf(result);
      if (!plan) throw new CoreProtocolError(method, 'result is not a session plan');
      if (plan.action !== 'stop') throw new CoreProtocolError(method, `result is a plan for another action: ${shown(plan.action)}`);
      if (plan.gauge !== gauge || plan.session !== session) throw new CoreProtocolError(method, 'result is a plan for another Gauge or session');
      return plan;
    }),
    applySession: async (plan, approval, sharedApproval) => {
      const sent = ownLists(plan, ['variables', 'sharedWith', 'steps']);
      // The model is an object, so it is copied too: a core that changes it changes nothing for the caller.
      const model: unknown = Object.hasOwn(sent, 'model') ? sent['model'] : undefined;
      if (isRecord(model)) Object.defineProperty(sent, 'model', { value: ownLists(model, []), enumerable: true, writable: true, configurable: true });
      // The result is checked against the copy that was sent, which was read once, and never against a second read of the caller's plan.
      const action = ownData(sent, 'action'), engine = ownData(sent, 'engine'), session = ownData(sent, 'session');
      if (typeof action !== 'string' || !SESSION_ACTION_LIST.includes(action)) throw new TypeError('applySession: the plan needs an own action of start or stop');
      if (typeof engine !== 'string') throw new TypeError('applySession: the plan needs an own engine');
      if (action === 'stop' && typeof session !== 'string') throw new TypeError('applySession: a stop plan needs an own session');
      return ask('bowerloom.sessions.apply', { plan: sent, ...(approval === undefined ? {} : { approval }), ...(sharedApproval === undefined ? {} : { sharedApproval }) }, (method, result) => {
        if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not an applied session plan');
        const gotAction = ownData(result, 'action'), gotSession = ownData(result, 'session'), gotEngine = ownData(result, 'engine'), state = ownData(result, 'state');
        if (typeof gotAction !== 'string' || !SESSION_ACTION_LIST.includes(gotAction) || !checkSessionId(gotSession).ok || typeof gotSession !== 'string' || typeof gotEngine !== 'string' || typeof state !== 'string' || !SESSION_STATE_LIST.includes(state)) {
          throw new CoreProtocolError(method, 'result is not an applied session plan');
        }
        if (gotAction !== action || gotEngine !== engine || (action === 'stop' && gotSession !== session)) throw new CoreProtocolError(method, 'result is for another plan');
        // A stop that succeeded is stopped. A start is past `ready`, since the program may have moved on already.
        if (action === 'stop' ? state !== 'stopped' : !STARTED_STATES.includes(state)) throw new CoreProtocolError(method, `result does not fit a ${action}`);
        return Object.freeze({ action: action as SessionAction, session: gotSession, engine: gotEngine, state: state as SessionState });
      });
    },
    listSessions: (gauge, engine) => ask('bowerloom.sessions.list', { gauge, engine }, (method, result) => {
      const items = readList(result);
      if (items === undefined) throw new CoreProtocolError(method, 'result is not a list');
      const sessions: SessionSummary[] = [];
      for (const [index, item] of items.entries()) {
        const summary = sessionSummaryOf(item);
        if (!summary) throw new CoreProtocolError(method, `result element ${index} is not a session`);
        if (summary.engine !== engine) throw new CoreProtocolError(method, `result element ${index} is a session of another engine`);
        if (sessions.some(earlier => earlier.id === summary.id)) throw new CoreProtocolError(method, `result element ${index} repeats a session`);
        sessions.push(summary);
      }
      return Object.freeze(sessions);
    }),
    getSession: (gauge, session) => ask('bowerloom.sessions.get', { gauge, session }, (method, result) => {
      const summary = sessionSummaryOf(result);
      if (!summary) throw new CoreProtocolError(method, 'result is not a session');
      if (summary.id !== session) throw new CoreProtocolError(method, `result is for another session: ${shown(summary.id)}`);
      return summary;
    }),
    listGauges: () => ask('bowerloom.gauges.list', {}, gaugeList),
    getGauge: id => ask('bowerloom.gauges.get', { id }, (method, result) => {
      const gauge = summaryOf(result);
      if (!gauge) throw new CoreProtocolError(method, 'result is not a Gauge summary');
      if (gauge.id !== id) throw new CoreProtocolError(method, `result is for another Gauge: ${shown(gauge.id)}`);
      return gauge;
    }),
    planInstall: folder => planning('install', { folder }),
    planUpdate: folder => planning('update', { folder }),
    planEnable: id => planning('enable', { id }),
    planDisable: id => planning('disable', { id }),
    planRemove: id => planning('remove', { id }),
    applyPlan: (plan, approval) => ask('bowerloom.gauges.apply', { plan: ownLists(plan, ['steps']), ...(approval === undefined ? {} : { approval }) }, (method, result) => {
      const applied = appliedOf(result);
      if (!applied) throw new CoreProtocolError(method, 'result is not an applied plan');
      if (applied.action !== plan.action || applied.id !== plan.id) throw new CoreProtocolError(method, 'result is for another plan');
      // The result must fit the step: an install adds the Gauge disabled, and each step ends in the state it names.
      const fits =
        applied.action === 'install' ? !applied.enabled && applied.version === plan.to
        : applied.action === 'update' ? applied.version === plan.to
        : applied.action === 'enable' ? applied.enabled
        : applied.action === 'disable' ? !applied.enabled
        : applied.version === null;
      if (!fits) throw new CoreProtocolError(method, `result does not fit a ${plan.action}`);
      return applied;
    }),
    planGrant: (id, permissions) => ask('bowerloom.grants.plan', { id, permissions: [...permissions] }, (method, result) => {
      const plan = grantPlanOf(result);
      if (!plan) throw new CoreProtocolError(method, 'result is not a grant plan');
      if (plan.id !== id) throw new CoreProtocolError(method, `result is a plan for another Gauge: ${shown(plan.id)}`);
      if (!sameList(plan.permissions, [...permissions].sort())) throw new CoreProtocolError(method, 'result is a plan for other permissions than were asked');
      return plan;
    }),
    applyGrant: (plan, approval) => ask('bowerloom.grants.apply', { plan: ownLists(plan, ['permissions', 'steps']), ...(approval === undefined ? {} : { approval }) }, (method, result) => {
      if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not an applied grant');
      const id = own(result, 'id'), permissions = permissionNames(own(result, 'permissions'));
      if (typeof id !== 'string' || !permissions) throw new CoreProtocolError(method, 'result is not an applied grant');
      if (id !== plan.id || !sameList(permissions, plan.permissions)) throw new CoreProtocolError(method, 'result is for another grant plan');
      return Object.freeze({ id, permissions: Object.freeze(permissions) });
    }),
    revoke: (id, permissions) => ask('bowerloom.grants.revoke', { id, permissions: [...permissions] }, (method, result) => {
      const revoked = revokedOf(method, result, id);
      // The core revokes what the Gauge held, so the list may be shorter than the request. It may never name a permission that was not asked.
      if (!revoked.revoked.every(name => permissions.includes(name))) throw new CoreProtocolError(method, 'result revokes other permissions than were asked');
      return revoked;
    }),
    revokeTraces: id => ask('bowerloom.grants.revoke', { id, group: 'traces' }, (method, result) => {
      const revoked = revokedOf(method, result, id);
      if (!revoked.revoked.every(isTracesPermission)) throw new CoreProtocolError(method, 'result revokes more than the traces permissions');
      return revoked;
    }),
    listGrants: id => ask('bowerloom.grants.list', { id }, (method, result) => {
      if (!Array.isArray(result)) throw new CoreProtocolError(method, 'result is not a list');
      const entries: GrantEntry[] = [];
      for (let index = 0; index < result.length; index += 1) {
        const entry = grantEntryOf(result[index]);
        if (!entry) throw new CoreProtocolError(method, `result element ${index} is not a grant`);
        entries.push(entry);
      }
      if (!isStrictlyIncreasing(entries.map(entry => entry.permission))) throw new CoreProtocolError(method, 'result is not sorted by permission, or repeats one');
      return Object.freeze(entries);
    }),
    checkPermission: (gauge, permission, engine) => ask('bowerloom.permissions.check', { gauge, permission, ...(engine === undefined ? {} : { engine }) }, (method, result) => {
      if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not a permission check');
      const resultGauge = own(result, 'gauge'), resultPermission = own(result, 'permission'), resultEngine = nullableText(own(result, 'engine'));
      if (typeof resultGauge !== 'string' || typeof resultPermission !== 'string' || resultEngine === undefined) throw new CoreProtocolError(method, 'result is not a permission check');
      if (resultGauge !== gauge || resultPermission !== permission || resultEngine !== (engine ?? null)) throw new CoreProtocolError(method, 'result is for another call');
      return Object.freeze({ gauge: resultGauge, permission: resultPermission, engine: resultEngine });
    }),
    readAudit: () => ask('bowerloom.audit.read', {}, (method, result) => {
      if (!isRecord(result)) throw new CoreProtocolError(method, 'result is not an audit read');
      const list = own(result, 'entries'), firstSeq = own(result, 'firstSeq'), droppedCount = own(result, 'droppedCount'), failed = own(result, 'auditFailed');
      if (!Array.isArray(list) || typeof failed !== 'boolean') throw new CoreProtocolError(method, 'result is not an audit read');
      const items = Array.from(list as unknown[]);
      const entries: AuditEntry[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const entry = auditEntryOf(items[index]);
        if (!entry) throw new CoreProtocolError(method, `result element ${index} is not an audit record`);
        // The records of the file have no gap: each takes the next number after the one before it, because only the oldest records are ever dropped.
        if (index > 0 && entry.seq !== (entries[index - 1]?.seq ?? 0) + 1) throw new CoreProtocolError(method, 'result records do not follow each other by one');
        entries.push(entry);
      }
      const first = entries[0]?.seq ?? null;
      if (firstSeq !== first) throw new CoreProtocolError(method, 'result firstSeq is not the number of the first record');
      if (typeof droppedCount !== 'number' || !Number.isSafeInteger(droppedCount) || droppedCount !== (first === null ? 0 : first - 1)) throw new CoreProtocolError(method, 'result droppedCount does not fit the first record');
      return Object.freeze({ entries: Object.freeze(entries), firstSeq: first, droppedCount, auditFailed: failed });
    }),
    listRoutes: () => ask('bowerloom.gauges.routes', {}, (method, result) => {
      if (!Array.isArray(result) || !Array.from(result as unknown[]).every((route): route is string => typeof route === 'string' && route.length <= '/gauges/'.length + MAX_ID_LENGTH && ROUTE.test(route))) {
        throw new CoreProtocolError(method, 'result is not a list of routes of the form /gauges/<id>');
      }
      return Object.freeze([...result]);
    }),
  };
}
