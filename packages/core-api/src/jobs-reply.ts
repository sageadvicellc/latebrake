import { checkEngineId, checkFolder, checkModel, checkSessionId, readList } from '../../engine-sessions/src/request.js';
import { SESSION_STATES } from '../../engine-sessions/src/states.js';
import { hasPlanUnsafeChar, hasUnsafeChar } from '../../engine-sessions/src/text.js';
import { BILLING_SOURCES, type Billing } from '../../engine-sessions/src/vocab.js';
import { MAX_JOB_SESSIONS, canonicalDefinition, checkDefinition, checkTaskText, hashDefinition, isLabel, isTitle, type JobDefinition } from '../../jobs/src/definition.js';
import { checkJobId, isRunId } from '../../jobs/src/ids.js';
import type { RunSessionPlan } from '../../jobs/src/runs.js';
import { HEX_64, denseTexts, isRecord, isStrictlyIncreasing, ownData } from './reading.js';
import { JOB_KINDS, type JobKind, type JobListing, type JobPlan, type JobRecord, type RunPlan, type RunSessionSummary, type RunSummary } from './types.js';

/**
 * The readers of a reply to a job or a run call. Each reads own data properties only, once, checks every field, and gives a new frozen value, or `undefined` when the reply is not one. The client turns
 * `undefined` into a protocol error. A reader that holds a definition checks it again with the one check of `packages/jobs`, so a core that stores a definition the check refuses is found here.
 */

const KINDS: readonly string[] = JOB_KINDS;
const BILLING_LIST: readonly string[] = BILLING_SOURCES;
const SESSION_STATE_LIST: readonly string[] = SESSION_STATES;
const MAX_PROGRAM_LENGTH = 4096;
const MAX_TITLE_OF_ENGINE = 64;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const nullableHash = (value: unknown): string | null | undefined => (value === null || (typeof value === 'string' && HEX_64.test(value)) ? value : undefined);
const hex = (value: unknown): value is string => typeof value === 'string' && HEX_64.test(value);
const isEngineName = (name: string): boolean => checkEngineId(name).ok;
const isVariableName = (name: string): boolean => name.length <= 64 && VARIABLE_NAME.test(name);
/** A list of names that is dense, has no repeat, and is in strict order. Gives a new list, or `undefined`. */
function orderedNames(value: unknown, valid: (name: string) => boolean): string[] | undefined {
  const names = denseTexts(value);
  return names !== undefined && names.every(valid) && isStrictlyIncreasing(names) ? names : undefined;
}
/** The steps of a plan: a dense list of text, at least one, with no line break and no hidden character. */
function stepsOf(value: unknown): string[] | undefined {
  const steps = denseTexts(value);
  return steps !== undefined && steps.length > 0 && !steps.some(hasPlanUnsafeChar) ? steps : undefined;
}

/** Reads a job record of a reply: an id, a title, and a definition that the one check accepts as it is. */
export function jobRecordOf(value: unknown): JobRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = ownData(value, 'id'), title = ownData(value, 'title'), sessions = ownData(value, 'sessions');
  if (!checkJobId(id).ok || typeof id !== 'string') return undefined;
  // The record holds exactly an id, a title, and sessions: the definition check refuses any field more, so the id is set aside before it.
  if (Reflect.ownKeys(value).length !== 3) return undefined;
  const checked = checkDefinition({ title, sessions });
  return checked.ok ? Object.freeze({ id, title: checked.value.title, sessions: checked.value.sessions }) : undefined;
}

/** Reads one job of the list. */
export function jobListingOf(value: unknown): JobListing | undefined {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 3) return undefined;
  const id = ownData(value, 'id'), title = ownData(value, 'title'), sessions = ownData(value, 'sessions');
  if (!checkJobId(id).ok || typeof id !== 'string' || !isTitle(title)) return undefined;
  if (typeof sessions !== 'number' || !Number.isSafeInteger(sessions) || sessions < 1 || sessions > MAX_JOB_SESSIONS) return undefined;
  return Object.freeze({ id, title, sessions });
}

/**
 * Reads a job plan of a reply. The plan keeps the shape of its kind: a create has no job and no base hash, an update has both, a delete has a job and a base hash and no definition and no next hash.
 * The definition is checked again, and the next hash must be its hash. The last step binds the change to the two hashes.
 */
export function jobPlanOf(value: unknown): JobPlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = ownData(value, 'action'), kind = ownData(value, 'kind'), gauge = ownData(value, 'gauge'), job = ownData(value, 'job'), definition = ownData(value, 'definition');
  const baseHash = nullableHash(ownData(value, 'baseHash')), nextHash = nullableHash(ownData(value, 'nextHash')), steps = stepsOf(ownData(value, 'steps')), digest = ownData(value, 'digest'), nonce = ownData(value, 'nonce');
  if (action !== 'job' || typeof kind !== 'string' || !KINDS.includes(kind) || !checkEngineId(gauge).ok || typeof gauge !== 'string') return undefined;
  if (baseHash === undefined || nextHash === undefined || steps === undefined || !hex(digest) || !hex(nonce)) return undefined;
  const kindOf = kind as JobKind;
  if (kindOf === 'create' ? job !== null : !checkJobId(job).ok || typeof job !== 'string') return undefined;
  let read: JobDefinition | null = null;
  if (kindOf === 'delete') {
    if (definition !== null || nextHash !== null) return undefined;
  } else {
    const checked = checkDefinition(definition);
    if (!checked.ok || nextHash !== hashDefinition(checked.value)) return undefined;
    read = checked.value;
  }
  if ((kindOf === 'create') !== (baseHash === null)) return undefined;
  if (steps[steps.length - 1] !== `bind the change to job ${baseHash ?? 'none'} and result ${nextHash ?? 'none'}`) return undefined;
  return Object.freeze({
    action, kind: kindOf, gauge, job: job as string | null, definition: read, baseHash, nextHash, steps: Object.freeze(steps), digest, nonce,
  });
}

/** True when two definitions are the same: the same canonical text. */
export const sameDefinition = (left: JobDefinition, right: JobDefinition): boolean => canonicalDefinition(left) === canonicalDefinition(right);

function runSessionPlanOf(value: unknown): RunSessionPlan | undefined {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 11) return undefined;
  const label = ownData(value, 'label'), engine = ownData(value, 'engine'), engineTitle = ownData(value, 'engineTitle'), harness = ownData(value, 'harness'), program = ownData(value, 'program'), folder = ownData(value, 'folder');
  const rawModel = ownData(value, 'model'), billing = ownData(value, 'billing'), variables = orderedNames(ownData(value, 'variables'), isVariableName), sharedWith = orderedNames(ownData(value, 'sharedWith'), isEngineName), task = ownData(value, 'task');
  if (!isLabel(label) || !checkEngineId(engine).ok || typeof engine !== 'string' || !checkEngineId(harness).ok || typeof harness !== 'string' || !checkFolder(folder).ok || typeof folder !== 'string') return undefined;
  if (typeof engineTitle !== 'string' || engineTitle === '' || engineTitle.length > MAX_TITLE_OF_ENGINE || hasUnsafeChar(engineTitle)) return undefined;
  if (typeof program !== 'string' || program === '' || program.length > MAX_PROGRAM_LENGTH || hasUnsafeChar(program)) return undefined;
  if (rawModel === undefined) return undefined;
  const model = checkModel(rawModel);
  if (!model.ok || typeof billing !== 'string' || !BILLING_LIST.includes(billing) || variables === undefined || sharedWith === undefined) return undefined;
  if (checkTaskText(task) !== undefined || typeof task !== 'string') return undefined;
  return Object.freeze({
    label, engine, engineTitle, harness, program, folder, model: model.value, billing: billing as Billing, variables: Object.freeze(variables), sharedWith: Object.freeze(sharedWith), task,
  });
}

/** Reads a run plan of a reply: one to eight sessions with distinct labels, and `shared` true exactly when a session shares its folder. */
export function runPlanOf(value: unknown): RunPlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = ownData(value, 'action'), gauge = ownData(value, 'gauge'), job = ownData(value, 'job'), title = ownData(value, 'title'), shared = ownData(value, 'shared');
  const items = readList(ownData(value, 'sessions'), MAX_JOB_SESSIONS), steps = stepsOf(ownData(value, 'steps')), digest = ownData(value, 'digest'), nonce = ownData(value, 'nonce');
  if (action !== 'run' || !checkEngineId(gauge).ok || typeof gauge !== 'string' || !checkJobId(job).ok || typeof job !== 'string' || !isTitle(title) || typeof shared !== 'boolean') return undefined;
  if (items === undefined || items.length === 0 || steps === undefined || !hex(digest) || !hex(nonce)) return undefined;
  const sessions: RunSessionPlan[] = [];
  for (const item of items) {
    const session = runSessionPlanOf(item);
    if (session === undefined || sessions.some(earlier => earlier.label === session.label)) return undefined;
    sessions.push(session);
  }
  if (shared !== sessions.some(session => session.sharedWith.length > 0)) return undefined;
  return Object.freeze({ action, gauge, job, title, shared, sessions: Object.freeze(sessions), steps: Object.freeze(steps), digest, nonce });
}

function runSessionSummaryOf(value: unknown): RunSessionSummary | undefined {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 4) return undefined;
  const label = ownData(value, 'label'), engine = ownData(value, 'engine'), session = ownData(value, 'session'), state = ownData(value, 'state');
  if (!isLabel(label) || !checkEngineId(engine).ok || typeof engine !== 'string' || typeof state !== 'string') return undefined;
  if (state !== 'forgotten' && state !== 'hidden' && !SESSION_STATE_LIST.includes(state)) return undefined;
  // A session that the Gauge may not read has no id, and one that it may read has one: the answer says nothing about a session that it hides.
  if ((state === 'hidden') !== (session === null)) return undefined;
  if (session !== null && (!checkSessionId(session).ok || typeof session !== 'string')) return undefined;
  return Object.freeze({ label, engine, session, state: state as RunSessionSummary['state'] });
}

/** Reads a run as a group of its sessions: one to eight, with distinct labels. */
export function runSummaryOf(value: unknown): RunSummary | undefined {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 4) return undefined;
  const id = ownData(value, 'id'), job = ownData(value, 'job'), title = ownData(value, 'title'), items = readList(ownData(value, 'sessions'), MAX_JOB_SESSIONS);
  if (!isRunId(id) || !checkJobId(job).ok || typeof job !== 'string' || !isTitle(title) || items === undefined || items.length === 0) return undefined;
  const sessions: RunSessionSummary[] = [];
  for (const item of items) {
    const session = runSessionSummaryOf(item);
    if (session === undefined || sessions.some(earlier => earlier.label === session.label)) return undefined;
    sessions.push(session);
  }
  return Object.freeze({ id, job, title, sessions: Object.freeze(sessions) });
}
