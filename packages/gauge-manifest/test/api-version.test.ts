import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_API_VERSION, parseRange, parseVersion, rangeIncludes } from '../src/api-version.js';

test('the Core API has a semantic version', () => {
  assert.ok(parseVersion(CORE_API_VERSION));
});

test('a version has three numbers with no leading zero and nothing else', () => {
  assert.deepEqual(parseVersion('1.20.3'), [1, 20, 3]);
  for (const text of ['1.0', '01.0.0', '1.0.0-beta', 'v1.0.0', '1.0.0.0', '', '1.0.x', ' 1.0.0', '1.0.1000000000']) assert.equal(parseVersion(text), undefined, text);
});

test('a range has one or two comparators joined by one space', () => {
  for (const text of ['>=1.0.0 <2.0.0', '=1.0.0', '>1.0.0', '<=3.1.4', '>=1.0.0']) assert.ok(parseRange(text), text);
  for (const text of ['', '^1.0.0', '>=1.0', '>=1.0.0  <2.0.0', '>=1.0.0 <2.0.0 <3.0.0', 'latest', '>= 1.0.0', '1.0.0', '>=1.0.0 ']) assert.equal(parseRange(text), undefined, text);
});

test('a range includes the versions between its comparators', () => {
  const range = parseRange('>=1.0.0 <2.0.0');
  assert.ok(range);
  assert.equal(rangeIncludes(range, [1, 0, 0]), true);
  assert.equal(rangeIncludes(range, [1, 9, 9]), true);
  assert.equal(rangeIncludes(range, [2, 0, 0]), false);
  assert.equal(rangeIncludes(range, [0, 9, 9]), false);
});

test('each comparator operator works at its edge', () => {
  const has = (text: string, version: [number, number, number]) => rangeIncludes(parseRange(text)!, version);
  assert.equal(has('>1.0.0', [1, 0, 0]), false);
  assert.equal(has('>1.0.0', [1, 0, 1]), true);
  assert.equal(has('<=1.0.0', [1, 0, 0]), true);
  assert.equal(has('<=1.0.0', [1, 0, 1]), false);
  assert.equal(has('=1.0.0', [1, 0, 0]), true);
  assert.equal(has('=1.0.0', [1, 0, 1]), false);
  assert.equal(has('>=1.2.0', [1, 10, 0]), true);
});
