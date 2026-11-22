// The Gauge error registry: one list of stable refusal codes, a check for equal codes, and a guard against codes that already exist in the product.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GAUGE_CODES, GAUGE_ERRORS, GAUGE_MEANINGS, codeNameProblems, collidingCodes, duplicateCodes, isGaugeCode,
} from '../../../dist/packages/gauge-errors/src/index.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/existing-code-literals.json', import.meta.url), 'utf8'));
const existing = new Set(fixture.literals);

// The stable codes. A removed or renamed code fails here on purpose: a code is a promise to Gauge authors.
const STABLE = [
  'GAUGE_MANIFEST_INVALID', 'GAUGE_MANIFEST_TOO_LARGE', 'GAUGE_PATH_UNSAFE', 'GAUGE_SECRET_FOUND', 'GAUGE_API_UNSUPPORTED',
  'UNKNOWN_GAUGE', 'GAUGE_EXISTS', 'GAUGE_PROTECTED', 'GAUGE_REMOVE_INCOMPLETE', 'GAUGE_NAME_RESERVED',
  'GAUGE_GRANT_MISSING', 'GAUGE_GRANT_STALE',
  'GAUGE_LAYOUT_INVALID',
  'GAUGE_PLAN_NOT_APPROVED', 'GAUGE_PLAN_CHANGED',
];

test('the registry lists the stable codes, each once, in a fixed order', () => {
  assert.deepEqual([...GAUGE_CODES], STABLE);
});

test('the registry is frozen, so no caller can add or change a code', () => {
  assert.equal(Object.isFrozen(GAUGE_ERRORS), true);
  assert.equal(Object.isFrozen(GAUGE_CODES), true);
  assert.equal(Object.isFrozen(GAUGE_MEANINGS), true);
  for (const entry of GAUGE_ERRORS) assert.equal(Object.isFrozen(entry), true, entry.code);
});

test('every code has a one-line meaning that ends in a full stop', () => {
  for (const { code, meaning } of GAUGE_ERRORS) {
    assert.equal(GAUGE_MEANINGS[code], meaning, code);
    assert.match(meaning, /^[^\n\r]+\.$/, code);
    assert.ok(meaning.length <= 140, `${code} meaning is ${meaning.length} characters`);
  }
});

test('no two codes in the registry are equal', () => {
  assert.deepEqual(duplicateCodes(GAUGE_ERRORS.map(entry => entry.code)), []);
});

test('the duplicate check names each repeated code once', () => {
  assert.deepEqual(duplicateCodes(['A_B', 'C_D', 'A_B', 'A_B', 'E_F', 'C_D']), ['A_B', 'C_D']);
  assert.deepEqual(duplicateCodes([]), []);
});

test('codes that differ only in case still count as different codes, so naming rules refuse the lower-case one', () => {
  assert.deepEqual(duplicateCodes(['GAUGE_A', 'gauge_a']), []);
  assert.notDeepEqual(codeNameProblems('gauge_a'), []);
});

test('no code in the registry equals a code literal that exists in the product today', () => {
  assert.deepEqual(collidingCodes(GAUGE_CODES, existing), []);
});

test('the collision guard reports an old literal that a new code reuses', () => {
  const [first] = fixture.literals;
  assert.deepEqual(collidingCodes(['GAUGE_NEW_ONE', first, 'BUNDLE_USAGE'], existing), [first, 'BUNDLE_USAGE'].sort());
  assert.deepEqual(collidingCodes([], existing), []);
});

test('the fixture stays pinned to the baseline commit, on purpose: a new code is checked against what existed then, and never against a newer commit', () => {
  assert.equal(fixture.commit, '107445d66c71b09ac7972e44f9d3d67c09ff44a9');
});

test('the fixture holds no secret-shaped token', () => {
  for (const literal of fixture.literals) {
    assert.doesNotMatch(literal, /^(?:AKIA|ASIA)[A-Z0-9]{16}$/, literal);
    assert.doesNotMatch(literal, /^[0-9A-F]{16,}$/, literal);
  }
});

test('the fixture is a real list from a pinned commit', () => {
  assert.match(fixture.commit, /^[0-9a-f]{40}$/);
  assert.ok(fixture.literals.length > 100, `${fixture.literals.length} literals`);
  assert.deepEqual(fixture.literals, [...new Set(fixture.literals)].sort());
  for (const literal of ['BUNDLE_USAGE', 'FAILED', 'NOT_ALLOWED', 'ENOSPC']) assert.ok(existing.has(literal), literal);
  assert.equal(typeof fixture.rule, 'string');
});

test('every code follows the naming rules', () => {
  for (const code of GAUGE_CODES) assert.deepEqual(codeNameProblems(code), [], code);
});

test('the naming rules refuse a code that breaks them, and say why', () => {
  const bad = {
    gauge_lower: 'single underscores join the words',
    'GAUGE-DASH': 'single underscores join the words',
    '_GAUGE_LEAD': 'single underscores join the words',
    GAUGE__GAP: 'single underscores join the words',
    GAUGE_2: 'starts with a capital',
    '2A_GAUGE': 'starts with a capital',
    GAUGE_EXTENSIONS: 'EXTENSION',
    GAUGE_NOEXTENSION: 'EXTENSION',
    GAUGE_MODULES: 'MODULE',
    GAUGE_SUBMODULE_X: 'MODULE',
    BAD_MANIFEST: 'the word GAUGE',
    GAUGES_ONLY: 'the word GAUGE',
    EXTENSION_EXISTS: 'EXTENSION',
    MODULE_NOT_FOUND: 'MODULE',
    GAUGE_ABSURDLY_LONG_CODE_NAME_THAT_NOBODY_CAN_READ_AT_A_GLANCE: 'at most 40',
  };
  for (const [code, words] of Object.entries(bad)) {
    const problems = codeNameProblems(code);
    assert.ok(problems.length > 0, code);
    assert.ok(problems.some(problem => problem.includes(words)), `${code}: ${problems.join(' | ')}`);
  }
  for (const value of [undefined, null, 7, {}, []]) assert.notDeepEqual(codeNameProblems(value), [], String(value));
});

test('the word GAUGE may lead, follow, or sit in the middle of a code', () => {
  for (const code of ['GAUGE_EXISTS', 'UNKNOWN_GAUGE', 'BAD_GAUGE_PLAN']) assert.deepEqual(codeNameProblems(code), [], code);
});

test('each new code has its own meaning, and the two removal and name codes are in the registry', () => {
  assert.match(GAUGE_MEANINGS.GAUGE_REMOVE_INCOMPLETE, /remov/i);
  assert.match(GAUGE_MEANINGS.GAUGE_NAME_RESERVED, /reserved/i);
});

test('isGaugeCode accepts a registry code and refuses everything else', () => {
  for (const code of GAUGE_CODES) assert.equal(isGaugeCode(code), true, code);
  for (const value of ['UNKNOWN', 'gauge_exists', '', 'toString', '__proto__', 'constructor', undefined, null, 5, {}]) assert.equal(isGaugeCode(value), false, String(value));
});
