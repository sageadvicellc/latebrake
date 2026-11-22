import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore, escapeForPlan, monotonicNow, type GaugeFolder } from '../src/fake-core.js';
import type { GaugePlan } from '../src/types.js';
import { VALID_MANIFESTS } from '../../gauge-manifest/src/fixtures.js';
import { FIXTURE_GAUGES } from '../src/fixtures.js';
import { DEFAULT_EXPECTED, runClientSuite } from './client-suite.js';
import { runLifecycleSuite } from './lifecycle-suite.js';

// The one client suite, run against the fake core.
runClientSuite('fake core', () => createFakeCore());

test('the fixture Gauges equal the list the suite expects', () => {
  assert.deepEqual(FIXTURE_GAUGES, DEFAULT_EXPECTED);
});

test('fixture Gauges are synthetic, so each id starts with "fixture-"', () => {
  assert.ok(FIXTURE_GAUGES.length >= 2);
  for (const gauge of FIXTURE_GAUGES) assert.match(gauge.id, /^fixture-[a-z-]+$/);
});

test('fixture data holds one protected Gauge and one that a person may remove', () => {
  assert.equal(FIXTURE_GAUGES.some(gauge => gauge.protected), true);
  assert.equal(FIXTURE_GAUGES.some(gauge => !gauge.protected), true);
});

test('a caller that changes a listed Gauge does not change what the core answers next', async () => {
  const core = createFakeCore();
  const first = await core.call('bowerloom.gauges.list', {});
  assert.ok(first.ok);
  const listed = first.result as { title: string }[];
  const [firstListed] = listed;
  assert.ok(firstListed);
  firstListed.title = 'changed';
  listed.length = 0;
  assert.deepEqual(await core.call('bowerloom.gauges.list', {}), { ok: true, result: FIXTURE_GAUGES });
});

test('two fake cores do not share state', async () => {
  const one = createFakeCore(), two = createFakeCore();
  const reply = await one.call('bowerloom.gauges.list', {});
  assert.ok(reply.ok);
  (reply.result as unknown[]).length = 0;
  assert.deepEqual(await two.call('bowerloom.gauges.list', {}), { ok: true, result: FIXTURE_GAUGES });
});

test('a method the core does not offer is a programming error, not a refusal code', async () => {
  const core = createFakeCore();
  await assert.rejects(core.call('bowerloom.nothing.here' as never, {}), /unknown core method/);
});

test('reading a Gauge without an id is refused with UNKNOWN_GAUGE', async () => {
  const reply = await createFakeCore().call('bowerloom.gauges.get', {});
  assert.deepEqual(reply, { ok: false, code: 'UNKNOWN_GAUGE' });
});

// The lifecycle suite, run against the fake core. The fake core gives the person's approval through its own `approve`, which no Gauge can reach.
// A real core must not copy how the fake mints an approval: the fake is a test double, and its tokens are not a security design.
runLifecycleSuite('fake core lifecycle', folders => {
  let now = 1_000_000;
  const core = createFakeCore({ folders, now: () => now });
  return { core, approve: plan => core.approve(plan.nonce), replaceFolder: folder => core.replaceFolder(folder), advance: milliseconds => { now += milliseconds; } };
});

const FOLDERS: readonly GaugeFolder[] = [{ name: 'tile-folder', location: 'user', manifest: VALID_MANIFESTS['tile-only'] }];
const planOf = async (core: ReturnType<typeof createFakeCore>): Promise<GaugePlan> => {
  const reply = await core.call('bowerloom.gauges.plan', { action: 'install', folder: 'tile-folder' });
  assert.ok(reply.ok);
  return reply.result as GaugePlan;
};

test('a lifecycle call with a malformed plan is refused with GAUGE_PLAN_CHANGED', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const approval = core.approve((await planOf(core)).nonce);
  for (const plan of [undefined, null, 'x', [], {}, { action: 'explode' }]) {
    assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  }
});

test('an approval is an unguessable random token, and each one differs', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const nonce = (await planOf(core)).nonce;
  const tokens = new Set(Array.from({ length: 50 }, () => core.approve(nonce)));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
});

test('an approval is for a nonce that the core issued, and no other', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  assert.throws(() => core.approve('f'.repeat(64)), /nonce/);
  assert.throws(() => core.approve(5 as never), /nonce/);
});

test('a token that was guessed or made up applies nothing', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const plan = await planOf(core);
  for (const approval of ['approval-1', '0'.repeat(64), plan.nonce, plan.digest, 5, null, undefined]) {
    assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan, approval }), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, String(approval));
  }
});

test('the core reads an id param only when it is a string', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  for (const id of [5, null, undefined, ['fixture-clock'], { toString: () => 'fixture-clock' }, true]) {
    assert.deepEqual(await core.call('bowerloom.gauges.get', { id }), { ok: false, code: 'UNKNOWN_GAUGE' }, String(id));
    for (const action of ['enable', 'disable', 'remove']) assert.deepEqual(await core.call('bowerloom.gauges.plan', { action, id }), { ok: false, code: 'UNKNOWN_GAUGE' }, `${action} ${String(id)}`);
  }
  for (const folder of [5, null, ['tile-folder'], undefined]) assert.deepEqual(await core.call('bowerloom.gauges.plan', { action: 'install', folder }), { ok: false, code: 'UNKNOWN_GAUGE' }, String(folder));
});

test('a caller that keeps a folder it gave to the core cannot change the core by it', async () => {
  const bytes = new TextEncoder().encode('export default 1;');
  const folder = { name: 'tile-folder', location: 'user' as const, manifest: VALID_MANIFESTS['tile-only'], files: { 'ui/tile.js': bytes } };
  const folders = [folder];
  const core = createFakeCore({ folders });
  const before = await planOf(core);
  bytes[0] = 0;
  (folder as { manifest: string }).manifest = '{}';
  (folder as { location: string }).location = 'bundled';
  folders.length = 0;
  const after = await planOf(core);
  assert.deepEqual({ ...after, nonce: '' }, { ...before, nonce: '' });
  assert.equal(after.origin, 'third-party');
});

test('a folder replaced in the core is copied too', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const bytes = new TextEncoder().encode('a');
  const replacement = { name: 'tile-folder', location: 'user' as const, manifest: VALID_MANIFESTS['tile-only'], files: { 'ui/tile.js': bytes } };
  core.replaceFolder(replacement);
  const before = await planOf(core);
  bytes[0] = 98;
  assert.equal((await planOf(core)).folderHash, before.folderHash);
});

test('replacing a folder that the core does not have adds it', async () => {
  const core = createFakeCore();
  const [first] = FOLDERS;
  assert.ok(first);
  core.replaceFolder(first);
  assert.equal((await planOf(core)).id, 'fixture-tile');
});

test('the default clock is the real clock, so an approval made now is still good a moment later', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const plan = await planOf(core);
  const approval = core.approve(plan.nonce);
  const applied = await core.call('bowerloom.gauges.apply', { plan, approval });
  assert.equal(applied.ok, true);
});

test('a plan call with an unknown action is a programming error, not a refusal code', async () => {
  await assert.rejects(createFakeCore().call('bowerloom.gauges.plan', { action: 'explode' }), /unknown plan action/);
});

test('a fake core made with no folders finds no folder to install', async () => {
  const reply = await createFakeCore().call('bowerloom.gauges.plan', { action: 'install', folder: 'nothing' });
  assert.deepEqual(reply, { ok: false, code: 'UNKNOWN_GAUGE' });
});

test('a stock id is reserved even when no bundled folder holds it, also after its Gauge is removed', async () => {
  const clash: GaugeFolder = { name: 'clash', location: 'user', manifest: VALID_MANIFESTS['tile-only'].replace('fixture-tile', 'fixture-clock') };
  const core = createFakeCore({ folders: [clash] });
  assert.deepEqual(await core.call('bowerloom.gauges.plan', { action: 'install', folder: 'clash' }), { ok: false, code: 'GAUGE_NAME_RESERVED' });
  const removal = await core.call('bowerloom.gauges.plan', { action: 'remove', id: 'fixture-clock' });
  assert.ok(removal.ok);
  const applied = await core.call('bowerloom.gauges.apply', { plan: removal.result, approval: core.approve((removal.result as GaugePlan).nonce) });
  assert.equal(applied.ok, true);
  assert.deepEqual(await core.call('bowerloom.gauges.plan', { action: 'install', folder: 'clash' }), { ok: false, code: 'GAUGE_NAME_RESERVED' });
});

test('the plan text escape leaves a plain name as it is, and turns every line break and invisible character into a visible escape', () => {
  assert.equal(escapeForPlan('tile-folder 1.0.0 caf\u00e9'), 'tile-folder 1.0.0 caf\u00e9');
  for (const [value, expected] of [['a\nb', 'a\\u{a}b'], ['a\rb', 'a\\u{d}b'], ['a\u2028b', 'a\\u{2028}b'], ['a\u2029b', 'a\\u{2029}b'], ['a\u200Bb', 'a\\u{200b}b'], ['a\\b', 'a\\\\b'], ['a\u0000b', 'a\\u{0}b'], ['a\u0085b', 'a\\u{85}b']] as const) {
    assert.equal(escapeForPlan(value), expected, JSON.stringify(value));
  }
  for (const value of ['\n', '\r\n', '\u2028\u2029', 'x\ny\nz', 'permissions: none\nkind: ui']) assert.equal(/[\n\r\u2028\u2029\u0085]/.test(escapeForPlan(value)), false, JSON.stringify(value));
});

test('the steps of a plan never hold a line break that a name put there', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const plan = await planOf(core);
  for (const step of plan.steps) assert.equal(/[\n\r\u2028\u2029]/.test(step), false, step);
});

test('a plan that is applied retires its nonce, and every plan issued before the state changed, so none can be approved later', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const issuedEarly = await planOf(core), applied = await planOf(core);
  const result = await core.call('bowerloom.gauges.apply', { plan: applied, approval: core.approve(applied.nonce) });
  assert.equal(result.ok, true);
  assert.throws(() => core.approve(applied.nonce), /nonce/);
  assert.throws(() => core.approve(issuedEarly.nonce), /nonce/);
  const later = await core.call('bowerloom.gauges.plan', { action: 'enable', id: 'fixture-tile' });
  assert.ok(later.ok);
  const laterPlan = later.result as GaugePlan;
  assert.notEqual(laterPlan.nonce, applied.nonce);
  assert.equal(typeof core.approve(laterPlan.nonce), 'string');
});

test('the default clock is monotonic: a system clock that steps back does not extend an approval', async t => {
  let performanceNow = 5_000;
  t.mock.method(performance, 'now', () => performanceNow);
  t.mock.method(Date, 'now', () => 0);
  const core = createFakeCore({ folders: FOLDERS });
  const plan = await planOf(core);
  const approval = core.approve(plan.nonce);
  performanceNow += 15 * 60 * 1000;
  assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan, approval }), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
});

test('the monotonic clock reads the performance clock and never the system clock', (t) => {
  t.mock.method(performance, 'now', () => 123.5);
  t.mock.method(Date, 'now', () => -1);
  assert.equal(monotonicNow(), 123.5);
});
