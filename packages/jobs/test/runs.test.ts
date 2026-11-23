// The run book: it plans a run from a job, begins every session of the run as one group, reads a run as a group of sessions, and undoes a run whose start failed part way. A launcher that starts no process
// stands in for the programs, so every event is made by the test. The host waits for a stop with a real timer, so these tests give it a short stop wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHost, type EngineHost, type EngineSpec } from '../../engine-sessions/src/host.js';
import { fakeSignal } from '../../engine-sessions/src/fixtures.js';
import { KEEP_ENDED_SESSIONS } from '../../engine-sessions/src/vocab.js';
import { manualLauncher, waitFor } from '../../engine-sessions/test/support.js';
import { checkDefinition } from '../src/definition.js';
import { createRunBook, type RunBook } from '../src/runs.js';
import type { Job } from '../src/store.js';

const spec = (id: string): EngineSpec => ({ id, title: `Engine ${id}`, program: `/bin/${id}`, args: [], env: id === 'alpha' ? ['ALPHA_KEY'] : [], billing: id === 'delta' ? 'local' : 'engine-plan', signalOf: fakeSignal });

interface Timer { readonly run: () => void; cancelled: boolean }
interface Rig {
  readonly host: EngineHost;
  readonly book: RunBook;
  readonly launcher: ReturnType<typeof manualLauncher>;
  /** The start timeouts of the host, in the order they were set. The test runs one when it chooses: no test waits on a real start timeout. */
  readonly timers: Timer[];
  /** What the book logged. */
  readonly lines: string[];
}
function rig(options: { readonly cap?: number; readonly newId?: () => string; readonly stopTimeoutMs?: number; readonly engines?: readonly EngineSpec[] } = {}): Rig {
  const launcher = manualLauncher();
  const timers: Timer[] = [];
  const lines: string[] = [];
  let counter = 0;
  const host = createEngineHost({
    engines: options.engines ?? ['alpha', 'beta', 'gamma', 'delta'].map(spec), launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined,
    newId: () => `s-${(counter += 1)}`, schedule: run => { const timer: Timer = { run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; }, stopTimeoutMs: options.stopTimeoutMs ?? 2000, killWaitMs: 20, ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  let runs = 0;
  return { host, launcher, timers, lines, book: createRunBook({ host, newId: options.newId ?? (() => `run-${(runs += 1)}`), log: line => lines.push(line) }) };
}
function jobOf(sessions: readonly { label: string; engine: string; folder: string; task?: string; model?: unknown }[], title = 'Review'): Job {
  const checked = checkDefinition({ title, sessions: sessions.map(entry => ({ label: entry.label, engine: entry.engine, harness: 'plain-harness', folder: entry.folder, model: entry.model ?? null, task: entry.task ?? 'Do the work.' })) });
  assert.ok(checked.ok, JSON.stringify(checked));
  return { id: 'job-1', definition: checked.value };
}
const THREE = jobOf([{ label: 'writer', engine: 'alpha', folder: '/w/a' }, { label: 'checker', engine: 'beta', folder: '/w/b' }, { label: 'tester', engine: 'gamma', folder: '/w/c' }]);

function planned(book: RunBook, job: Job) {
  const result = book.plan(job);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}
function begun(book: RunBook, plan: ReturnType<typeof planned>, sharedApproved = false) {
  const result = book.begin(plan, { sharedApproved });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}
const refusal = (result: { ok: boolean }) => {
  assert.equal(result.ok, false);
  return result as { ok: false; code: string; reason?: string; index?: number; label?: string };
};
/** True when the promise has not settled by the end of this turn. */
const isPending = (promise: Promise<unknown>): Promise<boolean> => Promise.race([promise.then(() => false), new Promise<boolean>(resolve => setImmediate(() => resolve(true)))]);
/** The program of a member spawns, and says that it runs. */
function up(r: Rig, index: number, line = 'state:running'): void {
  r.launcher.programs[index]?.spawn();
  r.launcher.programs[index]?.line(line);
}
const member = (index: number, label: string) => ({ index, label });

// The plan

test('a run plan lists every session of the job, with what the person approves for each, and changes nothing', () => {
  const r = rig();
  const job = jobOf([
    { label: 'writer', engine: 'alpha', folder: '/w/a', task: 'Write the summary.' },
    { label: 'checker', engine: 'delta', folder: '/w/b', task: 'Check it.' },
  ], 'Morning review');
  const result = planned(r.book, job);
  assert.deepEqual(result.plan, {
    job: 'job-1', title: 'Morning review', shared: false,
    sessions: [
      { label: 'writer', engine: 'alpha', engineTitle: 'Engine alpha', harness: 'plain-harness', program: '/bin/alpha', folder: '/w/a', model: null, billing: 'engine-plan', variables: ['ALPHA_KEY'], sharedWith: [], task: 'Write the summary.' },
      { label: 'checker', engine: 'delta', engineTitle: 'Engine delta', harness: 'plain-harness', program: '/bin/delta', folder: '/w/b', model: null, billing: 'local', variables: [], sharedWith: [], task: 'Check it.' },
    ],
  });
  assert.equal(result.start.length, 2);
  assert.deepEqual(r.host.list(), []);
  assert.equal(r.host.launched, 0);
  assert.deepEqual(r.book.list(), []);
});

test('a plan is frozen, and a plan of the same job twice is the same plan', () => {
  const r = rig();
  const one = planned(r.book, THREE), two = planned(r.book, THREE);
  assert.deepEqual(one.plan, two.plan);
  assert.equal(Object.isFrozen(one.plan), true);
  assert.equal(Object.isFrozen(one.plan.sessions), true);
  assert.equal(Object.isFrozen(one.plan.sessions[0]), true);
  assert.equal(Object.isFrozen(one.plan.sessions[0]?.variables), true);
  assert.equal(Object.isFrozen(one.plan.sessions[0]?.sharedWith), true);
});

test('a session that shares a folder shows every other engine there, in both directions, and the plan says that a second approval is needed', () => {
  const r = rig();
  const job = jobOf([{ label: 'writer', engine: 'alpha', folder: '/w/a' }, { label: 'checker', engine: 'beta', folder: '/w/a' }, { label: 'tester', engine: 'gamma', folder: '/w/b' }]);
  const result = planned(r.book, job);
  assert.deepEqual(result.plan.sessions.map(session => session.sharedWith), [['beta'], ['alpha'], []]);
  assert.equal(result.plan.shared, true);
});

test('a folder that another engine already uses is shown too, and the run needs the second approval', async () => {
  const r = rig();
  const other = r.host.planStart({ engine: 'delta', folder: '/w/a' });
  assert.ok(other.ok);
  assert.ok(r.host.beginStart(other.plan, { sharedApproved: false }).ok);
  const result = planned(r.book, jobOf([{ label: 'writer', engine: 'alpha', folder: '/w/a' }]));
  assert.deepEqual(result.plan.sessions[0]?.sharedWith, ['delta']);
  assert.equal(result.plan.shared, true);
});

test('a run is refused with the refusal of the host, with its reason, when a session cannot start: an engine, a program, a model, a pair, and the cap', () => {
  const r = rig({ cap: 2 });
  assert.deepEqual(refusal(r.book.plan(THREE)), { ok: false, code: 'ENGINE_LIMIT', index: 2, label: 'tester' });
  assert.deepEqual(refusal(r.book.plan(jobOf([{ label: 'a', engine: 'no-such', folder: '/w/a' }]))), { ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', index: 0, label: 'a' });
  assert.deepEqual(refusal(r.book.plan(jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a', model: { provider: 'p', model: 'm' } }]))), { ok: false, code: 'MODEL_NOT_FOR_ENGINE', index: 0, label: 'a' });
  assert.deepEqual(refusal(r.book.plan(jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'alpha', folder: '/w/a' }]))), { ok: false, code: 'ENGINE_PAIR_BUSY', index: 1, label: 'b' });
  assert.deepEqual(r.host.list(), []);
});

// Beginning a run

test('a run begins every session of the plan before the call returns, and it waits until every session has said that it runs', async () => {
  const r = rig();
  const plan = planned(r.book, THREE);
  const run = begun(r.book, plan);
  assert.equal(run.run, 'run-1');
  assert.deepEqual(run.sessions, ['s-1', 's-2', 's-3']);
  assert.equal(r.launcher.programs.length, 3, 'every program was asked for before the call returned');
  assert.deepEqual(r.book.get('run-1'), {
    id: 'run-1', job: 'job-1', title: 'Review',
    sessions: [
      { label: 'writer', engine: 'alpha', session: 's-1', state: 'starting' },
      { label: 'checker', engine: 'beta', session: 's-2', state: 'starting' },
      { label: 'tester', engine: 'gamma', session: 's-3', state: 'starting' },
    ],
  });
  for (const program of r.launcher.programs) program.spawn();
  assert.equal(await isPending(run.settled), true, 'a spawn is not enough');
  r.launcher.programs[0]?.line('state:running');
  r.launcher.programs[1]?.line('state:running');
  assert.equal(await isPending(run.settled), true, 'one session has not said that it runs');
  r.launcher.programs[2]?.line('state:waiting');
  assert.deepEqual(await run.settled, { ok: true, run: 'run-1' });
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['running', 'running', 'waiting']);
  assert.deepEqual(r.book.list().map(view => view.id), ['run-1']);
  assert.deepEqual(r.lines, []);
});

test('a run is recorded at once: a second call in the same tick sees it, and the places of its sessions', () => {
  const r = rig({ cap: 3 });
  begun(r.book, planned(r.book, THREE));
  assert.equal(r.book.list().length, 1);
  assert.deepEqual(refusal(r.book.plan(jobOf([{ label: 'x', engine: 'delta', folder: '/w/d' }]))), { ok: false, code: 'ENGINE_LIMIT', index: 0, label: 'x' });
});

test('a run whose second approval is missing starts nothing and is not recorded, and the refusal names the session', () => {
  const r = rig();
  const plan = planned(r.book, jobOf([{ label: 'writer', engine: 'alpha', folder: '/w/a' }, { label: 'checker', engine: 'beta', folder: '/w/a' }]));
  assert.deepEqual(refusal(r.book.begin(plan, { sharedApproved: false })), { ok: false, code: 'ENGINE_FOLDER_SHARED', index: 1, label: 'checker' });
  assert.equal(r.launcher.programs.length, 0);
  assert.deepEqual(r.book.list(), []);
  const run = begun(r.book, plan, true);
  assert.equal(r.launcher.programs.length, 2);
  assert.equal(run.sessions.length, 2);
});

test('only the plan that the book made is begun: a plan that no longer matches the state is a bug of the caller', () => {
  const r = rig({ cap: 4 });
  const plan = planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/a' }]));
  const single = r.host.planStart({ engine: 'gamma', folder: '/w/a' });
  assert.ok(single.ok);
  assert.ok(r.host.beginStart(single.plan, { sharedApproved: false }).ok);
  assert.throws(() => r.book.begin(plan, { sharedApproved: true }), /do not match the state now/);
  assert.equal(r.launcher.programs.length, 1);
  assert.deepEqual(r.book.list(), []);
});

test('a plan whose sessions are not the sessions of the host plans, by position, is a bug of the caller, and throws before anything starts', () => {
  const r = rig();
  const plan = planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }]));
  const swapped = { plan: plan.plan, start: [plan.start[1], plan.start[0]] as typeof plan.start };
  assert.throws(() => r.book.begin(swapped, { sharedApproved: false }), /not the engine of the plan/);
  assert.equal(r.launcher.programs.length, 0);
});

test('a run id that is bad or repeated is a bug: it throws before any session starts', () => {
  const bad = rig({ newId: () => 'Bad Id' });
  assert.throws(() => bad.book.begin(planned(bad.book, THREE), { sharedApproved: false }), /run id/);
  assert.equal(bad.launcher.programs.length, 0);
  assert.deepEqual(bad.host.list(), []);
  const repeat = rig({ newId: () => 'run-1' });
  begun(repeat.book, planned(repeat.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }])));
  assert.throws(() => repeat.book.begin(planned(repeat.book, jobOf([{ label: 'b', engine: 'beta', folder: '/w/b' }])), { sharedApproved: false }), /run id/);
  assert.equal(repeat.launcher.programs.length, 1);
  const thrown = rig({ newId: () => { throw new Error('no ids'); } });
  assert.throws(() => thrown.book.begin(planned(thrown.book, THREE), { sharedApproved: false }), /no ids/);
  assert.equal(thrown.launcher.programs.length, 0);
});

test('an engine never starts another engine, also when its adapter turns what it prints into a request: the session faults and is killed, and nothing starts and the run does not grow', async () => {
  // A hostile adapter: it reads a line that asks for a start, or a state that no line may claim, as a claim of the session.
  const hostile = (id: string): EngineSpec => ({ ...spec(id), signalOf: line => (line.startsWith('start:') ? 'ready' : line.startsWith('run:') ? line : fakeSignal(line)) });
  const r = rig({ cap: 8, engines: [hostile('alpha'), hostile('beta'), spec('gamma')] });
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'writer', engine: 'alpha', folder: '/w/a' }, { label: 'checker', engine: 'beta', folder: '/w/b' }])));
  up(r, 0);
  up(r, 1);
  assert.deepEqual(await run.settled, { ok: true, run: 'run-1' });
  r.launcher.programs[0]?.line('start:gamma');
  r.launcher.programs[1]?.line('run:job-1');
  const states = r.book.get('run-1')?.sessions.map(session => session.state);
  assert.deepEqual(states, ['failed', 'failed'], 'a claim that no line may make fails the session');
  assert.deepEqual(r.host.list().map(session => session.failure), ['illegal_move', 'illegal_move']);
  assert.deepEqual(r.launcher.programs.map(program => program.signals), [['kill'], ['kill']], 'and its process group is killed');
  assert.equal(r.host.launched, 2, 'nothing was started');
  assert.equal(r.launcher.programs.length, 2);
  assert.equal(r.host.list().length, 2, 'no session was added to the host');
  assert.equal(r.book.get('run-1')?.sessions.length, 2, 'the run did not grow');
});

// A start that fails part way

test('a session that fails at once undoes the whole run at once, before any other session has said anything, and the failure is the failure of that session', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, THREE));
  r.launcher.programs[0]?.spawn();
  r.launcher.programs[1]?.fail('no program', 'ENOENT');
  // The third program has not spawned, and the first has not said that it runs. The stop of both is under way already.
  await waitFor(() => r.launcher.programs[0]?.signals.includes('term') === true && r.launcher.programs[2]?.signals.includes('term') === true, 'the stop of the others');
  assert.equal(await isPending(run.settled), true);
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  r.launcher.programs[2]?.exit(null, 'SIGTERM');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', run: 'run-1', member: member(1, 'checker') });
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopped', 'failed', 'stopped']);
  assert.deepEqual(r.lines, ['run book: the start of session s-2 (checker) of the run run-1 failed: ENGINE_START_FAILED program_missing']);
});

test('a program that spawns and then ends before it says it runs undoes the run: the others, running or not, are stopped, and the reason is exited', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, THREE));
  up(r, 0);
  r.launcher.programs[1]?.spawn();
  r.launcher.programs[2]?.spawn();
  assert.equal(await isPending(run.settled), true);
  r.launcher.programs[1]?.exit(1);
  await waitFor(() => r.launcher.programs[0]?.signals.includes('term') === true && r.launcher.programs[2]?.signals.includes('term') === true, 'the stop of the others');
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  r.launcher.programs[2]?.exit(null, 'SIGTERM');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'exited', run: 'run-1', member: member(1, 'checker') });
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopped', 'failed', 'stopped']);
});

test('a program that never says that it runs is cut off by the start timeout, and the run is undone with the reason timed_out', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, THREE));
  up(r, 0);
  up(r, 1);
  assert.equal(r.timers.length, 3, 'each session has its own start timeout');
  assert.equal(await isPending(run.settled), true, 'the third program has not spawned, and the run waits for it');
  r.timers[2]?.run();
  await waitFor(() => r.launcher.programs[0]?.signals.includes('term') === true && r.launcher.programs[1]?.signals.includes('term') === true && r.launcher.programs[2]?.signals.includes('kill') === true, 'the stop of the others, and the kill of the program that timed out');
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  r.launcher.programs[1]?.exit(null, 'SIGTERM');
  r.launcher.programs[2]?.exit(null, 'SIGKILL');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'timed_out', run: 'run-1', member: member(2, 'tester') });
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopped', 'stopped', 'failed']);
});

test('a stop of the person during the start undoes the run, with the reason stopped', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, THREE));
  up(r, 1);
  r.launcher.programs[0]?.spawn();
  const stopped = r.host.beginStop('s-1');
  assert.ok(stopped.ok);
  await waitFor(() => r.launcher.programs[1]?.signals.includes('term') === true && r.launcher.programs[2]?.signals.includes('term') === true, 'the stop of the others');
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  r.launcher.programs[1]?.exit(null, 'SIGTERM');
  r.launcher.programs[2]?.exit(null, 'SIGTERM');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'stopped', run: 'run-1', member: member(0, 'writer') });
});

test('when several sessions fail, the failure that happened first is given, whatever its place in the plan', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, THREE));
  r.launcher.programs[2]?.fail('late in the plan', 'ENOENT');
  r.launcher.programs[0]?.fail('first in the plan', 'EACCES');
  r.launcher.programs[1]?.spawn();
  await waitFor(() => r.launcher.programs[1]?.signals.includes('term') === true, 'the stop of the middle one');
  r.launcher.programs[1]?.exit(null, 'SIGTERM');
  const outcome = await run.settled;
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome, { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', run: 'run-1', member: member(2, 'tester') });
  assert.equal(r.lines.length, 1, 'the first failure is logged, and the others are its consequence');
});

test('a stop that times out is asked again with the kill signal, and a session that goes then does not fail the undo', async () => {
  const r = rig({ stopTimeoutMs: 100 });
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }])));
  up(r, 0);
  r.launcher.programs[1]?.fail('no program', 'ENOENT');
  await waitFor(() => r.launcher.programs[0]?.signals.includes('kill') === true, 'the kill signal');
  assert.deepEqual(r.launcher.programs[0]?.signals, ['term', 'kill']);
  r.launcher.programs[0]?.exit(null, 'SIGKILL');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', run: 'run-1', member: member(1, 'b') });
  assert.equal(r.book.get('run-1')?.sessions[0]?.state, 'stopped');
});

test('a session that cannot be stopped is a failed undo: GAUGE_RUN_ROLLBACK_FAILED with the run, the session that failed, and its cause, and the session that remains reads as it is', async () => {
  const r = rig({ stopTimeoutMs: 50 });
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }])));
  up(r, 0);
  r.launcher.programs[1]?.fail('no program', 'ENOENT');
  assert.deepEqual(await run.settled, { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member: member(1, 'b'), cause: 'program_missing' });
  assert.deepEqual(r.launcher.programs[0]?.signals, ['term', 'kill']);
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopping', 'failed']);
  assert.deepEqual(r.lines, [
    'run book: the start of session s-2 (b) of the run run-1 failed: ENGINE_START_FAILED program_missing',
    'run book: session s-1 of the run run-1 did not go in time, also after the kill signal',
  ]);
  r.launcher.programs[0]?.exit(null, 'SIGKILL');
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopped', 'failed']);
});

test('an undo that finds a session already ended is done: it is not a failure', async () => {
  const r = rig();
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }])));
  up(r, 0);
  r.launcher.programs[0]?.exit(0);
  r.launcher.programs[1]?.fail('no program', 'ENOENT');
  assert.deepEqual(await run.settled, { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', run: 'run-1', member: member(1, 'b') });
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => session.state), ['stopped', 'failed']);
});

test('after an undo the places are free: the same job plans and begins again', async () => {
  const r = rig({ cap: 2 });
  const job = jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }]);
  const run = begun(r.book, planned(r.book, job));
  up(r, 0);
  r.launcher.programs[1]?.fail('no program', 'ENOENT');
  await waitFor(() => r.launcher.programs[0]?.signals.includes('term') === true, 'the stop');
  r.launcher.programs[0]?.exit(null, 'SIGTERM');
  await run.settled;
  const again = begun(r.book, planned(r.book, job));
  assert.equal(again.run, 'run-2');
  assert.equal(r.launcher.programs.length, 4);
});

// Reading runs

test('an unknown run reads as missing: a name from the prototype and a value that is not an id too', () => {
  const r = rig();
  begun(r.book, planned(r.book, THREE));
  for (const id of ['run-9', 'toString', '__proto__', 'constructor', '', undefined, null, 1, {}]) assert.equal(r.book.get(id as string), undefined, String(id));
});

test('a read gives new frozen values each time', () => {
  const r = rig();
  begun(r.book, planned(r.book, THREE));
  const view = r.book.get('run-1');
  assert.ok(view);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.sessions), true);
  assert.equal(Object.isFrozen(view.sessions[0]), true);
  assert.notEqual(r.book.get('run-1'), view);
  const list = r.book.list();
  assert.equal(Object.isFrozen(list), true);
  assert.notEqual(r.book.list(), list);
});

test('the runs are listed oldest first', () => {
  const r = rig({ cap: 8 });
  begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }])));
  begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'beta', folder: '/w/b' }])));
  begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'gamma', folder: '/w/c' }])));
  assert.deepEqual(r.book.list().map(view => view.id), ['run-1', 'run-2', 'run-3']);
});

/** Begins a run of one session, brings it up, and ends it. Gives the run id. */
async function oneAndEnded(r: Rig, folder: string): Promise<string> {
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'alpha', folder }])));
  const program = r.launcher.programs[r.launcher.programs.length - 1];
  program?.spawn();
  program?.line('state:running');
  assert.deepEqual(await run.settled, { ok: true, run: run.run });
  program?.exit(0);
  return run.run;
}

test('the history is bounded by the history of the host: runs whose sessions the host dropped are dropped, and the longest list is the most sessions the host keeps', async () => {
  const r = rig({ cap: 1 });
  const total = KEEP_ENDED_SESSIONS + 50;
  for (let index = 0; index < total; index += 1) await oneAndEnded(r, `/w/${index}`);
  const list = r.book.list();
  assert.equal(list.length, KEEP_ENDED_SESSIONS, 'a run is kept while the host keeps its session');
  assert.equal(list[0]?.id, `run-${total - KEEP_ENDED_SESSIONS + 1}`);
  assert.equal(list[list.length - 1]?.id, `run-${total}`);
  assert.equal(r.book.get('run-1'), undefined, 'the oldest run is gone');
});

test('a run is pruned by the order its sessions ended, and not by the order it began: a long run that ends last outlives the runs that began after it', async () => {
  const r = rig({ cap: 2 });
  const long = begun(r.book, planned(r.book, jobOf([{ label: 'a', engine: 'beta', folder: '/long' }])));
  const longProgram = r.launcher.programs[0];
  up(r, 0);
  await long.settled;
  for (let index = 0; index < KEEP_ENDED_SESSIONS + 10; index += 1) await oneAndEnded(r, `/w/${index}`);
  assert.equal(r.book.get('run-1')?.sessions[0]?.state, 'running');
  longProgram?.exit(0);
  assert.equal(r.book.get('run-1')?.sessions[0]?.state, 'stopped');
  await oneAndEnded(r, '/w/last');
  assert.ok(r.book.get('run-1'), 'the run that ended after 256 others is among the newest 256 that ended');
  assert.equal(r.book.get('run-2'), undefined, 'a run that ended earlier was dropped');
});

test('a session that the host dropped reads as forgotten, in a run that still has a live session', async () => {
  const r = rig({ cap: 4 });
  const run = begun(r.book, planned(r.book, jobOf([{ label: 'quick', engine: 'beta', folder: '/q' }, { label: 'slow', engine: 'gamma', folder: '/s' }])));
  up(r, 0);
  up(r, 1);
  await run.settled;
  r.launcher.programs[0]?.exit(0);
  for (let index = 0; index < KEEP_ENDED_SESSIONS; index += 1) await oneAndEnded(r, `/w/${index}`);
  assert.deepEqual(r.book.get('run-1')?.sessions.map(session => `${session.label}:${session.state}`), ['quick:forgotten', 'slow:running']);
});

test('the book holds at most one record more than the host keeps, also when nobody reads the list', async () => {
  const r = rig({ cap: 1 });
  for (let index = 0; index < KEEP_ENDED_SESSIONS + 40; index += 1) await oneAndEnded(r, `/w/${index}`);
  assert.ok(r.book.size <= KEEP_ENDED_SESSIONS + 1, `the book holds ${r.book.size} records`);
  assert.equal(r.book.list().length, KEEP_ENDED_SESSIONS);
  assert.equal(r.book.size, KEEP_ENDED_SESSIONS);
});

/** A host over the manual launcher whose stop is scripted: it gives the answers in the list for each call, and counts the calls. */
function scriptedStop(answers: readonly { readonly ok: boolean; readonly code?: string }[]) {
  const launcher = manualLauncher();
  let counter = 0;
  const real = createEngineHost({
    engines: ['alpha', 'beta'].map(spec), launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined, newId: () => `s-${(counter += 1)}`, schedule: () => () => undefined,
  });
  const calls: string[] = [];
  const host: EngineHost = { ...real, stop: async session => { calls.push(String(session)); return (answers[Math.min(calls.length - 1, answers.length - 1)] ?? { ok: true }) as never; } };
  return { host, launcher, calls };
}
async function failedStart(answers: readonly { readonly ok: boolean; readonly code?: string }[], options: { readonly log?: (message: string) => void; readonly stop?: () => never } = {}) {
  const s = scriptedStop(answers);
  const host: EngineHost = options.stop === undefined ? s.host : { ...s.host, stop: options.stop };
  const book = createRunBook({ host, newId: () => 'run-1', ...(options.log === undefined ? { log: () => undefined } : { log: options.log }) });
  const result = book.plan(jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }, { label: 'b', engine: 'beta', folder: '/w/b' }]));
  assert.ok(result.ok);
  const run = book.begin(result, { sharedApproved: false });
  assert.ok(run.ok);
  s.launcher.programs[0]?.fail('no program', 'ENOENT');
  s.launcher.programs[1]?.fail('no program', 'ENOENT');
  return { outcome: await run.settled, calls: s.calls };
}
const START_FAILED = { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', run: 'run-1', member: member(0, 'a') };
const ROLLBACK_FAILED = { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member: member(0, 'a'), cause: 'program_missing' };

test('an undo is done when the host says a session has ended or is not held; any other refusal ends the undo for that session at once and fails it', async () => {
  for (const code of ['ENGINE_SESSION_ENDED', 'ENGINE_SESSION_UNKNOWN']) {
    const done = await failedStart([{ ok: false, code }]);
    assert.deepEqual(done.outcome, START_FAILED, code);
    assert.equal(done.calls.length, 2, `${code}: one stop for each session`);
  }
  const refused = await failedStart([{ ok: false, code: 'ENGINE_REQUEST_INVALID' }]);
  assert.deepEqual(refused.outcome, ROLLBACK_FAILED);
  assert.equal(refused.calls.length, 2, 'a refusal that is not a timeout is not asked again');
  const timeouts = await failedStart([{ ok: false, code: 'ENGINE_STOP_TIMEOUT' }]);
  assert.deepEqual(timeouts.outcome, ROLLBACK_FAILED);
  assert.equal(timeouts.calls.length, 4, 'a timeout is asked once more for each session, and no more');
  const then = await failedStart([{ ok: false, code: 'ENGINE_STOP_TIMEOUT' }, { ok: false, code: 'ENGINE_STOP_TIMEOUT' }, { ok: true }, { ok: true }]);
  assert.equal(then.calls.length, 4);
});

test('an undo that throws is a failed undo, and the outcome still arrives', async () => {
  const thrown = await failedStart([], { stop: () => { throw new Error('the host broke'); } });
  assert.deepEqual(thrown.outcome, ROLLBACK_FAILED);
});

test('a plan with a different number of sessions than the host plans is a bug of the caller, and throws before anything starts', () => {
  const r = rig();
  const plan = planned(r.book, THREE);
  assert.throws(() => r.book.begin({ plan: plan.plan, start: plan.start.slice(1) }, { sharedApproved: false }), /different number of sessions/);
  assert.throws(() => r.book.begin({ plan: { ...plan.plan, sessions: plan.plan.sessions.slice(1) }, start: plan.start }, { sharedApproved: false }), /different number of sessions/);
  assert.equal(r.launcher.programs.length, 0);
});

test('an undo that cannot stop a session says so in the log, with the run, the session, and the cause, and every value of the line is escaped', async () => {
  const lines: string[] = [];
  const thrown = await failedStart([], { log: line => lines.push(line), stop: () => { throw new Error('the host\nbroke‮'); } });
  assert.deepEqual(thrown.outcome, ROLLBACK_FAILED);
  assert.deepEqual(lines, [
    'run book: the start of session s-1 (a) of the run run-1 failed: ENGINE_START_FAILED program_missing',
    'run book: the stop of session s-1 for the run run-1 threw: the host\\u{a}broke\\u{202e}',
    'run book: the stop of session s-2 for the run run-1 threw: the host\\u{a}broke\\u{202e}',
  ]);
  const refused: string[] = [];
  await failedStart([{ ok: false, code: 'ENGINE_REQUEST_INVALID' }], { log: line => refused.push(line) });
  assert.deepEqual(refused.slice(1), ['run book: the stop of session s-1 for the run run-1 was refused: ENGINE_REQUEST_INVALID', 'run book: the stop of session s-2 for the run run-1 was refused: ENGINE_REQUEST_INVALID']);
  const timed: string[] = [];
  await failedStart([{ ok: false, code: 'ENGINE_STOP_TIMEOUT' }], { log: line => timed.push(line) });
  assert.deepEqual(timed.slice(1), ['run book: session s-1 of the run run-1 did not go in time, also after the kill signal', 'run book: session s-2 of the run run-1 did not go in time, also after the kill signal']);
});

test('an undo that works logs only the failure that caused it, and a log that throws never stops the outcome from arriving', async () => {
  const quiet: string[] = [];
  assert.deepEqual((await failedStart([{ ok: true }], { log: line => quiet.push(line) })).outcome, START_FAILED);
  assert.deepEqual(quiet, ['run book: the start of session s-1 (a) of the run run-1 failed: ENGINE_START_FAILED program_missing']);
  const broken = await failedStart([{ ok: false, code: 'ENGINE_REQUEST_INVALID' }], { log: () => { throw new Error('the log broke'); } });
  assert.deepEqual(broken.outcome, ROLLBACK_FAILED);
});

test('the default run id is run- and sixteen hexadecimal characters', () => {
  const launcher = manualLauncher();
  const host = createEngineHost({ engines: [spec('alpha')], launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined, schedule: () => () => undefined });
  const book = createRunBook({ host });
  const result = book.plan(jobOf([{ label: 'a', engine: 'alpha', folder: '/w/a' }]));
  assert.ok(result.ok);
  const run = book.begin(result, { sharedApproved: false });
  assert.ok(run.ok);
  assert.match(run.run, /^run-[0-9a-f]{16}$/);
});
