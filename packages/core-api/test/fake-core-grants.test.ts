import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createCoreClient } from '../src/client.js';
import type { GaugePlan, GrantPlan } from '../src/types.js';
import { GRANT_FOLDERS, MIN_AUDIT_MAX_BYTES, runGrantsSuite } from './grants-suite.js';

// The one grants suite, run against the fake core. The fake core gives the person's approval through its own `approve`, which no Gauge can reach.
runGrantsSuite('fake core grants', (folders, options) => {
  let now = 1_000_000;
  const core = createFakeCore({ folders, now: () => now, ...(options.auditMaxBytes === undefined ? {} : { auditMaxBytes: options.auditMaxBytes }) });
  return { core, approve: plan => core.approve(plan.nonce), advance: milliseconds => { now += milliseconds; } };
});

const FOLDERS: readonly GaugeFolder[] = GRANT_FOLDERS;
const install = async (core: ReturnType<typeof createFakeCore>, folder: string, id: string) => {
  const client = createCoreClient(core);
  for (const plan of [() => client.planInstall(folder), () => client.planEnable(id)]) {
    const planned = await plan();
    assert.ok(planned.ok);
    const applied = await client.applyPlan(planned.value, core.approve(planned.value.nonce));
    assert.ok(applied.ok);
  }
  return client;
};
const grantOnce = async (core: ReturnType<typeof createFakeCore>, id: string, permissions: string[]) => {
  const client = createCoreClient(core);
  const plan = await client.planGrant(id, permissions);
  assert.ok(plan.ok);
  const applied = await client.applyGrant(plan.value, core.approve(plan.value.nonce));
  assert.ok(applied.ok);
};

test('the audit file is one JSON line for each record, ended by a line feed, with the fields in a fixed order and the time from the wall clock', async () => {
  const core = createFakeCore({ folders: FOLDERS, wall: () => Date.UTC(2026, 0, 2, 3, 4, 5, 6) });
  await install(core, 'solo-folder', 'fixture-solo');
  assert.equal(core.auditFile(), '');
  await grantOnce(core, 'fixture-solo', ['engines.read']);
  const lines = core.auditFile().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '');
  const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  assert.deepEqual(Object.keys(record), ['seq', 'at', 'action', 'via', 'id', 'version', 'permission', 'manifestHash', 'folderHash']);
  assert.equal(record['at'], '2026-01-02T03:04:05.006Z');
  assert.equal(record['seq'], 1);
});

test('the audit file never exceeds its cap in bytes, and the default cap is 64 KiB', async () => {
  const core = createFakeCore({ folders: FOLDERS, auditMaxBytes: MIN_AUDIT_MAX_BYTES });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  for (let round = 0; round < 40; round += 1) {
    await grantOnce(core, 'fixture-solo', ['engines.read', 'usage.read']);
    assert.ok(Buffer.byteLength(core.auditFile()) <= MIN_AUDIT_MAX_BYTES, `round ${round}`);
    const revoked = await client.revoke('fixture-solo', ['engines.read', 'usage.read']);
    assert.ok(revoked.ok);
    assert.ok(Buffer.byteLength(core.auditFile()) <= MIN_AUDIT_MAX_BYTES, `round ${round} after revoke`);
  }
  const fresh = createFakeCore({ folders: FOLDERS });
  const freshClient = await install(fresh, 'solo-folder', 'fixture-solo');
  for (let round = 0; round < 300; round += 1) {
    await grantOnce(fresh, 'fixture-solo', ['engines.read', 'usage.read']);
    assert.ok((await freshClient.revoke('fixture-solo', ['engines.read', 'usage.read'])).ok);
  }
  assert.ok(Buffer.byteLength(fresh.auditFile()) <= 64 * 1024);
  assert.ok(Buffer.byteLength(fresh.auditFile()) > 32 * 1024, 'the default cap is large, so 1,200 records fill more than half of it');
});

test('a size cap below the smallest allowed, or one that is not a whole number, is refused when the core is made', () => {
  for (const auditMaxBytes of [0, 100, MIN_AUDIT_MAX_BYTES - 1, 4096.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createFakeCore({ auditMaxBytes }), RangeError, String(auditMaxBytes));
  }
  assert.doesNotThrow(() => createFakeCore({ auditMaxBytes: MIN_AUDIT_MAX_BYTES }));
});

test('a wall clock that gives no usable time stops a grant before anything changes', async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, -8.64e15 - 1]) {
    const core = createFakeCore({ folders: FOLDERS, wall: () => bad });
    const client = await install(core, 'solo-folder', 'fixture-solo');
    const plan = await client.planGrant('fixture-solo', ['engines.read']);
    assert.ok(plan.ok);
    const approval = core.approve(plan.value.nonce);
    await assert.rejects(client.applyGrant(plan.value, approval), TypeError, String(bad));
    const grants = await client.listGrants('fixture-solo');
    assert.deepEqual(grants, { ok: true, value: [] });
    assert.equal(core.auditFile(), '');
    assert.deepEqual(await client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine'), { ok: false, code: 'GAUGE_GRANT_MISSING' });
  }
});

test('a wall clock that fails stops a revoke and a removal before anything changes', async () => {
  let broken = false;
  const core = createFakeCore({ folders: FOLDERS, wall: () => (broken ? Number.NaN : Date.UTC(2026, 0, 2)) });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  await grantOnce(core, 'fixture-solo', ['engines.read', 'usage.read']);
  const file = core.auditFile();
  const removal = await client.planRemove('fixture-solo');
  assert.ok(removal.ok);
  const approval = core.approve(removal.value.nonce);
  broken = true;
  await assert.rejects(client.revoke('fixture-solo', ['engines.read']), TypeError);
  await assert.rejects(client.applyPlan(removal.value, approval), TypeError);
  assert.equal(core.auditFile(), file);
  const gauge = await client.getGauge('fixture-solo');
  assert.equal(gauge.ok, true);
  const grants = await client.listGrants('fixture-solo');
  assert.ok(grants.ok);
  assert.deepEqual(grants.value.map(entry => entry.permission), ['engines.read', 'usage.read']);
  broken = false;
  const applied = await client.applyPlan(removal.value, approval);
  assert.equal(applied.ok, true);
});

test('a caller that changes a reply of the grants calls changes nothing for the next call', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  await install(core, 'solo-folder', 'fixture-solo');
  await grantOnce(core, 'fixture-solo', ['engines.read']);
  const listed = await core.call('bowerloom.grants.list', { id: 'fixture-solo' });
  assert.ok(listed.ok);
  const [firstListed] = listed.result as { permission: string }[];
  assert.ok(firstListed);
  firstListed.permission = 'changed';
  (listed.result as unknown[]).length = 0;
  const again = await core.call('bowerloom.grants.list', { id: 'fixture-solo' });
  assert.ok(again.ok);
  assert.equal((again.result as { permission: string }[])[0]?.permission, 'engines.read');
  const read = await core.call('bowerloom.audit.read', {});
  assert.ok(read.ok);
  const [firstRead] = read.result as { id: string }[];
  assert.ok(firstRead);
  firstRead.id = 'changed';
  (read.result as unknown[]).length = 0;
  const readAgain = await core.call('bowerloom.audit.read', {});
  assert.ok(readAgain.ok);
  assert.equal((readAgain.result as { id: string }[])[0]?.id, 'fixture-solo');
});

test('a folder that was given to the core and changed afterwards changes no grant', async () => {
  const source = GRANT_FOLDERS.find(candidate => candidate.name === 'solo-folder');
  assert.ok(source);
  const folder = { name: 'solo-folder', location: 'user' as const, manifest: source.manifest };
  const core = createFakeCore({ folders: [folder] });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  (folder as { manifest: string }).manifest = '{}';
  const plan = await client.planGrant('fixture-solo', ['engines.read']);
  assert.ok(plan.ok);
});

test('two fake cores do not share grants or audit records', async () => {
  const one = createFakeCore({ folders: FOLDERS }), two = createFakeCore({ folders: FOLDERS });
  await install(one, 'solo-folder', 'fixture-solo');
  const client = await install(two, 'solo-folder', 'fixture-solo');
  await grantOnce(one, 'fixture-solo', ['engines.read']);
  assert.deepEqual(await client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine'), { ok: false, code: 'GAUGE_GRANT_MISSING' });
  assert.equal(two.auditFile(), '');
});

test('a plan call for a grant is not a lifecycle plan, and the plan call of the lifecycle still refuses a grant action', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  await assert.rejects(core.call('bowerloom.gauges.plan', { action: 'grant', id: 'fixture-clock' }), /unknown plan action/);
});

test('the nonce of a grant plan is a random 64 character token that the core issued, and the approval of it differs each time', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  const plan = await client.planGrant('fixture-solo', ['engines.read']);
  assert.ok(plan.ok);
  const tokens = new Set(Array.from({ length: 30 }, () => core.approve(plan.value.nonce)));
  assert.equal(tokens.size, 30);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
  assert.throws(() => core.approve('f'.repeat(64)), /nonce/);
});

test('a plan of a grant that is applied retires every earlier plan, so none can be approved later', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  const early = await client.planGrant('fixture-solo', ['usage.read']), used = await client.planGrant('fixture-solo', ['engines.read']);
  assert.ok(early.ok && used.ok);
  assert.ok((await client.applyGrant(used.value, core.approve(used.value.nonce))).ok);
  assert.throws(() => core.approve(used.value.nonce), /nonce/);
  assert.throws(() => core.approve(early.value.nonce), /nonce/);
});

test('a revoke retires no plan, because it only narrows what a Gauge may do', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const client = await install(core, 'solo-folder', 'fixture-solo');
  await grantOnce(core, 'fixture-solo', ['engines.read']);
  const lifecycle = await client.planDisable('fixture-solo');
  assert.ok(lifecycle.ok);
  assert.ok((await client.revoke('fixture-solo', ['engines.read'])).ok);
  assert.equal(typeof core.approve((lifecycle.value as GaugePlan).nonce), 'string');
});

test('the lines of a grant plan hold no line break, even when a core text is hostile, because every value goes through the one escape', async () => {
  const core = createFakeCore({ folders: FOLDERS });
  const client = await install(core, 'traced-folder', 'fixture-traced');
  const plan = await client.planGrant('fixture-traced', ['engines.read', 'sessions.start', 'layout.propose']);
  assert.ok(plan.ok);
  for (const line of (plan.value as GrantPlan).steps) assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line), false, line);
});

test('a method of the grants calls that the core does not offer is a programming error', async () => {
  await assert.rejects(createFakeCore().call('bowerloom.grants.explode' as never, {}), /unknown core method/);
});
