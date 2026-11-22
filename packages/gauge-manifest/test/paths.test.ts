import test from 'node:test';
import assert from 'node:assert/strict';
import { unsafeNameReason, unsafePathReason } from '../src/paths.js';

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
