import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson } from '../src/strict-json.js';

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
