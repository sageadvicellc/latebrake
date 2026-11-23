/**
 * The checks on what a start or stop request holds. A value is checked here before a plan is built from it, and before any text of a plan prints it.
 * Every check reads own data properties only, once, and gives back a new frozen value. A refusal is a word of the closed set `REQUEST_REASONS`.
 */

/**
 * Why a request for a session was refused with `ENGINE_REQUEST_INVALID`, as a closed set. The code says what class of refusal it is, and the reason says which field.
 * A reason never holds a value that a caller sent.
 */
export const REQUEST_REASONS = Object.freeze(['engine', 'folder', 'model', 'variables', 'session'] as const);
export type RequestReason = (typeof REQUEST_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(REQUEST_REASONS);
/** True when the value is one of the request reasons. */
export const isRequestReason = (value: unknown): value is RequestReason => typeof value === 'string' && REASON_SET.has(value);

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: RequestReason };
const good = <T>(value: T): Checked<T> => ({ ok: true, value });
const refused = (reason: RequestReason): Checked<never> => ({ ok: false, reason });

/** One main-model choice: a provider and a model. */
export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SESSION_ID = /^[a-z0-9][a-z0-9-]*$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A control, format, line separator, or paragraph separator character. */
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** The loader names that make a program run code of the caller's choice: refused as variables to pass. */
const LOADER_NAME = /^(?:LD_|DYLD_)|^NODE_OPTIONS$/;

export const MAX_NAME_LENGTH = 64;
export const MAX_FOLDER_LENGTH = 1024;
export const MAX_CHOICE_LENGTH = 128;
export const MAX_VARIABLES = 32;
export const MAX_VARIABLE_LENGTH = 64;

/** An engine id: lower-case words joined by single hyphens, at most 64 characters. The same shape as a Gauge id. */
export function checkEngineId(value: unknown): Checked<string> {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && NAME.test(value) ? good(value) : refused('engine');
}

/** A session id: a short lower-case token. The core makes the ids, so any other shape is a malformed request. */
export function checkSessionId(value: unknown): Checked<string> {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && SESSION_ID.test(value) ? good(value) : refused('session');
}

/**
 * A folder: an absolute path that is already normal, with no control, format, or separator character, and not the root. A segment may hold a plain space, but not begin or end with white space.
 * It is at most 1,024 characters. The check is on the text only. Whether the folder exists, and which folder a link leads to, is the host's job.
 */
export function checkFolder(value: unknown): Checked<string> {
  if (typeof value !== 'string' || value.length > MAX_FOLDER_LENGTH || !value.startsWith('/') || value === '/' || UNSAFE_CHAR.test(value)) return refused('folder');
  const segments = value.slice(1).split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment !== segment.trim())) return refused('folder');
  return good(value);
}

/** Reads one own data property, once, without running a getter. A property that is only inherited, or an accessor, reads as missing. */
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

const choiceText = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_CHOICE_LENGTH && !UNSAFE_CHAR.test(value) && value === value.trim();

/** A model choice: `null` (the engine's own default), or exactly a provider and a model, each a short plain text. `undefined` reads as `null`. */
export function checkModel(value: unknown): Checked<ModelChoice | null> {
  if (value === null || value === undefined) return good(null);
  if (typeof value !== 'object' || Array.isArray(value)) return refused('model');
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('provider') || !keys.includes('model')) return refused('model');
    const provider = ownData(value, 'provider'), model = ownData(value, 'model');
    if (!choiceText(provider) || !choiceText(model)) return refused('model');
    return good(Object.freeze({ provider, model }));
  } catch {
    return refused('model');
  }
}

/** The variables a person allows: none, or a list of at most 32 plain names with no repeat and no loader name. The core sorts them. */
export function checkVariables(value: unknown): Checked<readonly string[]> {
  if (value === undefined) return good(Object.freeze([]));
  try {
    if (!Array.isArray(value) || value.length > MAX_VARIABLES) return refused('variables');
    // A hole in a list is not a name: Array.from reads it as undefined, where `every` would skip it.
    const names = Array.from(value as unknown[]);
    const plain = (name: unknown): name is string => typeof name === 'string' && name.length <= MAX_VARIABLE_LENGTH && VARIABLE.test(name) && !LOADER_NAME.test(name);
    if (!names.every(plain) || new Set(names).size !== names.length) return refused('variables');
    return good(Object.freeze(names.sort()));
  } catch {
    return refused('variables');
  }
}
