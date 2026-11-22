import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply } from '../src/types.js';

/** A core that records each call and gives back one scripted reply. The reply is `unknown` so a test can send a broken one. */
function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}

const GOOD = { id: 'fixture-clock', title: 'Fixture Clock', version: '1.2.0', kind: 'ui', origin: 'stock', protected: false };
const listing = (...elements: unknown[]) => scripted({ ok: true, result: elements });
const reading = (result: unknown, id = 'fixture-clock') => createCoreClient(scripted({ ok: true, result })).getGauge(id);

test('the client reaches the core through the one call, with a bowerloom wire name', async () => {
  const core = listing();
  await createCoreClient(core).listGauges();
  assert.deepEqual(core.calls, [{ method: 'bowerloom.gauges.list', params: {} }]);
});

test('the client sends the id of the Gauge to read', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  await createCoreClient(core).getGauge('fixture-clock');
  assert.deepEqual(core.calls, [{ method: 'bowerloom.gauges.get', params: { id: 'fixture-clock' } }]);
});

test('the client gives back a well-formed list of Gauges unchanged', async () => {
  assert.deepEqual(await createCoreClient(listing(GOOD)).listGauges(), { ok: true, value: [GOOD] });
});

test('the client passes on a refusal of a list with a code that is in the registry', async () => {
  const result = await createCoreClient(scripted({ ok: false, code: 'GAUGE_GRANT_MISSING' })).listGauges();
  assert.deepEqual(result, { ok: false, code: 'GAUGE_GRANT_MISSING' });
});

test('the client passes on a refusal of a read with a code that is in the registry', async () => {
  const result = await createCoreClient(scripted({ ok: false, code: 'GAUGE_GRANT_STALE' })).getGauge('fixture-clock');
  assert.deepEqual(result, { ok: false, code: 'GAUGE_GRANT_STALE' });
});

test('the client rejects a refusal code that is not in the registry', async () => {
  const client = createCoreClient(scripted({ ok: false, code: 'MADE_UP_CODE' }));
  await assert.rejects(client.listGauges(), (error: unknown) => error instanceof CoreProtocolError && /MADE_UP_CODE/.test(error.message));
});

test('the client names the failed method on the protocol error', async () => {
  await assert.rejects(createCoreClient(scripted(null)).listGauges(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.list');
  await assert.rejects(reading(null), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.get');
});

// The reply envelope.
for (const [name, reply] of [['null', null], ['undefined', undefined], ['a string', 'ok'], ['a number', 7], ['an empty list', []]] as const) {
  test(`the client rejects a reply that is ${name}`, async () => {
    await assert.rejects(createCoreClient(scripted(reply)).listGauges(), CoreProtocolError);
  });
}

for (const [name, reply] of [['the string "yes"', { ok: 'yes', result: [] }], ['the number 1', { ok: 1, result: [] }], ['missing', { result: [] }]] as const) {
  test(`the client rejects a reply whose ok is ${name}, saying it has no boolean ok`, async () => {
    await assert.rejects(createCoreClient(scripted(reply)).listGauges(), (error: unknown) => error instanceof CoreProtocolError && /reply has no boolean ok/.test(error.message));
  });
}

for (const [name, code] of [['a number', 42], ['null', null], ['missing', undefined], ['an object', { toString() { throw new Error('boom'); } }], ['a bigint', 10n]] as const) {
  test(`the client rejects a refusal whose code is ${name}, without throwing another error`, async () => {
    await assert.rejects(createCoreClient(scripted({ ok: false, code })).listGauges(), (error: unknown) => error instanceof CoreProtocolError && /not a string/.test(error.message));
  });
}

test('the client prints a hostile refusal code as a quoted string cut to 64 characters', async () => {
  const hostile = 'X'.repeat(500);
  await assert.rejects(createCoreClient(scripted({ ok: false, code: hostile })).listGauges(), (error: unknown) => {
    assert.ok(error instanceof CoreProtocolError);
    assert.ok(error.message.includes(JSON.stringify('X'.repeat(64))), error.message);
    assert.equal(error.message.includes('X'.repeat(65)), false);
    return true;
  });
});

test('the client prints a code with line breaks escaped, on one line', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'A\nB' })).listGauges(), (error: unknown) => error instanceof CoreProtocolError && !error.message.includes('\n'));
});

// The list.
test('the client rejects a list reply that is not a list', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: true, result: 'nope' })).listGauges(), CoreProtocolError);
});

for (const [name, elements] of [['numbers', [1, 2]], ['a mix of numbers, null, and a string', [1, null, 'x']], ['an empty object', [{}]], ['a list inside the list', [[]]]] as const) {
  test(`the client rejects a list that holds ${name}`, async () => {
    await assert.rejects(createCoreClient(listing(...elements)).listGauges(), CoreProtocolError);
  });
}

test('the client rejects a list where only the last Gauge is malformed', async () => {
  await assert.rejects(createCoreClient(listing(GOOD, GOOD, { ...GOOD, protected: 'no' })).listGauges(), CoreProtocolError);
});

// One Gauge, field by field.
for (const [name, result] of [['null', null], ['a list', []], ['an empty object', {}], ['an object with only an id', { id: 'x' }]] as const) {
  test(`the client rejects a Gauge reply that is ${name}`, async () => {
    await assert.rejects(reading(result), CoreProtocolError);
  });
}

const BAD_FIELDS: [string, unknown][] = [
  ['id is a number', { ...GOOD, id: 1 }],
  ['title is missing', { ...GOOD, title: undefined }],
  ['title is a number', { ...GOOD, title: 7 }],
  ['version is null', { ...GOOD, version: null }],
  ['kind is outside its union', { ...GOOD, kind: 'process' }],
  ['origin is outside its union', { ...GOOD, origin: 'unknown' }],
  ['protected is a string', { ...GOOD, protected: 'true' }],
  ['protected is missing', { ...GOOD, protected: undefined }],
];
for (const [name, result] of BAD_FIELDS) {
  test(`the client rejects a Gauge whose ${name}`, async () => {
    await assert.rejects(reading(result), CoreProtocolError);
    await assert.rejects(createCoreClient(listing(result)).listGauges(), CoreProtocolError);
  });
}

test('the client rejects a Gauge reply whose id is another Gauge, naming the method', async () => {
  await assert.rejects(reading({ ...GOOD, id: 'fixture-manager' }), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.get');
});

test('the client does not wrap an error that the core throws', async () => {
  const failure = new Error('transport down');
  const core: Core = { call: async () => { throw failure; } };
  await assert.rejects(createCoreClient(core).listGauges(), (error: unknown) => error === failure);
  await assert.rejects(createCoreClient(core).getGauge('x'), (error: unknown) => error === failure);
});
