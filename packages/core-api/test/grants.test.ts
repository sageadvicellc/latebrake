import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAudit, auditLine, grantState, type AuditEntry } from '../src/grants.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

test('a grant is current only when both the manifest hash and the folder hash are the installed ones', () => {
  assert.equal(grantState({ manifestHash: A, folderHash: B }, { manifestHash: A, folderHash: B }), 'current');
  assert.equal(grantState({ manifestHash: A, folderHash: B }, { manifestHash: C, folderHash: B }), 'stale');
  assert.equal(grantState({ manifestHash: A, folderHash: B }, { manifestHash: A, folderHash: C }), 'stale');
  assert.equal(grantState({ manifestHash: A, folderHash: B }, { manifestHash: C, folderHash: C }), 'stale');
});

test('a grant with no hashes is current only for a Gauge with no hashes', () => {
  assert.equal(grantState({ manifestHash: null, folderHash: null }, { manifestHash: null, folderHash: null }), 'current');
  assert.equal(grantState({ manifestHash: null, folderHash: null }, { manifestHash: A, folderHash: B }), 'stale');
  assert.equal(grantState({ manifestHash: A, folderHash: B }, { manifestHash: null, folderHash: null }), 'stale');
  assert.equal(grantState({ manifestHash: null, folderHash: B }, { manifestHash: null, folderHash: null }), 'stale');
  assert.equal(grantState({ manifestHash: A, folderHash: null }, { manifestHash: A, folderHash: B }), 'stale');
});

const ENTRY: AuditEntry = { seq: 7, at: '2026-01-02T03:04:05.006Z', action: 'grant', via: 'plan', id: 'fixture-solo', version: '1.0.0', permission: 'engines.read', manifestHash: A, folderHash: B };

test('an audit line is one JSON object with the fields in a fixed order, ended by one line feed', () => {
  assert.equal(auditLine(ENTRY), `{"seq":7,"at":"2026-01-02T03:04:05.006Z","action":"grant","via":"plan","id":"fixture-solo","version":"1.0.0","permission":"engines.read","manifestHash":"${A}","folderHash":"${B}"}\n`);
  assert.equal(auditLine({ ...ENTRY, version: null, manifestHash: null, folderHash: null }).includes('"version":null,"permission":"engines.read","manifestHash":null,"folderHash":null}'), true);
});

test('an audit line holds no raw line break inside it, whatever the values hold', () => {
  const line = auditLine({ ...ENTRY, id: 'a\nb c' });
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.equal(line.endsWith('\n'), true);
});

const bytes = (lines: readonly string[]) => lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);

test('appending keeps every line while the file fits the cap, with the cap itself allowed', () => {
  assert.deepEqual(appendAudit(['aaaa\n', 'bbbb\n'], 'cccc\n', 15), ['aaaa\n', 'bbbb\n', 'cccc\n']);
  assert.deepEqual(appendAudit([], 'cccc\n', 5), ['cccc\n']);
});

test('appending drops the oldest whole lines until the new line fits, one byte over the cap drops one', () => {
  assert.deepEqual(appendAudit(['aaaa\n', 'bbbb\n', 'cccc\n'], 'dddd\n', 15), ['bbbb\n', 'cccc\n', 'dddd\n']);
  assert.deepEqual(appendAudit(['aaaa\n', 'bbbb\n', 'cccc\n'], 'dddd\n', 14), ['cccc\n', 'dddd\n']);
  assert.deepEqual(appendAudit(['aa\n', 'bbbbbbbb\n'], 'cccccc\n', 8), ['cccccc\n']);
});

test('appending never changes the lines it was given', () => {
  const lines = ['aaaa\n', 'bbbb\n'];
  appendAudit(lines, 'cccc\n', 10);
  assert.deepEqual(lines, ['aaaa\n', 'bbbb\n']);
});

test('a line that is larger than the cap alone is a programming error, and nothing is dropped for it', () => {
  assert.throws(() => appendAudit(['aaaa\n'], 'toolongline\n', 8), RangeError);
});

test('the result of an append never exceeds the cap, for any run of appends', () => {
  let lines: readonly string[] = [];
  for (let i = 0; i < 200; i += 1) {
    lines = appendAudit(lines, auditLine({ ...ENTRY, seq: i + 1 }), 1000);
    assert.ok(bytes(lines) <= 1000, `${bytes(lines)} after ${i + 1}`);
    assert.equal(lines.length > 0 && lines[lines.length - 1]?.startsWith(`{"seq":${i + 1},`), true);
  }
});
