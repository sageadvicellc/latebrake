import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecret } from '../src/secrets.js';

// Every value here is synthetic and built from pieces, so no file holds a whole secret-shaped literal.
const synthetic = {
  accessKey: ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  sessionKey: ['ASIA', '0123456789ABCDEFGH'.slice(0, 16)].join(''),
  githubToken: ['gh', 'p_', 'a'.repeat(24)].join(''),
  apiKey: ['s', 'k-', 'b'.repeat(24)].join(''),
  chatToken: ['xo', 'xb-', '1234567890', '-abc'].join(''),
  jwt: ['ey', 'J', 'a'.repeat(12), '.', 'b'.repeat(12), '.', 'c'.repeat(12)].join(''),
  privateKey: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
  mixed: 'aB3'.repeat(11),
};

test('the secret scan flags each synthetic secret shape', () => {
  for (const [name, value] of Object.entries(synthetic)) assert.equal(looksLikeSecret(value), true, name);
});

test('the secret scan flags a secret inside a longer sentence', () => {
  assert.equal(looksLikeSecret(`use ${synthetic.githubToken} to sign in`), true);
});

test('the secret scan leaves ordinary manifest text alone', () => {
  for (const text of ['Fixture Clock', 'fixture-clock', 'ui/tile/main.js', '>=1.0.0 <2.0.0', 'engines.read', 'a'.repeat(80), 'aB3'.repeat(10), 'AKIA', ['AKIA', 'SHORT'].join(''), '0123456789abcdef'.repeat(4), '']) {
    assert.equal(looksLikeSecret(text), false, text.slice(0, 20));
  }
});

test('the mixed-token rule needs 32 characters and all three of lower case, upper case, and digits', () => {
  assert.equal(looksLikeSecret('aB3'.repeat(10) + 'ab'), true);
  assert.equal(looksLikeSecret('aB3'.repeat(10) + 'a'), false);
  assert.equal(looksLikeSecret('aB'.repeat(20)), false);
  assert.equal(looksLikeSecret('a3'.repeat(20)), false);
  assert.equal(looksLikeSecret('B3'.repeat(20)), false);
});
