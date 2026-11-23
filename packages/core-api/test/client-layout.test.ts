import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply, LayoutPlan } from '../src/types.js';
import { LAYOUT_REASONS, PROTECTED_REASONS } from '../../gauge-layout/src/index.js';
import { HOME_DOC } from './layout-suite.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}
const ok = (result: unknown) => scripted({ ok: true, result });
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const TEXT = '{"x":1}';
const PLAN: LayoutPlan = { action: 'layout', kind: 'swap', place: 'models', gauge: 'tracing', revision: null, text: null, steps: ['one', 'two'], digest: A, baseHash: B, nextHash: C, nonce: D };
const swapping = (result: unknown) => createCoreClient(ok(result)).planLayoutSwap('models', 'tracing');
const STATE = { layout: HOME_DOC, revision: 2, safe: null };
const reading = (result: unknown) => createCoreClient(ok(result)).readLayout();

test('each layout call sends its params under a bowerloom wire name', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  const client = createCoreClient(core);
  await client.readLayout();
  await client.listLayoutRevisions();
  await client.exportLayout();
  await client.planLayoutSet(TEXT);
  await client.planLayoutSwap('p1', 'g1');
  await client.planLayoutDefault('p2');
  await client.planLayoutRestore(3);
  await client.planLayoutPropose('g2');
  await client.applyLayout(PLAN, 'approval-1');
  await client.applyLayout(PLAN);
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.layout.read', params: {} },
    { method: 'bowerloom.layout.revisions', params: {} },
    { method: 'bowerloom.layout.export', params: {} },
    { method: 'bowerloom.layout.plan', params: { kind: 'set', text: TEXT } },
    { method: 'bowerloom.layout.plan', params: { kind: 'swap', place: 'p1', gauge: 'g1' } },
    { method: 'bowerloom.layout.plan', params: { kind: 'default', place: 'p2' } },
    { method: 'bowerloom.layout.plan', params: { kind: 'restore', revision: 3 } },
    { method: 'bowerloom.layout.plan', params: { kind: 'propose', gauge: 'g2' } },
    { method: 'bowerloom.layout.apply', params: { plan: PLAN, approval: 'approval-1' } },
    { method: 'bowerloom.layout.apply', params: { plan: PLAN } },
  ]);
});

test('the client sends a copy of the plan, so a core that changes it changes nothing for the caller', async () => {
  const plan: LayoutPlan = { ...PLAN, steps: ['one'] };
  const core: Core = { call: async (_method, params) => { (params['plan'] as { steps: string[] } | undefined)?.steps.push('x'); return { ok: false, code: 'UNKNOWN_GAUGE' }; } };
  await createCoreClient(core).applyLayout(plan);
  assert.deepEqual(plan.steps, ['one']);
});

// The state
test('a well-formed state comes back as a frozen copy, with the layout in canonical order', async () => {
  const result = await reading({ ...STATE, extra: 'x' });
  assert.deepEqual(result, { ok: true, value: STATE });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.layout), true);
  assert.equal(Object.isFrozen(result.value.layout.tiles), true);
  assert.equal(Object.isFrozen(result.value.layout.tiles[0]), true);
});

test('a state in safe mode has revision 0 and the cause, and a state that is not has revision 1 or more', async () => {
  const safe = { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' };
  assert.deepEqual(await reading({ layout: HOME_DOC, revision: 0, safe }), { ok: true, value: { layout: HOME_DOC, revision: 0, safe } });
  const protectedCause = { code: 'GAUGE_PROTECTED', reason: 'hidden' };
  assert.deepEqual(await reading({ layout: HOME_DOC, revision: 0, safe: protectedCause }), { ok: true, value: { layout: HOME_DOC, revision: 0, safe: protectedCause } });
  for (const bad of [
    { layout: HOME_DOC, revision: 0, safe: null }, { layout: HOME_DOC, revision: 1, safe },
    { layout: HOME_DOC, revision: 0, safe: { code: 'GAUGE_PROTECTED', reason: 'syntax' } }, { layout: HOME_DOC, revision: 0, safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'hidden' } },
    { layout: HOME_DOC, revision: 0, safe: { code: 'UNKNOWN_GAUGE', reason: 'syntax' } }, { layout: HOME_DOC, revision: 0, safe: { code: 'GAUGE_LAYOUT_INVALID' } },
    { layout: HOME_DOC, revision: 0, safe: 'syntax' }, { layout: HOME_DOC, revision: 0, safe: undefined },
  ]) await assert.rejects(reading(bad), CoreProtocolError, JSON.stringify(bad));
});

test('a state with a bad revision, a missing field, or a layout that is not a layout is a protocol error that names the method', async () => {
  const bad: unknown[] = [
    null, 'x', [], 5, {}, { layout: HOME_DOC }, { revision: 1, safe: null },
    { ...STATE, revision: -1 }, { ...STATE, revision: 1.5 }, { ...STATE, revision: '1' }, { ...STATE, revision: NaN }, { ...STATE, revision: 2 ** 53 }, { ...STATE, revision: null },
    { ...STATE, layout: null }, { ...STATE, layout: 'x' }, { ...STATE, layout: [] }, { ...STATE, layout: { ...HOME_DOC, extra: 1 } }, { ...STATE, layout: { ...HOME_DOC, format: 'x' } },
    { ...STATE, layout: { ...HOME_DOC, tiles: [{ ...HOME_DOC.tiles[0], col: 9 }] } },
    { ...STATE, layout: { ...HOME_DOC, tiles: [HOME_DOC.tiles[0], { ...HOME_DOC.tiles[1], col: 0 }] } },
    { ...STATE, layout: { ...HOME_DOC, tiles: [...HOME_DOC.tiles].reverse() } },
    { ...STATE, layout: { ...HOME_DOC, shelf: [...HOME_DOC.shelf].reverse() } },
    { ...STATE, layout: { ...HOME_DOC, shelf: ['b', 'a'] } },
    { ...STATE, layout: { ...HOME_DOC, shelf: ['a', 'a'] } },
    { ...STATE, layout: { ...HOME_DOC, shelf: ['A'] } },
    { ...STATE, layout: { ...HOME_DOC, hidden: ['jobs'] } },
    { ...STATE, layout: { ...HOME_DOC, tiles: [{ ...HOME_DOC.tiles[0], size: 'huge' }] } },
  ];
  for (const result of bad) {
    await assert.rejects(reading(result), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.read', JSON.stringify(result));
  }
});

test('a state is read from own properties only, and a field that an object inherits reads as missing', async () => {
  const inherited = Object.assign(Object.create({ layout: HOME_DOC }) as object, { revision: 1, safe: null });
  await assert.rejects(reading(inherited), CoreProtocolError);
  await assert.rejects(reading(Object.assign(Object.create({ revision: 1 }) as object, { layout: HOME_DOC, safe: null })), CoreProtocolError);
  await assert.rejects(reading({ layout: Object.create(HOME_DOC), revision: 1, safe: null }), CoreProtocolError);
});

test('a throw while the client reads a state becomes a protocol error', async () => {
  const hostile = { get layout(): never { throw new Error('boom'); }, revision: 1, safe: null };
  await assert.rejects(reading(hostile), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.read');
  const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  await assert.rejects(reading({ layout: proxy, revision: 1, safe: null }), CoreProtocolError);
});

test('a list with a hole in a layout is a protocol error', async () => {
  // eslint-disable-next-line no-sparse-arrays
  await assert.rejects(reading({ ...STATE, layout: { ...HOME_DOC, shelf: ['a', , 'c'] } }), CoreProtocolError);
});

// The revisions
const ENTRY = (revision: number) => ({ revision, layout: HOME_DOC });
test('a list of revisions comes back newest first as frozen copies, and may be empty', async () => {
  const result = await createCoreClient(ok([ENTRY(3), ENTRY(2), { ...ENTRY(1), extra: 1 }])).listLayoutRevisions();
  assert.deepEqual(result, { ok: true, value: [ENTRY(3), ENTRY(2), ENTRY(1)] });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[0]), true);
  assert.deepEqual(await createCoreClient(ok([])).listLayoutRevisions(), { ok: true, value: [] });
});

test('a list of revisions that is not sorted, repeats, holds more than 10, or has a bad element is a protocol error', async () => {
  const many = Array.from({ length: 11 }, (_, index) => ENTRY(12 - index));
  // eslint-disable-next-line no-sparse-arrays
  const bad: unknown[] = [null, {}, 'x', [ENTRY(1), ENTRY(2)], [ENTRY(2), ENTRY(2)], [ENTRY(0)], [ENTRY(-1)], [ENTRY(1.5)], many, [null], [{}], [{ revision: 1 }], [{ layout: HOME_DOC }], [{ revision: 1, layout: 'x' }], [ENTRY(3), , ENTRY(1)]];
  for (const result of bad) await assert.rejects(createCoreClient(ok(result)).listLayoutRevisions(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.revisions', JSON.stringify(result));
});

// The export
test('an export is the canonical text of a layout, and nothing else', async () => {
  const text = `${JSON.stringify(HOME_DOC)}\n`;
  assert.deepEqual(await createCoreClient(ok(text)).exportLayout(), { ok: true, value: text });
  const bad: unknown[] = [null, 5, {}, [], '', 'not json', JSON.stringify(HOME_DOC), ` ${text}`, text.replace('"hidden":[]', '"hidden":[ ]'), JSON.stringify({ ...HOME_DOC, extra: 1 }) + '\n', `${JSON.stringify({ ...HOME_DOC, shelf: [...HOME_DOC.shelf].reverse() })}\n`, `${text}${' '.repeat(40000)}`];
  for (const result of bad) await assert.rejects(createCoreClient(ok(result)).exportLayout(), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.export', String(result).slice(0, 30));
});

// The plans
test('a well-formed layout plan comes back as a frozen copy that drops other fields', async () => {
  const result = await swapping({ ...PLAN, extra: 'x' });
  assert.deepEqual(result, { ok: true, value: PLAN });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.steps), true);
});

test('a layout plan must answer the request: the kind, the place, the Gauge, the revision, and the text', async () => {
  const wrong: unknown[] = [{ ...PLAN, kind: 'default' }, { ...PLAN, place: 'other' }, { ...PLAN, gauge: 'other' }, { ...PLAN, place: null }, { ...PLAN, revision: 1 }, { ...PLAN, text: 'x' }];
  for (const plan of wrong) await assert.rejects(swapping(plan), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.plan', JSON.stringify(plan));
  assert.deepEqual(await createCoreClient(ok({ ...PLAN, kind: 'set', place: null, gauge: null, text: TEXT })).planLayoutSet(TEXT), { ok: true, value: { ...PLAN, kind: 'set', place: null, gauge: null, text: TEXT } });
  await assert.rejects(createCoreClient(ok({ ...PLAN, kind: 'set', place: null, gauge: null, text: `${TEXT} ` })).planLayoutSet(TEXT), CoreProtocolError);
  assert.deepEqual(await createCoreClient(ok({ ...PLAN, kind: 'default', gauge: null })).planLayoutDefault('models'), { ok: true, value: { ...PLAN, kind: 'default', gauge: null } });
  assert.deepEqual(await createCoreClient(ok({ ...PLAN, kind: 'restore', place: null, gauge: null, revision: 3 })).planLayoutRestore(3), { ok: true, value: { ...PLAN, kind: 'restore', place: null, gauge: null, revision: 3 } });
  await assert.rejects(createCoreClient(ok({ ...PLAN, kind: 'restore', place: null, gauge: null, revision: 4 })).planLayoutRestore(3), CoreProtocolError);
  assert.deepEqual(await createCoreClient(ok({ ...PLAN, kind: 'propose', place: null })).planLayoutPropose('tracing'), { ok: true, value: { ...PLAN, kind: 'propose', place: null } });
});

test('a layout plan with a missing or bad field is a protocol error', async () => {
  const bad: unknown[] = [
    null, 'x', [], {}, { ...PLAN, action: 'grant' }, { ...PLAN, action: 'swap' }, { ...PLAN, kind: 'explode' }, { ...PLAN, steps: 'x' }, { ...PLAN, steps: [5] }, { ...PLAN, steps: null },
    { ...PLAN, digest: 'abc' }, { ...PLAN, digest: A.toUpperCase() }, { ...PLAN, baseHash: 'x' }, { ...PLAN, nextHash: null }, { ...PLAN, nonce: 'x' }, { ...PLAN, nonce: `${D}0` }, { ...PLAN, nonce: 5 },
    { ...PLAN, place: 5 }, { ...PLAN, gauge: {} }, { ...PLAN, text: 5 }, { ...PLAN, revision: 'x' },
  ];
  for (const plan of bad) await assert.rejects(swapping(plan), CoreProtocolError, JSON.stringify(plan));
  // eslint-disable-next-line no-sparse-arrays
  await assert.rejects(swapping({ ...PLAN, steps: ['one', , 'three'] }), CoreProtocolError);
  const missing = { ...PLAN } as Record<string, unknown>;
  for (const field of Object.keys(PLAN)) {
    const copy = { ...missing };
    delete copy[field];
    await assert.rejects(swapping(copy), CoreProtocolError, field);
  }
});

test('a layout plan is read from own properties only', async () => {
  await assert.rejects(swapping(Object.create(PLAN)), CoreProtocolError);
});

// The applied change
test('an applied change must name the plan that it applied, and a change that was planned must have been made', async () => {
  const apply = (result: unknown, plan: LayoutPlan = PLAN) => createCoreClient(ok(result)).applyLayout(plan, 'approval');
  assert.deepEqual(await apply({ kind: 'swap', revision: 3, changed: true, extra: 1 }), { ok: true, value: { kind: 'swap', revision: 3, changed: true } });
  const result = await apply({ kind: 'swap', revision: 3, changed: true });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.deepEqual(await apply({ kind: 'swap', revision: 3, changed: false }, { ...PLAN, nextHash: PLAN.baseHash }), { ok: true, value: { kind: 'swap', revision: 3, changed: false } });
  const bad: unknown[] = [null, 'x', [], {}, { kind: 'default', revision: 3, changed: true }, { kind: 'swap', revision: 0, changed: true }, { kind: 'swap', revision: 1.5, changed: true }, { kind: 'swap', revision: '3', changed: true }, { kind: 'swap', revision: 3, changed: 'yes' }, { kind: 'swap', revision: 3 }, { revision: 3, changed: true }, { kind: 'swap', revision: 3, changed: false }];
  for (const value of bad) await assert.rejects(apply(value), (error: unknown) => error instanceof CoreProtocolError && error.method === 'bowerloom.layout.apply', JSON.stringify(value));
});

// The reasons
test('every layout reason is accepted with GAUGE_LAYOUT_INVALID, and the code needs one', async () => {
  for (const reason of LAYOUT_REASONS) assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'GAUGE_LAYOUT_INVALID', reason })).readLayout(), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason }, reason);
  for (const reason of [undefined, 'hidden', 'link', 'invalid_request_x', 'not_declared', 'clock_unusable', '', 5, null, '__proto__']) {
    await assert.rejects(createCoreClient(scripted({ ok: false, code: 'GAUGE_LAYOUT_INVALID', ...(reason === undefined ? {} : { reason }) })).readLayout(), CoreProtocolError, String(reason));
  }
});

test('every protected reason is accepted with GAUGE_PROTECTED, and so is no reason, and no other reason is', async () => {
  for (const reason of PROTECTED_REASONS) assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'GAUGE_PROTECTED', reason })).readLayout(), { ok: false, code: 'GAUGE_PROTECTED', reason }, reason);
  assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'GAUGE_PROTECTED' })).readLayout(), { ok: false, code: 'GAUGE_PROTECTED' });
  for (const reason of ['syntax', 'overlap', 'link', 'not_declared', 'clock_unusable', '', 5, '__proto__']) {
    await assert.rejects(createCoreClient(scripted({ ok: false, code: 'GAUGE_PROTECTED', reason })).readLayout(), CoreProtocolError, String(reason));
  }
});

test('a layout reason is refused with every other code, and a manifest reason still goes with the codes it went with', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'UNKNOWN_GAUGE', reason: 'overlap' })).readLayout(), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'GAUGE_PLAN_CHANGED', reason: 'hidden' })).readLayout(), CoreProtocolError);
  assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'syntax' })).readLayout(), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'syntax' });
});

test('a core that throws from the call itself is not wrapped for a layout call either', async () => {
  const failure = new Error('transport');
  const core: Core = { call: async () => { throw failure; } };
  await assert.rejects(createCoreClient(core).readLayout(), (error: unknown) => error === failure);
});
