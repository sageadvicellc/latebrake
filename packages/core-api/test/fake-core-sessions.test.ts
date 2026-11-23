import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeCore, type FakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createEngineHost, type EngineHost } from '../../engine-sessions/src/host.js';
import { createCoreClient } from '../src/client.js';
import { fakeEngine } from '../../engine-sessions/src/fixtures.js';
import { createProcessLauncher } from '../../engine-sessions/src/process-launcher.js';
import { assertNoLeaks } from '../../engine-sessions/test/leaks.js';
import { newTag, recording } from '../../engine-sessions/test/support.js';
import { SESSION_ENGINES, SESSION_ENVIRONMENT, SESSION_FOLDERS, runSessionsSuite, type SessionsHarness } from './sessions-suite.js';

/** The folders that a test makes are removed when the process ends. */
const roots: string[] = [];
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

export interface FakeRig extends SessionsHarness {
  readonly fake: FakeCore;
  readonly tag: string;
  readonly host: EngineHost;
}

/** A fake core over the Engine Host and the scriptable fake engines, as the suite describes them. The stop timeout is short, so a test of a stuck engine is quick. */
export function makeRig(folders: readonly GaugeFolder[], options: { readonly stopTimeoutMs?: number } = {}): FakeRig {
  let now = 1_000_000;
  const tag = newTag();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-suite-')));
  roots.push(root);
  const launcher = recording(createProcessLauncher());
  const stopTimeoutMs = options.stopTimeoutMs ?? 250;
  // The engines are configured with a link to the program, so that the real program is another path from the one that a Gauge reads.
  const programLink = path.join(root, 'engine-program');
  fs.symlinkSync(process.execPath, programLink);
  const engines = SESSION_ENGINES.map(fixture => {
    const spec = fakeEngine({ id: fixture.id, tag, steps: fixture.steps, ...(fixture.env === undefined ? {} : { env: fixture.env }), ...(fixture.takesModel === true ? { takesModel: true } : {}) });
    return fixture.missing === true ? { ...spec, program: path.join(root, 'no-such-program') } : { ...spec, program: programLink };
  });
  const host = createEngineHost({ engines, launcher, stopTimeoutMs, environment: () => SESSION_ENVIRONMENT });
  const fake = createFakeCore({ folders, now: () => now, engineHost: host });
  return {
    fake,
    tag,
    host,
    core: fake,
    approve: plan => fake.approve(plan.nonce),
    approveShared: plan => fake.approveShared(plan.nonce),
    advance: milliseconds => { now += milliseconds; },
    folder: name => { const full = path.join(root, name); fs.mkdirSync(full, { recursive: true }); return full; },
    link: (name, target) => { const full = path.join(root, name); fs.symlinkSync(target, full); return full; },
    person: plan => { const full = fake.personSessionPlan(plan.nonce); return { folder: full.realFolder, program: full.realProgram, sharedWith: full.allSharedWith }; },
    program: programLink,
    stopTimeoutMs,
    launches: () => host.launched,
    output: index => launcher.lines[index] ?? [],
    close: async () => { await host.killAll(); await assertNoLeaks(tag); },
  };
}

// The one sessions suite, run against the fake core over real fake engines.
runSessionsSuite('fake core sessions', folders => makeRig(folders));

// The fake core's own checks

const GAUGE = 'fixture-sessioner';
/** A rig with the Gauge installed, enabled, and granted the three session permissions. */
async function ready(t: TestContext, options: { readonly stopTimeoutMs?: number } = {}) {
  const rig = makeRig(SESSION_FOLDERS, options);
  t.after(() => rig.close());
  const client = createCoreClient(rig.fake);
  for (const step of [() => client.planInstall('sessioner-folder'), () => client.planEnable(GAUGE)]) {
    const planned = await step();
    assert.ok(planned.ok);
    assert.ok((await client.applyPlan(planned.value, rig.fake.approve(planned.value.nonce))).ok);
  }
  const grant = await client.planGrant(GAUGE, ['sessions.read', 'sessions.start', 'sessions.stop']);
  assert.ok(grant.ok);
  assert.ok((await client.applyGrant(grant.value, rig.fake.approve(grant.value.nonce))).ok);
  return { rig, client, fake: rig.fake };
}
const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const ENGINE = 'fixture-engine';

test('a core with no engine host refuses every engine as not found', async () => {
  const core = createFakeCore({ folders: SESSION_FOLDERS });
  const client = createCoreClient(core);
  for (const step of [() => client.planInstall('sessioner-folder'), () => client.planEnable(GAUGE)]) {
    const planned = await step();
    assert.ok(planned.ok);
    assert.ok((await client.applyPlan(planned.value, core.approve(planned.value.nonce))).ok);
  }
  const grant = must(await client.planGrant(GAUGE, ['sessions.start']));
  must(await client.applyGrant(grant, core.approve(grant.nonce)));
  assert.deepEqual(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: '/work/alpha' }), { ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine' });
});

test('a second approval is for a plan that names another engine in its folder, and for a plan that is still current', async t => {
  const { rig, client, fake } = await ready(t);
  const folder = rig.folder('alpha');
  const alone = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder }));
  assert.throws(() => fake.approveShared(alone.nonce), /a second approval is for a start in a folder that another engine uses/);
  assert.throws(() => fake.approveShared('0'.repeat(64)), /for a nonce that the core issued/);
  assert.throws(() => fake.approveShared(5 as unknown as string), TypeError);
  must(await client.applySession(alone, fake.approve(alone.nonce)));
  assert.throws(() => fake.approveShared(alone.nonce), TypeError, 'a plan that was applied is retired');
});

test('a throw while the host starts a program leaves the approval, the nonce, and the epoch as they were, so the same approval still applies', async t => {
  const rig = makeRig(SESSION_FOLDERS);
  t.after(() => rig.close());
  let broken = true;
  const flaky: EngineHost = { ...rig.host, launched: 0, stopTimeoutMs: rig.stopTimeoutMs, beginStart: (plan, approvals) => { if (broken) throw new Error('the host broke'); return rig.host.beginStart(plan, approvals); } };
  const fake = createFakeCore({ folders: SESSION_FOLDERS, engineHost: flaky });
  const client = createCoreClient(fake);
  for (const step of [() => client.planInstall('sessioner-folder'), () => client.planEnable(GAUGE)]) { const planned = must(await step()); must(await client.applyPlan(planned, fake.approve(planned.nonce))); }
  const grant = must(await client.planGrant(GAUGE, ['sessions.start', 'sessions.read']));
  must(await client.applyGrant(grant, fake.approve(grant.nonce)));
  const first = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const second = must(await client.planSessionStart(GAUGE, { engine: 'fixture-other', folder: rig.folder('beta') }));
  const firstApproval = fake.approve(first.nonce), secondApproval = fake.approve(second.nonce);
  const auditBefore = fake.auditFile();
  await assert.rejects(client.applySession(first, firstApproval), /the host broke/);
  assert.equal(rig.host.launched, 0);
  assert.equal(fake.auditFile(), auditBefore);
  broken = false;
  must(await client.applySession(first, firstApproval));
  assert.equal(rig.host.launched, 1, 'the same approval applies once the host works');
  assert.deepEqual((await client.applySession(second, secondApproval)).ok, false, 'and the start that applied ended the other approval, as every applied step does');
});

test('a start and a stop write nothing to the audit file: only grants and revokes do', async t => {
  const { rig, client, fake } = await ready(t);
  const before = fake.auditFile();
  const planned = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const started = must(await client.applySession(planned, fake.approve(planned.nonce)));
  const stop = must(await client.planSessionStop(GAUGE, started.session));
  must(await client.applySession(stop, fake.approve(stop.nonce)));
  assert.equal(fake.auditFile(), before);
});

test('a reply is a fresh copy: a caller that changes what the core gave changes nothing for the next call', async t => {
  const { rig, client, fake } = await ready(t);
  const started = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  must(await client.applySession(started, fake.approve(started.nonce)));
  const first = await fake.call('bowerloom.sessions.list', { gauge: GAUGE, engine: ENGINE });
  assert.ok(first.ok);
  const item = (first.result as { id: string }[])[0];
  assert.ok(item);
  item.id = 'changed';
  (first.result as unknown[]).length = 0;
  const second = await fake.call('bowerloom.sessions.list', { gauge: GAUGE, engine: ENGINE });
  assert.ok(second.ok);
  assert.equal((second.result as { id: string }[]).length, 1);
  assert.notEqual((second.result as { id: string }[])[0]?.id, 'changed');
  const plan = await fake.call('bowerloom.sessions.plan', { action: 'stop', gauge: GAUGE, session: (second.result as { id: string }[])[0]?.id });
  assert.ok(plan.ok);
  (plan.result as { steps: string[] }).steps.push('x');
  const again = await fake.call('bowerloom.sessions.plan', { action: 'stop', gauge: GAUGE, session: (second.result as { id: string }[])[0]?.id });
  assert.ok(again.ok);
  assert.equal((again.result as { steps: string[] }).steps.length, 4);
});

test('an unknown session action is a bug in the caller, and the core throws', async t => {
  const { fake } = await ready(t);
  await assert.rejects(fake.call('bowerloom.sessions.plan', { action: 'restart', gauge: GAUGE }), /unknown session action: restart/);
  await assert.rejects(fake.call('bowerloom.sessions.plan', { gauge: GAUGE }), /unknown session action: undefined/);
});

test('the core reads the plan it is sent from own properties, and treats a missing or odd field as a changed plan', async t => {
  const { rig, client, fake } = await ready(t);
  const planned = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const approval = fake.approve(planned.nonce);
  const apply = (plan: unknown) => fake.call('bowerloom.sessions.apply', { plan, approval });
  const changed = { ok: false, code: 'GAUGE_PLAN_CHANGED' };
  assert.deepEqual(await apply(null), changed);
  assert.deepEqual(await apply('plan'), changed);
  assert.deepEqual(await apply([]), changed);
  assert.deepEqual(await apply(Object.create(planned)), changed, 'a plan that only inherits its fields');
  for (const key of ['action', 'gauge', 'engine', 'folder', 'session', 'program', 'model', 'billing', 'variables', 'sharedWith', 'force', 'steps', 'digest', 'nonce']) {
    const copy: Record<string, unknown> = { ...planned };
    delete copy[key];
    assert.deepEqual(await apply(copy), changed, `without ${key}`);
  }
  for (const [key, value] of Object.entries({ action: 'restart', billing: 'provider-key', variables: 'A', sharedWith: 5, steps: [1], force: 'no', model: 'x', nonce: 5, gauge: 5 })) {
    assert.deepEqual(await apply({ ...planned, [key]: value }), changed, `with a bad ${key}`);
  }
  assert.deepEqual(await apply({ ...planned, variables: [...planned.variables, undefined] }), changed, 'a list with a hole or a non-text item');
  assert.deepEqual(await apply({ ...planned, digest: 'f'.repeat(64) }), changed, 'the digest is part of the plan that the Gauge read');
  const stillGood = await apply(planned);
  assert.equal(stillGood.ok, true, 'the plan as it was issued still applies, since no refusal used the approval up');
});

test('a stop plan that claims force while the session is not stopping is a changed plan, and so is one for another session', async t => {
  const { rig, client, fake } = await ready(t);
  const started = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const session = must(await client.applySession(started, fake.approve(started.nonce))).session;
  const other = must(await client.planSessionStart(GAUGE, { engine: 'fixture-other', folder: rig.folder('beta') }));
  const otherSession = must(await client.applySession(other, fake.approve(other.nonce))).session;
  const stop = must(await client.planSessionStop(GAUGE, session));
  const approval = fake.approve(stop.nonce);
  assert.deepEqual(await client.applySession({ ...stop, force: true }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.deepEqual(await client.applySession({ ...stop, session: otherSession }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.deepEqual(await client.applySession({ ...stop, steps: stop.steps.slice(1) }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal((await client.getSession(GAUGE, session)).ok, true);
  const gone = await client.applySession(stop, approval);
  assert.equal(gone.ok, true);
});

test('a plan for a shared folder is a changed plan once the other engine has gone, and nothing starts', async t => {
  const { rig, client, fake } = await ready(t);
  const folder = rig.folder('alpha');
  const first = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder }));
  must(await client.applySession(first, fake.approve(first.nonce)));
  const shared = must(await client.planSessionStart(GAUGE, { engine: 'fixture-other', folder }));
  assert.deepEqual(shared.sharedWith, [ENGINE]);
  const approval = fake.approve(shared.nonce), second = fake.approveShared(shared.nonce);
  // The first engine goes by itself, not through the core, so the core has no applied step and every approval is still good.
  const [running] = rig.host.list(ENGINE);
  assert.ok(running !== undefined);
  assert.equal((await rig.host.stop(running.id)).ok, true);
  assert.deepEqual(await client.applySession(shared, approval, second), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal(rig.host.launched, 1);
});

test('a host that is shutting down refuses a plan with ENGINE_START_FAILED and the reason shutting_down', async t => {
  const { rig, client } = await ready(t);
  await rig.host.killAll();
  assert.deepEqual(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }), { ok: false, code: 'ENGINE_START_FAILED', reason: 'shutting_down' });
  assert.equal(rig.host.launched, 0);
});

test('a plan made before a Gauge update, disable, or removal cannot start a session after it', async t => {
  const { rig, client, fake } = await ready(t);
  const planned = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const approval = fake.approve(planned.nonce);
  const disable = must(await client.planDisable(GAUGE));
  must(await client.applyPlan(disable, fake.approve(disable.nonce)));
  assert.deepEqual(await client.applySession(planned, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  assert.equal(rig.host.launched, 0);
});

test('the person who disables the Gauge ends its access to sessions at once', async t => {
  const { rig, client, fake } = await ready(t);
  const disable = must(await client.planDisable(GAUGE));
  must(await client.applyPlan(disable, fake.approve(disable.nonce)));
  assert.deepEqual(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'gauge_disabled' });
  assert.deepEqual(await client.listSessions(GAUGE, ENGINE), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'gauge_disabled' });
});

test('two plans of the same content and two nonces: the second approval of one never starts the other', async t => {
  const { rig, client, fake } = await ready(t);
  const folder = rig.folder('alpha');
  const first = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder }));
  must(await client.applySession(first, fake.approve(first.nonce)));
  const a = must(await client.planSessionStart(GAUGE, { engine: 'fixture-other', folder }));
  const b = must(await client.planSessionStart(GAUGE, { engine: 'fixture-other', folder }));
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.digest, b.digest, 'the digest holds the nonce, so no two plans share one');
  const approvalB = fake.approve(b.nonce), sharedA = fake.approveShared(a.nonce);
  assert.deepEqual(await client.applySession(b, approvalB, sharedA), { ok: false, code: 'ENGINE_FOLDER_SHARED' });
  assert.equal(rig.host.launched, 1);
  const sharedB = fake.approveShared(b.nonce);
  assert.equal((await client.applySession(b, approvalB, sharedB)).ok, true);
});

test('the lists of a plan that is sent back are read by index, from own data properties: an iterator, a subclass, and an accessor are a changed plan', async t => {
  const { rig, client, fake } = await ready(t);
  const planned = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const approval = fake.approve(planned.nonce);
  const apply = (plan: unknown) => fake.call('bowerloom.sessions.apply', { plan, approval });
  const changed = { ok: false, code: 'GAUGE_PLAN_CHANGED' };
  for (const key of ['variables', 'sharedWith', 'steps'] as const) {
    // The list holds one more item than the plan, and its iterator yields exactly the plan: a core that followed the iterator would accept it.
    const iterating: unknown[] = [...planned[key], 'extra'];
    Object.defineProperty(iterating, Symbol.iterator, { value: function* () { yield* planned[key]; } });
    class Sub extends Array {}
    const accessor: unknown[] = [...planned[key]];
    if (accessor.length === 0) accessor.push('x');
    Object.defineProperty(accessor, 0, { get() { return 'x'; }, enumerable: true });
    assert.deepEqual(await apply({ ...planned, [key]: Sub.from(planned[key]) }), changed, `${key} subclass`);
    assert.deepEqual(await apply({ ...planned, [key]: accessor }), changed, `${key} accessor`);
    assert.deepEqual(await apply({ ...planned, [key]: iterating }), changed, `${key} iterator`);
  }
  assert.equal((await apply(planned)).ok, true, 'no refusal used the approval up');
});

test('the lists of a grant or revoke that is sent in are read by index: a subclass, an iterator, and an accessor are an invalid request', async t => {
  const { fake } = await ready(t);
  class Sub extends Array {}
  const accessor = ['sessions.read'];
  Object.defineProperty(accessor, 0, { get() { return 'sessions.read'; }, enumerable: true });
  const iterating = ['sessions.read', 'extra'];
  Object.defineProperty(iterating, Symbol.iterator, { value: function* () { yield 'sessions.read'; } });
  for (const [label, list] of [['subclass', Sub.from(['sessions.read'])], ['accessor', accessor], ['iterator', iterating]] as const) {
    assert.deepEqual(await fake.call('bowerloom.grants.plan', { id: GAUGE, permissions: list }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: label === 'iterator' ? 'unknown_permission' : 'invalid_request' }, `plan ${label}`);
    assert.deepEqual(await fake.call('bowerloom.grants.revoke', { id: GAUGE, permissions: list }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: label === 'iterator' ? 'unknown_permission' : 'invalid_request' }, `revoke ${label}`);
  }
});

test('the steps of an old lifecycle, grant, or layout plan that is sent back are read by index too', async t => {
  const { client, fake } = await ready(t);
  const grant = must(await client.planGrant(GAUGE, ['sessions.read']));
  const approval = fake.approve(grant.nonce);
  class Sub extends Array {}
  const accessor = [...grant.steps];
  Object.defineProperty(accessor, 0, { get() { return grant.steps[0]; }, enumerable: true });
  const iterating = [...grant.steps, 'extra'];
  Object.defineProperty(iterating, Symbol.iterator, { value: function* () { yield* grant.steps; } });
  for (const hostile of [Sub.from(grant.steps), accessor, iterating]) {
    assert.deepEqual(await fake.call('bowerloom.grants.apply', { plan: { ...grant, steps: hostile }, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  }
  assert.equal((await fake.call('bowerloom.grants.apply', { plan: grant, approval })).ok, true);
});

test('the plan to stop a session that has ended but whose program may still run says so, and the plan for a stopping session keeps its text', async t => {
  const rig = makeRig(SESSION_FOLDERS);
  t.after(() => rig.close());
  let ended = false;
  const host: EngineHost = {
    ...rig.host, launched: 0, stopTimeoutMs: rig.stopTimeoutMs,
    get: id => { const found = rig.host.get(id); return found !== undefined && ended ? { ...found, state: 'failed' } : found; },
    planStop: id => { const planned = rig.host.planStop(id); return planned.ok && ended ? { ok: true, plan: { ...planned.plan, force: true } } : planned; },
  };
  const fake = createFakeCore({ folders: SESSION_FOLDERS, engineHost: host });
  const client = createCoreClient(fake);
  for (const step of [() => client.planInstall('sessioner-folder'), () => client.planEnable(GAUGE)]) { const planned = must(await step()); must(await client.applyPlan(planned, fake.approve(planned.nonce))); }
  const grant = must(await client.planGrant(GAUGE, ['sessions.read', 'sessions.start', 'sessions.stop']));
  must(await client.applyGrant(grant, fake.approve(grant.nonce)));
  const start = must(await client.planSessionStart(GAUGE, { engine: ENGINE, folder: rig.folder('alpha') }));
  const started = must(await client.applySession(start, fake.approve(start.nonce)));
  const live = must(await client.planSessionStop(GAUGE, started.session));
  assert.equal(live.force, false);
  assert.match(live.steps[2] ?? '', /^send the stop signal to the program/);
  ended = true;
  const plan = must(await client.planSessionStop(GAUGE, started.session));
  assert.equal(plan.force, true);
  assert.deepEqual(plan.steps.slice(2), [
    'the session has ended, but its program may still be running: send the kill signal again, which the program cannot ignore, to the program and everything it started',
    'the session keeps its state, and its place is free when the program has gone; if it does not go in time, the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
});
