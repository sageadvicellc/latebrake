import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply, GrantPlan } from '../src/types.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}
const ok = (result: unknown) => scripted({ ok: true, result });

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const PLAN: GrantPlan = { action: 'grant', id: 'fixture-solo', version: '1.0.0', permissions: ['engines.read', 'usage.read'], steps: ['one', 'two'], digest: A, manifestHash: B, folderHash: C, nonce: D };
const REQUEST = ['usage.read', 'engines.read'];
const planning = (result: unknown, request: readonly string[] = REQUEST) => createCoreClient(ok(result)).planGrant('fixture-solo', request);
const ENTRY = { permission: 'engines.read', manifestHash: B, folderHash: C, current: true };
const AUDIT = { seq: 1, at: '2026-01-02T03:04:05.006Z', action: 'grant', via: 'plan', id: 'fixture-solo', version: '1.0.0', permission: 'engines.read', manifestHash: B, folderHash: C };

test('each grants call sends its params under a bowerloom wire name', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  const client = createCoreClient(core);
  await client.planGrant('g1', ['b.x', 'a.y']);
  await client.applyGrant(PLAN, 'approval-1');
  await client.applyGrant(PLAN);
  await client.revoke('g2', ['usage.read']);
  await client.revokeTraces('g3');
  await client.listGrants('g4');
  await client.checkPermission('g5', 'engines.read', 'fixture-engine');
  await client.checkPermission('g6', 'layout.propose');
  await client.readAudit();
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.grants.plan', params: { id: 'g1', permissions: ['b.x', 'a.y'] } },
    { method: 'bowerloom.grants.apply', params: { plan: PLAN, approval: 'approval-1' } },
    { method: 'bowerloom.grants.apply', params: { plan: PLAN } },
    { method: 'bowerloom.grants.revoke', params: { id: 'g2', permissions: ['usage.read'] } },
    { method: 'bowerloom.grants.revoke', params: { id: 'g3', group: 'traces' } },
    { method: 'bowerloom.grants.list', params: { id: 'g4' } },
    { method: 'bowerloom.permissions.check', params: { gauge: 'g5', permission: 'engines.read', engine: 'fixture-engine' } },
    { method: 'bowerloom.permissions.check', params: { gauge: 'g6', permission: 'layout.propose' } },
    { method: 'bowerloom.audit.read', params: {} },
  ]);
});

test('the client sends a copy of the permissions and of the plan, so a core that changes them changes nothing for the caller', async () => {
  const request = ['engines.read'];
  const plan: GrantPlan = { ...PLAN, permissions: ['engines.read'], steps: ['one'] };
  const core: Core = { call: async (_method, params) => { (params['permissions'] as string[] | undefined)?.push('x'); const sent = params['plan'] as { steps: string[]; permissions: string[] } | undefined; sent?.steps.push('x'); sent?.permissions.push('x'); return { ok: false, code: 'UNKNOWN_GAUGE' }; } };
  const client = createCoreClient(core);
  await client.planGrant('fixture-solo', request);
  await client.revoke('fixture-solo', request);
  await client.applyGrant(plan);
  assert.deepEqual(request, ['engines.read']);
  assert.deepEqual(plan.steps, ['one']);
  assert.deepEqual(plan.permissions, ['engines.read']);
});

test('a well-formed grant plan comes back as a frozen copy that drops other fields', async () => {
  const result = await planning({ ...PLAN, extra: 'x' });
  assert.deepEqual(result, { ok: true, value: PLAN });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.steps), true);
  assert.equal(Object.isFrozen(result.value.permissions), true);
  assert.equal(Object.hasOwn(result.value, 'extra'), false);
});

test('a grant plan may carry no hashes, for a Gauge that the core started with', async () => {
  assert.deepEqual(await planning({ ...PLAN, manifestHash: null, folderHash: null }), { ok: true, value: { ...PLAN, manifestHash: null, folderHash: null } });
});

test('a grant plan of the wrong shape, or for another request, is a protocol error that names the method', async () => {
  const broken: unknown[] = [
    null, 'x', [], {}, { ...PLAN, action: 'install' }, { ...PLAN, action: undefined }, { ...PLAN, id: 'other' }, { ...PLAN, id: 5 }, { ...PLAN, version: null }, { ...PLAN, version: 1 },
    { ...PLAN, permissions: ['engines.read'] }, { ...PLAN, permissions: ['engines.read', 'usage.read', 'jobs.run'] }, { ...PLAN, permissions: ['usage.read', 'engines.read'] },
    { ...PLAN, permissions: ['engines.read', 'engines.read'] }, { ...PLAN, permissions: 'engines.read' }, { ...PLAN, permissions: [1, 2] }, { ...PLAN, permissions: ['engines.read', 'nothing.here'] },
    { ...PLAN, steps: 'x' }, { ...PLAN, steps: [1] }, { ...PLAN, steps: undefined },
    { ...PLAN, digest: 'z'.repeat(64) }, { ...PLAN, digest: 'a'.repeat(63) }, { ...PLAN, digest: 'A'.repeat(64) }, { ...PLAN, digest: 5 },
    { ...PLAN, manifestHash: 5 }, { ...PLAN, manifestHash: 'z'.repeat(64) }, { ...PLAN, manifestHash: undefined }, { ...PLAN, folderHash: 'c'.repeat(63) }, { ...PLAN, folderHash: undefined },
    { ...PLAN, nonce: null }, { ...PLAN, nonce: 'D'.repeat(64) }, { ...PLAN, nonce: 'd'.repeat(63) }, { ...PLAN, nonce: undefined },
  ];
  for (const result of broken) {
    await assert.rejects(planning(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.plan' && error.message.startsWith('bowerloom.grants.plan: '), JSON.stringify(result));
  }
});

test('a grant plan reply that asks for more permissions than were requested is refused, even when the list is valid', async () => {
  await assert.rejects(planning({ ...PLAN, permissions: ['engines.read', 'traces.facts', 'usage.read'] }), CoreProtocolError);
  await assert.rejects(planning({ ...PLAN, permissions: ['traces.facts'] }, ['traces.facts', 'traces.text']), CoreProtocolError);
  assert.ok((await planning({ ...PLAN, permissions: ['traces.facts', 'traces.text'] }, ['traces.text', 'traces.facts'])).ok);
});

test('a grant plan that mixes traces permissions with others is a protocol error, even when it is the plan that was asked for', async () => {
  const mixed = ['engines.read', 'traces.facts'];
  await assert.rejects(planning({ ...PLAN, permissions: mixed }, mixed), CoreProtocolError);
  assert.ok((await planning({ ...PLAN, permissions: ['traces.facts', 'traces.text'] }, ['traces.facts', 'traces.text'])).ok);
});

test('an own-property rule holds for a grant plan: a field that only the prototype holds reads as missing', async () => {
  const inherited = Object.create({ ...PLAN }) as unknown;
  await assert.rejects(planning(inherited), CoreProtocolError);
  const partial = Object.create({ nonce: D }, Object.fromEntries(Object.entries(PLAN).filter(([key]) => key !== 'nonce').map(([key, value]) => [key, { value, enumerable: true }]))) as unknown;
  await assert.rejects(planning(partial), CoreProtocolError);
});

test('a throwing getter in a reply is a protocol error, not the getter error', async () => {
  const hostile = { ...PLAN };
  Object.defineProperty(hostile, 'nonce', { enumerable: true, get() { throw new Error('boom'); } });
  await assert.rejects(planning(hostile), CoreProtocolError);
});

const applying = (result: unknown, plan: GrantPlan = PLAN) => createCoreClient(ok(result)).applyGrant(plan, 'approval');
const APPLIED = { id: 'fixture-solo', permissions: ['engines.read', 'usage.read'] };

test('an applied grant comes back as a frozen copy', async () => {
  const result = await applying({ ...APPLIED, extra: 1 });
  assert.deepEqual(result, { ok: true, value: APPLIED });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.permissions), true);
});

test('an applied grant that does not match the plan is a protocol error', async () => {
  for (const result of [null, 'x', {}, { ...APPLIED, id: 'other' }, { ...APPLIED, id: 5 }, { ...APPLIED, permissions: ['engines.read'] }, { ...APPLIED, permissions: ['engines.read', 'usage.read', 'jobs.run'] },
    { ...APPLIED, permissions: ['usage.read', 'engines.read'] }, { ...APPLIED, permissions: 'x' }, { ...APPLIED, permissions: [1, 2] }, { id: 'fixture-solo' }]) {
    await assert.rejects(applying(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.apply', JSON.stringify(result));
  }
});

const revoking = (result: unknown, permissions: readonly string[] = ['usage.read', 'engines.read']) => createCoreClient(ok(result)).revoke('fixture-solo', permissions);
const REVOKED = { id: 'fixture-solo', revoked: ['engines.read', 'usage.read'] };

test('a revoke reply must name exactly the permissions that were asked, sorted', async () => {
  assert.deepEqual(await revoking({ ...REVOKED, extra: 1 }), { ok: true, value: REVOKED });
  for (const result of [null, {}, { ...REVOKED, id: 'other' }, { ...REVOKED, revoked: ['engines.read'] }, { ...REVOKED, revoked: ['engines.read', 'usage.read', 'jobs.run'] },
    { ...REVOKED, revoked: ['usage.read', 'engines.read'] }, { ...REVOKED, revoked: 'x' }, { ...REVOKED, revoked: [5, 6] }, { id: 'fixture-solo' }]) {
    await assert.rejects(revoking(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.revoke', JSON.stringify(result));
  }
});

test('a reply to revoking the traces group holds only traces permissions, once, sorted, and at least one', async () => {
  const group = (result: unknown) => createCoreClient(ok(result)).revokeTraces('fixture-solo');
  assert.deepEqual(await group({ id: 'fixture-solo', revoked: ['traces.facts', 'traces.text'] }), { ok: true, value: { id: 'fixture-solo', revoked: ['traces.facts', 'traces.text'] } });
  assert.deepEqual(await group({ id: 'fixture-solo', revoked: ['traces.text'] }), { ok: true, value: { id: 'fixture-solo', revoked: ['traces.text'] } });
  for (const result of [null, {}, { id: 'other', revoked: ['traces.facts'] }, { id: 'fixture-solo', revoked: [] }, { id: 'fixture-solo', revoked: ['engines.read'] }, { id: 'fixture-solo', revoked: ['traces.facts', 'engines.read'] },
    { id: 'fixture-solo', revoked: ['traces.text', 'traces.facts'] }, { id: 'fixture-solo', revoked: ['traces.facts', 'traces.facts'] }, { id: 'fixture-solo', revoked: 'traces.facts' }]) {
    await assert.rejects(group(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.revoke', JSON.stringify(result));
  }
});

const listing = (result: unknown) => createCoreClient(ok(result)).listGrants('fixture-solo');

test('a list of grants comes back as frozen copies, sorted by name, and drops other fields', async () => {
  const second = { ...ENTRY, permission: 'usage.read', current: false };
  const result = await listing([{ ...ENTRY, extra: 1 }, second]);
  assert.deepEqual(result, { ok: true, value: [ENTRY, second] });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[0]), true);
  assert.deepEqual(await listing([]), { ok: true, value: [] });
  assert.deepEqual(await listing([{ ...ENTRY, manifestHash: null, folderHash: null }]), { ok: true, value: [{ ...ENTRY, manifestHash: null, folderHash: null }] });
});

test('a list of grants of the wrong shape is a protocol error', async () => {
  const second = { ...ENTRY, permission: 'usage.read' };
  for (const result of [null, {}, 'x', [null], [{}], [{ ...ENTRY, permission: 'nothing.here' }], [{ ...ENTRY, permission: 5 }], [{ ...ENTRY, current: 'yes' }], [{ ...ENTRY, current: undefined }],
    [{ ...ENTRY, manifestHash: 5 }], [{ ...ENTRY, manifestHash: 'z'.repeat(64) }], [{ ...ENTRY, folderHash: undefined }], [{ ...ENTRY, folderHash: 'c'.repeat(63) }],
    [second, ENTRY], [ENTRY, ENTRY], Object.create([ENTRY])]) {
    await assert.rejects(listing(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.list', JSON.stringify(result));
  }
});

const checking = (result: unknown, engine?: string) => createCoreClient(ok(result)).checkPermission('fixture-solo', 'engines.read', ...(engine === undefined ? [] : [engine]));

test('a permission check reply names the Gauge, the permission, and the engine that were asked', async () => {
  assert.deepEqual(await checking({ gauge: 'fixture-solo', permission: 'engines.read', engine: 'fixture-engine', extra: 1 }, 'fixture-engine'), { ok: true, value: { gauge: 'fixture-solo', permission: 'engines.read', engine: 'fixture-engine' } });
  assert.deepEqual(await checking({ gauge: 'fixture-solo', permission: 'engines.read', engine: null }), { ok: true, value: { gauge: 'fixture-solo', permission: 'engines.read', engine: null } });
  const frozen = await checking({ gauge: 'fixture-solo', permission: 'engines.read', engine: null });
  assert.ok(frozen.ok);
  assert.equal(Object.isFrozen(frozen.value), true);
  for (const [result, engine] of [
    [null, undefined], [{}, undefined], [{ gauge: 'other', permission: 'engines.read', engine: null }, undefined], [{ gauge: 'fixture-solo', permission: 'usage.read', engine: null }, undefined],
    [{ gauge: 'fixture-solo', permission: 'engines.read', engine: 'fixture-engine' }, undefined], [{ gauge: 'fixture-solo', permission: 'engines.read', engine: null }, 'fixture-engine'],
    [{ gauge: 'fixture-solo', permission: 'engines.read', engine: 'fixture-other' }, 'fixture-engine'], [{ gauge: 'fixture-solo', permission: 'engines.read' }, undefined], [{ gauge: 5, permission: 'engines.read', engine: null }, undefined],
  ] as const) {
    await assert.rejects(checking(result, engine), error => error instanceof CoreProtocolError && error.method === 'bowerloom.permissions.check', JSON.stringify(result));
  }
});

const reading = (result: unknown) => createCoreClient(ok(result)).readAudit();

test('an audit read gives frozen copies in the order of the file, and drops other fields', async () => {
  const second = { ...AUDIT, seq: 2, action: 'revoke', via: 'revoke' };
  const result = await reading([{ ...AUDIT, extra: 1 }, second]);
  assert.deepEqual(result, { ok: true, value: [AUDIT, second] });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[0]), true);
  assert.deepEqual(Object.keys(result.value[0] ?? {}), ['seq', 'at', 'action', 'via', 'id', 'version', 'permission', 'manifestHash', 'folderHash']);
  assert.deepEqual(await reading([]), { ok: true, value: [] });
  assert.deepEqual(await reading([{ ...AUDIT, seq: 41 }, { ...AUDIT, seq: 42, action: 'revoke', via: 'remove' }]), { ok: true, value: [{ ...AUDIT, seq: 41 }, { ...AUDIT, seq: 42, action: 'revoke', via: 'remove' }] });
});

test('an audit read of the wrong shape is a protocol error', async () => {
  const revoke = { ...AUDIT, action: 'revoke', via: 'revoke' };
  const bad: unknown[] = [
    null, {}, 'x', [null], [{}],
    [{ ...AUDIT, seq: 0 }], [{ ...AUDIT, seq: -1 }], [{ ...AUDIT, seq: 1.5 }], [{ ...AUDIT, seq: '1' }], [{ ...AUDIT, seq: Number.MAX_SAFE_INTEGER + 1 }],
    [AUDIT, AUDIT], [{ ...AUDIT, seq: 2 }, AUDIT],
    [{ ...AUDIT, at: 'yesterday' }], [{ ...AUDIT, at: '2026-01-02T03:04:05Z' }], [{ ...AUDIT, at: 5 }], [{ ...AUDIT, at: '2026-13-02T03:04:05.006Z' }],
    [{ ...AUDIT, action: 'allow' }], [{ ...AUDIT, via: 'magic' }], [{ ...AUDIT, via: 'revoke' }], [{ ...AUDIT, via: 'remove' }], [{ ...revoke, via: 'plan' }],
    [{ ...AUDIT, id: 5 }], [{ ...AUDIT, id: '' }], [{ ...AUDIT, version: 1 }], [{ ...AUDIT, version: undefined }], [{ ...AUDIT, permission: 'nothing.here' }], [{ ...AUDIT, permission: 5 }],
    [{ ...AUDIT, manifestHash: 5 }], [{ ...AUDIT, manifestHash: 'z'.repeat(64) }], [{ ...AUDIT, folderHash: undefined }],
  ];
  for (const result of bad) await assert.rejects(reading(result), error => error instanceof CoreProtocolError && error.method === 'bowerloom.audit.read', JSON.stringify(result));
});

test('a refusal of a grants call may carry a reason of the grant set, and only with GAUGE_GRANT_MISSING', async () => {
  const refused = (code: string, reason?: unknown) => createCoreClient(scripted(reason === undefined ? { ok: false, code } : { ok: false, code, reason })).checkPermission('fixture-solo', 'engines.read');
  for (const reason of ['unknown_permission', 'not_declared', 'engine_not_listed', 'gauge_disabled', 'not_held', 'invalid_request']) {
    assert.deepEqual(await refused('GAUGE_GRANT_MISSING', reason), { ok: false, code: 'GAUGE_GRANT_MISSING', reason });
  }
  assert.deepEqual(await refused('GAUGE_GRANT_MISSING'), { ok: false, code: 'GAUGE_GRANT_MISSING' });
  assert.deepEqual(await refused('GAUGE_GRANT_STALE'), { ok: false, code: 'GAUGE_GRANT_STALE' });
  assert.deepEqual(await refused('GAUGE_TRACES_OWN_STEP'), { ok: false, code: 'GAUGE_TRACES_OWN_STEP' });
  for (const [code, reason] of [['GAUGE_GRANT_STALE', 'not_held'], ['UNKNOWN_GAUGE', 'gauge_disabled'], ['GAUGE_TRACES_OWN_STEP', 'invalid_request'], ['GAUGE_GRANT_MISSING', 'made_up'], ['GAUGE_GRANT_MISSING', ''], ['GAUGE_GRANT_MISSING', 5], ['GAUGE_GRANT_MISSING', null], ['GAUGE_GRANT_MISSING', 'toString']] as const) {
    await assert.rejects(refused(code, reason), CoreProtocolError, `${code} ${String(reason)}`);
  }
});

test('a manifest reason with a manifest code is still accepted, and a manifest reason with the grant code is refused', async () => {
  const refused = (code: string, reason: string) => createCoreClient(scripted({ ok: false, code, reason })).planInstall('x');
  assert.deepEqual(await refused('GAUGE_MANIFEST_INVALID', 'unknown_permission'), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'unknown_permission' });
  assert.deepEqual(await refused('GAUGE_MANIFEST_INVALID', 'duplicate_key'), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'duplicate_key' });
  await assert.rejects(refused('GAUGE_GRANT_MISSING', 'duplicate_key'), CoreProtocolError);
});

test('a refusal code outside the registry on a grants call is a protocol error', async () => {
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'NOT_A_CODE' })).planGrant('x', ['engines.read']), CoreProtocolError);
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'NOT_A_CODE' })).readAudit(), CoreProtocolError);
});

test('a grants call that gets a reply with no boolean ok is a protocol error that names its method', async () => {
  const client = createCoreClient(scripted({ result: [] }));
  await assert.rejects(client.readAudit(), error => error instanceof CoreProtocolError && error.method === 'bowerloom.audit.read');
  await assert.rejects(client.listGrants('x'), error => error instanceof CoreProtocolError && error.method === 'bowerloom.grants.list');
});

test('a core that throws from a grants call is not wrapped', async () => {
  const failure = new Error('transport down');
  const client = createCoreClient({ call: async () => { throw failure; } });
  await assert.rejects(client.readAudit(), error => error === failure);
});
