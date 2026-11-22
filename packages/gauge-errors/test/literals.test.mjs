// The code literal scanner that builds the old-literal fixture. It is pure text work, so these tests need no git history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeLiterals, isScannedPath, CODE_SHAPE } from '../tools/existing-literals.mjs';

const found = text => [...extractCodeLiterals(text)].sort();

test('a quoted string that is wholly a code is a literal, in any quote style', () => {
  assert.deepEqual(found(`const a = 'BUNDLE_USAGE'; const b = "FAILED"; const c = \`NOT_ALLOWED\`;`), ['BUNDLE_USAGE', 'FAILED', 'NOT_ALLOWED']);
});

test('an object key in code shape is a literal, quoted or not', () => {
  assert.deepEqual(found(`const t = { BUNDLE_FORMAT: 'x', 'ENOSPC': 'y', "TOO_MANY": 'z', OPTIONAL_ONE?: 1 };`), ['BUNDLE_FORMAT', 'ENOSPC', 'OPTIONAL_ONE', 'TOO_MANY']);
});

test('a code in a union type or a case label is a literal', () => {
  assert.deepEqual(found(`type C = 'ONE_CODE' | 'TWO_CODE'; switch (x) { case 'THREE_CODE': break; }`), ['ONE_CODE', 'THREE_CODE', 'TWO_CODE']);
});

test('a string that holds more than a code is not a literal', () => {
  assert.deepEqual(found(`'Bad CODE here'; 'lowercase'; 'MIXED_case'; 'TRAILING_'; '_LEADING'; 'DOUBLE__GAP'; 'WITH SPACE'; ''`), []);
});

test('a single letter is not a literal', () => {
  assert.deepEqual(found(`const a = 'X'; const b = { N: 1 };`), []);
});

test('a constant name used as a value or declared is not a literal', () => {
  assert.deepEqual(found(`export const PATH_SHOWN_CHARS = 120; const n = PATH_SHOWN_CHARS + OTHER_LIMIT; call(BUNDLE_CODES);`), []);
});

test('a member access or a type path before a colon is not a key', () => {
  assert.deepEqual(found(`const a = obj.FIELD_NAME ? x : y; label: Foo::BAR_BAZ;`), []);
});

test('digits are allowed after the first letter of a word', () => {
  assert.deepEqual(found(`'V2_FORMAT'; 'ERR_HTTP2_BAD'`), ['ERR_HTTP2_BAD', 'V2_FORMAT']);
});

test('the same literal found twice is listed once', () => {
  assert.deepEqual(found(`'DUP_CODE'; { DUP_CODE: 1 }`), ['DUP_CODE']);
});

test('the code shape matches whole words in capitals and underscores only', () => {
  for (const ok of ['AB', 'A_B', 'UNKNOWN_GAUGE', 'V2_X']) assert.match(ok, CODE_SHAPE, ok);
  for (const bad of ['', 'A', 'a_b', 'A_', '_A', 'A__B', 'A-B', 'A B', '2A']) assert.doesNotMatch(bad, CODE_SHAPE, JSON.stringify(bad));
});

test('only source files outside build and dependency folders are scanned', () => {
  for (const path of ['packages/a/src/x.ts', 'apps/desktop/renderer/y.tsx', 'tools/z.mjs', 'a/b.js', 'c.cjs', 'd.mts', 'e.cts', 'f.jsx']) assert.equal(isScannedPath(path), true, path);
  for (const path of ['README.md', 'package-lock.json', 'dist/a.js', 'node_modules/x/y.js', 'apps/desktop/node_modules/x.js', 'a/.git/b.js', 'logo.svg']) assert.equal(isScannedPath(path), false, path);
});
