// `started` of a begun start: it resolves when the session has left `starting`, and says how. A program that spawns and then ends before it says it runs is a failed start, and so is a start that times out, an adapter that
// throws, a claim that no line may make, and a stop of the person's. Every refusal has its own reason. Time comes from a schedule that the test runs by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHost, type EngineHost, type EngineSpec, type HostOptions } from '../src/host.js';
import { fakeSignal } from '../src/fixtures.js';
import { manualLauncher } from './support.js';

const spec = (id: string, extra: Partial<EngineSpec> = {}): EngineSpec => ({ id, title: `Engine ${id}`, program: `/bin/${id}`, args: [], env: [], billing: 'engine-plan', signalOf: fakeSignal, ...extra });

function rig(engines: readonly EngineSpec[] = [spec('alpha')], options: Partial<HostOptions> = {}) {
  const launcher = manualLauncher();
  const timers: { run: () => void; cancelled: boolean }[] = [];
  let counter = 0;
  const host: EngineHost = createEngineHost({
    engines, launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined, newId: () => `s-${(counter += 1)}`,
    schedule: run => { const timer = { run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; }, stopTimeoutMs: 40, killWaitMs: 20, ...options,
  });
  return { host, launcher, timers };
}
function begin(host: EngineHost, engine = 'alpha', folder = '/w/a') {
  const planned = host.planStart({ engine, folder });
  assert.ok(planned.ok);
  const begun = host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  return begun;
}
const failed = (reason: string) => ({ ok: false, code: 'ENGINE_START_FAILED', reason });
/** True when the promise has not settled yet. */
const pending = (promise: Promise<unknown>): Promise<boolean> => Promise.race([promise.then(() => false), new Promise<boolean>(resolve => setImmediate(() => resolve(true)))]);

test('started resolves ok when the session claims running, and when it claims waiting; a spawn alone is not enough', async () => {
  const r = rig([spec('alpha'), spec('beta')]);
  const one = begin(r.host, 'alpha', '/w/a'), two = begin(r.host, 'beta', '/w/b');
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[1]?.spawn();
  assert.deepEqual(await one.settled, { ok: true, info: r.host.get(one.session) });
  assert.equal(await pending(one.started), true, 'the program has spawned and has not said that it runs');
  r.launcher.programs[0]?.line('state:running');
  r.launcher.programs[1]?.line('state:waiting');
  const first = await one.started, second = await two.started;
  assert.ok(first.ok && second.ok);
  assert.deepEqual([first.info.state, second.info.state], ['running', 'waiting']);
});

test('a program that spawns and then ends before it says it runs is a failed start with the reason exited, at once', async () => {
  const r = rig();
  const begun = begin(r.host);
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[0]?.exit(1);
  assert.deepEqual(await begun.started, failed('exited'));
  assert.equal(r.host.get(begun.session)?.state, 'failed');
  assert.equal((await begun.settled).ok, true, 'settled is the spawn, and it said ok');
});

test('a start that times out is a failed start with the reason timed_out, and the timer is the schedule of the host', async () => {
  const r = rig();
  const begun = begin(r.host);
  r.launcher.programs[0]?.spawn();
  assert.equal(r.timers.length, 1);
  r.timers[0]?.run();
  assert.deepEqual(await begun.started, failed('timed_out'));
  assert.equal((await begun.settled).ok, true, 'settled said ok at the spawn');
});

test('a start that times out before any spawn gives timed_out in both', async () => {
  const r = rig();
  const begun = begin(r.host);
  r.timers[0]?.run();
  assert.deepEqual(await begun.settled, failed('timed_out'));
  assert.deepEqual(await begun.started, failed('timed_out'));
});

test('a stop of the person during the start is the reason stopped, and so is the end of the host', async () => {
  const r = rig([spec('alpha'), spec('beta')]);
  const one = begin(r.host, 'alpha', '/w/a'), two = begin(r.host, 'beta', '/w/b');
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[1]?.spawn();
  const stopped = r.host.beginStop(one.session);
  assert.ok(stopped.ok);
  assert.deepEqual(await one.started, failed('stopped'));
  const killing = r.host.killAll();
  assert.deepEqual(await two.started, failed('stopped'));
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  r.launcher.programs[1]?.exit(null, 'SIGKILL');
  await killing;
});

test('an adapter that throws during the start is the reason adapter_error, and a claim that no line may make is illegal_claim', async () => {
  const r = rig([spec('alpha', { signalOf: () => { throw new Error('the adapter broke'); } }), spec('beta')]);
  const one = begin(r.host, 'alpha', '/w/a'), two = begin(r.host, 'beta', '/w/b');
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[1]?.spawn();
  r.launcher.programs[0]?.line('anything');
  r.launcher.programs[1]?.line('state:stopped');
  assert.deepEqual(await one.started, failed('adapter_error'));
  assert.deepEqual(await two.started, failed('illegal_claim'));
});

test('a launch that fails gives the same reason in started as in settled, also when the folder is the cause', async () => {
  const r = rig();
  const begun = begin(r.host);
  r.launcher.programs[0]?.fail('no program', 'ENOENT');
  assert.deepEqual(await begun.settled, failed('program_missing'));
  assert.deepEqual(await begun.started, failed('program_missing'));
  const adapter = rig([spec('alpha', { modelArgs: () => { throw new Error('no args'); } })]);
  const planned = adapter.host.planStart({ engine: 'alpha', folder: '/w/a', model: { provider: 'p', model: 'm' } });
  assert.ok(planned.ok);
  const second = adapter.host.beginStart(planned.plan, { sharedApproved: false });
  assert.ok(second.ok);
  assert.deepEqual(await second.started, failed('adapter_error'));
});

test('a session that has left starting once keeps the answer it gave: a later crash does not change started', async () => {
  const r = rig();
  const begun = begin(r.host);
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[0]?.line('state:running');
  const answer = await begun.started;
  r.launcher.programs[0]?.exit(2);
  assert.deepEqual(await begun.started, answer);
  assert.equal(r.host.get(begun.session)?.state, 'failed');
});

test('a host that is shut down while sessions start resolves every started', async () => {
  const r = rig([spec('alpha'), spec('beta')]);
  const plans = r.host.planStartGroup([{ engine: 'alpha', folder: '/w/a' }, { engine: 'beta', folder: '/w/b' }]);
  assert.ok(plans.ok);
  const group = r.host.beginStartGroup(plans.plans, { sharedApproved: false });
  assert.ok(group.ok);
  const killing = r.host.killAll();
  assert.deepEqual(await Promise.all(group.members.map(member => member.started)), [failed('stopped'), failed('stopped')]);
  r.launcher.programs[0]?.exit(null, 'SIGKILL');
  r.launcher.programs[1]?.exit(null, 'SIGKILL');
  await killing;
});
