import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore } from '../src/fake-core.js';
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
  listed[0]!.title = 'changed';
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
runLifecycleSuite('fake core lifecycle', folders => {
  const core = createFakeCore({ folders });
  return { core, approve: digest => core.approve(digest) };
});

test('a lifecycle call with a malformed plan is refused with GAUGE_PLAN_CHANGED', async () => {
  const core = createFakeCore();
  for (const plan of [undefined, null, 'x', [], {}, { action: 'explode' }]) {
    assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan, approval: core.approve('x') }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  }
});

test('a plan call with an unknown action is a programming error, not a refusal code', async () => {
  await assert.rejects(createFakeCore().call('bowerloom.gauges.plan', { action: 'explode' }), /unknown plan action/);
});

test('a fake core made with no folders finds no folder to install', async () => {
  const reply = await createFakeCore().call('bowerloom.gauges.plan', { action: 'install', folder: 'nothing' });
  assert.deepEqual(reply, { ok: false, code: 'UNKNOWN_GAUGE' });
});
