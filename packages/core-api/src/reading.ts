import { MAX_NAME_LENGTH, checkEngineId, readList } from '../../engine-sessions/src/request.js';

/** The small readers that the client uses for every reply. They read own data properties, once, and never run code of the value. */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads one own data property, once, and never runs a getter: an accessor reads as missing. */
export function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** A hash, a digest, or a nonce: exactly 64 lower-case hexadecimal characters. */
export const HEX_64 = /^[0-9a-f]{64}$/;

export const isText = (value: unknown): value is string => typeof value === 'string';

/** Reads a list of text once, by index, from own data properties, with no hole, no accessor, no subclass, and no iterator (see `readList`). Gives a new list. */
export const denseTexts = (value: unknown, max?: number): string[] | undefined => { const items = readList(value, max); return items !== undefined && items.every(isText) ? items : undefined; };

/** True when the list is in strict order, so sorted with no repeat. Names compare by code unit, and permission names are plain ASCII. */
export const isStrictlyIncreasing = (list: readonly string[]): boolean => list.every((item, index) => index === 0 || (list[index - 1] ?? '') < item);

const MAX_COPY_DEPTH = 5;

/**
 * A copy of a value to send: a record is copied from its own enumerable data properties (`Object.keys`), each read once through its descriptor, so an accessor, a hidden property, and an inherited
 * property are not sent and are not read. A list is copied by index (see `readList`, at most 4,096 items). A key such as `__proto__` stays an own data property of the copy. Anything else is sent as it is.
 * A list that cannot be read, or a value nested deeper than 5 levels (a loop is one), is a bug of the caller and throws a `TypeError`: nothing is sent.
 */
export function plainCopy(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_COPY_DEPTH) throw new TypeError('a value to send is nested too deep');
  if (Array.isArray(value)) {
    const items = readList(value);
    if (items === undefined) throw new TypeError('a list to send is a plain list of at most 4096 items');
    return items.map(item => plainCopy(item, depth + 1));
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    Object.defineProperty(copy, key, { value: plainCopy(descriptor.value as unknown, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/** A list of names that is dense, has no repeat, and is in strict order, each one valid. Gives a new list, or `undefined`. */
export function orderedNames(value: unknown, valid: (name: string) => boolean): string[] | undefined {
  const names = denseTexts(value);
  return names !== undefined && names.every(valid) && isStrictlyIncreasing(names) ? names : undefined;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An engine id: the shape that the Engine Host gives. */
export const isEngineName = (name: string): boolean => checkEngineId(name).ok;
/** The name of an environment variable that a plan lists. */
export const isVariableName = (name: string): boolean => name.length <= MAX_NAME_LENGTH && VARIABLE_NAME.test(name);
/** The longest program path that a plan may show. */
export const MAX_PROGRAM_LENGTH = 4096;
