// The sessions suite: the start plan and its approval, the session cap, a second engine in one folder, the states a session moves through, the stop, and a stop that times out, all through the
// client. Like the other suites, it takes the core as a parameter, so the same suite runs against the fake core now and against the real core later.
// The engines of the world it runs in are written out in `SESSION_ENGINES`: a harness must start a core that holds exactly those engines, each behaving as its steps say, and the environment
// of `SESSION_ENVIRONMENT`. Every expected value is written out here by hand, and none is read from the core, so a wrong core fails the suite.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { Core, GaugePlan, GrantPlan, SessionPlan } from '../src/types.js';
import type { GaugeFolder } from '../src/fake-core.js';
import type { FakeStep } from '../../engine-sessions/src/fixtures.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { APPROVAL_TTL_MS } from './lifecycle-suite.js';

export interface SessionsHarness {
  readonly core: Core;
  /** The person approves one plan, the one they saw. Works for every kind of plan. Gives back the approval. */
  approve(plan: { readonly nonce: string }): string | Promise<string>;
  /** The person gives the second approval of a start in a folder that another engine uses. */
  approveShared(plan: { readonly nonce: string }): string | Promise<string>;
  /** Moves the clock of the core forward, in milliseconds. */
  advance(milliseconds: number): void | Promise<void>;
  /** A folder that exists, made for this test, for a session to run in. The same name gives the same folder. It is a real path, with no link in it. */
  folder(name: string): string;
  /** The program that every engine of `SESSION_ENGINES` is configured with: a plan for a Gauge shows it as it is written here, and never the real path behind a link. */
  readonly program: string;
  /**
   * Optional: makes a link on disk, named `name`, to a real folder that `folder` made, and gives the path of the link. A harness that has it, and `person`, runs the test of what a Gauge may read.
   */
  link?(name: string, target: string): string;
  /** Optional: what the person reads for a plan that a Gauge read: the real folder, the real program, and every engine in the folder. */
  person?(plan: { readonly nonce: string }): { readonly folder: string; readonly program: string | null; readonly sharedWith: readonly string[] };
  /** How long the core waits for an engine to go before a stop times out, in milliseconds. */
  readonly stopTimeoutMs: number;
  /** How many programs the core has started so far. */
  launches(): number;
  /** The lines that the nth program wrote (the first is 0), in the order the core started them. */
  output(index: number): readonly string[];
  /** Kills every program that is left, and fails the test when one stays alive. */
  close(): Promise<void>;
}

export interface SessionEngineFixture {
  readonly id: string;
  /** What the engine does: each step in order, and then it exits with code 0. A line `state:<name>` claims that state. */
  readonly steps: readonly FakeStep[];
  /** The variables the engine declares. */
  readonly env?: readonly string[];
  /** True when the engine takes a main-model choice, which reaches it as `--model <provider>/<model>`. */
  readonly takesModel?: boolean;
  /** True when the program of the engine is not on this computer. */
  readonly missing?: boolean;
}

const RUNNING: FakeStep = { say: 'state:running' };
const HOLD: FakeStep = { hold: true };
/** The engines the suite uses. The cap of the core is the default of 4, and the engine `fixture-unknown` is not held at all. */
export const SESSION_ENGINES: readonly SessionEngineFixture[] = [
  { id: 'fixture-engine', env: ['FIXTURE_DECLARED'], steps: [{ printEnv: true }, RUNNING, HOLD] },
  { id: 'fixture-other', steps: [RUNNING, HOLD] },
  { id: 'fixture-stubborn', steps: [{ ignoreTerm: true }, RUNNING, HOLD] },
  { id: 'fixture-asking', steps: [{ say: 'state:waiting' }, HOLD] },
  { id: 'fixture-failing', steps: [RUNNING, { sleep: 60 }, { exit: 3 }] },
  { id: 'fixture-chooser', takesModel: true, steps: [{ printArgs: true }, RUNNING, HOLD] },
  { id: 'fixture-missing', missing: true, steps: [] },
];
/** The environment of the core, from which variables pass. Only the names that a plan lists may reach an engine. */
export const SESSION_ENVIRONMENT: Readonly<Record<string, string>> = { FIXTURE_DECLARED: 'declared-value', FIXTURE_ALLOWED: 'allowed-value', FIXTURE_UNLISTED: 'must-not-pass' };

const FILE = 'export default 1;';
const base = JSON.parse(validManifest('tile-only')) as Record<string, unknown>;
const manifestOf = (fields: Record<string, unknown>): string => JSON.stringify({ ...base, ...fields });
const ALL_ENGINES = ['fixture-engine', 'fixture-other', 'fixture-stubborn', 'fixture-asking', 'fixture-failing', 'fixture-chooser', 'fixture-missing', 'fixture-unknown'];
const ALL_SESSION_PERMISSIONS = ['sessions.read', 'sessions.start', 'sessions.stop'];

/** The folders the suite loads. Written out here. */
export const SESSION_FOLDERS: readonly GaugeFolder[] = [
  { name: 'sessioner-folder', location: 'user', manifest: manifestOf({ id: 'fixture-sessioner', title: 'Fixture Sessioner', engines: ALL_ENGINES, permissions: ALL_SESSION_PERMISSIONS }), files: { 'ui/tile.js': FILE } },
  { name: 'reader-folder', location: 'user', manifest: manifestOf({ id: 'fixture-reader', title: 'Fixture Reader', engines: ['fixture-engine'], permissions: ['sessions.read'] }), files: { 'ui/tile.js': FILE } },
  { name: 'narrow-folder', location: 'user', manifest: manifestOf({ id: 'fixture-narrow', title: 'Fixture Narrow', engines: ['fixture-engine'], permissions: ALL_SESSION_PERMISSIONS }), files: { 'ui/tile.js': FILE } },
  { name: 'other-folder', location: 'user', manifest: manifestOf({ id: 'fixture-second', title: 'Fixture Second', engines: ALL_ENGINES, permissions: ALL_SESSION_PERMISSIONS }), files: { 'ui/tile.js': FILE } },
];

const HEX = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLAN_KEYS = ['action', 'billing', 'digest', 'engine', 'folder', 'force', 'gauge', 'model', 'nonce', 'program', 'session', 'sharedWith', 'steps', 'variables'];
const SUMMARY_KEYS = ['billing', 'engine', 'failure', 'folder', 'id', 'model', 'state'];
const outcome = (result: { ok: boolean; code?: string; reason?: string }) => (result.ok ? { ok: true } : result.reason === undefined ? { ok: false, code: result.code } : { ok: false, code: result.code, reason: result.reason });
const refused = (code: string, reason?: string) => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Registers the sessions tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runSessionsSuite(name: string, makeHarness: (folders: readonly GaugeFolder[]) => SessionsHarness | Promise<SessionsHarness>): void {
  const boot = async (t: TestContext) => {
    const harness = await makeHarness(SESSION_FOLDERS);
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
  /** Installs, enables, and grants the three session permissions to a Gauge. */
  const bring = async (w: World, folder: string, id: string, permissions: readonly string[] = ALL_SESSION_PERMISSIONS) => {
    await lifecycle(w, w.client.planInstall(folder));
    await lifecycle(w, w.client.planEnable(id));
    const plan: GrantPlan = must(await w.client.planGrant(id, permissions));
    must(await w.client.applyGrant(plan, await w.harness.approve(plan)));
  };
  const GAUGE = 'fixture-sessioner';
  const prepare = async (t: TestContext) => {
    const w = await boot(t);
    await bring(w, 'sessioner-folder', GAUGE);
    return w;
  };
  const plan = async (w: World, request: Parameters<CoreClient['planSessionStart']>[1], gauge = GAUGE): Promise<SessionPlan> => must(await w.client.planSessionStart(gauge, request));
  /** Plans a start, approves it (and the shared folder, when the plan names one), and applies it. Gives the plan and the session id. */
  const startSession = async (w: World, request: Parameters<CoreClient['planSessionStart']>[1], gauge = GAUGE) => {
    const planned = await plan(w, request, gauge);
    const approval = await w.harness.approve(planned);
    const shared = planned.sharedWith.length > 0 ? await w.harness.approveShared(planned) : undefined;
    const applied = must(await w.client.applySession(planned, approval, shared));
    return { plan: planned, session: applied.session, state: applied.state };
  };
  const stateOf = async (w: World, id: string, gauge = GAUGE): Promise<string> => must(await w.client.getSession(gauge, id)).state;
  const settle = async (w: World, id: string, state: string, gauge = GAUGE): Promise<void> => {
    const until = Date.now() + 5000;
    while ((await stateOf(w, id, gauge)) !== state) {
      if (Date.now() > until) throw new Error(`session ${id} did not reach ${state}; it is ${await stateOf(w, id, gauge)}`);
      await pause(10);
    }
  };
  const listOf = async (w: World, engine: string, gauge = GAUGE) => must(await w.client.listSessions(gauge, engine));
  const stopSession = async (w: World, id: string, gauge = GAUGE) => {
    const planned = must(await w.client.planSessionStop(gauge, id));
    return w.client.applySession(planned, await w.harness.approve(planned));
  };
  const ENGINE = 'fixture-engine';

  test(`${name}: makeHarness gives a distinct core on each call`, async t => {
    const one = await boot(t), two = await boot(t);
    assert.notEqual(one.core, two.core);
  });

  // The start plan

  test(`${name}: a start plan lists the engine, the program, the folder, the model choice, the billing source, and the variables, and it changes nothing`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const planned = await plan(w, { engine: ENGINE, folder });
    assert.deepEqual(Object.keys(planned).sort(), PLAN_KEYS);
    assert.deepEqual({
      action: planned.action, gauge: planned.gauge, engine: planned.engine, folder: planned.folder, session: planned.session, program: planned.program, model: planned.model, billing: planned.billing,
      variables: planned.variables, sharedWith: planned.sharedWith, force: planned.force,
    }, {
      action: 'start', gauge: GAUGE, engine: ENGINE, folder, session: null, program: w.harness.program, model: null, billing: 'engine-plan', variables: ['FIXTURE_DECLARED'], sharedWith: [], force: false,
    });
    assert.match(planned.digest, HEX);
    assert.match(planned.nonce, HEX);
    assert.notEqual(planned.digest, planned.nonce);
    assert.equal(Object.isFrozen(planned), true);
    assert.equal(Object.isFrozen(planned.steps), true);
    assert.equal(w.harness.launches(), 0, 'a plan starts no program');
    assert.deepEqual(await listOf(w, ENGINE), [], 'and makes no session');
  });

  test(`${name}: a start plan reads exactly like this`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const planned = await plan(w, { engine: ENGINE, folder, variables: ['FIXTURE_ALLOWED'] });
    assert.deepEqual(planned.steps, [
      'Gauge fixture-sessioner asks for a new session of the engine fixture-engine (Fake fixture-engine)',
      `program: ${w.harness.program}`,
      `folder: ${folder}`,
      "model: the engine's own default, and the core picks none",
      'billing source: the plan of the engine itself, so the core bills no key',
      'variables passed: FIXTURE_ALLOWED, FIXTURE_DECLARED',
      'the program gets these variables only, and it starts with an argument list and never through a shell',
      'the core never answers a permission prompt of the engine: you answer it yourself',
      'start the program in the folder, and keep the session until it stops or fails',
    ]);
  });

  test(`${name}: the variables of a plan are those the engine declares and those the person allows, sorted, with no repeat`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    assert.deepEqual((await plan(w, { engine: ENGINE, folder, variables: ['ZED', 'FIXTURE_ALLOWED', 'FIXTURE_DECLARED'] })).variables, ['FIXTURE_ALLOWED', 'FIXTURE_DECLARED', 'ZED']);
    assert.deepEqual((await plan(w, { engine: 'fixture-other', folder, variables: [] })).variables, []);
  });

  test(`${name}: a model choice is listed in the plan when the engine can take one, and refused with MODEL_NOT_FOR_ENGINE when it cannot, and it is never dropped`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const choice = { provider: 'local-llama', model: 'qwen3-7b' };
    const planned = await plan(w, { engine: 'fixture-chooser', folder, model: choice });
    assert.deepEqual(planned.model, choice);
    assert.ok(planned.steps.includes('model: local-llama qwen3-7b, as the Gauge asks'));
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder, model: choice })), refused('MODEL_NOT_FOR_ENGINE'));
    assert.deepEqual((await plan(w, { engine: 'fixture-chooser', folder, model: null })).model, null);
    assert.deepEqual(w.harness.launches(), 0);
  });

  test(`${name}: a model choice reaches the engine as an argument, after approval`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: 'fixture-chooser', folder: w.harness.folder('alpha'), model: { provider: 'local-llama', model: 'qwen' } });
    await settle(w, started.session, 'running');
    const line = w.harness.output(0).find(item => item.startsWith('args:'));
    assert.ok(line);
    const args = JSON.parse(line.slice('args:'.length)) as string[];
    assert.deepEqual(args.slice(-2), ['--model', 'local-llama/qwen']);
  });

  test(`${name}: a start plan is refused for a Gauge that holds no grant, an engine that the Gauge does not list, a Gauge that is not there, and a Gauge that is disabled`, async t => {
    const w = await boot(t);
    const folder = w.harness.folder('alpha');
    await lifecycle(w, w.client.planInstall('sessioner-folder'));
    await lifecycle(w, w.client.planEnable(GAUGE));
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder })), refused('GAUGE_GRANT_MISSING'), 'no grant');
    await bring(w, 'narrow-folder', 'fixture-narrow');
    assert.deepEqual(outcome(await w.client.planSessionStart('fixture-narrow', { engine: 'fixture-other', folder })), refused('GAUGE_GRANT_MISSING', 'engine_not_listed'));
    assert.deepEqual(outcome(await w.client.planSessionStart('no-such-gauge', { engine: ENGINE, folder })), refused('UNKNOWN_GAUGE'));
    await lifecycle(w, w.client.planDisable('fixture-narrow'));
    assert.deepEqual(outcome(await w.client.planSessionStart('fixture-narrow', { engine: ENGINE, folder })), refused('GAUGE_GRANT_MISSING', 'gauge_disabled'));
    await bring(w, 'reader-folder', 'fixture-reader', ['sessions.read']);
    assert.deepEqual(outcome(await w.client.planSessionStart('fixture-reader', { engine: ENGINE, folder })), refused('GAUGE_GRANT_MISSING', 'not_declared'));
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: a malformed start request is refused with ENGINE_REQUEST_INVALID and the field that is wrong`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const ask = async (request: unknown) => outcome(await w.client.planSessionStart(GAUGE, request as Parameters<CoreClient['planSessionStart']>[1]));
    const invalid = (reason: string) => refused('ENGINE_REQUEST_INVALID', reason);
    assert.deepEqual(await ask({ engine: ENGINE, folder: 'relative/path' }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder: '/' }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder: `${folder}/../alpha` }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder: `${folder}/does-not-exist` }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder: `${folder}\nforged` }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder: 5 }), invalid('folder'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, model: 'qwen' }), invalid('model'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, model: { provider: 'p' } }), invalid('model'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, model: { provider: '', model: 'm' } }), invalid('model'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, variables: ['A', 'A'] }), invalid('variables'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, variables: ['LD_PRELOAD'] }), invalid('variables'));
    assert.deepEqual(await ask({ engine: ENGINE, folder, variables: ['1BAD'] }), invalid('variables'));
    assert.equal(w.harness.launches(), 0);
  });

  test(`${name}: an engine that the core does not hold, or whose program is not on this computer, is ENGINE_NOT_FOUND`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: 'fixture-unknown', folder })), refused('ENGINE_NOT_FOUND', 'engine'));
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: 'fixture-missing', folder })), refused('ENGINE_NOT_FOUND', 'program_missing'));
  });

  // Approval

  test(`${name}: no start happens without an approval: no approval and an unknown one are refused, and the approval of another plan does not start this one, and no program starts`, async t => {
    const w = await prepare(t);
    const planned = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    assert.deepEqual(outcome(await w.client.applySession(planned)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(outcome(await w.client.applySession(planned, 'not-an-approval')), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(outcome(await w.client.applySession(planned, '')), refused('GAUGE_PLAN_NOT_APPROVED'));
    const grant = must(await w.client.planGrant(GAUGE, ['sessions.read']));
    const grantApproval = await w.harness.approve(grant);
    assert.deepEqual(outcome(await w.client.applySession(planned, grantApproval)), refused('GAUGE_PLAN_CHANGED'), 'the approval of a grant plan is for another plan');
    assert.equal(w.harness.launches(), 0);
    assert.deepEqual(await listOf(w, ENGINE), []);
  });

  test(`${name}: an approval is for one plan: another plan, a changed plan, and a changed folder are GAUGE_PLAN_CHANGED, and no program starts`, async t => {
    const w = await prepare(t);
    const one = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const two = await plan(w, { engine: 'fixture-other', folder: w.harness.folder('beta') });
    const approval = await w.harness.approve(one);
    assert.deepEqual(outcome(await w.client.applySession(two, approval)), refused('GAUGE_PLAN_CHANGED'), 'another plan');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, folder: w.harness.folder('beta') }, approval)), refused('GAUGE_PLAN_CHANGED'), 'another folder');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, program: '/bin/other-program' }, approval)), refused('GAUGE_PLAN_CHANGED'), 'another program');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, steps: [...one.steps, 'and also do this'] }, approval)), refused('GAUGE_PLAN_CHANGED'), 'another text');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, variables: [...one.variables, 'EXTRA'] }, approval)), refused('GAUGE_PLAN_CHANGED'), 'another variable');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, nonce: two.nonce }, approval)), refused('GAUGE_PLAN_CHANGED'), 'another nonce');
    assert.deepEqual(outcome(await w.client.applySession({ ...one, digest: two.digest }, approval)), refused('GAUGE_PLAN_CHANGED'), 'the digest is part of the plan that the Gauge read, so another digest is another plan');
    assert.deepEqual(outcome(await w.client.applySession(one, approval)), { ok: true }, 'and the plan as it was issued still applies, since no refusal used the approval up');
    assert.equal(w.harness.launches(), 1);
  });

  test(`${name}: an approval works once`, async t => {
    const w = await prepare(t);
    const planned = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const approval = await w.harness.approve(planned);
    must(await w.client.applySession(planned, approval));
    assert.deepEqual(outcome(await w.client.applySession(planned, approval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(w.harness.launches(), 1);
  });

  test(`${name}: an approval lasts 15 minutes`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const late = await plan(w, { engine: ENGINE, folder });
    const approval = await w.harness.approve(late);
    await w.harness.advance(APPROVAL_TTL_MS);
    assert.deepEqual(outcome(await w.client.applySession(late, approval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    const fresh = await plan(w, { engine: ENGINE, folder });
    const kept = await w.harness.approve(fresh);
    await w.harness.advance(APPROVAL_TTL_MS - 1);
    assert.deepEqual(outcome(await w.client.applySession(fresh, kept)), { ok: true });
  });

  test(`${name}: an applied step ends every approval given before it, so a plan approved before a start cannot apply after it`, async t => {
    const w = await prepare(t);
    const first = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const second = await plan(w, { engine: 'fixture-other', folder: w.harness.folder('beta') });
    const firstApproval = await w.harness.approve(first);
    const secondApproval = await w.harness.approve(second);
    must(await w.client.applySession(first, firstApproval));
    assert.deepEqual(outcome(await w.client.applySession(second, secondApproval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(w.harness.launches(), 1);
  });

  test(`${name}: two applies of one plan at once start one program, and the other is refused`, async t => {
    const w = await prepare(t);
    const planned = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const approval = await w.harness.approve(planned);
    const results = await Promise.all([w.client.applySession(planned, approval), w.client.applySession(planned, approval)]);
    assert.deepEqual(results.map(outcome).sort((a, b) => String(a.code).localeCompare(String(b.code))), [{ ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, { ok: true }]);
    assert.equal(w.harness.launches(), 1);
    assert.equal((await listOf(w, ENGINE)).length, 1);
  });

  test(`${name}: a revoke of sessions.start retires a plan that is waiting, so an approved start cannot apply after the person revoked`, async t => {
    const w = await prepare(t);
    const planned = await plan(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const approval = await w.harness.approve(planned);
    must(await w.client.revoke(GAUGE, ['sessions.start']));
    assert.deepEqual(outcome(await w.client.applySession(planned, approval)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(w.harness.launches(), 0);
  });

  // A session

  test(`${name}: an approved start makes a session that reaches running from its own line, and the engine got a clean environment`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const started = await startSession(w, { engine: ENGINE, folder, variables: ['FIXTURE_ALLOWED', 'FIXTURE_NOT_SET'] });
    assert.match(started.session, SESSION_ID);
    assert.ok(['starting', 'running'].includes(started.state), started.state);
    await settle(w, started.session, 'running');
    assert.deepEqual(await listOf(w, ENGINE), [{ id: started.session, engine: ENGINE, folder, state: 'running', billing: 'engine-plan', model: null, failure: null }]);
    const read = must(await w.client.getSession(GAUGE, started.session));
    assert.deepEqual(Object.keys(read).sort(), SUMMARY_KEYS);
    assert.equal(w.harness.launches(), 1);
    assert.deepEqual(w.harness.output(0).find(line => line.startsWith('env:')), `env:${JSON.stringify({ FIXTURE_ALLOWED: 'allowed-value', FIXTURE_DECLARED: 'declared-value' })}`);
  });

  test(`${name}: an engine that asks for its own sign-in puts the session in waiting`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: 'fixture-asking', folder: w.harness.folder('alpha') });
    await settle(w, started.session, 'waiting');
  });

  test(`${name}: an engine that ends with an error fails the session with the failure crashed, and the session leaves the cap`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: 'fixture-failing', folder: w.harness.folder('alpha') });
    await settle(w, started.session, 'failed');
    assert.equal(must(await w.client.getSession(GAUGE, started.session)).failure, 'crashed');
  });

  test(`${name}: a session list holds the sessions of the asked engine only, oldest first, with no output of the engine`, async t => {
    const w = await prepare(t);
    const one = await startSession(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const other = await startSession(w, { engine: 'fixture-other', folder: w.harness.folder('alpha') });
    const two = await startSession(w, { engine: ENGINE, folder: w.harness.folder('beta') });
    assert.deepEqual((await listOf(w, ENGINE)).map(item => item.id), [one.session, two.session]);
    assert.deepEqual((await listOf(w, 'fixture-other')).map(item => item.id), [other.session]);
    assert.deepEqual(await listOf(w, 'fixture-failing'), []);
  });

  // The cap and the pairs

  test(`${name}: the cap is 4: a fifth start is refused with ENGINE_LIMIT, and a stopped session frees its place`, async t => {
    const w = await prepare(t);
    const ids: string[] = [];
    for (const dir of ['one', 'two', 'three', 'four']) ids.push((await startSession(w, { engine: ENGINE, folder: w.harness.folder(dir) })).session);
    assert.equal(w.harness.launches(), 4);
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder: w.harness.folder('five') })), refused('ENGINE_LIMIT'));
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: 'fixture-other', folder: w.harness.folder('five') })), refused('ENGINE_LIMIT'));
    assert.equal(w.harness.launches(), 4);
    for (const id of ids) await settle(w, id, 'running');
    must(await stopSession(w, ids[0] ?? ''));
    assert.ok((await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder: w.harness.folder('five') })).ok);
  });

  test(`${name}: one engine runs once in a folder: a second start of the pair is ENGINE_PAIR_BUSY`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    await startSession(w, { engine: ENGINE, folder });
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder })), refused('ENGINE_PAIR_BUSY'));
    assert.ok((await w.client.planSessionStart(GAUGE, { engine: ENGINE, folder: w.harness.folder('beta') })).ok);
  });

  // A second engine in one folder

  test(`${name}: a second engine in one folder needs a notice and a second approval`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const first = await startSession(w, { engine: ENGINE, folder });
    const planned = await plan(w, { engine: 'fixture-other', folder });
    assert.deepEqual(planned.sharedWith, [ENGINE]);
    assert.deepEqual(planned.steps.slice(-3), [
      "notice: fixture-engine already runs in this folder, and two engines in one folder can overwrite each other's files",
      'a second approval is needed, for the shared folder',
      'start the program in the folder, and keep the session until it stops or fails',
    ]);
    const approval = await w.harness.approve(planned);
    assert.deepEqual(outcome(await w.client.applySession(planned, approval)), refused('ENGINE_FOLDER_SHARED'));
    assert.equal(w.harness.launches(), 1, 'the first approval alone starts nothing');
    assert.deepEqual(await listOf(w, 'fixture-other'), []);
    assert.deepEqual(outcome(await w.client.applySession(planned, approval, 'not-an-approval')), refused('ENGINE_FOLDER_SHARED'));
    const shared = await w.harness.approveShared(planned);
    assert.deepEqual(outcome(await w.client.applySession(planned, approval, shared)), { ok: true });
    assert.equal(w.harness.launches(), 2);
    assert.equal((await listOf(w, 'fixture-other')).length, 1);
    assert.equal(first.plan.sharedWith.length, 0);
  });

  test(`${name}: the two approvals are of two kinds: the second never stands for the first, and the first never stands for the second`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    await startSession(w, { engine: ENGINE, folder });
    const planned = await plan(w, { engine: 'fixture-other', folder });
    const approval = await w.harness.approve(planned);
    const shared = await w.harness.approveShared(planned);
    assert.deepEqual(outcome(await w.client.applySession(planned, shared, shared)), refused('GAUGE_PLAN_NOT_APPROVED'), 'the second approval as the first');
    assert.deepEqual(outcome(await w.client.applySession(planned, approval, approval)), refused('ENGINE_FOLDER_SHARED'), 'the first approval as the second');
    assert.equal(w.harness.launches(), 1);
    assert.deepEqual(outcome(await w.client.applySession(planned, approval, shared)), { ok: true }, 'a refusal used neither approval up');
  });

  test(`${name}: the second approval is for the same plan: the second approval of another plan does not start this one`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    await startSession(w, { engine: ENGINE, folder });
    const planned = await plan(w, { engine: 'fixture-other', folder });
    const other = await plan(w, { engine: 'fixture-failing', folder });
    const approval = await w.harness.approve(planned);
    const wrong = await w.harness.approveShared(other);
    assert.deepEqual(outcome(await w.client.applySession(planned, approval, wrong)), refused('ENGINE_FOLDER_SHARED'));
    assert.equal(w.harness.launches(), 1);
  });

  test(`${name}: a folder that another engine has left needs no second approval`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const first = await startSession(w, { engine: ENGINE, folder });
    await settle(w, first.session, 'running');
    must(await stopSession(w, first.session));
    const planned = await plan(w, { engine: 'fixture-other', folder });
    assert.deepEqual(planned.sharedWith, []);
    must(await w.client.applySession(planned, await w.harness.approve(planned)));
  });

  // Stop

  test(`${name}: a stop is a plan too, and it reads exactly like this`, async t => {
    const w = await prepare(t);
    const folder = w.harness.folder('alpha');
    const started = await startSession(w, { engine: ENGINE, folder });
    await settle(w, started.session, 'running');
    const planned = must(await w.client.planSessionStop(GAUGE, started.session));
    assert.deepEqual(Object.keys(planned).sort(), PLAN_KEYS);
    assert.deepEqual({
      action: planned.action, gauge: planned.gauge, engine: planned.engine, folder: planned.folder, session: planned.session, program: planned.program, model: planned.model, variables: planned.variables, sharedWith: planned.sharedWith, force: planned.force,
    }, { action: 'stop', gauge: GAUGE, engine: ENGINE, folder, session: started.session, program: null, model: null, variables: [], sharedWith: [], force: false });
    assert.deepEqual(planned.steps, [
      `Gauge fixture-sessioner asks to stop session ${started.session} of the engine fixture-engine`,
      `folder: ${folder}`,
      `send the stop signal to the program and everything it started, and wait up to ${w.harness.stopTimeoutMs} ms for them to go`,
      'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
    ]);
    assert.equal(await stateOf(w, started.session), 'running', 'a plan stops nothing');
  });

  test(`${name}: a stop without an approval stops nothing, and an approved stop ends the session`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    await settle(w, started.session, 'running');
    const planned = must(await w.client.planSessionStop(GAUGE, started.session));
    assert.deepEqual(outcome(await w.client.applySession(planned)), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.deepEqual(outcome(await w.client.applySession(planned, 'nope')), refused('GAUGE_PLAN_NOT_APPROVED'));
    assert.equal(await stateOf(w, started.session), 'running');
    const applied = must(await w.client.applySession(planned, await w.harness.approve(planned)));
    assert.deepEqual(applied, { action: 'stop', session: started.session, engine: ENGINE, state: 'stopped' });
    assert.equal(await stateOf(w, started.session), 'stopped');
    assert.equal(must(await w.client.getSession(GAUGE, started.session)).failure, null);
  });

  test(`${name}: a stop of a session that is not there is ENGINE_SESSION_UNKNOWN, one that has ended is ENGINE_SESSION_ENDED, and a malformed id is a request refusal`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    await settle(w, started.session, 'running');
    must(await stopSession(w, started.session));
    assert.deepEqual(outcome(await w.client.planSessionStop(GAUGE, started.session)), refused('ENGINE_SESSION_ENDED'));
    assert.deepEqual(outcome(await w.client.planSessionStop(GAUGE, 's-0000000000000000')), refused('ENGINE_SESSION_UNKNOWN'));
    assert.deepEqual(outcome(await w.client.planSessionStop(GAUGE, 'constructor')), refused('ENGINE_SESSION_UNKNOWN'));
    for (const bad of ['', 'S-1', '../x', 'a b']) assert.deepEqual(outcome(await w.client.planSessionStop(GAUGE, bad)), refused('ENGINE_REQUEST_INVALID', 'session'), bad);
    assert.deepEqual(outcome(await w.client.planSessionStop('no-such-gauge', started.session)), refused('UNKNOWN_GAUGE'));
  });

  test(`${name}: a stop needs the sessions.stop grant for the engine of the session`, async t => {
    const w = await prepare(t);
    await bring(w, 'narrow-folder', 'fixture-narrow');
    await bring(w, 'reader-folder', 'fixture-reader', ['sessions.read']);
    const other = await startSession(w, { engine: 'fixture-other', folder: w.harness.folder('alpha') });
    const mine = await startSession(w, { engine: ENGINE, folder: w.harness.folder('beta') });
    assert.deepEqual(outcome(await w.client.planSessionStop('fixture-narrow', other.session)), refused('ENGINE_SESSION_UNKNOWN'), 'a session of an engine the Gauge does not list reads as unknown');
    assert.deepEqual(outcome(await w.client.planSessionStop('fixture-reader', mine.session)), refused('GAUGE_GRANT_MISSING', 'not_declared'), 'a Gauge that does not declare the permission');
    must(await w.client.revoke(GAUGE, ['sessions.stop']));
    assert.deepEqual(outcome(await w.client.planSessionStop(GAUGE, mine.session)), refused('GAUGE_GRANT_MISSING'), 'a grant that was revoked');
    assert.ok((await w.client.planSessionStop('fixture-narrow', mine.session)).ok);
  });

  test(`${name}: a stop that times out leaves the session stopping and reports ENGINE_STOP_TIMEOUT, and a second stop kills it`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: 'fixture-stubborn', folder: w.harness.folder('alpha') });
    await settle(w, started.session, 'running');
    const first = await stopSession(w, started.session);
    assert.deepEqual(outcome(first), refused('ENGINE_STOP_TIMEOUT'));
    assert.equal(await stateOf(w, started.session), 'stopping');
    // The session still holds its place, and the engine is still alive.
    const second = must(await w.client.planSessionStop(GAUGE, started.session));
    assert.equal(second.force, true);
    assert.deepEqual(second.steps.slice(2), [
      'the session is stopping already: send the kill signal, which the program cannot ignore, to the program and everything it started',
      'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
    ]);
    const applied = must(await w.client.applySession(second, await w.harness.approve(second)));
    assert.deepEqual(applied, { action: 'stop', session: started.session, engine: 'fixture-stubborn', state: 'stopped' });
    assert.equal(await stateOf(w, started.session), 'stopped');
  });

  test(`${name}: a session that is stopping keeps its place under the cap`, async t => {
    const w = await prepare(t);
    const stuck = await startSession(w, { engine: 'fixture-stubborn', folder: w.harness.folder('one') });
    for (const dir of ['two', 'three', 'four']) await startSession(w, { engine: 'fixture-other', folder: w.harness.folder(dir) });
    await settle(w, stuck.session, 'running');
    assert.deepEqual(outcome(await stopSession(w, stuck.session)), refused('ENGINE_STOP_TIMEOUT'));
    assert.deepEqual(outcome(await w.client.planSessionStart(GAUGE, { engine: 'fixture-other', folder: w.harness.folder('five') })), refused('ENGINE_LIMIT'));
  });

  // Reads

  test(`${name}: a read needs the sessions.read grant for the engine, and a Gauge that lists one engine reads that engine only`, async t => {
    const w = await prepare(t);
    await bring(w, 'reader-folder', 'fixture-reader', ['sessions.read']);
    const mine = await startSession(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    const other = await startSession(w, { engine: 'fixture-other', folder: w.harness.folder('beta') });
    assert.deepEqual((await listOf(w, ENGINE, 'fixture-reader')).map(item => item.id), [mine.session]);
    assert.equal(must(await w.client.getSession('fixture-reader', mine.session)).id, mine.session);
    assert.deepEqual(outcome(await w.client.listSessions('fixture-reader', 'fixture-other')), refused('GAUGE_GRANT_MISSING', 'engine_not_listed'));
    assert.deepEqual(outcome(await w.client.getSession('fixture-reader', other.session)), refused('ENGINE_SESSION_UNKNOWN'));
    assert.deepEqual(outcome(await w.client.listSessions('no-such-gauge', ENGINE)), refused('UNKNOWN_GAUGE'));
    assert.deepEqual(outcome(await w.client.getSession('no-such-gauge', mine.session)), refused('UNKNOWN_GAUGE'));
  });

  test(`${name}: a session of an engine that the caller has no grant for reads exactly as a session that is not there, for a get and for a stop, so a Gauge cannot find which ids exist`, async t => {
    const w = await prepare(t);
    await bring(w, 'narrow-folder', 'fixture-narrow');
    const hidden = await startSession(w, { engine: 'fixture-other', folder: w.harness.folder('alpha') });
    const absent = 's-0000000000000000';
    assert.deepEqual(outcome(await w.client.getSession('fixture-narrow', hidden.session)), outcome(await w.client.getSession('fixture-narrow', absent)));
    assert.deepEqual(outcome(await w.client.planSessionStop('fixture-narrow', hidden.session)), outcome(await w.client.planSessionStop('fixture-narrow', absent)));
    assert.deepEqual(outcome(await w.client.getSession('fixture-narrow', absent)), refused('ENGINE_SESSION_UNKNOWN'));
    // The grant check comes first: a Gauge with no grant at all gets the grant refusal for any id, existing or not, so the refusal never says whether the id exists.
    must(await w.client.revoke('fixture-narrow', ['sessions.read', 'sessions.stop']));
    assert.deepEqual(outcome(await w.client.getSession('fixture-narrow', hidden.session)), refused('GAUGE_GRANT_MISSING'));
    assert.deepEqual(outcome(await w.client.getSession('fixture-narrow', absent)), refused('GAUGE_GRANT_MISSING'));
    assert.deepEqual(outcome(await w.client.planSessionStop('fixture-narrow', hidden.session)), refused('GAUGE_GRANT_MISSING'));
    assert.deepEqual(outcome(await w.client.planSessionStop('fixture-narrow', absent)), refused('GAUGE_GRANT_MISSING'));
  });

  test(`${name}: a read of a session that is not there is ENGINE_SESSION_UNKNOWN, and a malformed id is a request refusal`, async t => {
    const w = await prepare(t);
    assert.deepEqual(outcome(await w.client.getSession(GAUGE, 's-0000000000000000')), refused('ENGINE_SESSION_UNKNOWN'));
    assert.deepEqual(outcome(await w.client.getSession(GAUGE, 'constructor')), refused('ENGINE_SESSION_UNKNOWN'));
    for (const bad of ['', 'S-1', 'a/b', '__proto__']) assert.deepEqual(outcome(await w.client.getSession(GAUGE, bad)), refused('ENGINE_REQUEST_INVALID', 'session'), bad);
  });

  test(`${name}: a read without the grant is refused, and a revoke of sessions.read ends the access at once`, async t => {
    const w = await prepare(t);
    const started = await startSession(w, { engine: ENGINE, folder: w.harness.folder('alpha') });
    must(await w.client.revoke(GAUGE, ['sessions.read']));
    assert.deepEqual(outcome(await w.client.listSessions(GAUGE, ENGINE)), refused('GAUGE_GRANT_MISSING'));
    assert.deepEqual(outcome(await w.client.getSession(GAUGE, started.session)), refused('GAUGE_GRANT_MISSING'));
  });

  test(`${name}: a Gauge that lists one engine reads no real folder and no engine that it may not read, in any reply, and the second approval is taken from the plan of the person`, async t => {
    const w = await boot(t);
    const { link, person } = w.harness;
    if (link === undefined || person === undefined) { t.skip('the harness has no link and no view of the person'); return; }
    await bring(w, 'sessioner-folder', GAUGE);
    await bring(w, 'narrow-folder', 'fixture-narrow');
    const real = w.harness.folder('leak-real'), linked = link('leak-link', real);
    // Another Gauge runs the engine that the narrow Gauge does not list, in the real folder.
    const other = await startSession(w, { engine: 'fixture-other', folder: real });
    await settle(w, other.session, 'running');
    // Everything that the narrow Gauge reads is kept, and searched at the end.
    const seen: string[] = [];
    const watching: Core = {
      call: async (method, params) => {
        try {
          const reply = await w.harness.core.call(method, params);
          seen.push(JSON.stringify(reply));
          return reply;
        } catch (error) {
          seen.push(String(error));
          throw error;
        }
      },
    };
    const narrow = createCoreClient(watching);
    const planned = must(await narrow.planSessionStart('fixture-narrow', { engine: ENGINE, folder: linked }));
    assert.equal(planned.folder, linked);
    assert.deepEqual(planned.sharedWith, []);
    const full = person(planned);
    assert.equal(full.folder, real, 'the person reads the real folder');
    assert.deepEqual(full.sharedWith, ['fixture-other'], 'and the engine that the Gauge may not read');
    const approval = await w.harness.approve(planned);
    const shared = full.sharedWith.length > 0 ? await w.harness.approveShared(planned) : undefined;
    assert.notEqual(shared, undefined);
    const applied = must(await narrow.applySession(planned, approval, shared));
    await settle(w, applied.session, 'running');
    assert.equal(must(await w.client.getSession(GAUGE, applied.session)).folder, linked, 'a read of the session gives the folder as it was asked for');
    // A second start of the pair and a plan that is changed are refused with a code, and nothing more.
    assert.deepEqual(outcome(await narrow.planSessionStart('fixture-narrow', { engine: ENGINE, folder: linked })), refused('ENGINE_PAIR_BUSY'));
    assert.deepEqual(outcome(await narrow.applySession({ ...planned, folder: w.harness.folder('leak-other') }, approval)), refused('GAUGE_PLAN_NOT_APPROVED'), 'the approval was used up');
    const text = seen.join('\n');
    assert.notEqual(full.program, w.harness.program, 'the harness configures its program as a link, so the real program is another path');
    for (const secret of [real, full.program ?? '', 'fixture-other']) assert.equal(text.includes(secret), false, secret);
  });
}
