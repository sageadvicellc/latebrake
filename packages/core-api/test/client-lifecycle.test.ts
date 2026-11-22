import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply, GaugePlan } from '../src/types.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}

const DIGEST = 'a'.repeat(64);
const PLAN: GaugePlan = { action: 'install', id: 'fixture-tile', folder: 'tile-folder', from: null, to: '1.0.0', origin: 'third-party', steps: ['one', 'two'], digest: DIGEST };
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
