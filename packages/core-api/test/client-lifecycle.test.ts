import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import { PLAN_ACTIONS, type Core, type CoreReply, type GaugePlan } from '../src/types.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}

const DIGEST = 'a'.repeat(64);
const PLAN: GaugePlan = { action: 'install', id: 'fixture-tile', folder: 'tile-folder', from: null, to: '1.0.0', origin: 'third-party', steps: ['one', 'two'], digest: DIGEST, manifestHash: 'b'.repeat(64), folderHash: 'c'.repeat(64), nonce: 'd'.repeat(64) };
const APPLIED = { action: 'install', id: 'fixture-tile', version: '1.0.0', enabled: false };
const planning = (result: unknown) => createCoreClient(scripted({ ok: true, result })).planInstall('tile-folder');
const applying = (result: unknown, plan: GaugePlan = PLAN) => createCoreClient(scripted({ ok: true, result })).applyPlan(plan, 'approval');

test('each plan call sends its action and its target under a bowerloom wire name', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  const client = createCoreClient(core);
  await client.planInstall('f1');
  await client.planUpdate('f2');
  await client.planEnable('g1');
  await client.planDisable('g2');
  await client.planRemove('g3');
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.gauges.plan', params: { action: 'install', folder: 'f1' } },
    { method: 'bowerloom.gauges.plan', params: { action: 'update', folder: 'f2' } },
    { method: 'bowerloom.gauges.plan', params: { action: 'enable', id: 'g1' } },
    { method: 'bowerloom.gauges.plan', params: { action: 'disable', id: 'g2' } },
    { method: 'bowerloom.gauges.plan', params: { action: 'remove', id: 'g3' } },
  ]);
});

test('apply sends the whole plan and the approval, and leaves out an approval that was not given', async () => {
  const core = scripted({ ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  const client = createCoreClient(core);
  await client.applyPlan(PLAN, 'approval-1');
  await client.applyPlan(PLAN);
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.gauges.apply', params: { plan: PLAN, approval: 'approval-1' } },
    { method: 'bowerloom.gauges.apply', params: { plan: PLAN } },
  ]);
});

test('routes use their own wire name', async () => {
  const core = scripted({ ok: true, result: ['/gauges/a'] });
  assert.deepEqual(await createCoreClient(core).listRoutes(), { ok: true, value: ['/gauges/a'] });
  assert.deepEqual(core.calls, [{ method: 'bowerloom.gauges.routes', params: {} }]);
});

test('the client gives back a well-formed plan as a frozen copy and drops other fields', async () => {
  const result = await planning({ ...PLAN, extra: 'x' });
  assert.deepEqual(result, { ok: true, value: PLAN });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.steps), true);
  assert.equal(Object.hasOwn(result.value, 'extra'), false);
});

test('the client passes on refusals of the new calls when the code is in the registry', async () => {
  for (const code of ['GAUGE_PLAN_NOT_APPROVED', 'GAUGE_PLAN_CHANGED', 'GAUGE_PROTECTED', 'GAUGE_API_UNSUPPORTED']) {
    assert.deepEqual(await createCoreClient(scripted({ ok: false, code })).planInstall('x'), { ok: false, code });
    assert.deepEqual(await createCoreClient(scripted({ ok: false, code })).applyPlan(PLAN), { ok: false, code });
    assert.deepEqual(await createCoreClient(scripted({ ok: false, code })).listRoutes(), { ok: false, code });
  }
});

test('a refusal code outside the registry on a new call is a protocol error', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'NOT_A_CODE' })).applyPlan(PLAN), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'NOT_A_CODE' })).planEnable('x'), CoreProtocolError);
});

test('a plan reply of the wrong shape is a protocol error that names the method', async () => {
  const broken: unknown[] = [
    null, 'x', [], {}, { ...PLAN, action: 'explode' }, { ...PLAN, action: 'enable' }, { ...PLAN, folder: 'other-folder' }, { ...PLAN, folder: null }, { ...PLAN, id: 5 }, { ...PLAN, id: '' },
    { ...PLAN, from: 1 }, { ...PLAN, to: 1 }, { ...PLAN, origin: 'self' }, { ...PLAN, steps: 'x' }, { ...PLAN, steps: [1] }, { ...PLAN, steps: undefined },
    { ...PLAN, digest: 'z'.repeat(64) }, { ...PLAN, digest: 'a'.repeat(63) }, { ...PLAN, digest: 'A'.repeat(64) }, { ...PLAN, digest: 5 },
    { ...PLAN, manifestHash: 5 }, { ...PLAN, manifestHash: 'z'.repeat(64) }, { ...PLAN, manifestHash: undefined }, { ...PLAN, folderHash: 'c'.repeat(63) }, { ...PLAN, folderHash: undefined },
    { ...PLAN, nonce: null }, { ...PLAN, nonce: 'D'.repeat(64) }, { ...PLAN, nonce: 'd'.repeat(63) }, { ...PLAN, nonce: undefined },
  ];
  for (const result of broken) {
    await assert.rejects(planning(result), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.plan', JSON.stringify(result));
  }
});

test('a plan for a Gauge must be for the Gauge that was asked for', async () => {
  const enable = { ...PLAN, action: 'enable', folder: null, id: 'fixture-tile' };
  assert.equal((await createCoreClient(scripted({ ok: true, result: enable })).planEnable('fixture-tile')).ok, true);
  await assert.rejects(createCoreClient(scripted({ ok: true, result: enable })).planEnable('fixture-other'), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: true, result: enable })).planDisable('fixture-tile'), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: true, result: { ...enable, folder: 'x' } })).planEnable('fixture-tile'), CoreProtocolError);
});

test('an inherited field of a plan reads as missing', async () => {
  const inherited = Object.create({ digest: DIGEST }) as Record<string, unknown>;
  Object.assign(inherited, { ...PLAN, digest: undefined });
  delete inherited['digest'];
  await assert.rejects(planning(inherited), CoreProtocolError);
});

test('a throw while the client reads a plan becomes a protocol error', async () => {
  const hostile = { ...PLAN, get steps(): never { throw new Error('boom'); } };
  await assert.rejects(planning(hostile), CoreProtocolError);
});

test('the client gives back a well-formed result of an apply and checks it is for the plan', async () => {
  assert.deepEqual(await applying(APPLIED), { ok: true, value: APPLIED });
  assert.deepEqual(await applying({ action: 'remove', id: 'fixture-tile', version: null, enabled: false }, { ...PLAN, action: 'remove' }), { ok: true, value: { action: 'remove', id: 'fixture-tile', version: null, enabled: false } });
  for (const result of [null, [], {}, { ...APPLIED, action: 'remove' }, { ...APPLIED, id: 'fixture-other' }, { ...APPLIED, version: 1 }, { ...APPLIED, enabled: 'no' }, { ...APPLIED, enabled: undefined }]) {
    await assert.rejects(applying(result), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.apply', JSON.stringify(result));
  }
});

test('a list of routes must be a list of strings', async () => {
  for (const result of [null, 'x', {}, [1], ['a', null]]) {
    await assert.rejects(createCoreClient(scripted({ ok: true, result })).listRoutes(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.routes', JSON.stringify(result));
  }
  const routes = await createCoreClient(scripted({ ok: true, result: ['/gauges/a'] })).listRoutes();
  assert.ok(routes.ok);
  assert.equal(Object.isFrozen(routes.value), true);
});

test('a plan may have no manifest hash and no folder hash, as the Gauges the core starts with have none', async () => {
  const result = await planning({ ...PLAN, manifestHash: null, folderHash: null });
  assert.deepEqual(result, { ok: true, value: { ...PLAN, manifestHash: null, folderHash: null } });
});

test('a refusal may carry a reason from the closed set, and the client passes it on', async () => {
  const result = await createCoreClient(scripted({ ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'duplicate_key' })).planInstall('x');
  assert.deepEqual(result, { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'duplicate_key' });
  for (const call of [(c: ReturnType<typeof createCoreClient>) => c.listGauges(), (c: ReturnType<typeof createCoreClient>) => c.getGauge('x'), (c: ReturnType<typeof createCoreClient>) => c.applyPlan(PLAN), (c: ReturnType<typeof createCoreClient>) => c.listRoutes()]) {
    assert.deepEqual(await call(createCoreClient(scripted({ ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'syntax' }))), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'syntax' });
  }
});

test('a refusal without a reason has no reason key, and a reason of undefined counts as none', async () => {
  const plain = await createCoreClient(scripted({ ok: false, code: 'UNKNOWN_GAUGE' })).planInstall('x');
  assert.equal(Object.hasOwn(plain, 'reason'), false);
  const undef = await createCoreClient(scripted({ ok: false, code: 'UNKNOWN_GAUGE', reason: undefined })).planInstall('x');
  assert.deepEqual(undef, { ok: false, code: 'UNKNOWN_GAUGE' });
  assert.equal(Object.hasOwn(undef, 'reason'), false);
});

test('a reason that is not a string of the closed set is a protocol error', async () => {
  for (const reason of [5, null, '', 'not_a_reason', 'SYNTAX', 'toString', {}, ['syntax'], true]) {
    await assert.rejects(createCoreClient(scripted({ ok: false, code: 'GAUGE_MANIFEST_INVALID', reason })).planInstall('x'), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.plan', String(reason));
  }
});

test('the result of an apply must fit the step that was applied', async () => {
  const at = (action: GaugePlan['action'], to: string | null) => ({ ...PLAN, action, to, ...(action === 'enable' || action === 'disable' || action === 'remove' ? { folder: null } : {}) });
  const fits: [GaugePlan, unknown][] = [
    [at('install', '1.0.0'), { action: 'install', id: 'fixture-tile', version: '1.0.0', enabled: false }],
    [at('update', '1.1.0'), { action: 'update', id: 'fixture-tile', version: '1.1.0', enabled: true }],
    [at('update', '1.1.0'), { action: 'update', id: 'fixture-tile', version: '1.1.0', enabled: false }],
    [at('enable', '1.0.0'), { action: 'enable', id: 'fixture-tile', version: '1.0.0', enabled: true }],
    [at('disable', '1.0.0'), { action: 'disable', id: 'fixture-tile', version: '1.0.0', enabled: false }],
    [at('remove', null), { action: 'remove', id: 'fixture-tile', version: null, enabled: false }],
  ];
  for (const [plan, result] of fits) assert.equal((await applying(result, plan)).ok, true, JSON.stringify(result));
  const misfits: [GaugePlan, unknown][] = [
    [at('install', '1.0.0'), { action: 'install', id: 'fixture-tile', version: '1.0.0', enabled: true }],
    [at('install', '1.0.0'), { action: 'install', id: 'fixture-tile', version: '2.0.0', enabled: false }],
    [at('install', '1.0.0'), { action: 'install', id: 'fixture-tile', version: null, enabled: false }],
    [at('update', '1.1.0'), { action: 'update', id: 'fixture-tile', version: '1.0.0', enabled: true }],
    [at('update', '1.1.0'), { action: 'update', id: 'fixture-tile', version: null, enabled: true }],
    [at('enable', '1.0.0'), { action: 'enable', id: 'fixture-tile', version: '1.0.0', enabled: false }],
    [at('disable', '1.0.0'), { action: 'disable', id: 'fixture-tile', version: '1.0.0', enabled: true }],
    [at('remove', null), { action: 'remove', id: 'fixture-tile', version: '1.0.0', enabled: false }],
  ];
  for (const [plan, result] of misfits) {
    await assert.rejects(applying(result, plan), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.apply', `${plan.action} ${JSON.stringify(result)}`);
  }
});

test('each route must be exactly /gauges/ and a valid Gauge id', async () => {
  for (const routes of [['/gauges/fixture-clock'], ['/gauges/a', '/gauges/a-b-c1'], []]) assert.equal((await createCoreClient(scripted({ ok: true, result: routes })).listRoutes()).ok, true, JSON.stringify(routes));
  for (const route of ['/gauges/', '/gauges', 'gauges/a', '/gauges/A', '/gauges/a/b', '/gauges/../x', '/gauges/a b', '/gauges/a-', '/gauges/-a', '/gauge/a', '/gauges/a?x=1', '/gauges/a\n', 'https://example.test/gauges/a', `/gauges/${'a'.repeat(65)}`]) {
    await assert.rejects(createCoreClient(scripted({ ok: true, result: ['/gauges/ok', route] })).listRoutes(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.routes', route);
  }
});

test('the plan actions are one list, used by the client and the fake core', async () => {
  assert.deepEqual([...PLAN_ACTIONS], ['install', 'enable', 'disable', 'update', 'remove']);
  assert.equal(Object.isFrozen(PLAN_ACTIONS), true);
});

test('a sparse steps list in a lifecycle plan is a protocol error, because a hole is not a line of text', async () => {
  const sparse: unknown[] = ['one'];
  sparse[2] = 'three';
  await assert.rejects(planning({ ...PLAN, steps: sparse }), CoreProtocolError);
  await assert.rejects(planning({ ...PLAN, steps: new Array<string>(2) }), CoreProtocolError);
});

test('a sparse list of routes is a protocol error, because a hole is not a route', async () => {
  const sparse: unknown[] = ['/gauges/a'];
  sparse[2] = '/gauges/b';
  await assert.rejects(createCoreClient(scripted({ ok: true, result: sparse })).listRoutes(), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: true, result: new Array<string>(1) })).listRoutes(), CoreProtocolError);
});
