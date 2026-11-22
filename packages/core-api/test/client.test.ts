import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply } from '../src/types.js';

/** A core that records each call and gives back one scripted reply. */
function scripted(reply: CoreReply): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply; } };
}

test('the client reaches the core through the one call, with a bowerloom wire name', async () => {
  const core = scripted({ ok: true, result: [] });
  await createCoreClient(core).listGauges();
  assert.deepEqual(core.calls, [{ method: 'bowerloom.gauges.list', params: {} }]);
});

test('the client sends the id of the Gauge to read', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  await createCoreClient(core).getGauge('fixture-clock');
  assert.deepEqual(core.calls, [{ method: 'bowerloom.gauges.get', params: { id: 'fixture-clock' } }]);
});

test('the client passes on a refusal code that is in the registry', async () => {
  const result = await createCoreClient(scripted({ ok: false, code: 'GAUGE_GRANT_MISSING' })).listGauges();
  assert.deepEqual(result, { ok: false, code: 'GAUGE_GRANT_MISSING' });
});

test('the client rejects a refusal code that is not in the registry', async () => {
  const client = createCoreClient(scripted({ ok: false, code: 'MADE_UP_CODE' }));
  await assert.rejects(client.listGauges(), (error: unknown) => error instanceof CoreProtocolError && /MADE_UP_CODE/.test(error.message));
});

test('the client rejects a list reply that is not a list', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: true, result: 'nope' })).listGauges(), CoreProtocolError);
});

test('the client rejects a Gauge reply that is not an object', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: true, result: null })).getGauge('fixture-clock'), CoreProtocolError);
});
