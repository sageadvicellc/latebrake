import { createHash } from 'node:crypto';
import { looksLikeSecret } from '../../gauge-manifest/src/secrets.js';
import { checkEngineId, checkFolder, checkModel, readList, type ModelChoice } from '../../engine-sessions/src/request.js';
import { hasUnsafeChar } from '../../engine-sessions/src/text.js';
import { MAX_START_GROUP } from '../../engine-sessions/src/vocab.js';

/**
 * The job definition: what a Gauge sends and what the core stores. A job is a saved definition of AI work: a title and one or more sessions. Each session has a label (its name inside the job), an engine, a harness,
 * a folder, a model choice, and a task. The check reads own data properties only, once each, and gives a new frozen value. A refusal is a code and one word of a closed set that says which field.
 */

/** The most sessions in one job. It is the most that the Engine Host starts as one group. */
export const MAX_JOB_SESSIONS = MAX_START_GROUP;
export const MAX_TITLE_LENGTH = 80;
export const MAX_LABEL_LENGTH = 32;
export const MAX_TASK_LENGTH = 4096;

/**
 * Why a definition, or a job id, was refused with `GAUGE_JOB_INVALID`. `request`: not a plain record, or a field that the definition does not have. `title`, `sessions`, `label`, `engine`, `harness`, `folder`, `model`, `task`:
 * that field is missing or wrong (a label that repeats is a wrong label). `secret`: the title, a label, a folder, a model, or a task looks like a secret. A job is stored and shown to every Gauge that may read jobs, so the scan refuses the shapes it knows
 * (the scan of `gauge-manifest`). It does not find every secret, and it also refuses a harmless word of 32 characters or more that mixes lower case, upper case, and digits. `job`: the id of a job is malformed.
 * A reason never holds a value that a caller sent.
 */
export const JOB_REASONS = Object.freeze(['request', 'title', 'sessions', 'label', 'engine', 'harness', 'folder', 'model', 'task', 'secret', 'job'] as const);
export type JobReason = (typeof JOB_REASONS)[number];
const JOB_REASON_SET: ReadonlySet<string> = new Set(JOB_REASONS);
/** True when the value is one of the reasons of `GAUGE_JOB_INVALID`. */
export const isJobReason = (value: unknown): value is JobReason => typeof value === 'string' && JOB_REASON_SET.has(value);

/** Why `GAUGE_JOB_NOT_INTERACTIVE` was given. `schedule`: a field that schedules a job. `unattended`: a field or a request that asks for a run without a person. v0.9.1 runs are interactive: the person watches. */
export const NOT_INTERACTIVE_REASONS = Object.freeze(['schedule', 'unattended'] as const);
export type NotInteractiveReason = (typeof NOT_INTERACTIVE_REASONS)[number];
const NOT_INTERACTIVE_SET: ReadonlySet<string> = new Set(NOT_INTERACTIVE_REASONS);
/** True when the value is one of the reasons of `GAUGE_JOB_NOT_INTERACTIVE`. */
export const isNotInteractiveReason = (value: unknown): value is NotInteractiveReason => typeof value === 'string' && NOT_INTERACTIVE_SET.has(value);

export type DefinitionRefusal =
  | { readonly ok: false; readonly code: 'GAUGE_JOB_INVALID'; readonly reason: JobReason }
  | { readonly ok: false; readonly code: 'GAUGE_JOB_NOT_INTERACTIVE'; readonly reason: NotInteractiveReason };

/** One session of a job. `model` is `null` for the engine's own default. */
export interface JobSession {
  readonly label: string;
  readonly engine: string;
  readonly harness: string;
  readonly folder: string;
  readonly model: ModelChoice | null;
  readonly task: string;
}

/** What a Gauge defines: a title and its sessions. */
export interface JobDefinition {
  readonly title: string;
  readonly sessions: readonly JobSession[];
}

const invalid = (reason: JobReason): DefinitionRefusal => ({ ok: false, code: 'GAUGE_JOB_INVALID', reason });
const notInteractive = (reason: NotInteractiveReason): DefinitionRefusal => ({ ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason });

const LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** True for a label: lower-case words joined by single hyphens, at most 32 characters. */
export const isLabel = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_LABEL_LENGTH && LABEL.test(value);
/** The characters a task may not hold, once its line feeds and tabs are set aside: a control, format, line separator, or paragraph separator character. */
const TASK_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A plain record: an ordinary object or one with no prototype. A class instance, a list, and a value with a prototype of its own are not. */
function isPlainRecord(value: unknown): value is object {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    // A proxy whose trap throws, or one that was revoked, is not a plain record, and never a throw.
    return false;
  }
}

/**
 * Reads the own fields of a record, each once, from data properties. It gives `undefined` for a record that holds a symbol key or an accessor, or whose reading throws. Every key is a string key, and `__proto__` is only a key.
 */
function ownFields(value: object): Map<string, unknown> | undefined {
  try {
    const fields = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      fields.set(key, descriptor.value);
    }
    return fields;
  } catch {
    return undefined;
  }
}

/** True for a title of a job: 1 to 80 characters, no control or format character, no space at either end. */
export const isTitle = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= MAX_TITLE_LENGTH && value === value.trim() && !hasUnsafeChar(value);

const SESSION_FIELDS = Object.freeze(['label', 'engine', 'harness', 'folder', 'model', 'task'] as const);

/**
 * Looks for a schedule and for an unattended flag in the definition and in every session, before any other field is checked, so the person is told the true cause and an earlier invalid field never hides it.
 * A schedule anywhere is named before an unattended flag anywhere. A session that is not a record, or that cannot be read, holds no flag the scan can see, and the full check refuses it later.
 */
function interactiveRefusal(top: ReadonlyMap<string, unknown>): DefinitionRefusal | undefined {
  const found = new Set<NotInteractiveReason>();
  if (top.has('schedule')) found.add('schedule');
  if (top.has('unattended')) found.add('unattended');
  const items = readList(top.get('sessions'), MAX_JOB_SESSIONS);
  for (const item of items ?? []) {
    if (!isPlainRecord(item)) continue;
    const fields = ownFields(item);
    if (fields === undefined) continue;
    if (fields.has('schedule')) found.add('schedule');
    if (fields.has('unattended')) found.add('unattended');
  }
  return found.has('schedule') ? notInteractive('schedule') : found.has('unattended') ? notInteractive('unattended') : undefined;
}

/** What a check of the task gives: the text, or the reason. */
type TaskResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: Extract<JobReason, 'task' | 'secret'> };

function checkTask(value: unknown): TaskResult {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TASK_LENGTH) return { ok: false, reason: 'task' };
  if (TASK_UNSAFE.test(value.replace(/[\n\t]/g, ''))) return { ok: false, reason: 'task' };
  return looksLikeSecret(value) ? { ok: false, reason: 'secret' } : { ok: true, value };
}

/** Checks the text of a task: `undefined` when it is good, `task` when it is the wrong shape, and `secret` when it looks like a secret. The Core API client uses it to read a plan. */
export function checkTaskText(value: unknown): Extract<JobReason, 'task' | 'secret'> | undefined {
  const checked = checkTask(value);
  return checked.ok ? undefined : checked.reason;
}

function checkSession(value: unknown): { readonly ok: true; readonly value: JobSession } | DefinitionRefusal {
  if (!isPlainRecord(value)) return invalid('request');
  const fields = ownFields(value);
  if (fields === undefined) return invalid('request');
  if ([...fields.keys()].some(key => !(SESSION_FIELDS as readonly string[]).includes(key))) return invalid('request');
  const label = fields.get('label'), engine = fields.get('engine'), harness = fields.get('harness'), folder = fields.get('folder'), model = fields.get('model'), task = fields.get('task');
  // A field is checked for its shape first, and then for a secret, so a field that is wrong is refused for that, and a secret is only looked for in a field that is otherwise good.
  if (!isLabel(label)) return invalid('label');
  if (looksLikeSecret(label)) return invalid('secret');
  if (typeof engine !== 'string' || !checkEngineId(engine).ok) return invalid('engine');
  if (typeof harness !== 'string' || !checkEngineId(harness).ok) return invalid('harness');
  if (typeof folder !== 'string' || !checkFolder(folder).ok) return invalid('folder');
  if (looksLikeSecret(folder)) return invalid('secret');
  // A model choice is written out: `null` for the engine's own default, or a provider and a model. A field that is left out is not a choice.
  const checkedModel = model === undefined ? undefined : checkModel(model);
  if (checkedModel === undefined || !checkedModel.ok) return invalid('model');
  if (checkedModel.value !== null && (looksLikeSecret(checkedModel.value.provider) || looksLikeSecret(checkedModel.value.model))) return invalid('secret');
  const checkedTask = checkTask(task);
  if (!checkedTask.ok) return invalid(checkedTask.reason);
  return { ok: true, value: Object.freeze({ label, engine, harness, folder, model: checkedModel.value, task: checkedTask.value }) };
}

/**
 * Checks a job definition. A schedule or an unattended flag, in the definition or in any session, is refused first, as `GAUGE_JOB_NOT_INTERACTIVE`, whatever else is wrong. Every other refusal is `GAUGE_JOB_INVALID` with the field that is wrong. The sessions are a plain
 * list of 1 to 8, each with exactly the six fields, and no two share a label. The value that comes out is new and frozen.
 */
export function checkDefinition(value: unknown): { readonly ok: true; readonly value: JobDefinition } | DefinitionRefusal {
  if (!isPlainRecord(value)) return invalid('request');
  const fields = ownFields(value);
  if (fields === undefined) return invalid('request');
  const refused = interactiveRefusal(fields);
  if (refused) return refused;
  if ([...fields.keys()].some(key => key !== 'title' && key !== 'sessions')) return invalid('request');
  const title = fields.get('title');
  if (!isTitle(title)) return invalid('title');
  if (looksLikeSecret(title)) return invalid('secret');
  const items = readList(fields.get('sessions'), MAX_JOB_SESSIONS);
  if (items === undefined || items.length === 0) return invalid('sessions');
  const sessions: JobSession[] = [];
  for (const item of items) {
    const checked = checkSession(item);
    if (!checked.ok) return checked;
    if (sessions.some(earlier => earlier.label === checked.value.label)) return invalid('label');
    sessions.push(checked.value);
  }
  return { ok: true, value: Object.freeze({ title, sessions: Object.freeze(sessions) }) };
}

/** The canonical text of a definition: compact JSON of its title and, for each session, its six fields in a fixed order. The same definition always gives the same text. */
export const canonicalDefinition = (definition: JobDefinition): string => JSON.stringify([
  definition.title,
  definition.sessions.map(session => [session.label, session.engine, session.harness, session.folder, session.model === null ? null : [session.model.provider, session.model.model], session.task]),
]);

/** The SHA-256 of the canonical text, in lower-case hex. A plan for a change to a job holds it, so an approval is for the job the person saw. */
export const hashDefinition = (definition: JobDefinition): string => createHash('sha256').update(canonicalDefinition(definition)).digest('hex');
