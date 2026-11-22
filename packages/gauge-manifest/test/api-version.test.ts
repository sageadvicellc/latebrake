import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_API_VERSION, compareVersions, parseRange, parseVersion, rangeIncludes, rangeIsSatisfiable } from '../src/api-version.js';

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

test('versions compare by major, then minor, then patch', () => {
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 4]), -1);
  assert.equal(compareVersions([1, 10, 0], [1, 9, 9]), 1);
  assert.equal(compareVersions([2, 0, 0], [1, 99, 99]), 1);
  assert.equal(compareVersions([0, 9, 9], [1, 0, 0]), -1);
});

test('a range that nothing can satisfy is found, and a range that something can satisfy is not', () => {
  const satisfiable = (text: string) => rangeIsSatisfiable(parseRange(text)!);
  for (const text of ['>=2.0.0 <1.0.0', '>=1.0.0 <1.0.0', '>1.0.0 <=1.0.0', '>1.0.0 <1.0.1', '=1.0.0 >1.0.0', '<0.0.0', '=1.0.0 =1.0.1', '>2.0.0 =2.0.0']) assert.equal(satisfiable(text), false, text);
  for (const text of ['>=1.0.0 <2.0.0', '>=1.0.0', '<0.0.1', '<=0.0.0', '=1.0.0', '>1.0.0 <1.0.2', '>=1.0.0 <=1.0.0', '>999999999.0.0', '<1.0.0']) assert.equal(satisfiable(text), true, text);
});
