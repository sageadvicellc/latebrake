/** Why a text is not strict JSON. Anything that is not one of the three named reasons is `syntax`. */
export type JsonProblem = 'duplicate_key' | 'comment' | 'trailing_comma' | 'syntax';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonResult =
  | { readonly ok: true; readonly value: JsonValue; readonly strings: readonly string[] }
  | { readonly ok: false; readonly reason: JsonProblem };

const MAX_DEPTH = 16;
/** The most characters that one number may have. A longer number is refused as a syntax problem. */
export const MAX_NUMBER_TEXT = 400;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

class Refusal extends Error {
  constructor(readonly reason: JsonProblem) { super(reason); }
}

/**
 * Reads strict JSON (RFC 8259) and refuses what the standard parser lets through: a duplicate key (also when an escape spells the same key), a
 * comment, a trailing comma, a byte order mark, and a nesting deeper than 16. It never uses `JSON.parse`. Objects have no prototype, so a key such as
 * `__proto__` is an ordinary own key. It also lists every string it read, keys and values, with escapes decoded, for the secret scan.
 */
export function parseStrictJson(text: string): JsonResult {
  let at = 0;
  const strings: string[] = [];
  const fail = (reason: JsonProblem = 'syntax'): never => { throw new Refusal(reason); };
  const skip = (): void => {
    while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r')) at += 1;
    if (text[at] === '/' && (text[at + 1] === '/' || text[at + 1] === '*')) fail('comment');
  };
  const readString = (): string => {
    at += 1;
    let out = '';
    for (;;) {
      if (at >= text.length) return fail();
      const char = text[at]!;
      if (char === '"') {
        at += 1;
        // A lone surrogate, written as an escape, is not text, so it is refused in a key and in a value.
        if (LONE_SURROGATE.test(out)) return fail();
        strings.push(out);
        return out;
      }
      if (char < ' ') return fail();
      if (char !== '\\') { out += char; at += 1; continue; }
      const escape = text[at + 1];
      if (escape === 'u') {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail();
        out += String.fromCharCode(parseInt(hex, 16));
        at += 6;
        continue;
      }
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape === undefined || !Object.hasOwn(simple, escape)) return fail();
      out += simple[escape]!;
      at += 2;
    }
  };
  const readValue = (depth: number): JsonValue => {
    skip();
    const char = text[at];
    if (char === undefined) return fail();
    if (char === '"') return readString();
    if (char === '{') {
      if (depth >= MAX_DEPTH) return fail();
      at += 1;
      const object = Object.create(null) as { [key: string]: JsonValue };
      skip();
      if (text[at] === '}') { at += 1; return object; }
      for (;;) {
        skip();
        if (text[at] !== '"') return fail();
        const key = readString();
        if (Object.hasOwn(object, key)) return fail('duplicate_key');
        skip();
        if (text[at] !== ':') return fail();
        at += 1;
        Object.defineProperty(object, key, { value: readValue(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ',') {
          at += 1;
          skip();
          if (text[at] === '}') return fail('trailing_comma');
          continue;
        }
        if (text[at] === '}') { at += 1; return object; }
        return fail();
      }
    }
    if (char === '[') {
      if (depth >= MAX_DEPTH) return fail();
      at += 1;
      const list: JsonValue[] = [];
      skip();
      if (text[at] === ']') { at += 1; return list; }
      for (;;) {
        list.push(readValue(depth + 1));
        skip();
        if (text[at] === ',') {
          at += 1;
          skip();
          if (text[at] === ']') return fail('trailing_comma');
          continue;
        }
        if (text[at] === ']') { at += 1; return list; }
        return fail();
      }
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return value; }
    }
    const number = NUMBER.exec(text.slice(at, at + MAX_NUMBER_TEXT));
    if (!number) return fail();
    at += number[0].length;
    const value = Number(number[0]);
    return Number.isFinite(value) ? value : fail();
  };
  try {
    const value = readValue(0);
    skip();
    if (at < text.length) return { ok: false, reason: 'syntax' };
    return { ok: true, value, strings };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}
