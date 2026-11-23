// The shared text helpers: what counts as unsafe, and one escape that plan lines and log lines both use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, hasPlanUnsafeChar, hasUnsafeChar } from '../src/text.js';

test('the narrow class is control, format, line separator, and paragraph separator characters', () => {
  for (const text of ['a\nb', 'a\rb', 'a\u0000b', 'a\u0085b', 'a\u202eb', 'a\u200bb', 'a\u2028b', 'a\u2029b', '\u061c', '\ufeff']) assert.equal(hasUnsafeChar(text), true, JSON.stringify(text));
  for (const text of ['', 'plain', 'with space', 'café', 'cafe\u0301', '\u00a0', '\u3164', '\u{1F680}', '/work/a b']) assert.equal(hasUnsafeChar(text), false, JSON.stringify(text));
});

test('the wide class adds the look-alike spaces, blank letters, and combining marks, and never the plain space', () => {
  for (const text of ['\u00a0', '\u1680', '\u2000', '\u200a', '\u202f', '\u205f', '\u3000', '\u3164', '\u2800', '\u115f', '\u1160', '\uffa0', 'e\u0301', '\u0300', '\u20e3']) {
    assert.equal(hasPlanUnsafeChar(text), true, JSON.stringify(text));
  }
  for (const text of ['', 'plain', 'a b', 'café', '\u{1F680}', '/work/a-b_c.d', '中文']) assert.equal(hasPlanUnsafeChar(text), false, JSON.stringify(text));
  assert.equal(hasPlanUnsafeChar('\n'), true, 'the wide class holds the narrow one');
});

test('escapeText turns each unsafe character into a visible escape and leaves everything else as it is', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['a\nb', 'a\\u{a}b'], ['a\r\nb', 'a\\u{d}\\u{a}b'], ['a\\b', 'a\\\\b'], ['a\u2028b', 'a\\u{2028}b'], ['a\u2029b', 'a\\u{2029}b'], ['\u202e', '\\u{202e}'], ['\u200b', '\\u{200b}'],
    ['\u0000', '\\u{0}'], ['\u00a0', '\\u{a0}'], ['\u3000', '\\u{3000}'], ['\u3164', '\\u{3164}'], ['\u2800', '\\u{2800}'], ['\u115f\u1160', '\\u{115f}\\u{1160}'], ['\uffa0', '\\u{ffa0}'],
    ['e\u0301', 'e\\u{301}'], ['a b', 'a b'], ['café \u{1F680}', 'café \u{1F680}'], ['', ''], ['plain/path-1.0', 'plain/path-1.0'],
  ];
  for (const [value, expected] of cases) assert.equal(escapeText(value), expected, JSON.stringify(value));
});

test('an escaped text holds no unsafe character, and escaping twice escapes the backslash that the first escape made', () => {
  const hostile = 'x\n\u2028\u202e\u00a0\u3164e\u0301\\';
  const once = escapeText(hostile);
  assert.equal(hasPlanUnsafeChar(once), false);
  assert.equal(escapeText(once), once.replace(/\\/g, '\\\\'));
});
