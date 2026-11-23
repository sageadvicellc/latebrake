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

test('the client prints a hostile refusal code as a quoted string cut to 64 characters, marked as cut', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'X'.repeat(500) })).listGauges(), (error: unknown) => {
    assert.ok(error instanceof CoreProtocolError);
    assert.ok(error.message.includes('"' + 'X'.repeat(63) + '...'), error.message);
    assert.equal(error.message.includes('X'.repeat(64)), false);
    return true;
  });
});

for (const [name, tail] of [['a line break', '\n'], ['a unicode escape', '\u0001'], ['a quote', '"'], ['a backslash', '\\']] as const) {
  test(`the client never cuts ${name} in half when it prints a long code`, async () => {
    // The quoted text is the opening quote, 62 letters, and then the tail, so the 64-character cut would fall inside the tail.
    const code = 'a'.repeat(62) + tail + 'b'.repeat(20);
    await assert.rejects(createCoreClient(scripted({ ok: false, code })).listGauges(), (error: unknown) => {
      assert.ok(error instanceof CoreProtocolError);
      assert.ok(error.message.endsWith('"' + 'a'.repeat(62) + '...'), error.message);
      return true;
    });
  });
}

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

// A refusal of a read.
test('the client rejects a read refusal whose code is not a string', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 42 })).getGauge('x'), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.get' && /not a string/.test(error.message));
});

test('the client rejects a read refusal whose code is not in the registry', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'MADE_UP_CODE' })).getGauge('x'), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.get' && /MADE_UP_CODE/.test(error.message));
});

// A reply that carries both a result and a code. The word ok decides.
test('the client treats an ok reply as a success and ignores a code that it also carries', async () => {
  assert.deepEqual(await createCoreClient(scripted({ ok: true, code: 'NOT_A_CODE', result: [GOOD] })).listGauges(), { ok: true, value: [GOOD] });
});

test('the client treats a refusal as a refusal and ignores a result that it also carries', async () => {
  assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'UNKNOWN_GAUGE', result: 'not read' })).getGauge('x'), { ok: false, code: 'UNKNOWN_GAUGE' });
});

// What the client hands back is built from the six fields it read, and from nothing else.
test('the client drops a field that is not one of the six', async () => {
  const result = await reading({ ...GOOD, extra: 1, note: 'x' });
  assert.ok(result.ok);
  assert.deepEqual(result.value, GOOD);
  assert.equal('extra' in result.value, false);
});

test('the client drops an own "__proto__" field that came from JSON and does not pollute anything', async () => {
  const parsed: unknown = JSON.parse(JSON.stringify(GOOD).replace('{', '{"__proto__":{"polluted":true},'));
  const result = await reading(parsed);
  assert.ok(result.ok);
  assert.equal(Object.hasOwn(result.value, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('the client gives back a fresh frozen Gauge, not the object the core sent', async () => {
  const sent = { ...GOOD };
  const result = await reading(sent);
  assert.ok(result.ok);
  assert.notEqual(result.value, sent);
  assert.equal(Object.isFrozen(result.value), true);
  sent.title = 'changed later';
  assert.equal(result.value.title, GOOD.title);
});

test('the client gives back a frozen list of frozen Gauges', async () => {
  const result = await createCoreClient(listing({ ...GOOD })).listGauges();
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[0]), true);
});

for (const [name, make] of [
  ['an object that inherits its fields', () => Object.create(GOOD)],
  ['an object whose prototype holds its fields', () => ({ __proto__: GOOD })],
] as const) {
  test(`the client rejects a Gauge that is ${name}`, async () => {
    await assert.rejects(reading(make()), CoreProtocolError);
  });
  test(`the client rejects a list that holds a Gauge that is ${name}`, async () => {
    await assert.rejects(createCoreClient(listing(make())).listGauges(), CoreProtocolError);
  });
}

test('the client reads each field once, so a getter cannot show one value to the check and another to the caller', async () => {
  let reads = 0;
  const shifty = { ...GOOD, get kind() { reads += 1; return reads === 1 ? 'ui' : 'process'; } };
  const result = await reading(shifty);
  assert.ok(result.ok);
  assert.equal(reads, 1);
  assert.equal(result.value.kind, 'ui');
});

// A reply that throws when it is read.
const boom = () => { throw new Error('boom'); };
for (const [name, reply] of [
  ['a getter on the reply', { get ok() { return boom(); }, result: [] }],
  ['a getter on the result', { ok: true, get result() { return boom(); } }],
  ['a proxy as the reply', new Proxy({}, { getOwnPropertyDescriptor: boom, get: (_target, key) => (key === 'then' ? undefined : boom()), has: boom })],
  ['a proxy as the list', { ok: true, result: new Proxy([], { getOwnPropertyDescriptor: boom }) }],
] as const) {
  test(`the client turns a throw from ${name} into a CoreProtocolError that names the method`, async () => {
    await assert.rejects(createCoreClient(scripted(reply)).listGauges(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.list');
  });
}

test('the client reads a list by index and never runs a get trap of a proxy', async () => {
  const result = await createCoreClient(scripted({ ok: true, result: new Proxy([], { get: boom }) })).listGauges();
  assert.deepEqual(result, { ok: true, value: [] });
});

test('the client turns a throw from a getter on a Gauge into a CoreProtocolError that names the method', async () => {
  const hostile = { ...GOOD, get title() { return boom(); } };
  await assert.rejects(reading(hostile), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.gauges.get');
  await assert.rejects(createCoreClient(listing(hostile)).listGauges(), CoreProtocolError);
});
