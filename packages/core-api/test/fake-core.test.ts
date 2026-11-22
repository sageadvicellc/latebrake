import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore } from '../src/fake-core.js';
import { createCoreClient } from '../src/client.js';
import { FIXTURE_GAUGES } from '../src/fixtures.js';
import { runClientSuite } from './client-suite.js';

// The one client suite, run against the fake core.
runClientSuite('fake core', () => createFakeCore());

test('fixture Gauges are synthetic, so each id starts with "fixture-"', () => {
  assert.ok(FIXTURE_GAUGES.length >= 2);
  for (const gauge of FIXTURE_GAUGES) assert.match(gauge.id, /^fixture-[a-z-]+$/);
});

test('fixture data holds one protected Gauge and one that a person may remove', () => {
  assert.equal(FIXTURE_GAUGES.some(gauge => gauge.protected), true);
  assert.equal(FIXTURE_GAUGES.some(gauge => !gauge.protected), true);
});

test('a caller that changes a listed Gauge does not change what the core answers next', async () => {
  const client = createCoreClient(createFakeCore());
  const first = await client.listGauges();
  assert.ok(first.ok);
  (first.value[0] as { title: string }).title = 'changed';
  (first.value as unknown as unknown[]).length = 0;
  assert.deepEqual(await client.listGauges(), { ok: true, value: FIXTURE_GAUGES });
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
