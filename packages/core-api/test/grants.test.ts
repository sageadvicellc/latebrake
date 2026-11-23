import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AUDIT_LINE_BYTES, MIN_AUDIT_MAX_BYTES, appendAuditStep, auditLine, grantSteps, type AuditEntry } from '../src/grants.js';
import { escapeForPlan } from '../src/plan-text.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);

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

test('the longest audit line is 398 bytes, and the smallest cap holds 15 of them, one for each permission', () => {
  assert.equal(MAX_AUDIT_LINE_BYTES, 398);
  assert.equal(MIN_AUDIT_MAX_BYTES, 5970);
  const longest: AuditEntry = {
    seq: Number.MAX_SAFE_INTEGER, at: '9999-12-31T23:59:59.999Z', action: 'revoke', via: 'disable', id: 'a'.repeat(64), version: '999999999.999999999.999999999',
    permission: 'sessions.attach', manifestHash: 'f'.repeat(64), folderHash: 'f'.repeat(64),
  };
  assert.equal(Buffer.byteLength(auditLine(longest)), 398);
  for (const via of ['plan', 'revoke', 'remove', 'update'] as const) assert.ok(Buffer.byteLength(auditLine({ ...longest, via })) <= 398, via);
});

const bytes = (lines: readonly string[]) => lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);

test('a step is appended whole while the file fits the cap, with the cap itself allowed', () => {
  assert.deepEqual(appendAuditStep(['aaaa\n', 'bbbb\n'], ['cccc\n'], 15), { lines: ['aaaa\n', 'bbbb\n', 'cccc\n'], dropped: 0 });
  assert.deepEqual(appendAuditStep([], ['cccc\n', 'dddd\n'], 10), { lines: ['cccc\n', 'dddd\n'], dropped: 0 });
});

test('a step drops the oldest whole lines until all of its own lines fit, and one byte over the cap drops one more', () => {
  assert.deepEqual(appendAuditStep(['aaaa\n', 'bbbb\n', 'cccc\n'], ['dddd\n'], 15), { lines: ['bbbb\n', 'cccc\n', 'dddd\n'], dropped: 1 });
  assert.deepEqual(appendAuditStep(['aaaa\n', 'bbbb\n', 'cccc\n'], ['dddd\n'], 14), { lines: ['cccc\n', 'dddd\n'], dropped: 2 });
  assert.deepEqual(appendAuditStep(['aa\n', 'bbbbbbbb\n'], ['cccccc\n'], 8), { lines: ['cccccc\n'], dropped: 2 });
});

test('a step never drops a line of its own, however many it holds', () => {
  const step = ['11111\n', '22222\n', '33333\n'];
  assert.deepEqual(appendAuditStep(['old1\n', 'old2\n'], step, 18), { lines: step, dropped: 2 });
  assert.deepEqual(appendAuditStep(['old1\n', 'old2\n'], step, 23), { lines: ['old2\n', ...step], dropped: 1 });
});

test('a step that is larger than the cap alone is refused, and nothing is dropped for it', () => {
  assert.equal(appendAuditStep(['aaaa\n'], ['11111\n', '22222\n'], 11), undefined);
  assert.equal(appendAuditStep([], ['toolongline\n'], 8), undefined);
});

test('an empty step changes nothing', () => {
  assert.deepEqual(appendAuditStep(['aaaa\n'], [], 5), { lines: ['aaaa\n'], dropped: 0 });
});

test('appending never changes the lines it was given', () => {
  const lines = ['aaaa\n', 'bbbb\n'], step = ['cccc\n'];
  appendAuditStep(lines, step, 10);
  assert.deepEqual(lines, ['aaaa\n', 'bbbb\n']);
  assert.deepEqual(step, ['cccc\n']);
});

test('the result of an append never exceeds the cap, for any run of steps', () => {
  let lines: readonly string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const step = [auditLine({ ...ENTRY, seq: 2 * i + 1 }), auditLine({ ...ENTRY, seq: 2 * i + 2 })];
    const next = appendAuditStep(lines, step, 1000);
    assert.ok(next);
    lines = next.lines;
    assert.ok(bytes(lines) <= 1000, `${bytes(lines)} after ${i + 1}`);
    assert.deepEqual(lines.slice(-2), step);
  }
});

const HASHES = { manifestHash: A, folderHash: B };

test('a plain grant plan reads exactly like this', () => {
  assert.deepEqual(grantSteps({ id: 'fixture-solo', version: '1.0.0', permissions: ['engines.read', 'usage.read'], engines: ['fixture-engine'], ...HASHES }), [
    'grant 2 permissions to fixture-solo 1.0.0',
    'permission engines.read (read): Read the state of the engines the Gauge lists.',
    'permission usage.read (read): Read the usage figures of the engines the Gauge lists.',
    'engines: fixture-engine',
    `bind the grant to manifest ${A} and folder ${B}`,
  ]);
});

test('a grant plan for one permission says permission in the singular, and a Gauge with no engine says none, and a Gauge with no hashes says none', () => {
  assert.deepEqual(grantSteps({ id: 'fixture-bare', version: '2.0.0', permissions: ['layout.propose'], engines: [], manifestHash: null, folderHash: null }), [
    'grant 1 permission to fixture-bare 2.0.0',
    'permission layout.propose (write): Ask for a plan to add the Gauge to the layout. The Gauge never skips the plan.',
    'engines: none',
    'bind the grant to manifest none and folder none',
  ]);
});

test('a traces grant plan carries the notice line, between the engines and the bind line', () => {
  assert.deepEqual(grantSteps({ id: 'fixture-traced', version: '1.0.0', permissions: ['traces.facts', 'traces.text'], engines: ['fixture-engine', 'fixture-other'], ...HASHES }), [
    'grant 2 permissions to fixture-traced 1.0.0',
    'permission traces.facts (read): Read the recorded facts of traces from the engines the Gauge lists. Denied until the person grants it.',
    'permission traces.text (read): Read the prompt and reply text of traces, together with traces.facts. Denied until the person grants it.',
    'engines: fixture-engine, fixture-other',
    'traces permissions start denied, are granted only here, and one revoke removes them all',
    `bind the grant to manifest ${A} and folder ${B}`,
  ]);
});

test('a grant plan for the three jobs permissions says what each one really gives', () => {
  assert.deepEqual(grantSteps({ id: 'fixture-jobber', version: '1.0.0', permissions: ['jobs.read', 'jobs.run', 'jobs.write'], engines: ['fixture-engine'], ...HASHES }), [
    'grant 3 permissions to fixture-jobber 1.0.0',
    'permission jobs.read (read): Read every saved job, with the folder and the task text of each session, and the runs of the jobs.',
    'permission jobs.run (act): Ask for a plan to run a job, and see its folders, programs, and tasks; each engine needs a start grant. The Gauge never skips the plan.',
    'permission jobs.write (write): Ask for a plan to create, change, or delete a job; the plan shows its old title, session count, and hash. The Gauge never skips the plan.',
    'engines: fixture-engine',
    `bind the grant to manifest ${A} and folder ${B}`,
  ]);
});

test('hostile text in an id, a version, an engine, or a hash becomes visible escapes, so no value adds or forges a line', () => {
  const long = 'x'.repeat(500);
  const steps = grantSteps({
    id: 'a\nb c', version: '9.0.0\u0085\r', permissions: ['engines.read'], engines: ['e1\npermission jobs.run (act): forged', `e2${long}`, 'tab\there', 'back\\slash'],
    manifestHash: 'h h', folderHash: 'bidi‮end',
  });
  assert.deepEqual(steps, [
    'grant 1 permission to a\\u{a}b\\u{2028}c 9.0.0\\u{85}\\u{d}',
    'permission engines.read (read): Read the state of the engines the Gauge lists.',
    `engines: e1\\u{a}permission jobs.run (act): forged, e2${long}, tab\\u{9}here, back\\\\slash`,
    'bind the grant to manifest h\\u{2029}h and folder bidi\\u{202e}end',
  ]);
  assert.equal(steps.length, 4);
  for (const line of steps) assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line), false, line);
});

test('a permission that is not in the list is a programming error, not a line of the plan', () => {
  assert.throws(() => grantSteps({ id: 'a', version: '1.0.0', permissions: ['nothing.here' as never], engines: [], ...HASHES }), /not in the permission list/);
});

test('the plan text escape leaves a plain name as it is', () => {
  assert.equal(escapeForPlan('tile-folder 1.0.0 café'), 'tile-folder 1.0.0 café');
});
