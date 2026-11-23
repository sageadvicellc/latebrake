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
  const host = createEngineHost({ engines, launcher, locate: program => program, canonical: folder => folder, log: entry => faults.push(entry), newId: () => `s-${(counter += 1)}`, ...options });
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
  const r = rig({}, [spec('alpha', { env: ['PATH'] })]);
  const planned = r.host.planStart(request('alpha', '/work/one', { variables: ['PATH'] }));
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.variables, ['PATH']);
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
  const odd = rig({ canonical: () => '/real/../one' });
  assert.deepEqual(odd.host.planStart(request('alpha', '/work/one')), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder' }, 'a canonical path that fails the folder rules is refused too');
  const moved = rig({ canonical: folder => folder.replace('/link', '/real') });
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

test('an adapter that throws on a line is reported on standard error, and the session is left as it was', async () => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const r = rig({}, [spec('alpha', { signalOf: () => { throw new Error('adapter broke'); } })]);
    const id = await startOne(r, 'alpha', '/work/one');
    programOf(r, 0).line('anything');
    assert.equal(stateOf(r, id), 'starting');
    assert.deepEqual(lines, [`engine session ${id}: the adapter of alpha threw on a line: adapter broke\n`]);
  } finally {
    process.stderr.write = write;
  }
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
  assert.deepEqual(r.faults, []);
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
  const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: p => p, canonical: f => f, newId: () => 's-1' });
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
  const host = createEngineHost({ engines: [mutable], launcher, locate: p => p, canonical: f => f });
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
    const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: p => p, canonical: f => f, newId: () => queue.shift() ?? 'last', cap: 8 });
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
