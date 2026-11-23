/**
 * Reads a record that crossed a seam. A plain record is an ordinary object or one with no prototype. Its keys are read once, as own data properties: a symbol key, an accessor, a class instance, a list, and a proxy whose
 * trap throws are all refused. Every key is a string key, and `__proto__` is only a key. The one list reader is `readList` of `packages/engine-sessions`.
 */
export function plainRecord(value: unknown): Map<string, unknown> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
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

/** True when a record has exactly these keys, and no other. */
export const hasExactly = (fields: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean => fields.size === keys.length && keys.every(key => fields.has(key));
