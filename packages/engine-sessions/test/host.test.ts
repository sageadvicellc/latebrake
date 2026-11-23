// The host, with a launcher that starts no process: each event of a program is made by the test, so every state change is exact. The tests with real processes are in `host-process.test.ts`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SESSION_CAP, DEFAULT_STOP_TIMEOUT_MS, createEngineHost, type EngineHost, type EngineSpec, type HostOptions } from '../src/host.js';
import { fakeSignal } from '../src/fixtures.js';
import type { FaultEntry } from '../src/session.js';
import { manualLauncher } from './support.js';

const spec = (id: string, extra: Partial<EngineSpec> = {}): EngineSpec => ({ id, title: `Engine ${id}`, program: `/bin/${id}`, args: ['--flag'], env: [], billing: 'engine-plan', signalOf: fakeSignal, ...extra });

interface Rig {
  readonly host: EngineHost;
  readonly launcher: ReturnType<typeof manualLauncher>;
  readonly faults: FaultEntry[];
}
/** A host over the manual launcher. Folders are plain names, and programs are found as they are written. */
function rig(options: Partial<HostOptions> = {}, engines: readonly EngineSpec[] = [spec('alpha'), spec('beta'), spec('gamma')]): Rig {
  const launcher = manualLauncher();
  const faults: FaultEntry[] = [];
  let counter = 0;
  const host = createEngineHost({ engines, launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: entry => faults.push(entry), newId: () => `s-${(counter += 1)}`, ...options });
  return { host, launcher, faults };
}
const request = (engine: string, folder: unknown, extra: Record<string, unknown> = {}) => ({ engine, folder, ...extra });
/** Plans and begins a start, makes the program spawn, and gives the session id. */
async function startOne(r: Rig, engine: string, folder: string, extra: Record<string, unknown> = {}, shared = false): Promise<string> {
  const planned = r.host.planStart(request(engine, folder, extra));
  assert.ok(planned.ok, JSON.stringify(planned));
  const begun = r.host.beginStart(planned.plan, { sharedApproved: shared });
  assert.ok(begun.ok, JSON.stringify(begun));
  r.launcher.programs[r.launcher.programs.length - 1]?.spawn();
  const settled = await begun.settled;
  assert.ok(settled.ok, JSON.stringify(settled));
  return begun.session;
}
const programOf = (r: Rig, index: number) => {
  const program = r.launcher.programs[index];
  assert.ok(program, `program ${index}`);
  return program;
};
const stateOf = (r: Rig, id: string) => r.host.get(id)?.state;

// The plan

test('a start plan lists the engine, the real program, the folder, the model choice, the billing source, and the variables', () => {
  const r = rig({}, [spec('alpha', { env: ['PATH', 'HOME'], billing: 'local' })]);
  const planned = r.host.planStart(request('alpha', '/work/one', { variables: ['ZED', 'ALPHA'] }));
  assert.deepEqual(planned, {
    ok: true,
    plan: { engine: 'alpha', title: 'Engine alpha', program: '/bin/alpha', folder: '/work/one', model: null, billing: 'local', variables: ['ALPHA', 'HOME', 'PATH', 'ZED'], sharedWith: [] },
  });
});

test('a plan changes nothing: no session exists and no program was launched', () => {
  const r = rig();
  assert.ok(r.host.planStart(request('alpha', '/work/one')).ok);
  assert.deepEqual(r.host.list(), []);
  assert.equal(r.host.launched, 0);
  assert.equal(r.launcher.programs.length, 0);
});

test('a plan is frozen, and its lists are new on each call', () => {
  const r = rig();
  const first = r.host.planStart(request('alpha', '/work/one'));
  const second = r.host.planStart(request('alpha', '/work/one'));
  assert.ok(first.ok && second.ok);
  assert.equal(Object.isFrozen(first.plan), true);
  assert.equal(Object.isFrozen(first.plan.variables), true);
  assert.equal(Object.isFrozen(first.plan.sharedWith), true);
  assert.notEqual(first.plan.variables, second.plan.variables);
});

test('a declared variable and an allowed variable that are the same name are listed once', () => {
  const r = rig({}, [spec('alpha', { env: ['PATH', 'HOME'] })]);
  const planned = r.host.planStart(request('alpha', '/work/one', { variables: ['HOME'] }));
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.variables, ['HOME', 'PATH'], 'an engine may declare PATH');
  assert.ok(r.host.planStart(request('alpha', '/work/one', { variables: ['PATH'] })).ok, 'a name that the engine declares passes, so a plan that is planned again is accepted');
  const bare = rig({}, [spec('beta')]);
  assert.deepEqual(bare.host.planStart(request('beta', '/work/one', { variables: ['PATH'] })), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'variables' }, 'a caller may not ask for PATH');
});

test('a request that is malformed is refused with the field that is wrong, before any engine is looked up', () => {
  const r = rig();
  const bad: readonly (readonly [unknown, string])[] = [
    [null, 'engine'], ['alpha', 'engine'], [[], 'engine'], [undefined, 'engine'], [5, 'engine'],
    [request('Alpha', '/work/one'), 'engine'], [request('', '/work/one'), 'engine'], [{ folder: '/work/one' }, 'engine'], [request('nothing', 'relative'), 'folder'],
    [request('alpha', 'relative'), 'folder'], [request('alpha', '/'), 'folder'], [request('alpha', '/a/../b'), 'folder'], [request('alpha', '/a\nb'), 'folder'], [request('alpha', 5), 'folder'],
    [request('alpha', '/work/one', { model: 'x' }), 'model'], [request('alpha', '/work/one', { model: { provider: 'p' } }), 'model'],
    [request('alpha', '/work/one', { variables: 'A' }), 'variables'], [request('alpha', '/work/one', { variables: ['A', 'A'] }), 'variables'], [request('alpha', '/work/one', { variables: ['LD_PRELOAD'] }), 'variables'],
    [Object.create({ engine: 'alpha', folder: '/work/one' }), 'engine'],
  ];
  bad.forEach(([value, reason], index) => assert.deepEqual(r.host.planStart(value), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason }, `request ${index}`));
});

test('an engine that the host does not hold, or whose program is not on this computer, is ENGINE_NOT_FOUND', () => {
  const missing = rig({ locate: () => undefined });
  assert.deepEqual(missing.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_NOT_FOUND' });
  const r = rig();
  for (const id of ['nothing', 'constructor', 'proto', 'a'.repeat(64)]) assert.deepEqual(r.host.planStart(request(id, '/work/one')), { ok: false, code: 'ENGINE_NOT_FOUND' }, id);
});

test('a program whose real path holds a line break or another control character is not offered: it is ENGINE_NOT_FOUND', () => {
  for (const program of ['/bin/evil\nprogram', '/bin/evil\u2028program', '/bin/evil\u202eprogram', '/bin/evil\u0000program']) {
    const r = rig({ locate: () => program });
    assert.deepEqual(r.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_NOT_FOUND' }, JSON.stringify(program));
  }
});

test('a folder that the canonical function does not accept is a folder refusal, and a canonical path is the folder of the plan', () => {
  const none = rig({ canonical: () => undefined });
  assert.deepEqual(none.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder' });
  const odd = rig({ canonical: () => ({ path: '/real/../one', key: 'k' }) });
  assert.deepEqual(odd.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder' }, 'a canonical path that fails the folder rules is refused too');
  const moved = rig({ canonical: folder => ({ path: folder.replace('/link', '/real'), key: folder.replace('/link', '/real') }) });
  const planned = moved.host.planStart(request('alpha', '/link/one'));
  assert.ok(planned.ok);
  assert.equal(planned.plan.folder, '/real/one');
});

test('a model choice is refused for an engine that has no delivery path, and never dropped, and an engine that takes one passes it on', async () => {
  const r = rig({}, [spec('plain'), spec('picky', { modelArgs: choice => ['--model', `${choice.provider}:${choice.model}`] })]);
  const choice = { provider: 'local-llama', model: 'qwen' };
  assert.deepEqual(r.host.planStart(request('plain', '/work/one', { model: choice })), { ok: false, code: 'MODEL_NOT_FOR_ENGINE' });
  const planned = r.host.planStart(request('picky', '/work/one', { model: choice }));
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.model, choice);
  const begun = r.host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(programOf(r, 0).spec.args, ['--flag', '--model', 'local-llama:qwen']);
});

// The cap

test('the cap is 4 by default and the stop timeout is 5,000 ms', () => {
  assert.equal(DEFAULT_SESSION_CAP, 4);
  assert.equal(DEFAULT_STOP_TIMEOUT_MS, 5000);
});

test('a start past the cap of 4 is refused with ENGINE_LIMIT, and the fifth plan is refused before anything starts', async () => {
  const r = rig();
  for (const folder of ['/work/1', '/work/2', '/work/3', '/work/4']) await startOne(r, 'alpha', folder);
  assert.equal(r.host.list().length, 4);
  assert.deepEqual(r.host.planStart(request('alpha', '/work/5')), { ok: false, code: 'ENGINE_LIMIT' });
  assert.deepEqual(r.host.planStart(request('beta', '/work/5')), { ok: false, code: 'ENGINE_LIMIT' });
  assert.equal(r.host.launched, 4);
});

test('the cap counts the sessions that have not ended: a stopped one, a failed one, and an ended one free a place, and a stopping one keeps its place', async () => {
  const r = rig({ cap: 3 });
  const one = await startOne(r, 'alpha', '/work/1'), two = await startOne(r, 'alpha', '/work/2'), three = await startOne(r, 'alpha', '/work/3');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/4')), { ok: false, code: 'ENGINE_LIMIT' });
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  assert.equal(stateOf(r, one), 'stopped');
  assert.ok(r.host.planStart(request('alpha', '/work/4')).ok, 'a stopped session frees its place');
  const four = await startOne(r, 'alpha', '/work/4');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/5')), { ok: false, code: 'ENGINE_LIMIT' });
  programOf(r, 1).exit(1);
  assert.equal(stateOf(r, two), 'failed');
  assert.ok(r.host.planStart(request('alpha', '/work/5')).ok, 'a failed session frees its place');
  await startOne(r, 'alpha', '/work/5');
  // A session that is stopping still has a process, so it keeps its place.
  programOf(r, 2).line('state:running');
  assert.ok(r.host.beginStop(three).ok);
  assert.equal(stateOf(r, three), 'stopping');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/6')), { ok: false, code: 'ENGINE_LIMIT' });
  assert.equal(stateOf(r, four), 'starting');
});

test('a cap of 1 to 64 is accepted, and any other cap is refused when the host is made', () => {
  for (const cap of [1, 2, 64]) assert.doesNotThrow(() => rig({ cap }), String(cap));
  for (const cap of [0, -1, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4' as unknown as number]) assert.throws(() => rig({ cap }), RangeError, String(cap));
});

test('a stop timeout of 1 to 600,000 ms is accepted, and any other is refused when the host is made', () => {
  for (const stopTimeoutMs of [1, 5000, 600_000]) assert.doesNotThrow(() => rig({ stopTimeoutMs }), String(stopTimeoutMs));
  for (const stopTimeoutMs of [0, -5, 600_001, 2.5, Number.NaN]) assert.throws(() => rig({ stopTimeoutMs }), RangeError, String(stopTimeoutMs));
});

// One session for each engine and folder pair

test('one engine in one folder runs once: a second start of the pair is ENGINE_PAIR_BUSY, and the same engine in another folder is fine', async () => {
  const r = rig();
  await startOne(r, 'alpha', '/work/one');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  assert.ok(r.host.planStart(request('alpha', '/work/two')).ok);
});

test('the pair is free again once its session has ended', async () => {
  const r = rig();
  await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  assert.ok(r.host.planStart(request('alpha', '/work/one')).ok);
});

test('the pair check runs before the cap, so a busy pair is reported as busy at the cap', async () => {
  const r = rig({ cap: 1 });
  await startOne(r, 'alpha', '/work/one');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  assert.deepEqual(r.host.planStart(request('beta', '/work/one')), { ok: false, code: 'ENGINE_LIMIT' });
});

// A second engine in one folder

test('a second engine in a folder lists the engines already there, sorted, and needs a second approval to begin', async () => {
  const r = rig();
  await startOne(r, 'gamma', '/work/one');
  await startOne(r, 'alpha', '/work/one', {}, true);
  const planned = r.host.planStart(request('beta', '/work/one'));
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.sharedWith, ['alpha', 'gamma']);
  assert.deepEqual(r.host.beginStart(planned.plan, { sharedApproved: false }), { ok: false, code: 'ENGINE_FOLDER_SHARED' });
  assert.equal(r.host.launched, 2, 'no program was launched for the refused start');
  assert.equal(r.host.list().length, 2, 'and no session was made');
  const begun = r.host.beginStart(planned.plan, { sharedApproved: true });
  assert.ok(begun.ok);
  assert.equal(r.host.launched, 3);
});

test('an engine alone in its folder has an empty sharedWith, and a session that has ended is not shared with', async () => {
  const r = rig();
  const first = await startOne(r, 'alpha', '/work/one');
  const alone = r.host.planStart(request('beta', '/work/two'));
  assert.ok(alone.ok);
  assert.deepEqual(alone.plan.sharedWith, []);
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  assert.equal(stateOf(r, first), 'stopped');
  const after = r.host.planStart(request('beta', '/work/one'));
  assert.ok(after.ok);
  assert.deepEqual(after.plan.sharedWith, []);
});

test('beginStart plans again, and a plan that no longer matches the state throws: it is a bug in the caller, and never starts a program', async () => {
  const r = rig();
  const planned = r.host.planStart(request('beta', '/work/one'));
  assert.ok(planned.ok);
  await startOne(r, 'alpha', '/work/one', {}, false);
  assert.throws(() => r.host.beginStart(planned.plan, { sharedApproved: true }), /does not match the state now/);
  assert.equal(r.host.launched, 1);
  assert.equal(r.host.list().length, 1);
  const forged = { ...planned.plan, program: '/bin/evil' };
  assert.throws(() => r.host.beginStart(forged, { sharedApproved: true }), /does not match the state now/);
});

// States

test('a start walks detected, ready, starting, and the program running sets the state from its own lines', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  assert.equal(stateOf(r, id), 'starting');
  programOf(r, 0).line('state:running');
  assert.equal(stateOf(r, id), 'running');
  programOf(r, 0).line('a line that claims nothing');
  assert.equal(stateOf(r, id), 'running');
  programOf(r, 0).line('state:waiting');
  assert.equal(stateOf(r, id), 'waiting');
  programOf(r, 0).line('state:running');
  assert.equal(stateOf(r, id), 'running');
  assert.deepEqual(r.faults, []);
});

test('an engine that asks for its own sign-in at once puts the session in waiting, straight from starting', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:waiting');
  assert.equal(stateOf(r, id), 'waiting');
});

test('a line that repeats the state the session is in is no move and no fault', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).line('state:running');
  assert.equal(stateOf(r, id), 'running');
  programOf(r, 0).line('state:waiting');
  programOf(r, 0).line('state:waiting');
  assert.equal(stateOf(r, id), 'waiting');
  assert.deepEqual(r.faults, []);
});

test('a claim of an earlier state is an illegal move, and not a repeat', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).line('state:starting');
  assert.equal(stateOf(r, id), 'failed');
  assert.deepEqual(r.faults.map(entry => [entry.from, entry.to]), [['running', 'starting']]);
});

test('a claim that is not a legal move marks the session failed with illegal_move, logs the id and both states, and kills the program', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).line('state:ready');
  assert.equal(stateOf(r, id), 'failed');
  assert.equal(r.host.get(id)?.failure, 'illegal_move');
  assert.deepEqual(r.faults, [{ session: id, from: 'running', to: 'ready', message: `engine session ${id}: illegal move running -> ready` }]);
  assert.deepEqual(programOf(r, 0).signals, ['kill'], 'a failed session never has a live process');
});

test('a claim of a name that is not a state is a fault too', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:bogus');
  assert.equal(stateOf(r, id), 'failed');
  assert.deepEqual(r.faults.map(entry => [entry.from, entry.to]), [['starting', 'bogus']]);
  assert.deepEqual(programOf(r, 0).signals, ['kill']);
});

test('a program that ends with code 0 while running is stopped, and one that ends with an error code or a signal is failed with crashed', async () => {
  const r = rig();
  const ids = [await startOne(r, 'alpha', '/work/1'), await startOne(r, 'alpha', '/work/2'), await startOne(r, 'alpha', '/work/3'), await startOne(r, 'alpha', '/work/4')];
  ids.forEach((_id, index) => programOf(r, index).line(index === 3 ? 'state:waiting' : 'state:running'));
  programOf(r, 0).exit(0);
  programOf(r, 1).exit(2);
  programOf(r, 2).exit(null, 'SIGSEGV');
  programOf(r, 3).exit(0);
  assert.deepEqual(ids.map(id => [r.host.get(id)?.state, r.host.get(id)?.failure]), [['stopped', null], ['failed', 'crashed'], ['failed', 'crashed'], ['stopped', null]]);
  assert.deepEqual(r.faults.map(entry => [entry.session, entry.from, entry.to, entry.message]), [
    [ids[1], 'running', 'failed', `engine session ${ids[1]}: the program ended with code 2 and no signal`],
    [ids[2], 'running', 'failed', `engine session ${ids[2]}: the program ended with no code and the signal SIGSEGV`],
  ], 'a clean exit logs nothing, and a crash logs the code or the signal');
});

test('a program that ends before it ran, with any code, is a failed start', async () => {
  const r = rig();
  const zero = await startOne(r, 'alpha', '/work/1'), one = await startOne(r, 'alpha', '/work/2');
  programOf(r, 0).exit(0);
  programOf(r, 1).exit(1);
  assert.deepEqual([zero, one].map(id => [r.host.get(id)?.state, r.host.get(id)?.failure]), [['failed', 'start_failed'], ['failed', 'start_failed']]);
});

test('a program that cannot be started fails the session, and the start is refused with ENGINE_START_FAILED', async () => {
  const r = rig();
  const planned = r.host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  const begun = r.host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  programOf(r, 0).fail('spawn ENOENT');
  assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
  assert.deepEqual(r.host.list().map(item => [item.id, item.state, item.failure]), [[begun.session, 'failed', 'start_failed']]);
  assert.equal(r.host.launched, 1);
  assert.ok(r.host.planStart(request('alpha', '/work/one')).ok, 'the failed session frees its pair and its place');
});

test('a launcher that throws fails the session in the same way', async () => {
  const launcher = manualLauncher({ throwOnLaunch: true });
  const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: p => p, canonical: f => ({ path: f, key: f }), newId: () => 's-1' });
  const planned = host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  const begun = host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
  assert.deepEqual(host.list().map(item => [item.state, item.failure]), [['failed', 'start_failed']]);
});

test('an event after a session has ended changes nothing', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  programOf(r, 0).line('state:waiting');
  programOf(r, 0).exit(1);
  assert.equal(stateOf(r, id), 'stopped');
  assert.deepEqual(r.faults, []);
});

// Stop

test('a stop asks the program to go: the session is stopping at once, the program gets a term signal, and the session is stopped when the program has gone', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  const begun = r.host.beginStop(id);
  assert.ok(begun.ok);
  assert.equal(stateOf(r, id), 'stopping');
  assert.deepEqual(programOf(r, 0).signals, ['term']);
  programOf(r, 0).exit(0);
  const settled = await begun.settled;
  assert.ok(settled.ok);
  assert.equal(settled.info.state, 'stopped');
  assert.equal(settled.info.failure, null);
});

test('a stop that times out leaves the session stopping and reports ENGINE_STOP_TIMEOUT', async () => {
  const r = rig({ stopTimeoutMs: 40 });
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  assert.deepEqual(await r.host.stop(id), { ok: false, code: 'ENGINE_STOP_TIMEOUT' });
  assert.equal(stateOf(r, id), 'stopping');
  assert.deepEqual(programOf(r, 0).signals, ['term']);
});

test('after a timeout the session keeps its place, and a second stop sends the kill signal, then the session is stopped when the program goes', async () => {
  const r = rig({ stopTimeoutMs: 40, cap: 1 });
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  assert.deepEqual(await r.host.stop(id), { ok: false, code: 'ENGINE_STOP_TIMEOUT' });
  assert.deepEqual(r.host.planStart(request('beta', '/work/two')), { ok: false, code: 'ENGINE_LIMIT' });
  const planned = r.host.planStop(id);
  assert.ok(planned.ok);
  assert.equal(planned.plan.force, true);
  const second = r.host.beginStop(id);
  assert.ok(second.ok);
  assert.deepEqual(programOf(r, 0).signals, ['term', 'kill']);
  programOf(r, 0).exit(null, 'SIGKILL');
  const settled = await second.settled;
  assert.ok(settled.ok);
  assert.equal(settled.info.state, 'stopped');
});

test('a late exit after a timeout still moves the session from stopping to stopped', async () => {
  const r = rig({ stopTimeoutMs: 30 });
  const id = await startOne(r, 'alpha', '/work/one');
  assert.deepEqual(await r.host.stop(id), { ok: false, code: 'ENGINE_STOP_TIMEOUT' });
  programOf(r, 0).exit(0);
  assert.equal(stateOf(r, id), 'stopped');
  assert.deepEqual(r.faults, []);
});

test('a stopping session ignores what the engine still says: a late line is no move and no fault', async () => {
  const r = rig({ stopTimeoutMs: 30 });
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  await r.host.stop(id);
  programOf(r, 0).line('state:running');
  programOf(r, 0).line('state:waiting');
  programOf(r, 0).line('state:ready');
  assert.equal(stateOf(r, id), 'stopping');
  assert.deepEqual(r.faults, []);
});

test('a stop can begin from starting, running, and waiting', async () => {
  const r = rig();
  const ids = [await startOne(r, 'alpha', '/work/1'), await startOne(r, 'alpha', '/work/2'), await startOne(r, 'alpha', '/work/3')];
  programOf(r, 1).line('state:running');
  programOf(r, 2).line('state:waiting');
  for (const id of ids) assert.ok(r.host.beginStop(id).ok, id);
  assert.deepEqual(ids.map(id => stateOf(r, id)), ['stopping', 'stopping', 'stopping']);
});

test('a stop of a session that is not there is ENGINE_SESSION_UNKNOWN, and one that has ended is ENGINE_SESSION_ENDED, and a malformed id is a request refusal', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  assert.deepEqual(r.host.planStop(id), { ok: false, code: 'ENGINE_SESSION_ENDED' });
  assert.deepEqual(r.host.beginStop(id), { ok: false, code: 'ENGINE_SESSION_ENDED' });
  assert.deepEqual(await r.host.stop('s-99'), { ok: false, code: 'ENGINE_SESSION_UNKNOWN' });
  assert.deepEqual(r.host.planStop('constructor'), { ok: false, code: 'ENGINE_SESSION_UNKNOWN' });
  for (const bad of ['', 'S-1', '../x', 5, null, undefined, {}]) assert.deepEqual(r.host.planStop(bad), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'session' }, String(bad));
  assert.deepEqual(programOf(r, 0).signals, [], 'no signal went to a program that had ended');
});

test('a stop plan names the session, its engine and folder, and says force only when the session is stopping', async () => {
  const r = rig({ stopTimeoutMs: 20 });
  const id = await startOne(r, 'beta', '/work/one');
  assert.deepEqual(r.host.planStop(id), { ok: true, plan: { session: id, engine: 'beta', folder: '/work/one', force: false } });
  await r.host.stop(id);
  assert.deepEqual(r.host.planStop(id), { ok: true, plan: { session: id, engine: 'beta', folder: '/work/one', force: true } });
});

test('a planned stop changes nothing, and the program gets no signal', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  assert.ok(r.host.planStop(id).ok);
  assert.equal(stateOf(r, id), 'running');
  assert.deepEqual(programOf(r, 0).signals, []);
});

// Reads

test('a read gives a new frozen copy with no output of the engine, oldest first, and a filter by engine', async () => {
  const r = rig();
  const one = await startOne(r, 'alpha', '/work/1'), two = await startOne(r, 'beta', '/work/2'), three = await startOne(r, 'alpha', '/work/3');
  const all = r.host.list();
  assert.deepEqual(all.map(item => item.id), [one, two, three]);
  assert.deepEqual(r.host.list('alpha').map(item => item.id), [one, three]);
  assert.deepEqual(r.host.list('nothing'), []);
  assert.deepEqual(Object.keys(all[0] ?? {}).sort(), ['billing', 'engine', 'failure', 'folder', 'id', 'model', 'state']);
  const picky = rig({}, [spec('picky', { modelArgs: choice => [choice.model] })]);
  const chosen = await startOne(picky, 'picky', '/work/one', { model: { provider: 'p', model: 'm' } });
  const first = picky.host.get(chosen)?.model, second = picky.host.get(chosen)?.model;
  assert.deepEqual(first, { provider: 'p', model: 'm' });
  assert.notEqual(first, second, 'the model of a read is a new object each time');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(all), true);
  assert.equal(Object.isFrozen(all[0]), true);
  assert.notEqual(r.host.get(one), r.host.get(one));
  assert.equal(r.host.get('nothing'), undefined);
  assert.equal(r.host.get('__proto__'), undefined);
});

// Making the host

test('the host refuses a bad engine list when it is made', () => {
  const launcher = manualLauncher();
  const make = (engines: readonly EngineSpec[]) => () => createEngineHost({ engines, launcher });
  assert.throws(make([spec('alpha'), spec('alpha')]), /two engines have the id alpha/);
  assert.throws(make([spec('Alpha')]), RangeError);
  assert.throws(make([spec('alpha', { title: '' })]), RangeError);
  assert.throws(make([spec('alpha', { title: 'two\nlines' })]), RangeError, 'a title with a line break would forge a line of a plan');
  assert.throws(make([spec('alpha', { title: 'x'.repeat(65) })]), RangeError);
  assert.throws(make([spec('alpha', { program: '' })]), RangeError);
  assert.throws(make([spec('alpha', { args: [5 as unknown as string] })]), RangeError);
  assert.throws(make([spec('alpha', { env: ['1BAD'] })]), RangeError);
  assert.throws(make([spec('alpha', { env: ['LD_PRELOAD'] })]), RangeError);
  assert.throws(make([spec('alpha', { signalOf: 'x' as unknown as EngineSpec['signalOf'] })]), RangeError);
  assert.throws(make([spec('alpha', { modelArgs: 5 as unknown as (choice: { provider: string; model: string }) => readonly string[] })]), RangeError);
  assert.throws(make(Array.from({ length: 17 }, (_, index) => spec(`engine-${index}`))), /at most 16 engines/);
  assert.doesNotThrow(make(Array.from({ length: 16 }, (_, index) => spec(`engine-${index}`))));
  assert.doesNotThrow(make([]));
});

test('a provider key as the billing source is refused until the keys and spend work is built', () => {
  const launcher = manualLauncher();
  assert.throws(() => createEngineHost({ engines: [spec('alpha', { billing: 'provider-key' as unknown as 'local' })], launcher }), /a provider key waits for the keys and spend work/);
});

test('the host keeps its own copy of an engine: a caller that changes the spec afterwards changes nothing', () => {
  const mutable = { ...spec('alpha'), args: ['--one'], env: ['A'] };
  const launcher = manualLauncher();
  const host = createEngineHost({ engines: [mutable], launcher, locate: p => p, canonical: f => ({ path: f, key: f }) });
  (mutable.args as string[]).push('--two');
  (mutable.env as string[]).push('B');
  const planned = host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.variables, ['A']);
  assert.ok(host.beginStart(planned.plan, { sharedApproved: false }).ok);
  assert.deepEqual(launcher.programs[0]?.spec.args, ['--one']);
});

test('a session id that is malformed or already used is a bug in newId, and throws before any program starts', () => {
  for (const ids of [['BAD ID'], ['s-1', 's-1']]) {
    const launcher = manualLauncher();
    const queue = [...ids];
    const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: p => p, canonical: f => ({ path: f, key: f }), newId: () => queue.shift() ?? 'last', cap: 8 });
    const first = host.planStart(request('alpha', '/work/1'));
    assert.ok(first.ok);
    if (ids.length === 1) {
      assert.throws(() => host.beginStart(first.plan, { sharedApproved: false }), /malformed or already used/);
      assert.equal(launcher.programs.length, 0);
    } else {
      assert.ok(host.beginStart(first.plan, { sharedApproved: false }).ok);
      const second = host.planStart(request('alpha', '/work/2'));
      assert.ok(second.ok);
      assert.throws(() => host.beginStart(second.plan, { sharedApproved: false }), /malformed or already used/);
      assert.equal(launcher.programs.length, 1);
    }
  }
});

test('the environment is built from the variables the plan lists, from the source the host was given, and a name such as __proto__ is an ordinary variable', async () => {
  const source: Record<string, string | undefined> = { PATH: '/p', HOME: '/h', SECRET_TOKEN: 'no', EMPTY: undefined };
  Object.defineProperty(source, '__proto__', { value: 'proto-value', enumerable: true });
  const r = rig({ environment: () => source }, [spec('alpha', { env: ['PATH', 'EMPTY'] })]);
  const planned = r.host.planStart(request('alpha', '/work/one', { variables: ['HOME', '__proto__', 'NOT_SET', 'constructor'] }));
  assert.ok(planned.ok);
  assert.ok(r.host.beginStart(planned.plan, { sharedApproved: false }).ok);
  const env = programOf(r, 0).spec.env;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', '__proto__']);
  assert.equal(Object.getPrototypeOf(env), Object.prototype, 'the prototype of the environment is not replaced');
  assert.equal(Object.getOwnPropertyDescriptor(env, '__proto__')?.value, 'proto-value');
  assert.equal(env['HOME'], '/h');
  assert.equal(Object.hasOwn(env, 'SECRET_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'constructor'), false, 'a name that is only inherited in the source is not a value');
});

test('the program starts in the folder of the plan, with the arguments of the engine, and nothing else', async () => {
  const r = rig();
  await startOne(r, 'alpha', '/work/one');
  assert.deepEqual(programOf(r, 0).spec, { program: '/bin/alpha', args: ['--flag'], cwd: '/work/one', env: {} });
});

test('killAll sends the kill signal to every program that is still running, and waits for it to go', async () => {
  const r = rig();
  await startOne(r, 'alpha', '/work/1');
  await startOne(r, 'alpha', '/work/2');
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(0);
  const killing = r.host.killAll();
  assert.deepEqual(programOf(r, 0).signals, [], 'a program that has gone gets no signal');
  assert.deepEqual(programOf(r, 1).signals, ['kill']);
  programOf(r, 1).exit(null, 'SIGKILL');
  await killing;
  assert.deepEqual(r.host.list().map(item => item.state), ['stopped', 'failed']);
});

test('two starts of the same plan in a row: the second finds the pair busy and starts nothing', () => {
  const r = rig();
  const plan = r.host.planStart(request('alpha', '/work/one'));
  assert.ok(plan.ok);
  assert.ok(r.host.beginStart(plan.plan, { sharedApproved: false }).ok);
  assert.deepEqual(r.host.beginStart(plan.plan, { sharedApproved: false }), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  assert.equal(r.host.list().length, 1);
  assert.equal(r.host.launched, 1);
});

// The claims of an engine can move a session only to running or waiting

test('a claim of any other state is a fault, whatever the table says: the session is failed with illegal_move, the process is killed, and the id and both states are logged', async () => {
  for (const from of ['starting', 'running', 'waiting'] as const) {
    for (const claim of ['stopped', 'failed', 'stopping', 'detected', 'ready', 'starting']) {
      if (claim === from) continue;
      const r = rig();
      const id = await startOne(r, 'alpha', '/work/one');
      if (from !== 'starting') programOf(r, 0).line(`state:${from}`);
      programOf(r, 0).line(`state:${claim}`);
      assert.equal(stateOf(r, id), 'failed', `${from} ${claim}`);
      assert.equal(r.host.get(id)?.failure, 'illegal_move', `${from} ${claim}`);
      assert.deepEqual(r.faults, [{ session: id, from, to: claim, message: `engine session ${id}: illegal move ${from} -> ${claim}` }], `${from} ${claim}`);
      assert.deepEqual(programOf(r, 0).signals, ['kill'], `${from} ${claim}`);
    }
  }
});

test('a claim that is not text is a fault too', async () => {
  const r = rig({}, [spec('alpha', { signalOf: () => ({}) as unknown as string })]);
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('anything');
  assert.equal(stateOf(r, id), 'failed');
  assert.equal(r.host.get(id)?.failure, 'illegal_move');
  assert.deepEqual(programOf(r, 0).signals, ['kill']);
});

test('a session that a claim failed still counts for the pair, the cap, and the shared folder until its process has gone', async () => {
  const r = rig({ cap: 1 });
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('state:running');
  programOf(r, 0).line('state:stopped');
  assert.equal(stateOf(r, id), 'failed');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  assert.deepEqual(r.host.planStart(request('beta', '/work/two')), { ok: false, code: 'ENGINE_LIMIT' });
  assert.deepEqual(r.host.planStop(id), { ok: false, code: 'ENGINE_SESSION_ENDED' });
  const reads = [r.host.list(), r.host.list('alpha'), r.host.get(id)];
  assert.equal(reads.length, 3, 'a read does not throw');
  programOf(r, 0).exit(null, 'SIGKILL');
  assert.ok(r.host.planStart(request('alpha', '/work/one')).ok, 'the process has gone, so the pair is free');
  assert.equal(stateOf(r, id), 'failed');
});

test('a failed session always has a cause, so a session is failed if and only if it has a failure', async () => {
  const r = rig({ cap: 8 });
  const ids = [await startOne(r, 'alpha', '/work/1'), await startOne(r, 'alpha', '/work/2'), await startOne(r, 'alpha', '/work/3'), await startOne(r, 'alpha', '/work/4')];
  programOf(r, 0).line('state:stopped');
  programOf(r, 1).line('state:failed');
  programOf(r, 2).line('state:running');
  programOf(r, 2).exit(0);
  for (const info of r.host.list()) assert.equal(info.state === 'failed', info.failure !== null, info.id);
  assert.equal(r.host.get(ids[3] ?? '')?.failure, null);
});

// Two names for one folder

test('the pair rule and the shared folder rule use the key of the folder, so two spellings of one folder are one folder', async () => {
  const r = rig({ canonical: folder => ({ path: folder, key: folder.toLowerCase() }), cap: 8 });
  await startOne(r, 'alpha', '/Work/One');
  assert.deepEqual(r.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  const shared = r.host.planStart(request('beta', '/WORK/ONE'));
  assert.ok(shared.ok);
  assert.deepEqual(shared.plan.sharedWith, ['alpha']);
  assert.equal(shared.plan.folder, '/WORK/ONE', 'the plan shows the path for display');
  const apart = r.host.planStart(request('beta', '/work/two'));
  assert.ok(apart.ok);
  assert.deepEqual(apart.plan.sharedWith, []);
});

test('a start plans again with the key, so a folder that another name took in the meantime is a changed plan', async () => {
  const r = rig({ canonical: folder => ({ path: folder, key: folder.toLowerCase() }), cap: 8 });
  const planned = r.host.planStart(request('beta', '/Work/One'));
  assert.ok(planned.ok);
  await startOne(r, 'alpha', '/work/one');
  assert.throws(() => r.host.beginStart(planned.plan, { sharedApproved: true }), /does not match the state now/);
});

test('a canonical answer must hold a plain key: a key that is not text is a bug', () => {
  const r = rig({ canonical: folder => ({ path: folder, key: 5 as unknown as string }) });
  assert.throws(() => r.host.planStart(request('alpha', '/work/one')), /key/);
});

// The variables of a plan

test('the variables of a plan are at most 32, those of the engine and those allowed together, so no approved plan fails to start for a count', () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => `V${String(index).padStart(2, '0')}`);
  const r = rig({}, [spec('alpha', { env: ['ZED'] })]);
  assert.deepEqual(r.host.planStart(request('alpha', '/work/one', { variables: names(32) })), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'variables' });
  const fits = r.host.planStart(request('alpha', '/work/one', { variables: names(31) }));
  assert.ok(fits.ok);
  assert.equal(fits.plan.variables.length, 32);
  const overlap = r.host.planStart(request('alpha', '/work/one', { variables: [...names(31), 'ZED'] }));
  assert.ok(overlap.ok, 'a name that the engine declares and the person allows counts once');
  assert.equal(overlap.plan.variables.length, 32);
  const none = rig({}, [spec('beta')]);
  assert.ok(none.host.planStart(request('beta', '/work/one', { variables: names(32) })).ok);
});

// The adapter

test('an adapter that throws is a fault: the session fails with adapter_error, the program is killed, and the id and the message are logged', async () => {
  const r = rig({}, [spec('alpha', { signalOf: () => { throw new Error('adapter broke\nforged line'); } })]);
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('anything');
  assert.equal(stateOf(r, id), 'failed');
  assert.equal(r.host.get(id)?.failure, 'adapter_error');
  assert.deepEqual(r.faults, [{ session: id, from: 'starting', to: 'failed', message: `engine session ${id}: the adapter of alpha threw: adapter broke\\u{a}forged line` }]);
  assert.deepEqual(programOf(r, 0).signals, ['kill']);
  programOf(r, 0).line('more');
  assert.equal(r.faults.length, 1, 'a later line is ignored');
});

test('an adapter that throws something that is not an error is logged as text', async () => {
  const r = rig({}, [spec('alpha', { signalOf: () => { throw 'plain text'; } })]);
  const id = await startOne(r, 'alpha', '/work/one');
  programOf(r, 0).line('x');
  assert.equal(r.faults[0]?.message, `engine session ${id}: the adapter of alpha threw: plain text`);
});

// The start timeout

/** A schedule that runs nothing by itself: the test runs each callback when it chooses. */
function manualSchedule() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return { timers, schedule: (run: () => void, ms: number) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
}

test('a session that is still starting when the start timeout passes is failed with start_failed, killed, and logged', async () => {
  const clock = manualSchedule();
  const r = rig({ schedule: clock.schedule });
  const id = await startOne(r, 'alpha', '/work/one');
  assert.deepEqual(clock.timers.map(timer => timer.ms), [30_000], 'the default is 30,000 ms');
  clock.timers[0]?.run();
  assert.equal(stateOf(r, id), 'failed');
  assert.equal(r.host.get(id)?.failure, 'start_failed');
  assert.deepEqual(programOf(r, 0).signals, ['kill']);
  assert.deepEqual(r.faults.map(entry => [entry.session, entry.from, entry.to, entry.message]), [[id, 'starting', 'failed', `engine session ${id}: the program did not say it runs within 30000 ms`]]);
  programOf(r, 0).exit(null, 'SIGKILL');
  assert.equal(r.host.get(id)?.failure, 'start_failed');
});

test('the start timeout does nothing to a session that has moved on, and it is cancelled when the session leaves starting', async () => {
  for (const leave of [(p: ReturnType<typeof programOf>) => p.line('state:running'), (p: ReturnType<typeof programOf>) => p.line('state:waiting'), (p: ReturnType<typeof programOf>) => p.exit(0)]) {
    const clock = manualSchedule();
    const r = rig({ schedule: clock.schedule });
    const id = await startOne(r, 'alpha', '/work/one');
    leave(programOf(r, 0));
    assert.equal(clock.timers[0]?.cancelled, true);
    const before = stateOf(r, id);
    clock.timers[0]?.run();
    assert.equal(stateOf(r, id), before, 'even a timer that ran late changes nothing');
    assert.deepEqual(programOf(r, 0).signals.filter(signal => signal === 'kill'), []);
  }
});

test('a start timeout is cancelled by a stop and by a fault, and it is a whole number of milliseconds from 1 to 600,000', async () => {
  const clock = manualSchedule();
  const r = rig({ schedule: clock.schedule, startTimeoutMs: 1234 });
  const id = await startOne(r, 'alpha', '/work/one');
  assert.equal(clock.timers[0]?.ms, 1234);
  assert.ok(r.host.beginStop(id).ok);
  assert.equal(clock.timers[0]?.cancelled, true, 'a stop cancels it: a stopping session is not a failed start');
  const second = await startOne(r, 'alpha', '/work/two');
  programOf(r, 1).line('state:stopped');
  assert.equal(clock.timers[1]?.cancelled, true, 'a fault cancels it');
  assert.equal(stateOf(r, second), 'failed');
  for (const startTimeoutMs of [1, 30_000, 600_000]) assert.doesNotThrow(() => rig({ startTimeoutMs }), String(startTimeoutMs));
  for (const startTimeoutMs of [0, -1, 600_001, 1.5, Number.NaN]) assert.throws(() => rig({ startTimeoutMs }), RangeError, String(startTimeoutMs));
});

// Why a start failed

test('a program that cannot be started logs the cause with the session id, and the person-visible refusal stays bare', async () => {
  const r = rig();
  const planned = r.host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  const begun = r.host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  const error = Object.assign(new Error('spawn /bin/alpha ENOENT'), { code: 'ENOENT' });
  programOf(r, 0).fail(error.message, error.code);
  assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
  assert.deepEqual(r.faults, [{ session: begun.session, from: 'starting', to: 'failed', message: `engine session ${begun.session}: the program could not be started: ENOENT spawn /bin/alpha ENOENT` }]);
});

test('a launcher that throws logs the cause too', async () => {
  const faults: FaultEntry[] = [];
  const host = createEngineHost({ engines: [spec('alpha')], launcher: manualLauncher({ throwOnLaunch: true }), locate: p => p, canonical: f => ({ path: f, key: f }), newId: () => 's-1', log: entry => faults.push(entry) });
  const planned = host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  const begun = host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  await begun.settled;
  assert.deepEqual(faults.map(entry => entry.message), ['engine session s-1: the program could not be started: the launcher broke']);
});

test('a handle that was made before a throw is killed, so a failed start never leaves a live process', async () => {
  const launcher = manualLauncher({ throwOnListen: true });
  const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: p => p, canonical: f => ({ path: f, key: f }), newId: () => 's-1', log: () => undefined });
  const planned = host.planStart(request('alpha', '/work/one'));
  assert.ok(planned.ok);
  const begun = host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
  assert.deepEqual(launcher.programs[0]?.signals, ['kill']);
});

test('launched counts a program only when the launcher is asked: a modelArgs that throws asks for none', async () => {
  const r = rig({}, [spec('picky', { modelArgs: () => { throw new Error('no args'); } })]);
  const planned = r.host.planStart(request('picky', '/work/one', { model: { provider: 'p', model: 'm' } }));
  assert.ok(planned.ok);
  const begun = r.host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
  assert.equal(r.host.launched, 0);
  assert.equal(r.launcher.programs.length, 0);
});

test('only the value true is the second approval: any other value is not', async () => {
  for (const value of ['no', 1, 'true', {}, [], undefined, null]) {
    const r = rig();
    await startOne(r, 'alpha', '/work/one');
    const planned = r.host.planStart(request('beta', '/work/one'));
    assert.ok(planned.ok);
    assert.deepEqual(r.host.beginStart(planned.plan, { sharedApproved: value as unknown as boolean }), { ok: false, code: 'ENGINE_FOLDER_SHARED' }, String(value));
    assert.equal(r.host.launched, 1);
  }
});

// Why a session ended

test('a crash logs the code or the signal and the end of the standard error, escaped, and a stopping session that crashes stays stopped and logs the signal', async () => {
  const r = rig();
  const crashed = await startOne(r, 'alpha', '/work/1');
  programOf(r, 0).line('state:running');
  programOf(r, 0).exit(3, null, 'boom\nforged\u202e');
  assert.deepEqual(r.faults.map(entry => entry.message), [`engine session ${crashed}: the program ended with code 3 and no signal; the end of its standard error: "boom\\u{a}forged\\u{202e}"`]);
  const stopping = await startOne(r, 'alpha', '/work/2');
  programOf(r, 1).line('state:running');
  assert.ok(r.host.beginStop(stopping).ok);
  programOf(r, 1).exit(null, 'SIGSEGV');
  assert.equal(stateOf(r, stopping), 'stopped');
  assert.equal(r.faults[1]?.message, `engine session ${stopping}: the program ended with no code and the signal SIGSEGV while it was stopping`);
  assert.equal(r.faults.length, 2);
});

test('a stopping session that ends the way a stop makes it end logs nothing', async () => {
  const r = rig();
  const ids = [await startOne(r, 'alpha', '/work/1'), await startOne(r, 'alpha', '/work/2'), await startOne(r, 'alpha', '/work/3')];
  for (const id of ids) assert.ok(r.host.beginStop(id).ok);
  programOf(r, 0).exit(0);
  programOf(r, 1).exit(null, 'SIGTERM');
  programOf(r, 2).exit(null, 'SIGKILL');
  assert.deepEqual(r.faults, []);
});

test('a failed start by an early exit logs the code too', async () => {
  const r = rig();
  const id = await startOne(r, 'alpha', '/work/1');
  programOf(r, 0).exit(1, null, 'no such file');
  assert.deepEqual(r.faults.map(entry => entry.message), [`engine session ${id}: the program ended with code 1 and no signal; the end of its standard error: "no such file"`]);
});

test('killAll gives the number of programs that are still alive after the kill signal, and none when they have all gone', async () => {
  const r = rig({ killWaitMs: 20 });
  await startOne(r, 'alpha', '/work/1');
  await startOne(r, 'alpha', '/work/2');
  assert.equal(await r.host.killAll(), 2, 'neither program went');
  const again = r.host.killAll();
  programOf(r, 0).exit(null, 'SIGKILL');
  programOf(r, 1).exit(null, 'SIGKILL');
  assert.equal(await again, 0);
  assert.equal(await r.host.killAll(), 0);
});

test('the kill wait is a whole number of milliseconds from 1 to 60,000', () => {
  for (const killWaitMs of [1, 5000, 60_000]) assert.doesNotThrow(() => rig({ killWaitMs }), String(killWaitMs));
  for (const killWaitMs of [0, -1, 60_001, 1.5]) assert.throws(() => rig({ killWaitMs }), RangeError, String(killWaitMs));
});
