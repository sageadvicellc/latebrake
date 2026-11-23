// The jobs suite: a job is created, read, updated, and deleted through plans and grants, and a run starts every session of a job through one plan, all through the client. Like the other suites, it takes the
// core as a parameter, so the same suite runs against the fake core now and against the real core later.
// The engines of the world it runs in are written out in `JOB_ENGINES`: a harness must start a core that holds exactly those engines, each behaving as its steps say, and the environment of `SESSION_ENVIRONMENT`.
// Every expected value is written out here by hand, and none is read from the core, so a wrong core fails the suite.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { Core, GaugePlan, GrantPlan, JobPlan, RunPlan } from '../src/types.js';
import type { GaugeFolder } from '../src/fake-core.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { APPROVAL_TTL_MS } from './lifecycle-suite.js';
import { SESSION_ENGINES, type SessionEngineFixture } from './sessions-suite.js';

export interface JobsHarness {
  readonly core: Core;
  /** The person approves one plan, the one they saw. Works for every kind of plan. Gives back the approval. */
  approve(plan: { readonly nonce: string }): string | Promise<string>;
  /** The person gives the second approval of a start in a folder that another engine uses. */
  approveShared(plan: { readonly nonce: string }): string | Promise<string>;
  /** Moves the clock of the core forward, in milliseconds. */
  advance(milliseconds: number): void | Promise<void>;
  /** A folder that exists, made for this test, for a session to run in. The same name gives the same folder. It is a real path, with no link in it. */
  folder(name: string): string;
  /** How many programs the core has started so far. */
  launches(): number;
  /** Kills every program that is left, and fails the test when one stays alive. */
  close(): Promise<void>;
}

/** The engines the suite uses: those of the sessions suite, and an engine that says things that no engine may do. The cap of the core is the default of 4. */
export const JOB_ENGINES: readonly SessionEngineFixture[] = [
  ...SESSION_ENGINES,
  { id: 'fixture-chatty', steps: [{ say: 'state:running' }, { say: 'start:fixture-other' }, { say: 'run:job-1' }, { say: '{"start":"fixture-other","folder":"/tmp"}' }, { say: 'state:waiting' }, { hold: true }] },
];

const FILE = 'export default 1;';
const base = JSON.parse(validManifest('tile-only')) as Record<string, unknown>;
const manifestOf = (fields: Record<string, unknown>): string => JSON.stringify({ ...base, ...fields });
const ENGINE_IDS = ['fixture-engine', 'fixture-other', 'fixture-stubborn', 'fixture-asking', 'fixture-failing', 'fixture-chooser', 'fixture-missing', 'fixture-chatty', 'fixture-unknown'];
const FULL = ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start', 'sessions.read', 'sessions.stop'];
const folderOf = (name: string, id: string, permissions: readonly string[], engines: readonly string[] = ENGINE_IDS): GaugeFolder => (
  { name, location: 'user', manifest: manifestOf({ id, title: id, engines, permissions }), files: { 'ui/tile.js': FILE } }
);

/** The folders the suite loads. Written out here. */
export const JOB_FOLDERS: readonly GaugeFolder[] = [
  folderOf('jobber-folder', 'fixture-jobber', FULL),
  folderOf('reader-folder', 'fixture-reader', ['jobs.read'], []),
  folderOf('writer-folder', 'fixture-writer', ['jobs.write'], []),
  folderOf('runner-folder', 'fixture-runner', ['jobs.read', 'jobs.run', 'sessions.start', 'sessions.read'], ['fixture-engine']),
  folderOf('blind-folder', 'fixture-blind', ['jobs.read', 'jobs.run', 'sessions.start'], ENGINE_IDS),
  folderOf('bare-folder', 'fixture-bare', [], []),
  folderOf('second-folder', 'fixture-second', FULL),
];

const HEX = /^[0-9a-f]{64}$/;
const outcome = (result: { ok: boolean; code?: string; reason?: string }) => (result.ok ? { ok: true } : result.reason === undefined ? { ok: false, code: result.code } : { ok: false, code: result.code, reason: result.reason });
const refused = (code: string, reason?: string) => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const entry = (label: string, engine: string, folder: string, extra: Record<string, unknown> = {}) => ({ label, engine, harness: 'plain-harness', folder, model: null, task: `Task of ${label}.`, ...extra });

/** Registers the jobs tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runJobsSuite(name: string, makeHarness: (folders: readonly GaugeFolder[]) => JobsHarness | Promise<JobsHarness>): void {
  const boot = async (t: TestContext) => {
    const harness = await makeHarness(JOB_FOLDERS);
    t.after(() => harness.close());
    return { harness, core: harness.core, client: createCoreClient(harness.core) };
  };
  type World = Awaited<ReturnType<typeof boot>>;

  const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  const lifecycle = async (w: World, planned: Promise<{ ok: true; value: GaugePlan } | { ok: false; code: string }>) => {
    const plan = must(await planned);
    must(await w.client.applyPlan(plan, await w.harness.approve(plan)));
  };
  /** Installs, enables, and grants every permission that the Gauge declares. */
  const bring = async (w: World, folder: string, id: string, permissions: readonly string[]) => {
    await lifecycle(w, w.client.planInstall(folder));
    await lifecycle(w, w.client.planEnable(id));
    if (permissions.length === 0) return;
    const plan: GrantPlan = must(await w.client.planGrant(id, permissions));
    must(await w.client.applyGrant(plan, await w.harness.approve(plan)));
  };
  const GAUGE = 'fixture-jobber';
  const prepare = async (t: TestContext) => {
    const w = await boot(t);
    await bring(w, 'jobber-folder', GAUGE, FULL);
    return w;
  };
  const definition = (title: string, sessions: readonly Record<string, unknown>[]) => ({ title, sessions });
  /** Plans, approves, and applies a change to a job. Gives the plan and the id of the job. */
  const change = async (w: World, planned: Promise<{ ok: true; value: JobPlan } | { ok: false; code: string; reason?: string }>, gauge = GAUGE) => {
    const plan = must(await planned);
    const applied = must(await w.client.applyJob(plan, await w.harness.approve(plan)));
    return { plan, job: applied.job, applied, gauge };
  };
  const create = async (w: World, def: unknown, gauge = GAUGE): Promise<string> => (await change(w, w.client.planJobCreate(gauge, def))).job;
  const jobWith = async (w: World, title: string, sessions: readonly Record<string, unknown>[]): Promise<string> => create(w, definition(title, sessions));
  const runPlan = async (w: World, job: string, gauge = GAUGE): Promise<RunPlan> => must(await w.client.planRun(gauge, job));
  /** Plans a run, approves it (and the shared folder, when the plan says so), and applies it. */
  const startRun = async (w: World, job: string, gauge = GAUGE) => {
    const planned = await runPlan(w, job, gauge);
    const approval = await w.harness.approve(planned);
    const shared = planned.shared ? await w.harness.approveShared(planned) : undefined;
    return { plan: planned, result: await w.client.applyRun(planned, approval, shared) };
  };
  const stateOf = async (w: World, run: string, gauge = GAUGE): Promise<string[]> => must(await w.client.getRun(gauge, run)).sessions.map(session => session.state);
  const settleRun = async (w: World, run: string, state: string, gauge = GAUGE): Promise<void> => {
    const until = Date.now() + 5000;
    for (;;) {
      const states = await stateOf(w, run, gauge);
      if (states.every(each => each === state)) return;
      if (Date.now() > until) throw new Error(`run ${run} did not reach ${state}; it is ${states.join(', ')}`);
      await pause(10);
    }
  };

  test(`${name}: makeHarness gives a distinct core on each call`, async t => {
    const one = await boot(t), two = await boot(t);
    assert.notEqual(one.core, two.core);
  });

  // Jobs

  test(`${name}: a job is created through a plan and an approval, read, updated, and deleted, and each change is a plan of its own`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), []);
    const first = definition('Morning review', [entry('writer', 'fixture-engine', folder), entry('checker', 'fixture-other', folder, { harness: 'strict-harness', model: null })]);
    const plan = must(await w.client.planJobCreate(GAUGE, first));
    assert.deepEqual({ action: plan.action, kind: plan.kind, gauge: plan.gauge, job: plan.job, baseHash: plan.baseHash }, { action: 'job', kind: 'create', gauge: GAUGE, job: null, baseHash: null });
    assert.match(plan.digest, HEX);
    assert.match(plan.nonce, HEX);
    assert.match(plan.nextHash ?? '', HEX);
    assert.deepEqual(plan.definition, first);
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), [], 'a plan creates nothing');
    const created = must(await w.client.applyJob(plan, await w.harness.approve(plan)));
    assert.equal(created.kind, 'create');
    assert.match(created.job, /^[a-z0-9][a-z0-9-]*$/);
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), [{ id: created.job, title: 'Morning review', sessions: 2 }]);
    assert.deepEqual(must(await w.client.getJob(GAUGE, created.job)), { id: created.job, ...first });
    // An update replaces the definition and keeps the id.
    const second = definition('Evening review', [entry('writer', 'fixture-engine', folder, { task: 'A new task.' })]);
    const update = must(await w.client.planJobUpdate(GAUGE, created.job, second));
    assert.equal(update.kind, 'update');
    assert.equal(update.job, created.job);
    assert.match(update.baseHash ?? '', HEX);
    assert.notEqual(update.baseHash, update.nextHash);
    assert.equal(update.baseHash, plan.nextHash, 'the job it replaces is the job that was created');
    assert.deepEqual(must(await w.client.getJob(GAUGE, created.job)), { id: created.job, ...first }, 'a plan changes nothing');
    assert.deepEqual(must(await w.client.applyJob(update, await w.harness.approve(update))), { kind: 'update', job: created.job });
    assert.deepEqual(must(await w.client.getJob(GAUGE, created.job)), { id: created.job, ...second });
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), [{ id: created.job, title: 'Evening review', sessions: 1 }]);
    // A delete removes it.
    const removal = must(await w.client.planJobDelete(GAUGE, created.job));
    assert.deepEqual({ kind: removal.kind, job: removal.job, definition: removal.definition, nextHash: removal.nextHash }, { kind: 'delete', job: created.job, definition: null, nextHash: null });
    assert.deepEqual(must(await w.client.listJobs(GAUGE)).length, 1, 'a plan deletes nothing');
    assert.deepEqual(must(await w.client.applyJob(removal, await w.harness.approve(removal))), { kind: 'delete', job: created.job });
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), []);
    assert.deepEqual(outcome(await w.client.getJob(GAUGE, created.job)), refused('GAUGE_JOB_UNKNOWN'));
  });

  test(`${name}: a job plan reads exactly like this`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const plan = must(await w.client.planJobCreate(GAUGE, definition('Review', [entry('writer', 'fixture-engine', folder)])));
    assert.deepEqual(plan.steps, [
      'Gauge fixture-jobber asks to create a job: Review',
      'the job holds 1 session',
      `session 1, writer: engine fixture-engine, harness plain-harness, folder ${folder}, the model is the default of the engine`,
      'task of session 1, 15 characters: Task of writer.',
      'a job is a saved definition: creating it starts no session, and a run needs a plan of its own',
      'the core makes the id of the job when you approve',
      `bind the change to job none and result ${plan.nextHash}`,
    ]);
  });

  test(`${name}: a job is read back as a new copy each time, with its sessions in order`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const choice = { provider: 'local-llama', model: 'qwen3-7b' };
    const job = await jobWith(w, 'Review', [entry('one', 'fixture-chooser', folder, { model: choice }), entry('two', 'fixture-engine', w.harness.folder('beta'))]);
    const read = must(await w.client.getJob(GAUGE, job));
    assert.deepEqual(read.sessions.map(session => session.label), ['one', 'two']);
    assert.deepEqual(read.sessions[0]?.model, choice);
    assert.deepEqual(read.sessions[1]?.model, null);
    assert.notEqual(must(await w.client.getJob(GAUGE, job)), read);
  });

  test(`${name}: a job write needs the jobs.write grant, and a read needs jobs.read, each by its own grant`, async t => {
    const w = await boot(t);
    await bring(w, 'reader-folder', 'fixture-reader', ['jobs.read']);
    await bring(w, 'writer-folder', 'fixture-writer', ['jobs.write']);
    await bring(w, 'bare-folder', 'fixture-bare', []);
    const folder = w.harness.folder('alpha');
    const def = definition('Review', [entry('writer', 'fixture-engine', folder)]);
    assert.deepEqual(outcome(await w.client.planJobCreate('fixture-reader', def)), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.planJobCreate('fixture-bare', def)), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.planJobDelete('fixture-reader', 'job-1')), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.listJobs('fixture-writer')), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.getJob('fixture-bare', 'job-1')), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.listRuns('fixture-writer')), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.planJobCreate('no-such-gauge', def)), refused('UNKNOWN_GAUGE'));
    const job = await create(w, def, 'fixture-writer');
    assert.deepEqual(must(await w.client.listJobs('fixture-reader')), [{ id: job, title: 'Review', sessions: 1 }]);
    assert.equal(must(await w.client.getJob('fixture-reader', job)).title, 'Review');
  });

  test(`${name}: a declared permission that the person has not granted is refused, and a grant that is revoked after the plan ends the approval`, async t => {
    const w = await boot(t);
    await bring(w, 'jobber-folder', GAUGE, ['jobs.read']);
    const folder = w.harness.folder('alpha');
    const def = definition('Review', [entry('writer', 'fixture-engine', folder)]);
    assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, def)), refused('GAUGE_GRANT_MISSING'));
    const grant = must(await w.client.planGrant(GAUGE, ['jobs.write']));
    must(await w.client.applyGrant(grant, await w.harness.approve(grant)));
    const plan = must(await w.client.planJobCreate(GAUGE, def));
    const approval = await w.harness.approve(plan);
    must(await w.client.revoke(GAUGE, ['jobs.write']));
    // A revoke is a change of state, so it ends every approval given before it, and the plan cannot be applied.
    assert.deepEqual(outcome(await w.client.applyJob(plan, approval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), [], 'no job was made');
    assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, def)), refused('GAUGE_GRANT_MISSING'), 'and a new plan is refused');
  });

  test(`${name}: a job plan is applied only with the person's approval of that exact plan, and once`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const plan = must(await w.client.planJobCreate(GAUGE, definition('One', [entry('writer', 'fixture-engine', folder)])));
    const other = must(await w.client.planJobCreate(GAUGE, definition('Two', [entry('writer', 'fixture-engine', folder)])));
    assert.deepEqual(outcome(await w.client.applyJob(plan)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(outcome(await w.client.applyJob(plan, 'not-an-approval')), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(outcome(await w.client.applyJob(plan, await w.harness.approve(other))), refused('GAUGE_PLAN_CHANGED'), 'the approval of another plan is not the approval of this one');
    const approval = await w.harness.approve(plan);
    must(await w.client.applyJob(plan, approval));
    assert.deepEqual(outcome(await w.client.applyJob(plan, approval)), refused('GAUGE_PLAN_NOT_APPROVED'), 'an approval works once');
    assert.equal(must(await w.client.listJobs(GAUGE)).length, 1);
  });

  test(`${name}: an approval is for one plan: the approval of a second plan with the same content does not apply the first, and a plan cannot be applied as another Gauge`, async t => {
    const w = await prepare(t);
    await bring(w, 'second-folder', 'fixture-second', FULL);
    const def = definition('One', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const one = must(await w.client.planJobCreate(GAUGE, def)), two = must(await w.client.planJobCreate(GAUGE, def));
    assert.equal(one.digest, two.digest, 'two plans of one content have one digest');
    assert.notEqual(one.nonce, two.nonce);
    assert.deepEqual(outcome(await w.client.applyJob(one, await w.harness.approve(two))), refused('GAUGE_PLAN_CHANGED'));
    const mine = must(await w.client.planJobCreate(GAUGE, def));
    assert.deepEqual(outcome(await w.client.applyJob({ ...mine, gauge: 'fixture-second' }, await w.harness.approve(mine))), refused('GAUGE_PLAN_CHANGED'), 'the approval of a plan for one Gauge does not apply it for another');
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), []);
  });

  test(`${name}: an approval ends after 15 minutes, and when any other step is applied`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const plan = must(await w.client.planJobCreate(GAUGE, definition('One', [entry('writer', 'fixture-engine', folder)])));
    const old = await w.harness.approve(plan);
    await w.harness.advance(APPROVAL_TTL_MS);
    assert.deepEqual(outcome(await w.client.applyJob(plan, old)), refused('GAUGE_PLAN_NOT_APPROVED'));
    const fresh = must(await w.client.planJobCreate(GAUGE, definition('One', [entry('writer', 'fixture-engine', folder)])));
    const approval = await w.harness.approve(fresh);
    await create(w, definition('Two', [entry('writer', 'fixture-engine', folder)]));
    assert.deepEqual(outcome(await w.client.applyJob(fresh, approval)), refused('GAUGE_PLAN_NOT_APPROVED'), 'a step that was applied in between ends the approval');
  });

  test(`${name}: a plan that was changed on the way is refused, in each field that the person reads`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const plan = must(await w.client.planJobCreate(GAUGE, definition('One', [entry('writer', 'fixture-engine', folder)])));
    const approval = await w.harness.approve(plan);
    const other = definition('Other', [entry('writer', 'fixture-engine', folder, { task: 'Delete every file.' })]);
    const tampered: readonly JobPlan[] = [
      { ...plan, definition: other as unknown as JobPlan['definition'] }, { ...plan, steps: [...plan.steps.slice(0, -2), 'nothing at all', plan.steps[plan.steps.length - 1] ?? ''] },
      { ...plan, nextHash: 'f'.repeat(64) }, { ...plan, gauge: 'fixture-writer' },
    ];
    for (const bad of tampered) assert.deepEqual(outcome(await w.client.applyJob(bad, approval)), refused('GAUGE_PLAN_CHANGED'), JSON.stringify(bad).slice(0, 80));
    assert.deepEqual(must(await w.client.listJobs(GAUGE)), []);
    must(await w.client.applyJob(plan, approval));
    assert.equal(must(await w.client.listJobs(GAUGE)).length, 1);
  });

  test(`${name}: a job that changed since the plan is refused: an update after an update, a delete, and an update of a job that is gone`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const job = await jobWith(w, 'One', [entry('writer', 'fixture-engine', folder)]);
    const stale = must(await w.client.planJobUpdate(GAUGE, job, definition('Stale', [entry('writer', 'fixture-engine', folder)])));
    const staleApproval = await w.harness.approve(stale);
    await change(w, w.client.planJobUpdate(GAUGE, job, definition('Newer', [entry('writer', 'fixture-engine', folder)])));
    assert.deepEqual(outcome(await w.client.applyJob(stale, staleApproval)), refused('GAUGE_PLAN_NOT_APPROVED'), 'the step in between ended the approval');
    const again = must(await w.client.planJobUpdate(GAUGE, job, definition('Again', [entry('writer', 'fixture-engine', folder)])));
    await change(w, w.client.planJobDelete(GAUGE, job));
    assert.deepEqual(outcome(await w.client.applyJob(again, await w.harness.approve(must(await w.client.planJobCreate(GAUGE, definition('x', [entry('writer', 'fixture-engine', folder)])))))), refused('GAUGE_PLAN_CHANGED'));
    assert.deepEqual(outcome(await w.client.planJobUpdate(GAUGE, job, definition('Gone', [entry('writer', 'fixture-engine', folder)]))), refused('GAUGE_JOB_UNKNOWN'));
    assert.deepEqual(outcome(await w.client.planJobDelete(GAUGE, job)), refused('GAUGE_JOB_UNKNOWN'));
  });

  const BAD: readonly (readonly [string, unknown, string, string?])[] = [
    ['not a record', 'x', 'GAUGE_JOB_INVALID', 'request'],
    ['a field more', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp')], extra: 1 }, 'GAUGE_JOB_INVALID', 'request'],
    ['no title', { sessions: [entry('a', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_INVALID', 'title'],
    ['an empty title', { title: '', sessions: [entry('a', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_INVALID', 'title'],
    ['no sessions', { title: 'x', sessions: [] }, 'GAUGE_JOB_INVALID', 'sessions'],
    ['nine sessions', { title: 'x', sessions: Array.from({ length: 9 }, (_value, index) => entry(`s-${index}`, 'fixture-engine', '/tmp')) }, 'GAUGE_JOB_INVALID', 'sessions'],
    ['a repeated label', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp'), entry('a', 'fixture-other', '/tmp')] }, 'GAUGE_JOB_INVALID', 'label'],
    ['a bad label', { title: 'x', sessions: [entry('A b', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_INVALID', 'label'],
    ['a bad engine', { title: 'x', sessions: [entry('a', 'Engine', '/tmp')] }, 'GAUGE_JOB_INVALID', 'engine'],
    ['a bad harness', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp', { harness: 'A B' })] }, 'GAUGE_JOB_INVALID', 'harness'],
    ['a relative folder', { title: 'x', sessions: [entry('a', 'fixture-engine', 'relative')] }, 'GAUGE_JOB_INVALID', 'folder'],
    ['a model that is not a choice', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp', { model: { provider: 'p' } })] }, 'GAUGE_JOB_INVALID', 'model'],
    ['an empty task', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp', { task: '' })] }, 'GAUGE_JOB_INVALID', 'task'],
    ['a task with a secret', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp', { task: `use sk-${'a1'.repeat(15)} to call it` })] }, 'GAUGE_JOB_INVALID', 'secret'],
    ['a schedule', { title: 'x', schedule: '0 * * * *', sessions: [entry('a', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_NOT_INTERACTIVE', 'schedule'],
    ['a schedule in a session', { title: 'x', sessions: [entry('a', 'fixture-engine', '/tmp', { schedule: 'daily' })] }, 'GAUGE_JOB_NOT_INTERACTIVE', 'schedule'],
    ['an unattended flag', { title: 'x', unattended: true, sessions: [entry('a', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_NOT_INTERACTIVE', 'unattended'],
    ['an unattended flag that is false', { title: 'x', unattended: false, sessions: [entry('a', 'fixture-engine', '/tmp')] }, 'GAUGE_JOB_NOT_INTERACTIVE', 'unattended'],
  ];

  test(`${name}: a definition that breaks a rule is refused with the code and the reason of that rule, in a create and in an update, and nothing changes`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Keep', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    for (const [label, bad, code, reason] of BAD) {
      assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, bad)), refused(code, reason), `create: ${label}`);
      assert.deepEqual(outcome(await w.client.planJobUpdate(GAUGE, job, bad)), refused(code, reason), `update: ${label}`);
    }
    assert.deepEqual(must(await w.client.listJobs(GAUGE)).map(listed => listed.title), ['Keep']);
  });

  test(`${name}: a schedule or an unattended flag is refused whatever else is wrong, so the person is told the true cause`, async t => {
    const w = await prepare(t);
    assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, { title: '', schedule: 'daily', sessions: 'x' })), refused('GAUGE_JOB_NOT_INTERACTIVE', 'schedule'));
    assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, { title: '', unattended: true, sessions: 'x' })), refused('GAUGE_JOB_NOT_INTERACTIVE', 'unattended'));
  });

  test(`${name}: a job id that is malformed is a refusal with the reason job, and a job that is not there is GAUGE_JOB_UNKNOWN`, async t => {
    const w = await prepare(t);
    const def = definition('Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    for (const bad of ['', 'Job 1', '../x', 'job\n1', 'x'.repeat(65), '__proto__', 'toString']) {
      assert.deepEqual(outcome(await w.client.getJob(GAUGE, bad)), refused('GAUGE_JOB_INVALID', 'job'), JSON.stringify(bad));
      assert.deepEqual(outcome(await w.client.planJobUpdate(GAUGE, bad, def)), refused('GAUGE_JOB_INVALID', 'job'), JSON.stringify(bad));
      assert.deepEqual(outcome(await w.client.planJobDelete(GAUGE, bad)), refused('GAUGE_JOB_INVALID', 'job'), JSON.stringify(bad));
      assert.deepEqual(outcome(await w.client.planRun(GAUGE, bad)), refused('GAUGE_JOB_INVALID', 'job'), JSON.stringify(bad));
    }
    for (const missing of ['job-9', 'constructor', 'proto']) {
      assert.deepEqual(outcome(await w.client.getJob(GAUGE, missing)), refused('GAUGE_JOB_UNKNOWN'), missing);
      assert.deepEqual(outcome(await w.client.planRun(GAUGE, missing)), refused('GAUGE_JOB_UNKNOWN'), missing);
    }
  });

  test(`${name}: a Gauge with no jobs grant gets the same answer whether a job exists or not`, async t => {
    const w = await prepare(t);
    await bring(w, 'bare-folder', 'fixture-bare', []);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    for (const id of [job, 'job-9', 'toString', 'Not An Id']) {
      assert.deepEqual(outcome(await w.client.getJob('fixture-bare', id)), refused('GAUGE_GRANT_MISSING', 'not_declared'), id);
      assert.deepEqual(outcome(await w.client.planJobDelete('fixture-bare', id)), refused('GAUGE_GRANT_MISSING', 'not_declared'), id);
      assert.deepEqual(outcome(await w.client.planRun('fixture-bare', id)), refused('GAUGE_GRANT_MISSING', 'not_declared'), id);
      assert.deepEqual(outcome(await w.client.getRun('fixture-bare', id)), refused('GAUGE_GRANT_MISSING', 'not_declared'), id);
    }
  });

  test(`${name}: the core holds at most 64 jobs: the 65th is refused with GAUGE_JOB_LIMIT, nothing changes, and a delete makes room`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const ids: string[] = [];
    for (let index = 0; index < 64; index += 1) ids.push(await jobWith(w, `Job ${index}`, [entry('writer', 'fixture-engine', folder)]));
    assert.equal(new Set(ids).size, 64);
    assert.deepEqual(outcome(await w.client.planJobCreate(GAUGE, definition('One too many', [entry('writer', 'fixture-engine', folder)]))), refused('GAUGE_JOB_LIMIT'));
    assert.equal(must(await w.client.listJobs(GAUGE)).length, 64);
    // An update adds no job, so a full core still takes one.
    must(await w.client.planJobUpdate(GAUGE, ids[3] ?? '', definition('Changed', [entry('writer', 'fixture-engine', folder)])));
    await change(w, w.client.planJobDelete(GAUGE, ids[0] ?? ''));
    await jobWith(w, 'Fits now', [entry('writer', 'fixture-engine', folder)]);
    assert.equal(must(await w.client.listJobs(GAUGE)).length, 64);
  });

  // Runs

  test(`${name}: a run plan lists every session of the job, and a plan starts nothing`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha'), beta = w.harness.folder('beta');
    const job = await jobWith(w, 'Morning review', [entry('writer', 'fixture-engine', alpha), entry('checker', 'fixture-other', beta, { harness: 'strict-harness' })]);
    const plan = await runPlan(w, job);
    assert.deepEqual({ action: plan.action, gauge: plan.gauge, job: plan.job, title: plan.title, shared: plan.shared }, { action: 'run', gauge: GAUGE, job, title: 'Morning review', shared: false });
    assert.deepEqual(plan.sessions.map(session => [session.label, session.engine, session.engineTitle, session.harness, session.folder, session.model, session.billing, session.variables, session.sharedWith, session.task]), [
      ['writer', 'fixture-engine', 'Fake fixture-engine', 'plain-harness', alpha, null, 'engine-plan', ['FIXTURE_DECLARED'], [], 'Task of writer.'],
      ['checker', 'fixture-other', 'Fake fixture-other', 'strict-harness', beta, null, 'engine-plan', [], [], 'Task of checker.'],
    ]);
    assert.match(plan.digest, HEX);
    assert.match(plan.nonce, HEX);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(w.harness.launches(), 0, 'a plan starts no program');
    assert.deepEqual(must(await w.client.listRuns(GAUGE)), []);
    assert.deepEqual(must(await w.client.listSessions(GAUGE, 'fixture-engine')), []);
  });

  test(`${name}: a run plan reads exactly like this`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha'), beta = w.harness.folder('beta');
    const job = await jobWith(w, 'Morning review', [entry('writer', 'fixture-engine', alpha), entry('checker', 'fixture-other', beta, { harness: 'strict-harness' })]);
    const plan = await runPlan(w, job);
    const program = plan.sessions[0]?.program ?? '';
    assert.deepEqual(plan.steps, [
      `Gauge fixture-jobber asks to run the job ${job}, Morning review: 2 sessions start together`,
      'session 1 of 2, writer: the engine fixture-engine (Fake fixture-engine), harness plain-harness',
      `program: ${program}`,
      `folder: ${alpha}`,
      "model: the engine's own default, and the core picks none",
      'billing source: the plan of the engine itself, so the core bills no key',
      'variables passed: FIXTURE_DECLARED',
      'task of 15 characters: Task of writer.',
      'session 2 of 2, checker: the engine fixture-other (Fake fixture-other), harness strict-harness',
      `program: ${program}`,
      `folder: ${beta}`,
      "model: the engine's own default, and the core picks none",
      'billing source: the plan of the engine itself, so the core bills no key',
      'variables passed: none',
      'task of 16 characters: Task of checker.',
      'each program gets its variables only, and starts with an argument list and never through a shell',
      'the core never answers a permission prompt of an engine: you answer each yourself',
      'the core does not send a task to an engine: you give it in the pane of the engine',
      'if one session fails to start, the core stops the sessions that started and gives the failure',
      'the run is interactive: you watch it, and nothing is scheduled and nothing runs unattended',
      'start every program in its folder at once, and keep each session until it stops or fails',
    ]);
  });

  test(`${name}: a run starts every session of the job through one approval, and reads as a group of its sessions`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha'), beta = w.harness.folder('beta');
    const job = await jobWith(w, 'Morning review', [entry('writer', 'fixture-engine', alpha), entry('checker', 'fixture-other', beta)]);
    const { plan, result } = await startRun(w, job);
    const run = must(result);
    assert.equal(w.harness.launches(), 2, 'both programs were started by the one approval');
    assert.match(run.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.deepEqual({ job: run.job, title: run.title }, { job, title: 'Morning review' });
    assert.deepEqual(run.sessions.map(session => [session.label, session.engine]), [['writer', 'fixture-engine'], ['checker', 'fixture-other']]);
    assert.ok(run.sessions.every(session => session.session !== null && ['starting', 'running'].includes(session.state)));
    await settleRun(w, run.id, 'running');
    const read = must(await w.client.getRun(GAUGE, run.id));
    assert.deepEqual(read.sessions.map(session => session.state), ['running', 'running']);
    assert.deepEqual(must(await w.client.listRuns(GAUGE)).map(listed => listed.id), [run.id]);
    // The sessions of the run are the sessions of the Engine Host, so the session calls read them too.
    const first = read.sessions[0]?.session ?? '', second = read.sessions[1]?.session ?? '';
    assert.equal(must(await w.client.getSession(GAUGE, first)).folder, alpha);
    assert.equal(must(await w.client.getSession(GAUGE, second)).folder, beta);
    assert.deepEqual(must(await w.client.listSessions(GAUGE, 'fixture-engine')).map(session => session.id), [first]);
    assert.equal(plan.sessions.length, 2);
  });

  test(`${name}: a run plan is applied once: the approval is used up, and a second apply starts nothing`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const plan = await runPlan(w, job);
    const approval = await w.harness.approve(plan);
    assert.deepEqual(outcome(await w.client.applyRun(plan)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(w.harness.launches(), 0);
    const first = w.client.applyRun(plan, approval);
    const second = w.client.applyRun(plan, approval);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.ok).sort(), [false, true], 'two calls in one tick start the run once');
    assert.equal(w.harness.launches(), 1);
    assert.equal(must(await w.client.listRuns(GAUGE)).length, 1);
  });

  test(`${name}: a run plan that was changed on the way is refused, and nothing starts`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha'), beta = w.harness.folder('beta');
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', alpha)]);
    const plan = await runPlan(w, job);
    const approval = await w.harness.approve(plan);
    const sessions = [{ ...plan.sessions[0]!, folder: beta }];
    const tampered: readonly RunPlan[] = [
      { ...plan, sessions }, { ...plan, sessions: [{ ...plan.sessions[0]!, task: 'Delete every file.' }] }, { ...plan, sessions: [...plan.sessions, { ...plan.sessions[0]!, label: 'extra', engine: 'fixture-other' }] },
      { ...plan, title: 'Another' }, { ...plan, steps: ['nothing at all'] }, { ...plan, job: 'job-9' },
    ];
    for (const bad of tampered) assert.notEqual(outcome(await w.client.applyRun(bad, approval)).ok, true, JSON.stringify(bad).slice(0, 80));
    assert.equal(w.harness.launches(), 0);
    const plain = await w.client.applyRun({ ...plan, sessions }, approval);
    assert.deepEqual(outcome(plain), refused('GAUGE_PLAN_CHANGED'));
    assert.equal(w.harness.launches(), 0);
    must(await w.client.applyRun(plan, approval));
    assert.equal(w.harness.launches(), 1);
  });

  test(`${name}: a run plan is for one plan and one Gauge: the approval of another plan of the same content, or of another Gauge, does not start it`, async t => {
    const w = await prepare(t);
    await bring(w, 'second-folder', 'fixture-second', FULL);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const one = await runPlan(w, job), two = await runPlan(w, job);
    assert.equal(one.digest, two.digest);
    assert.deepEqual(outcome(await w.client.applyRun(one, await w.harness.approve(two))), refused('GAUGE_PLAN_CHANGED'));
    const mine = await runPlan(w, job);
    assert.deepEqual(outcome(await w.client.applyRun({ ...mine, gauge: 'fixture-second' }, await w.harness.approve(mine))), refused('GAUGE_PLAN_CHANGED'));
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: a run plan that is applied ends every other approval at once, before the programs have started`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const other = must(await w.client.planJobCreate(GAUGE, definition('Other', [entry('writer', 'fixture-other', w.harness.folder('beta'))])));
    const plan = await runPlan(w, job);
    const otherApproval = await w.harness.approve(other), approval = await w.harness.approve(plan);
    const applying = w.client.applyRun(plan, approval);
    assert.deepEqual(outcome(await w.client.applyJob(other, otherApproval)), refused('GAUGE_PLAN_NOT_APPROVED'), 'the run took effect when it began, and not when its programs had started');
    must(await applying);
    assert.equal(must(await w.client.listJobs(GAUGE)).length, 1);
  });

  test(`${name}: a job that changed after the run plan makes the plan stale, and the approval ends with the step`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha');
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', alpha)]);
    const plan = await runPlan(w, job);
    const approval = await w.harness.approve(plan);
    await change(w, w.client.planJobUpdate(GAUGE, job, definition('Review', [entry('writer', 'fixture-engine', alpha, { task: 'A different task.' })])));
    assert.deepEqual(outcome(await w.client.applyRun(plan, approval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: a run needs the jobs.run grant, and the sessions.start grant for the engine of every session: a Gauge that lists one engine never starts another through a job`, async t => {
    const w = await prepare(t);
    await bring(w, 'runner-folder', 'fixture-runner', ['jobs.read', 'jobs.run', 'sessions.start', 'sessions.read']);
    await bring(w, 'reader-folder', 'fixture-reader', ['jobs.read']);
    const alpha = w.harness.folder('alpha');
    const own = await jobWith(w, 'Own', [entry('writer', 'fixture-engine', alpha)]);
    const wide = await jobWith(w, 'Wide', [entry('writer', 'fixture-engine', alpha), entry('checker', 'fixture-other', w.harness.folder('beta'))]);
    const unknown = await jobWith(w, 'Unknown engine', [entry('writer', 'fixture-engine', alpha), entry('ghost', 'fixture-unknown', w.harness.folder('gamma'))]);
    assert.deepEqual(outcome(await w.client.planRun('fixture-reader', own)), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.deepEqual(outcome(await w.client.planRun('fixture-runner', wide)), refused('GAUGE_GRANT_MISSING', 'engine_not_listed'));
    assert.deepEqual(outcome(await w.client.planRun('fixture-runner', unknown)), refused('GAUGE_GRANT_MISSING', 'engine_not_listed'), 'an engine that does not exist reads as an engine that is not listed');
    assert.ok((await w.client.planRun('fixture-runner', own)).ok);
    assert.ok((await w.client.planRun(GAUGE, wide)).ok);
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: a request for an unattended run is refused, after the grant check, with any value`, async t => {
    const w = await prepare(t);
    await bring(w, 'reader-folder', 'fixture-reader', ['jobs.read']);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    for (const unattended of [true, false, null, 'yes']) {
      const reply = await w.core.call('bowerloom.runs.plan', { gauge: GAUGE, job, unattended });
      assert.deepEqual(reply, { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'unattended' }, String(unattended));
      const ungranted = await w.core.call('bowerloom.runs.plan', { gauge: 'fixture-reader', job, unattended });
      assert.deepEqual(ungranted, { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'not_declared' }, 'a Gauge with no grant learns nothing');
    }
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: an engine never starts another engine, and a run never grows: what a program says changes no launch and no session`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Chatty', [entry('talker', 'fixture-chatty', w.harness.folder('alpha')), entry('quiet', 'fixture-other', w.harness.folder('beta'))]);
    const run = must((await startRun(w, job)).result);
    // The chatty engine claims waiting last, so every line before it has been read when its session reads waiting.
    const until = Date.now() + 5000;
    while ((await stateOf(w, run.id))[0] !== 'waiting') {
      if (Date.now() > until) throw new Error('the chatty session did not reach waiting');
      await pause(10);
    }
    assert.equal(w.harness.launches(), 2);
    assert.equal(must(await w.client.getRun(GAUGE, run.id)).sessions.length, 2);
    assert.equal(must(await w.client.listRuns(GAUGE)).length, 1);
    assert.deepEqual(must(await w.client.listSessions(GAUGE, 'fixture-other')).length, 1, 'no session of another engine was added');
  });

  test(`${name}: two sessions of one engine in one folder are the pair rule, at plan time, and the cap counts the whole run`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha');
    const pair = await jobWith(w, 'Pair', [entry('one', 'fixture-engine', alpha), entry('two', 'fixture-engine', alpha)]);
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, pair)), refused('ENGINE_PAIR_BUSY'));
    const five = await jobWith(w, 'Five', ['fixture-engine', 'fixture-other', 'fixture-stubborn', 'fixture-asking', 'fixture-chooser'].map((engine, index) => entry(`s-${index}`, engine, w.harness.folder(`f${index}`))));
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, five)), refused('ENGINE_LIMIT'));
    const four = await jobWith(w, 'Four', ['fixture-engine', 'fixture-other', 'fixture-stubborn', 'fixture-asking'].map((engine, index) => entry(`s-${index}`, engine, w.harness.folder(`g${index}`))));
    must((await startRun(w, four)).result);
    const one = await jobWith(w, 'One', [entry('solo', 'fixture-chooser', w.harness.folder('h'))]);
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, one)), refused('ENGINE_LIMIT'), 'the places of a run that began are taken');
    assert.equal(w.harness.launches(), 4);
  });

  test(`${name}: a job with a missing program, an engine that is not held, and a model for an engine that cannot take one are refused at plan time with their own codes`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const missing = await jobWith(w, 'Missing', [entry('a', 'fixture-missing', folder)]);
    const unknown = await jobWith(w, 'Unknown', [entry('a', 'fixture-unknown', folder)]);
    const model = await jobWith(w, 'Model', [entry('a', 'fixture-engine', folder, { model: { provider: 'p', model: 'm' } })]);
    const notFolder = await jobWith(w, 'No folder', [entry('a', 'fixture-engine', `${folder}/does-not-exist`)]);
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, missing)), refused('ENGINE_NOT_FOUND', 'program_missing'));
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, unknown)), refused('ENGINE_NOT_FOUND', 'engine'));
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, model)), refused('MODEL_NOT_FOR_ENGINE'));
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, notFolder)), refused('ENGINE_REQUEST_INVALID', 'folder'));
  });

  test(`${name}: a run in a folder that another engine uses needs the second approval, once for the whole run`, async t => {
    const w = await prepare(t);
    const alpha = w.harness.folder('alpha');
    const job = await jobWith(w, 'Shared', [entry('writer', 'fixture-engine', alpha), entry('checker', 'fixture-other', alpha)]);
    const plan = await runPlan(w, job);
    assert.equal(plan.shared, true);
    assert.deepEqual(plan.sessions.map(session => session.sharedWith), [['fixture-other'], ['fixture-engine']]);
    assert.ok(plan.steps.includes('a second approval is needed, once for the whole run, for the shared folder'));
    const approval = await w.harness.approve(plan);
    assert.deepEqual(outcome(await w.client.applyRun(plan, approval)), refused('ENGINE_FOLDER_SHARED'));
    assert.equal(w.harness.launches(), 0, 'nothing starts without the second approval');
    const other = await runPlan(w, job);
    const wrongShared = await w.harness.approveShared(other);
    const again = await w.harness.approve(plan);
    assert.deepEqual(outcome(await w.client.applyRun(plan, again, wrongShared)), refused('ENGINE_FOLDER_SHARED'), 'the second approval of another plan is not this plan\'s');
    assert.equal(w.harness.launches(), 0);
    const fresh = await runPlan(w, job);
    const first = await w.harness.approve(fresh), second = await w.harness.approveShared(fresh);
    assert.deepEqual(outcome(await w.client.applyRun(fresh, second, first)), refused('GAUGE_PLAN_NOT_APPROVED'), 'the two approvals are not interchangeable');
    const run = must(await w.client.applyRun(fresh, first, second));
    assert.equal(run.sessions.length, 2);
    assert.equal(w.harness.launches(), 2);
  });

  test(`${name}: a run that shares nothing cannot be given a second approval`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const plan = await runPlan(w, job);
    assert.equal(plan.shared, false);
    assert.throws(() => w.harness.approveShared(plan), TypeError);
  });

  test(`${name}: a run reads for a Gauge without sessions.read as hidden sessions with no id, the same whatever the session is`, async t => {
    const w = await prepare(t);
    await bring(w, 'blind-folder', 'fixture-blind', ['jobs.read', 'jobs.run', 'sessions.start']);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha')), entry('checker', 'fixture-other', w.harness.folder('beta'))]);
    const started = must((await startRun(w, job, 'fixture-blind')).result);
    assert.deepEqual(started.sessions, [{ label: 'writer', engine: 'fixture-engine', session: null, state: 'hidden' }, { label: 'checker', engine: 'fixture-other', session: null, state: 'hidden' }]);
    assert.deepEqual(must(await w.client.getRun('fixture-blind', started.id)).sessions.map(session => session.state), ['hidden', 'hidden']);
    assert.deepEqual(must(await w.client.listRuns('fixture-blind')).map(run => run.sessions.map(session => session.session)), [[null, null]]);
    await settleRun(w, started.id, 'running');
    const seen = must(await w.client.getRun(GAUGE, started.id));
    assert.ok(seen.sessions.every(session => session.session !== null && session.state === 'running'));
  });

  test(`${name}: a run that is not there reads as GAUGE_RUN_UNKNOWN, for a malformed id too`, async t => {
    const w = await prepare(t);
    for (const id of ['run-9', 'toString', '__proto__', '', 'Run 1', 'x'.repeat(65)]) assert.deepEqual(outcome(await w.client.getRun(GAUGE, id)), refused('GAUGE_RUN_UNKNOWN'), JSON.stringify(id));
    assert.deepEqual(must(await w.client.listRuns(GAUGE)), []);
  });

  test(`${name}: the sessions of a run are stopped one by one through the session calls, and the run reads as ended`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha')), entry('checker', 'fixture-other', w.harness.folder('beta'))]);
    const run = must((await startRun(w, job)).result);
    await settleRun(w, run.id, 'running');
    for (const session of must(await w.client.getRun(GAUGE, run.id)).sessions) {
      const stop = must(await w.client.planSessionStop(GAUGE, session.session ?? ''));
      must(await w.client.applySession(stop, await w.harness.approve(stop)));
    }
    assert.deepEqual(await stateOf(w, run.id), ['stopped', 'stopped']);
    // The places are free: the job runs again, as a new run.
    const again = must((await startRun(w, job)).result);
    assert.notEqual(again.id, run.id);
    assert.deepEqual(must(await w.client.listRuns(GAUGE)).map(listed => listed.id), [run.id, again.id]);
    assert.equal(must(await w.client.getRun(GAUGE, run.id)).id, run.id);
    assert.equal(must(await w.client.getRun(GAUGE, again.id)).id, again.id);
  });

  test(`${name}: a job that is deleted does not stop its run, and the run keeps the job id and the title`, async t => {
    const w = await prepare(t);
    const job = await jobWith(w, 'Review', [entry('writer', 'fixture-engine', w.harness.folder('alpha'))]);
    const run = must((await startRun(w, job)).result);
    await change(w, w.client.planJobDelete(GAUGE, job));
    await settleRun(w, run.id, 'running');
    const read = must(await w.client.getRun(GAUGE, run.id));
    assert.deepEqual({ job: read.job, title: read.title }, { job, title: 'Review' });
    assert.deepEqual(outcome(await w.client.planRun(GAUGE, job)), refused('GAUGE_JOB_UNKNOWN'));
  });

  test(`${name}: a start that fails part way stops the sessions that started, gives the failure of the session that failed, and leaves the run as a group that ended`, async t => {
    if (process.getuid?.() === 0) return t.skip('a folder that cannot be searched needs a user that is not root');
    const w = await prepare(t);
    const good = w.harness.folder('good'), locked = w.harness.folder('locked');
    const job = await jobWith(w, 'Part way', [entry('first', 'fixture-engine', good), entry('second', 'fixture-other', locked), entry('third', 'fixture-stubborn', w.harness.folder('third'))]);
    const plan = await runPlan(w, job);
    const approval = await w.harness.approve(plan);
    // The folder is there when the plan is made and when the core plans again, and it cannot be searched when the program starts.
    fs.chmodSync(locked, 0o000);
    try {
      const result = await w.client.applyRun(plan, approval);
      assert.deepEqual(outcome(result), refused('ENGINE_START_FAILED', 'folder_unusable'));
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    const runs = must(await w.client.listRuns(GAUGE));
    assert.equal(runs.length, 1, 'the run is recorded');
    assert.deepEqual(runs[0]?.sessions.map(session => session.state), ['stopped', 'failed', 'stopped']);
    // Every place is free again.
    const again = await w.client.planRun(GAUGE, job);
    assert.ok(again.ok, JSON.stringify(again));
  });
}
