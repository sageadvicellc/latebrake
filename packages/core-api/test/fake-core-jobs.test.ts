import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore, type FakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createCoreClient } from '../src/client.js';
import { fakeSignal } from '../../engine-sessions/src/fixtures.js';
import { manualLauncher, waitFor } from '../../engine-sessions/test/support.js';
import type { EngineSpec } from '../../engine-sessions/src/host.js';
import type { Core } from '../src/types.js';
import { JOB_FOLDERS } from './jobs-suite.js';
import { createEngineHost, type EngineHost } from '../../engine-sessions/src/host.js';
import { fakeEngine } from '../../engine-sessions/src/fixtures.js';
import { createProcessLauncher } from '../../engine-sessions/src/process-launcher.js';
import { assertNoLeaks } from '../../engine-sessions/test/leaks.js';
import { newTag, recording } from '../../engine-sessions/test/support.js';
import { SESSION_ENVIRONMENT } from './sessions-suite.js';
import { JOB_ENGINES, runJobsSuite, type JobsHarness } from './jobs-suite.js';

/** The folders that a test makes are removed when the process ends. */
const roots: string[] = [];
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

export interface JobsRig extends JobsHarness {
  readonly fake: FakeCore;
  readonly tag: string;
  readonly host: EngineHost;
}

/** A fake core over the Engine Host and the scriptable fake engines, as the suite describes them. The stop timeout is short, so a test of a stuck engine is quick. */
export function makeJobsRig(folders: readonly GaugeFolder[], options: { readonly stopTimeoutMs?: number } = {}): JobsRig {
  let now = 1_000_000;
  let jobs = 0, runs = 0;
  const tag = newTag();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-suite-')));
  roots.push(root);
  const launcher = recording(createProcessLauncher());
  const engines = JOB_ENGINES.map(fixture => {
    const spec = fakeEngine({ id: fixture.id, tag, steps: fixture.steps, ...(fixture.env === undefined ? {} : { env: fixture.env }), ...(fixture.takesModel === true ? { takesModel: true } : {}) });
    return fixture.missing === true ? { ...spec, program: path.join(root, 'no-such-program') } : spec;
  });
  const host = createEngineHost({ engines, launcher, stopTimeoutMs: options.stopTimeoutMs ?? 250, environment: () => SESSION_ENVIRONMENT });
  const fake = createFakeCore({ folders, now: () => now, engineHost: host, jobIds: () => `job-${(jobs += 1)}`, runIds: () => `run-${(runs += 1)}` });
  return {
    fake,
    tag,
    host,
    core: fake,
    approve: plan => fake.approve(plan.nonce),
    approveShared: plan => fake.approveShared(plan.nonce),
    advance: milliseconds => { now += milliseconds; },
    folder: name => { const full = path.join(root, name); fs.mkdirSync(full, { recursive: true }); return full; },
    launches: () => host.launched,
    close: async () => { await host.killAll(); await assertNoLeaks(tag); },
  };
}

// The one jobs suite, run against the fake core over real fake engines.
runJobsSuite('fake core jobs', folders => makeJobsRig(folders));

// The fake core's own checks, over a host whose programs are made by the test, so every event is exact.

const GAUGE = 'fixture-jobber';
const spec = (id: string): EngineSpec => ({ id, title: `Engine ${id}`, program: `/bin/${id}`, args: [], env: [], billing: 'engine-plan', signalOf: fakeSignal });

/** A core over the manual launcher, with the Gauge installed, enabled, and granted every permission it declares. */
async function manual(options: { readonly stopTimeoutMs?: number; readonly jobCap?: number; readonly ids?: boolean } = {}) {
  const launcher = manualLauncher();
  let counter = 0, jobs = 0, runs = 0;
  const host = createEngineHost({
    engines: ['fixture-engine', 'fixture-other', 'fixture-stubborn'].map(spec), launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined,
    newId: () => `s-${(counter += 1)}`, schedule: () => () => undefined, stopTimeoutMs: options.stopTimeoutMs ?? 2000, killWaitMs: 20,
  });
  const fake = createFakeCore({
    folders: JOB_FOLDERS, engineHost: host, ...(options.jobCap === undefined ? {} : { jobCap: options.jobCap }),
    ...(options.ids === false ? {} : { jobIds: () => `job-${(jobs += 1)}`, runIds: () => `run-${(runs += 1)}` }),
  });
  const client = createCoreClient(fake);
  for (const step of [() => client.planInstall('jobber-folder'), () => client.planEnable(GAUGE)]) {
    const planned = await step();
    assert.ok(planned.ok);
    assert.ok((await client.applyPlan(planned.value, fake.approve(planned.value.nonce))).ok);
  }
  const grant = await client.planGrant(GAUGE, ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start', 'sessions.read', 'sessions.stop']);
  assert.ok(grant.ok);
  assert.ok((await client.applyGrant(grant.value, fake.approve(grant.value.nonce))).ok);
  return { launcher, host, fake, client };
}
type Manual = Awaited<ReturnType<typeof manual>>;
const entry = (label: string, engine: string, folder: string) => ({ label, engine, harness: 'plain-harness', folder, model: null, task: `Task of ${label}.` });
const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
async function makeJob(m: Manual, sessions: readonly Record<string, unknown>[]): Promise<string> {
  const plan = must(await m.client.planJobCreate(GAUGE, { title: 'Review', sessions }));
  return must(await m.client.applyJob(plan, m.fake.approve(plan.nonce))).job;
}
const THREE = [entry('a', 'fixture-engine', '/w/a'), entry('b', 'fixture-other', '/w/b'), entry('c', 'fixture-stubborn', '/w/c')];

test('a run whose session fails to start gives the failure of that session through the core, with its reason, and every other session is stopped', async () => {
  const m = await manual();
  const job = await makeJob(m, THREE);
  const plan = must(await m.client.planRun(GAUGE, job));
  const approval = m.fake.approve(plan.nonce);
  const applying = m.client.applyRun(plan, approval);
  assert.equal(m.launcher.programs.length, 3, 'every program was asked for before the first wait');
  m.launcher.programs[0]?.spawn();
  m.launcher.programs[1]?.fail('no program', 'ENOENT');
  m.launcher.programs[2]?.spawn();
  await waitFor(() => m.launcher.programs[0]?.signals.includes('term') === true && m.launcher.programs[2]?.signals.includes('term') === true, 'the stop of the others');
  m.launcher.programs[0]?.exit(null, 'SIGTERM');
  m.launcher.programs[2]?.exit(null, 'SIGTERM');
  assert.deepEqual(await applying, { ok: false, code: 'ENGINE_START_FAILED', reason: 'program_missing', member: { index: 1, label: 'b' }, run: 'run-1' });
  const run = must(await m.client.getRun(GAUGE, 'run-1'));
  assert.deepEqual(run.sessions.map(session => session.state), ['stopped', 'failed', 'stopped']);
  // The approval was used up, so the same plan is not applied again.
  assert.deepEqual(await m.client.applyRun(plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  assert.equal(m.host.launched, 3);
});

test('a run whose started session cannot be stopped gives GAUGE_RUN_ROLLBACK_FAILED, and the run stays readable with the session that remains', async () => {
  const m = await manual({ stopTimeoutMs: 40 });
  const job = await makeJob(m, THREE.slice(0, 2));
  const plan = must(await m.client.planRun(GAUGE, job));
  const applying = m.client.applyRun(plan, m.fake.approve(plan.nonce));
  m.launcher.programs[0]?.spawn();
  m.launcher.programs[1]?.fail('no program', 'ENOENT');
  assert.deepEqual(await applying, { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member: { index: 1, label: 'b' }, cause: 'program_missing' });
  assert.deepEqual(must(await m.client.getRun(GAUGE, 'run-1')).sessions.map(session => session.state), ['stopping', 'failed']);
  m.launcher.programs[0]?.exit(null, 'SIGKILL');
  assert.deepEqual(must(await m.client.getRun(GAUGE, 'run-1')).sessions.map(session => session.state), ['stopped', 'failed']);
});

test('the default ids of a job and of a run are random: a prefix and sixteen hexadecimal characters, and no two are alike', async () => {
  const m = await manual({ ids: false });
  const one = await makeJob(m, [THREE[0] ?? {}]);
  const two = await makeJob(m, [THREE[1] ?? {}]);
  assert.match(one, /^job-[0-9a-f]{16}$/);
  assert.notEqual(one, two);
  const plan = must(await m.client.planRun(GAUGE, one));
  const applying = m.client.applyRun(plan, m.fake.approve(plan.nonce));
  m.launcher.programs[0]?.spawn();
  m.launcher.programs[0]?.line('state:running');
  const run = must(await applying);
  assert.match(run.id, /^run-[0-9a-f]{16}$/);
});

test('the number of jobs is limited by the option of the core', async () => {
  const m = await manual({ jobCap: 2 });
  await makeJob(m, [THREE[0] ?? {}]);
  await makeJob(m, [THREE[1] ?? {}]);
  assert.deepEqual(await m.client.planJobCreate(GAUGE, { title: 'x', sessions: [THREE[0]] }), { ok: false, code: 'GAUGE_JOB_LIMIT' });
});

test('a job change of a kind that is not one is a bug of the caller, and throws', async () => {
  const m = await manual();
  await assert.rejects(m.fake.call('bowerloom.jobs.plan', { kind: 'merge', gauge: GAUGE }), /unknown job change/);
});

test('a job plan that is not a whole plan is refused as changed, and a plan that holds a definition the check refuses too', async () => {
  const m = await manual();
  const plan = must(await m.client.planJobCreate(GAUGE, { title: 'Review', sessions: [THREE[0]] }));
  const approval = m.fake.approve(plan.nonce);
  const accessor = { ...plan } as Record<string, unknown>;
  Object.defineProperty(accessor, 'steps', { get: () => plan.steps, enumerable: true });
  const holey = [...plan.steps];
  holey.length = plan.steps.length + 1;
  const cases: readonly unknown[] = [
    null, 'x', [plan], { ...plan, action: 'grant' }, { ...plan, kind: 'merge' }, { ...plan, gauge: 7 }, { ...plan, nonce: 7 }, { ...plan, steps: 'x' }, { ...plan, steps: holey }, accessor,
    { ...plan, definition: { title: 'x', sessions: [] } }, { ...plan, job: 7 }, { ...plan, baseHash: 7 }, Object.create(plan) as unknown,
  ];
  for (const bad of cases) assert.deepEqual(await m.fake.call('bowerloom.jobs.apply', { plan: bad, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, JSON.stringify(bad)?.slice(0, 60));
  assert.deepEqual(must(await m.client.listJobs(GAUGE)), []);
  assert.ok((await m.fake.call('bowerloom.jobs.apply', { plan, approval })).ok);
});

test('a run plan that is not a whole plan is refused as changed, and nothing starts', async () => {
  const m = await manual();
  const job = await makeJob(m, THREE.slice(0, 2));
  const plan = must(await m.client.planRun(GAUGE, job));
  const approval = m.fake.approve(plan.nonce);
  const accessor = { ...plan } as Record<string, unknown>;
  Object.defineProperty(accessor, 'sessions', { get: () => plan.sessions, enumerable: true });
  const first = plan.sessions[0] ?? ({} as never);
  const cases: readonly unknown[] = [
    null, 'x', [plan], { ...plan, action: 'job' }, { ...plan, gauge: 7 }, { ...plan, job: 7 }, { ...plan, title: 7 }, { ...plan, shared: 'no' }, { ...plan, nonce: 7 }, { ...plan, steps: 'x' }, { ...plan, sessions: 'x' },
    { ...plan, sessions: [7] }, { ...plan, sessions: [{ ...first, label: 7 }] }, { ...plan, sessions: [{ ...first, model: 7 }] }, { ...plan, sessions: [{ ...first, variables: 'x' }] }, { ...plan, sessions: [{ ...first, billing: 'key' }] },
    { ...plan, sessions: Array.from({ length: 9 }, () => first) }, accessor,
  ];
  for (const bad of cases) assert.deepEqual(await m.fake.call('bowerloom.runs.apply', { plan: bad, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(m.host.launched, 0);
});

test('the reads of jobs and runs give new values each time: a caller that changes a reply changes nothing for the next call', async () => {
  const m = await manual();
  const job = await makeJob(m, [THREE[0] ?? {}]);
  const first = (await m.fake.call('bowerloom.jobs.get', { gauge: GAUGE, job })) as { ok: true; result: { sessions: { task: string }[] } };
  first.result.sessions[0]!.task = 'changed';
  first.result.sessions.length = 0;
  const second = must(await m.client.getJob(GAUGE, job));
  assert.equal(second.sessions[0]?.task, 'Task of a.');
  const listed = (await m.fake.call('bowerloom.jobs.list', { gauge: GAUGE })) as { ok: true; result: { title: string }[] };
  listed.result[0]!.title = 'changed';
  assert.equal(must(await m.client.listJobs(GAUGE))[0]?.title, 'Review');
});

test('a core that was not given a host holds no engine, so a run is refused as an engine that is not found', async () => {
  const fake = createFakeCore({ folders: JOB_FOLDERS });
  const client = createCoreClient(fake);
  for (const step of [() => client.planInstall('jobber-folder'), () => client.planEnable(GAUGE)]) {
    const planned = await step();
    assert.ok(planned.ok);
    assert.ok((await client.applyPlan(planned.value, fake.approve(planned.value.nonce))).ok);
  }
  const grant = await client.planGrant(GAUGE, ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start']);
  assert.ok(grant.ok);
  assert.ok((await client.applyGrant(grant.value, fake.approve(grant.value.nonce))).ok);
  const made = await client.planJobCreate(GAUGE, { title: 'x', sessions: [entry('a', 'fixture-engine', '/w/a')] });
  assert.ok(made.ok);
  const job = must(await client.applyJob(made.value, fake.approve(made.value.nonce))).job;
  assert.deepEqual(await client.planRun(GAUGE, job), { ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', member: { index: 0, label: 'a' } });
  const core: Core = fake;
  assert.equal(typeof core.call, 'function');
});
