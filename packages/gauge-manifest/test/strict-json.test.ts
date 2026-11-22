import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NUMBER_TEXT, parseStrictJson } from '../src/strict-json.js';

const reason = (text: string) => {
  const result = parseStrictJson(text);
  assert.equal(result.ok, false, text);
  return result.ok ? undefined : result.reason;
};

test('strict JSON gives back objects, lists, strings, numbers, and literals', () => {
  const result = parseStrictJson(' {"a": [1, -2.5e3, "x\\n\\u0041", true, false, null], "b": {}} \n');
  assert.ok(result.ok);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { a: [1, -2500, 'x\nA', true, false, null], b: {} });
});

test('strict JSON refuses a duplicate key, also in a nested object and also when an escape spells the same key', () => {
  assert.equal(reason('{"a":1,"a":2}'), 'duplicate_key');
  assert.equal(reason('{"o":{"k":1,"k":1}}'), 'duplicate_key');
  assert.equal(reason('{"a":1,"\\u0061":2}'), 'duplicate_key');
});

test('strict JSON refuses a line comment and a block comment', () => {
  assert.equal(reason('{"a":1} // note'), 'comment');
  assert.equal(reason('{/* note */"a":1}'), 'comment');
  assert.equal(reason('// note\n{"a":1}'), 'comment');
});

test('strict JSON refuses a trailing comma in an object and in a list', () => {
  assert.equal(reason('{"a":1,}'), 'trailing_comma');
  assert.equal(reason('{"a":[1,2,]}'), 'trailing_comma');
  assert.equal(reason('{"a":[1,\n ]}'), 'trailing_comma');
});

test('strict JSON refuses every other break of the format as a syntax problem', () => {
  for (const text of ['', ' ', "{'a':1}", '{a:1}', '{"a":01}', '{"a":NaN}', '{"a":1} x', '{"a":"x', '{"a":"\u0001"}', '{"a" 1}', '{"a":1', '[1 2]', '{"a":+1}', '{"a":.5}', '﻿{}', '{"a":"\\x"}', '{"a":"\\u12"}']) {
    assert.equal(reason(text), 'syntax', JSON.stringify(text));
  }
});

test('strict JSON refuses a document nested deeper than the limit and does not overflow the stack', () => {
  assert.equal(reason('['.repeat(10_000) + ']'.repeat(10_000)), 'syntax');
  assert.ok(parseStrictJson('['.repeat(16) + ']'.repeat(16)).ok);
});

test('a key named __proto__ is an own key and never changes a prototype', () => {
  const result = parseStrictJson('{"__proto__":{"polluted":true}}');
  assert.ok(result.ok);
  assert.equal(Object.hasOwn(result.value as object, '__proto__'), true);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('strict JSON lists every string it read, keys and values, with escapes decoded', () => {
  const result = parseStrictJson('{"k":["v\\u0041",{"inner":"x"}]}');
  assert.ok(result.ok);
  assert.deepEqual([...result.strings].sort(), ['inner', 'k', 'vA', 'x']);
});

test('a number that is too large for a finite number is refused', () => {
  for (const text of ['1e999', '-1e999', '{"a":1e999}', '[1e400]']) assert.equal(reason(text), 'syntax', text);
  assert.ok(parseStrictJson('1e308').ok);
});

test('a number of more characters than the limit is refused, and one at the limit is read', () => {
  assert.equal(MAX_NUMBER_TEXT, 400);
  assert.equal(reason(`[1${'0'.repeat(MAX_NUMBER_TEXT)}]`), 'syntax');
  assert.ok(parseStrictJson(`[0.${'0'.repeat(MAX_NUMBER_TEXT - 3)}1]`).ok);
});

test('only a double slash or a slash and a star is a comment, and any other slash is a syntax problem', () => {
  for (const text of ['{"a":1}/', '{"a":1} /x', '/', '{/}', '{"a":/1}', '[1,/]']) assert.equal(reason(text), 'syntax', text);
  for (const text of ['{"a":1}//', '{"a":1}/*', '//', '/*']) assert.equal(reason(text), 'comment', text);
});

test('a lone surrogate, written as an escape, is refused in a value and in a key, and a pair is read', () => {
  for (const text of ['{"a":"\\ud800"}', '{"\\udc00":1}', '"\\ud800x"', '"x\\udc00"', '"\\udc00\\ud800"']) assert.equal(reason(text), 'syntax', text);
  const pair = parseStrictJson('"\\ud83d\\ude00"');
  assert.ok(pair.ok);
  assert.equal(pair.value, '\u{1F600}');
});

test('nesting of 16 passes and nesting of 17 is refused, for lists and for objects', () => {
  const lists = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
  const objects = (depth: number) => '{"a":'.repeat(depth - 1) + '{}' + '}'.repeat(depth - 1);
  assert.ok(parseStrictJson(lists(16)).ok);
  assert.equal(reason(lists(17)), 'syntax');
  assert.ok(parseStrictJson(objects(16)).ok);
  assert.equal(reason(objects(17)), 'syntax');
});

test('keys named like Object members are own keys', () => {
  const result = parseStrictJson('{"constructor":1,"toString":2,"hasOwnProperty":3}');
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.value as object).sort(), ['constructor', 'hasOwnProperty', 'toString']);
});
