import { hasUnsafeChar } from './text.js';

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
/** The plain charset of a provider and a model: letters, digits, and `. _ : / @ + -`. Nothing that a shell, a flag, or a path means. */
const CHOICE_CHARS = /^[A-Za-z0-9._:/@+-]+$/;
/** The names that make a program load code of the caller's choice, or run a start-up script, or trust another set of certificates, or find its tools elsewhere. */
const LOADER_PREFIX = /^(?:LD_|DYLD_)/;
const LOADER_NAMES: ReadonlySet<string> = new Set(['NODE_OPTIONS']);
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'NODE_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PATH',
]);

/**
 * True when a variable may not be passed on the request of a caller. This is a denylist: it names the loader prefixes (`LD_`, `DYLD_`) and the names above, in any case. It cannot name every variable that
 * changes how a program starts, so it is a floor and not a guarantee. The person sees every name in the plan before it applies.
 */
export const isRefusedVariable = (name: string): boolean => LOADER_PREFIX.test(name.toUpperCase()) || REFUSED_NAMES.has(name.toUpperCase());
/** True for the names that no engine may declare either: the loader prefixes and `NODE_OPTIONS`. An engine may declare `PATH` and `HOME`, since an adapter is trusted code of the app. */
export const isLoaderVariable = (name: string): boolean => LOADER_PREFIX.test(name.toUpperCase()) || LOADER_NAMES.has(name.toUpperCase());

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
  if (typeof value !== 'string' || value.length > MAX_FOLDER_LENGTH || !value.startsWith('/') || value === '/' || hasUnsafeChar(value)) return refused('folder');
  const segments = value.slice(1).split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment !== segment.trim())) return refused('folder');
  return good(value);
}

/** Reads one own data property, once, without running a getter. A property that is only inherited, or an accessor, reads as missing. */
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** A provider or a model: 1 to 128 characters of the plain charset, never starting with a dash (a flag) or an equals sign. */
const choiceText = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_CHOICE_LENGTH && CHOICE_CHARS.test(value) && !value.startsWith('-') && !value.startsWith('=');

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

/** The longest list that `readList` reads when no cap is given. */
export const MAX_LIST_LENGTH = 4096;

/**
 * Reads a list once, by index, from own data properties, and gives a new list, or `undefined`. It never uses the iterator of the list, so an iterator that lies is not followed. A subclass of Array, a hole,
 * an accessor index, a length over `max`, and a list whose reading throws are all refused. The length is checked before any item is read.
 */
export function readList(value: unknown, max: number = MAX_LIST_LENGTH): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > max) return undefined;
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return undefined;
  }
}

/**
 * The variables a person allows: none, or a list of at most 32 plain names with no repeat and no refused name. The core sorts them. With `denylist: false` the refused names pass, for the host, which lets an engine
 * keep the names that it declares itself (a plan lists them, and a plan that is planned again must be accepted) and refuses the others.
 */
export function checkVariables(value: unknown, options: { readonly denylist?: boolean } = {}): Checked<readonly string[]> {
  if (value === undefined) return good(Object.freeze([]));
  const names = readList(value, MAX_VARIABLES);
  if (names === undefined) return refused('variables');
  const denylist = options.denylist !== false;
  const plain = (name: unknown): name is string => typeof name === 'string' && name.length <= MAX_VARIABLE_LENGTH && VARIABLE.test(name) && !(denylist && isRefusedVariable(name));
  if (!names.every(plain) || new Set(names).size !== names.length) return refused('variables');
  return good(Object.freeze(names.sort()));
}
