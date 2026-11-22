import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnsafeFolderName, unsafeNameReason, unsafePathReason } from '../src/paths.js';

test('a plain name is safe', () => {
  for (const name of ['fixture-clock', 'tile', 'main.js', 'a.b.c', 'x']) assert.equal(unsafeNameReason(name), undefined, name);
});

test('a hidden name is refused, and so is a name made only of dots', () => {
  for (const name of ['.hidden', '.', '.git']) assert.equal(unsafeNameReason(name), 'hidden_name', name);
});

test('a name with two dots in a row is refused wherever the dots are', () => {
  for (const name of ['..', 'a..b', 'a..', 'x...y']) assert.equal(unsafeNameReason(name), 'dotdot_name', name);
});

test('a name that is a link is refused', () => {
  for (const name of ['https://example.test/x.js', 'file:x', 'data:text/plain,x', 'javascript:x', '//example.test/x.js', 'a:b']) assert.equal(unsafeNameReason(name), 'link', name);
});

test('a path is checked one segment at a time', () => {
  assert.equal(unsafePathReason('ui/tile/main.js'), undefined);
  assert.equal(unsafePathReason('ui/.secret/main.js'), 'hidden_name');
  assert.equal(unsafePathReason('ui/../main.js'), 'dotdot_name');
  assert.equal(unsafePathReason('./main.js'), 'hidden_name');
  assert.equal(unsafePathReason('/abs/main.js'), 'absolute_path');
  assert.equal(unsafePathReason('https://example.test/main.js'), 'link');
  assert.equal(unsafePathReason('ui//main.js'), 'invalid_path');
  assert.equal(unsafePathReason('ui\\main.js'), 'invalid_path');
  assert.equal(unsafePathReason(''), 'invalid_path');
  assert.equal(unsafePathReason('ui/main.js/'), 'invalid_path');
  assert.equal(unsafePathReason('ui/ma in.js'), 'invalid_path');
});

test('a Windows device name is refused, with or without an extension and in any case', () => {
  for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.js', 'NUL.tar.gz', 'aux.txt']) assert.equal(unsafeNameReason(name), 'device_name', name);
  for (const name of ['com0', 'com10', 'lpt0', 'console', 'icon', 'auxiliary', 'nullable', 'a.con', 'com']) assert.equal(unsafeNameReason(name), undefined, name);
  assert.equal(unsafePathReason('ui/CON/main.js'), 'device_name');
  assert.equal(unsafePathReason('ui/nul.js'), 'device_name');
});

test('a folder name with a control, format, or separator character, a slash, or a backslash is unsafe', () => {
  for (const name of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u200Bb', 'a\u202Eb', 'a\u0000b', 'a\u007Fb', 'a/b', '/abs/path', '/', 'a\\b', 'C:\\x', '\n']) assert.equal(isUnsafeFolderName(name), true, JSON.stringify(name));
  for (const name of ['tile-folder', 'a b', 'caf\u00e9', 'a.b', '\u65e5\u672c', '\u{1F600}', 'x_y']) assert.equal(isUnsafeFolderName(name), false, name);
});
