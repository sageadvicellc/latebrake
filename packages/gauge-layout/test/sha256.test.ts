import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/index.js';

test('sha256Hex gives the known digests of the standard test texts', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256Hex agrees with the platform on texts of every length around the block size, and on multi-byte text', () => {
  const texts = [...Array.from({ length: 130 }, (_, length) => 'a'.repeat(length)), 'é中\u{1F4A5}', 'x'.repeat(10_000), '{"a":1}\n'];
  for (const text of texts) assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), text.slice(0, 20));
});
