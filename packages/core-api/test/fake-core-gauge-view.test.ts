// What a Gauge reads of a start plan, and what the person reads. The core makes one plan with two views of it: the person reads the real folder, the real program, and every engine in the folder, and a Gauge reads the folder
// and the program as it asked for them and only the engines it may read. The digest and the approval are for the full plan, so what the person approves is exactly what runs. The host's programs are made by the test, and
// a link is a table of the test, so each event is exact. One test at the end uses a real link on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCore, type FakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createCoreClient, type CoreClient } from '../src/client.js';
import { fakeSignal } from '../../engine-sessions/src/fixtures.js';
import { createEngineHost, type EngineHost, type EngineSpec } from '../../engine-sessions/src/host.js';
import { manualLauncher } from '../../engine-sessions/test/support.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import type { Core, CoreMethod, CoreReply, RunPlan, SessionPlan } from '../src/types.js';

const FILE = 'export default 1;';
const base = JSON.parse(validManifest('tile-only')) as Record<string, unknown>;
const folderOf = (name: string, id: string, engines: readonly string[], permissions: readonly string[]): GaugeFolder => (
  { name, location: 'user', manifest: JSON.stringify({ ...base, id, title: id, engines, permissions }), files: { 'ui/tile.js': FILE } }
);
const ALL = ['fixture-engine', 'fixture-other', 'fixture-third'];
const FOLDERS: readonly GaugeFolder[] = [
  // Only `sessions.start` for one engine: the Gauge of the acceptance.
  folderOf('starter-folder', 'fixture-starter', ['fixture-engine'], ['sessions.start']),
  // Start and stop for one engine, and no read.
  folderOf('stopper-folder', 'fixture-stopper', ['fixture-engine'], ['sessions.start', 'sessions.stop']),
  // Start for one engine, and read for the engine `fixture-other`.
  folderOf('viewer-folder', 'fixture-viewer', ['fixture-engine', 'fixture-other'], ['sessions.start', 'sessions.read']),
  // Jobs and runs, with a start grant for the engines of its job, and no read of any session.
  folderOf('blind-folder', 'fixture-blind', ['fixture-engine', 'fixture-other'], ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start']),
  // The same, and it may read the sessions of all three engines.
  folderOf('seer-folder', 'fixture-seer', ALL, ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start', 'sessions.read']),
];
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'fixture-starter': ['sessions.start'], 'fixture-stopper': ['sessions.start', 'sessions.stop'], 'fixture-viewer': ['sessions.start', 'sessions.read'],
  'fixture-blind': ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start'], 'fixture-seer': ['jobs.read', 'jobs.write', 'jobs.run', 'sessions.start', 'sessions.read'],
};
const spec = (id: string, program = `/bin/${id}`): EngineSpec => ({ id, title: `Engine ${id}`, program, args: [], env: [], billing: 'engine-plan', signalOf: fakeSignal });
const REAL = '/real/one', LINK = '/link/one', REAL_PROGRAM = '/real/bin/claude-1.2';

/** A core over a host whose programs the test makes. The folder `/link/one` is a link to a real folder that the test can move, and the program `claude` is found at a real path behind a link. */
async function world(options: { readonly cap?: number } = {}) {
  const launcher = manualLauncher();
  const links: Record<string, string> = { [LINK]: REAL, '/link/two': '/real/two', '/link/three': '/real/three', '/link/four': '/real/four' };
  let counter = 0, jobs = 0, runs = 0;
  const host: EngineHost = createEngineHost({
    engines: [spec('fixture-engine', 'claude'), spec('fixture-other'), spec('fixture-third')], launcher, log: () => undefined, newId: () => `s-${(counter += 1)}`, schedule: () => () => undefined, stopTimeoutMs: 2000, killWaitMs: 20,
    locate: program => (program === 'claude' ? REAL_PROGRAM : program),
    canonical: folder => { const real = links[folder] ?? folder; return { path: real, key: real }; },
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  const fake = createFakeCore({ folders: FOLDERS, engineHost: host, jobIds: () => `job-${(jobs += 1)}`, runIds: () => `run-${(runs += 1)}` });
  const client = createCoreClient(fake);
  for (const folder of FOLDERS) {
    const id = (JSON.parse(folder.manifest as string) as { id: string }).id;
    for (const step of [() => client.planInstall(folder.name), () => client.planEnable(id)]) {
      const planned = await step();
      assert.ok(planned.ok, JSON.stringify(planned));
      assert.ok((await client.applyPlan(planned.value, fake.approve(planned.value.nonce))).ok);
    }
    const grant = await client.planGrant(id, PERMISSIONS[id] ?? []);
    assert.ok(grant.ok, JSON.stringify(grant));
    assert.ok((await client.applyGrant(grant.value, fake.approve(grant.value.nonce))).ok);
  }
  /** Someone else (the person, or another Gauge) runs the engine in the folder: the host starts it, and its program says that it runs. */
  const occupy = (engine: string, folder: string): string => {
    const planned = host.planStart({ engine, folder });
    assert.ok(planned.ok, JSON.stringify(planned));
    const begun = host.beginStart(planned.plan, { sharedApproved: true });
    assert.ok(begun.ok, JSON.stringify(begun));
    launcher.programs[launcher.programs.length - 1]?.spawn();
    launcher.programs[launcher.programs.length - 1]?.line('state:running');
    return begun.session;
  };
  return { launcher, host, fake, client, links, occupy };
}
type World = Awaited<ReturnType<typeof world>>;

const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const sessionOf = (plan: SessionPlan | RunPlan): SessionPlan => { assert.ok(plan.action === 'start' || plan.action === 'stop'); return plan; };
const runOf = (plan: SessionPlan | RunPlan): RunPlan => { assert.equal(plan.action, 'run'); return plan as RunPlan; };
/** The names of the fields whose values differ between two plans. */
const differing = (left: object, right: object): string[] => {
  const one = left as Record<string, unknown>, two = right as Record<string, unknown>;
  return [...new Set([...Object.keys(one), ...Object.keys(two)])].filter(key => JSON.stringify(one[key]) !== JSON.stringify(two[key])).sort();
};
const entry = (label: string, engine: string, folder: string) => ({ label, engine, harness: 'plain-harness', folder, model: null, task: `Task of ${label}.` });
async function makeJob(w: World, sessions: readonly Record<string, unknown>[], gauge = 'fixture-blind'): Promise<string> {
  const plan = must(await w.client.planJobCreate(gauge, { title: 'Review', sessions }));
  return must(await w.client.applyJob(plan, w.fake.approve(plan.nonce))).job;
}
/** The plain SHA-256 hashes that a Gauge could make of a plan that it half knows, by every way that a core could put a nonce and a label in front of or behind it. */
function plainGuesses(label: string, nonce: string, fields: readonly unknown[]): string[] {
  const plain = (text: string): string => createHash('sha256').update(text).digest('hex');
  const lists: unknown[][] = [fields.slice(), [label, ...fields], [nonce, ...fields], [label, nonce, ...fields], [nonce, label, ...fields], [label, ...fields, nonce], [...fields, nonce], [nonce, label, ...fields, nonce]];
  return lists.flatMap(list => [plain(JSON.stringify(list)), plain(`${nonce}${JSON.stringify(list)}`), plain(`${JSON.stringify(list)}${nonce}`)]);
}
/**
 * An apply that is meant to be refused answers at once. A core that wrongly starts the programs waits for them to say that they run, and the manual launcher never does, so the call is given one turn of the loop and
 * then reported as still waiting, which no assertion accepts: a wrong core fails the test, and does not hang it.
 */
const promptly = <T>(call: Promise<T>): Promise<T | 'still waiting'> => Promise.race([call, new Promise<'still waiting'>(resolve => setImmediate(() => resolve('still waiting')))]);
const applyNow = (client: CoreClient, ...args: Parameters<CoreClient['applySession']>) => promptly(client.applySession(...args));
const applyRunNow = (client: CoreClient, ...args: Parameters<CoreClient['applyRun']>) => promptly(client.applyRun(...args));
const SHARED_NOTICE = "notice: fixture-other already runs in this folder, and two engines in one folder can overwrite each other's files";
const START_COMMON = [
  "model: the engine's own default, and the core picks none",
  'billing source: the plan of the engine itself, so the core bills no key',
  'variables passed: none',
  'the program gets these variables only, and it starts with an argument list and never through a shell',
  'the core never answers a permission prompt of the engine: you answer it yourself',
];
const HEAD = (gauge: string): string => `Gauge ${gauge} asks for a new session of the engine fixture-engine (Engine fixture-engine)`;
const LAST = 'start the program in the folder, and keep the session until it stops or fails';

// The start plan

test('a Gauge with only sessions.start for one engine reads the folder and the program as it asked for them, and no engine it may not read', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  assert.equal(plan.folder, LINK);
  assert.equal(plan.program, 'claude');
  assert.deepEqual(plan.sharedWith, []);
  assert.deepEqual(plan.steps, [HEAD('fixture-starter'), 'program: claude', `folder: ${LINK}`, ...START_COMMON, LAST]);
  const text = JSON.stringify(plan);
  for (const secret of [REAL, REAL_PROGRAM, 'fixture-other', 'claude-1.2']) assert.equal(text.includes(secret), false, secret);
});

test('the person reads the full plan: the real folder, the real program, every engine in the folder, and the name the Gauge used', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const person = sessionOf(w.fake.personPlan(plan.nonce));
  assert.equal(person.folder, REAL);
  assert.equal(person.program, REAL_PROGRAM);
  assert.deepEqual(person.sharedWith, ['fixture-other']);
  assert.deepEqual(person.steps, [
    HEAD('fixture-starter'), `program: ${REAL_PROGRAM}`, `folder: ${REAL}`, `the Gauge named this folder as ${LINK}`, ...START_COMMON, SHARED_NOTICE, 'a second approval is needed, for the shared folder', LAST,
  ]);
});

test('the Gauge plan and the person plan are one plan: they differ in the folder, the program, the engines that share, and the text of those, and in nothing else', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK, variables: ['FIXTURE_ALLOWED'] }));
  const person = sessionOf(w.fake.personPlan(plan.nonce));
  assert.deepEqual(differing(plan, person), ['folder', 'program', 'sharedWith', 'steps']);
  assert.equal(person.digest, plan.digest);
  assert.equal(person.nonce, plan.nonce);
  assert.deepEqual(Object.keys(plan).sort(), Object.keys(person).sort());
  // The text differs in exactly the lines of those values.
  const kept = person.steps.filter(line => !line.startsWith('program:') && !line.startsWith('folder:') && !line.startsWith('the Gauge named') && !line.startsWith('notice:') && !line.startsWith('a second approval'));
  assert.deepEqual(plan.steps.filter(line => !line.startsWith('program:') && !line.startsWith('folder:')), kept);
});

test('a plan without a link or a hidden engine is the same plan for the Gauge and for the person, up to the program path that it names', async () => {
  const w = await world();
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: '/work/plain' }));
  const person = sessionOf(w.fake.personPlan(plan.nonce));
  assert.deepEqual(differing(plan, person), ['program', 'steps'], 'only the program differs: it is the configured name for a Gauge and the real path for the person');
  assert.deepEqual(person.steps.filter(line => !line.startsWith('program:')), plan.steps.filter(line => !line.startsWith('program:')));
});

test('a Gauge reads the engines that it may read in the folder, and the person reads them all', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  w.occupy('fixture-third', REAL);
  const plan = must(await w.client.planSessionStart('fixture-viewer', { engine: 'fixture-engine', folder: LINK }));
  assert.deepEqual(plan.sharedWith, ['fixture-other'], 'the Gauge may read fixture-other, and may not read fixture-third, which its manifest does not list');
  assert.deepEqual(plan.steps, [
    HEAD('fixture-viewer'), 'program: claude', `folder: ${LINK}`, ...START_COMMON, SHARED_NOTICE, 'a second approval is needed, for the shared folder', LAST,
  ]);
  assert.equal(plan.folder, LINK, 'it still reads the folder as it asked for it');
  const person = sessionOf(w.fake.personPlan(plan.nonce));
  assert.deepEqual(person.sharedWith, ['fixture-other', 'fixture-third']);
  assert.deepEqual(differing(plan, person), ['folder', 'program', 'sharedWith', 'steps']);
  assert.ok(person.steps.includes("notice: fixture-other, fixture-third already run in this folder, and two engines in one folder can overwrite each other's files"));
});

test('a Gauge that holds sessions.start for an engine, and not sessions.read, does not read that engine in a folder', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-blind', { engine: 'fixture-engine', folder: LINK }));
  assert.deepEqual(plan.sharedWith, [], 'the Gauge may start fixture-other, but a start grant is not a read of what it does');
  assert.deepEqual(sessionOf(w.fake.personPlan(plan.nonce)).sharedWith, ['fixture-other']);
});

test('the digest is the same in both views, differs for each plan, and no plain SHA-256 of the plan gives it', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const request = { engine: 'fixture-engine', folder: LINK };
  const one = must(await w.client.planSessionStart('fixture-starter', request)), two = must(await w.client.planSessionStart('fixture-starter', request));
  assert.notEqual(one.digest, two.digest, 'two plans of one request have two digests, so a Gauge cannot tell from a digest that two plans agree');
  assert.match(one.digest, /^[0-9a-f]{64}$/);
  const person = sessionOf(w.fake.personPlan(one.nonce));
  // A Gauge that guessed the real folder and the engine could test its guess against any digest that a plain hash gives. These are the plain hashes that it could make of the person plan: with the nonce
  // at the start, after the label, or at the end, with and without the label, as a list or as text.
  const fields = [person.action, person.gauge, person.engine, person.folder, person.session, person.program, person.model, person.billing, person.variables, person.sharedWith, person.force, person.steps];
  const plain = (text: string): string => createHash('sha256').update(text).digest('hex');
  const guesses = plainGuesses('session', one.nonce, fields).concat(plainGuesses('session', one.nonce, [...fields, LINK, 'claude']), [plain(JSON.stringify(person))]);
  assert.ok(!guesses.includes(one.digest));
});

test('the Gauge applies the plan it read: the person approves the full plan, and the program starts in the real folder, as the person saw', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const before = w.launcher.programs.length;
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const applying = w.client.applySession(plan, w.fake.approve(plan.nonce), w.fake.approveShared(plan.nonce));
  w.launcher.programs[before]?.spawn();
  const applied = must(await applying);
  assert.equal(applied.engine, 'fixture-engine');
  const launched = w.launcher.programs[before]?.spec;
  assert.equal(launched?.cwd, REAL, 'the program runs in the real folder that the person saw');
  assert.equal(launched?.program, REAL_PROGRAM, 'and it is the real program that the person saw');
  const kept = w.host.get(applied.session);
  assert.equal(kept?.folder, REAL);
  assert.equal(kept?.requestedFolder, LINK);
});

test('a plan whose engines in the folder are hidden from the Gauge still needs the second approval, and the refusal without it names no engine and no folder', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const before = w.launcher.programs.length;
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const approval = w.fake.approve(plan.nonce);
  assert.deepEqual(await applyNow(w.client, plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, 'the same refusal as for a missing approval, since the Gauge may not read the engine that shares');
  assert.equal(w.launcher.programs.length, before, 'nothing started');
  // The approval was not used up, so the person can give the second one now.
  const applying = w.client.applySession(plan, approval, w.fake.approveShared(plan.nonce));
  w.launcher.programs[before]?.spawn();
  assert.ok((await applying).ok);
});

test('a Gauge that may read the engine that shares is refused with ENGINE_FOLDER_SHARED when the second approval is missing', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const before = w.launcher.programs.length;
  const plan = must(await w.client.planSessionStart('fixture-viewer', { engine: 'fixture-engine', folder: LINK }));
  assert.deepEqual(await applyNow(w.client, plan, w.fake.approve(plan.nonce)), { ok: false, code: 'ENGINE_FOLDER_SHARED' });
  assert.equal(w.launcher.programs.length, before);
});

test('a plan is applied only as the core issued it: any change of the Gauge view is a changed plan, and the person plan is not the plan of a Gauge', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const approval = w.fake.approve(plan.nonce), shared = w.fake.approveShared(plan.nonce);
  const person = sessionOf(w.fake.personPlan(plan.nonce));
  const other = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: '/work/other' }));
  const changes: readonly SessionPlan[] = [
    { ...plan, folder: '/work/other' }, { ...plan, steps: [...plan.steps, 'one more line'] }, { ...plan, digest: 'f'.repeat(64) }, { ...plan, digest: other.digest },
    { ...plan, program: '/real/bin/claude-1.2' }, { ...plan, sharedWith: ['fixture-other'] }, { ...plan, variables: ['FIXTURE_ALLOWED'] }, { ...plan, model: { provider: 'p', model: 'm' } },
    { ...plan, gauge: 'fixture-viewer' }, { ...plan, billing: 'local' }, { ...plan, engine: 'fixture-other' }, person,
  ];
  for (const changed of changes) {
    assert.deepEqual(await applyNow(w.client, changed, approval, shared), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, JSON.stringify(differing(plan, changed)));
  }
  assert.equal(w.launcher.programs.length, 1, 'nothing started but the engine of someone else');
  const before = w.launcher.programs.length;
  const applying = w.client.applySession(plan, approval, shared);
  w.launcher.programs[before]?.spawn();
  assert.ok((await applying).ok, 'the plan as it was issued still applies');
});

test('the approval of a plan is not the approval of a plan of another kind: a session plan sent with the nonce of another plan is a changed plan', async () => {
  const w = await world();
  const session = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const grant = must(await w.client.planGrant('fixture-starter', ['sessions.start']));
  const approval = w.fake.approve(grant.nonce);
  assert.deepEqual(await applyNow(w.client, { ...session, nonce: grant.nonce }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal(w.launcher.programs.length, 0);
});

test('a link that moves after the plan was made makes the plan stale: the core plans again from the folder as the Gauge asked for it', async () => {
  const w = await world();
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const approval = w.fake.approve(plan.nonce);
  w.links[LINK] = '/real/elsewhere';
  assert.deepEqual(await applyNow(w.client, plan, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal(w.launcher.programs.length, 0, 'nothing started in the folder that the person did not see');
});

test('an engine that the Gauge may not read, and that begins or ends in the folder after the plan, makes the plan stale', async () => {
  const w = await world();
  const first = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const approval = w.fake.approve(first.nonce);
  w.occupy('fixture-other', REAL);
  assert.deepEqual(await applyNow(w.client, first, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, 'an engine began in the folder: the person approved a plan without it');
  const second = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const again = w.fake.approve(second.nonce);
  const ended = w.launcher.programs[0];
  ended?.exit(0, null);
  assert.deepEqual(await applyNow(w.client, second, again, w.fake.approveShared(second.nonce)), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, 'the engine ended: the plan that the person approved named it');
});

test('a start that is refused tells a Gauge nothing but a closed code: the pair, the limit, and a folder that is not one', async () => {
  const w = await world({ cap: 2 });
  w.occupy('fixture-engine', REAL);
  assert.deepEqual(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }), { ok: false, code: 'ENGINE_PAIR_BUSY' });
  w.occupy('fixture-other', '/real/two');
  assert.deepEqual(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: '/link/two' }), { ok: false, code: 'ENGINE_LIMIT' });
  assert.deepEqual(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: 'not/absolute' }), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder' });
});

// The stop plan, and the reads of a session

test('a stop plan for a Gauge shows the folder as the session was asked for, and the person reads the real folder', async () => {
  const w = await world();
  const before = w.launcher.programs.length;
  const start = must(await w.client.planSessionStart('fixture-stopper', { engine: 'fixture-engine', folder: LINK }));
  const applying = w.client.applySession(start, w.fake.approve(start.nonce));
  w.launcher.programs[before]?.spawn();
  w.launcher.programs[before]?.line('state:running');
  const session = must(await applying).session;
  const stop = must(await w.client.planSessionStop('fixture-stopper', session));
  assert.equal(stop.folder, LINK);
  assert.deepEqual(stop.steps, [
    `Gauge fixture-stopper asks to stop session ${session} of the engine fixture-engine`, `folder: ${LINK}`,
    'send the stop signal to the program and everything it started, and wait up to 2000 ms for them to go',
    'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
  assert.equal(JSON.stringify(stop).includes(REAL), false);
  const person = sessionOf(w.fake.personPlan(stop.nonce));
  assert.equal(person.folder, REAL);
  assert.deepEqual(person.steps, [
    `Gauge fixture-stopper asks to stop session ${session} of the engine fixture-engine`, `folder: ${REAL}`, `the session was asked for in the folder ${LINK}`,
    'send the stop signal to the program and everything it started, and wait up to 2000 ms for them to go',
    'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
  assert.deepEqual(differing(stop, person), ['folder', 'steps']);
  const stopping = w.client.applySession(stop, w.fake.approve(stop.nonce));
  w.launcher.programs[before]?.exit(null, 'SIGTERM');
  assert.equal(must(await stopping).state, 'stopped');
});

test('a Gauge that reads sessions reads the folder as the session was asked for, in a list and in a read', async () => {
  const w = await world();
  const id = w.occupy('fixture-other', LINK);
  const list = must(await w.client.listSessions('fixture-viewer', 'fixture-other'));
  assert.deepEqual(list.map(session => [session.id, session.folder]), [[id, LINK]]);
  assert.equal(must(await w.client.getSession('fixture-viewer', id)).folder, LINK);
  assert.equal(w.host.get(id)?.folder, REAL, 'the host still holds the real folder, for the person');
});

// Runs

async function runWorld() {
  const w = await world();
  const job = await makeJob(w, [entry('writer', 'fixture-engine', LINK), entry('checker', 'fixture-other', '/work/b')]);
  return { w, job };
}

test('a Gauge that may start the engines of a job reads the run plan with the folder and the program as the job names them, and no engine it may not read', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-third', REAL);
  const plan = must(await w.client.planRun('fixture-blind', job));
  assert.deepEqual(plan.sessions.map(session => [session.label, session.folder, session.program, session.sharedWith]), [['writer', LINK, 'claude', []], ['checker', '/work/b', '/bin/fixture-other', []]]);
  assert.equal(plan.shared, false);
  assert.ok(!plan.steps.some(line => line.includes('second approval')));
  const text = JSON.stringify(plan);
  for (const secret of [REAL, REAL_PROGRAM, 'fixture-third']) assert.equal(text.includes(secret), false, secret);
});

test('the person reads the full run plan, and the Gauge plan and the person plan differ in the folders, the programs, the engines that share, whether it is shared, and the text of those', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-third', REAL);
  const plan = must(await w.client.planRun('fixture-blind', job));
  const person = runOf(w.fake.personPlan(plan.nonce));
  assert.deepEqual(person.sessions.map(session => [session.label, session.folder, session.program, session.sharedWith]), [['writer', REAL, REAL_PROGRAM, ['fixture-third']], ['checker', '/work/b', '/bin/fixture-other', []]]);
  assert.equal(person.shared, true);
  assert.ok(person.steps.includes('the job names the folder of session 1 as /link/one'));
  assert.ok(person.steps.includes("notice for session 1: fixture-third also runs in this folder, and two engines in one folder can overwrite each other's files"));
  assert.ok(person.steps.includes('a second approval is needed, once for the whole run, for the shared folder'));
  assert.deepEqual(differing(plan, person), ['shared', 'sessions', 'steps'].sort());
  assert.deepEqual(differing(plan.sessions[0]!, person.sessions[0]!), ['folder', 'program', 'sharedWith']);
  assert.deepEqual(differing(plan.sessions[1]!, person.sessions[1]!), []);
  assert.equal(person.digest, plan.digest);
  assert.equal(person.nonce, plan.nonce);
});

test('the digest of a run plan is a keyed hash that holds the nonce: two plans of one job have two digests, and no plain hash of the plan gives one', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-third', REAL);
  const one = must(await w.client.planRun('fixture-blind', job)), two = must(await w.client.planRun('fixture-blind', job));
  assert.notEqual(one.digest, two.digest);
  const person = runOf(w.fake.personPlan(one.nonce));
  const fields = [person.gauge, person.job, person.title, person.shared, person.sessions.map(session => [session.label, session.engine, session.engineTitle, session.harness, session.program, session.folder, session.model, session.billing, session.variables, session.sharedWith, session.task]), person.steps];
  assert.ok(!plainGuesses('run', one.nonce, fields).includes(one.digest));
});

test('the run starts as the person approved it: the real folder and the real program, once the person gave both approvals', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-third', REAL);
  const before = w.launcher.programs.length;
  const plan = must(await w.client.planRun('fixture-blind', job));
  const approval = w.fake.approve(plan.nonce);
  assert.deepEqual(await applyRunNow(w.client, plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, 'the second approval is missing, and the Gauge may not read the engine that shares: no engine and no member is named');
  assert.equal(w.launcher.programs.length, before);
  const applying = w.client.applyRun(plan, approval, w.fake.approveShared(plan.nonce));
  for (const program of w.launcher.programs.slice(before)) { program.spawn(); program.line('state:running'); }
  assert.ok((await applying).ok);
  assert.deepEqual(w.launcher.programs.slice(before).map(program => [program.spec.cwd, program.spec.program]), [[REAL, REAL_PROGRAM], ['/work/b', '/bin/fixture-other']]);
});

test('a Gauge that may read the engine that shares reads it in the run plan, and the refusal without the second approval names the session', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-third', REAL);
  const plan = must(await w.client.planRun('fixture-seer', job));
  assert.deepEqual(plan.sessions.map(session => session.sharedWith), [['fixture-third'], []]);
  assert.equal(plan.shared, true);
  assert.equal(plan.sessions[0]?.folder, LINK);
  assert.deepEqual(await applyRunNow(w.client, plan, w.fake.approve(plan.nonce)), { ok: false, code: 'ENGINE_FOLDER_SHARED', member: { index: 0, label: 'writer' } });
});

test('the engines of one run that share a folder are read by the person, and by a Gauge only when it may read them', async () => {
  const w = await world();
  const job = await makeJob(w, [entry('writer', 'fixture-engine', LINK), entry('checker', 'fixture-other', REAL)]);
  const blind = must(await w.client.planRun('fixture-blind', job));
  assert.deepEqual(blind.sessions.map(session => session.sharedWith), [[], []]);
  assert.equal(blind.shared, false);
  assert.deepEqual(runOf(w.fake.personPlan(blind.nonce)).sessions.map(session => session.sharedWith), [['fixture-other'], ['fixture-engine']]);
  const seer = must(await w.client.planRun('fixture-seer', job));
  assert.deepEqual(seer.sessions.map(session => session.sharedWith), [['fixture-other'], ['fixture-engine']]);
  assert.equal(seer.shared, true);
});

test('a run plan is applied only as the core issued it, and a link that moved makes it stale', async () => {
  const { w, job } = await runWorld();
  const plan = must(await w.client.planRun('fixture-blind', job));
  const approval = w.fake.approve(plan.nonce);
  const person = runOf(w.fake.personPlan(plan.nonce));
  const first = plan.sessions[0]!;
  const changes: readonly RunPlan[] = [
    { ...plan, steps: [...plan.steps, 'one more line'] }, { ...plan, digest: 'f'.repeat(64) }, { ...plan, title: 'Other' }, { ...plan, sessions: [{ ...first, folder: '/work/c' }, plan.sessions[1]!] },
    { ...plan, sessions: [{ ...first, sharedWith: ['fixture-third'] }, plan.sessions[1]!] }, { ...plan, sessions: [{ ...first, program: REAL_PROGRAM }, plan.sessions[1]!] }, { ...plan, shared: true }, person,
  ];
  for (const changed of changes) assert.deepEqual(await applyRunNow(w.client, changed, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  w.links[LINK] = '/real/elsewhere';
  assert.deepEqual(await applyRunNow(w.client, plan, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal(w.launcher.programs.length, 0);
});

test('a run that is refused tells a Gauge the session and a closed code, and no folder and no engine that it may not read', async () => {
  const { w, job } = await runWorld();
  w.occupy('fixture-engine', REAL);
  assert.deepEqual(await w.client.planRun('fixture-blind', job), { ok: false, code: 'ENGINE_PAIR_BUSY', member: { index: 0, label: 'writer' } });
});

// The person plan

test('the person plan is for a plan that is still current, and it is a copy', async () => {
  const w = await world();
  w.occupy('fixture-other', REAL);
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  const first = sessionOf(w.fake.personPlan(plan.nonce));
  (first.steps as string[]).push('changed');
  (first.sharedWith as string[]).push('changed');
  assert.deepEqual(sessionOf(w.fake.personPlan(plan.nonce)).sharedWith, ['fixture-other'], 'a caller that changes it changes nothing for the next call');
  const other = must(await w.client.planGrant('fixture-starter', ['sessions.start']));
  for (const bad of ['0'.repeat(64), 'x', 7, null, other.nonce]) assert.throws(() => w.fake.personPlan(bad as string), TypeError, String(bad));
  const approval = w.fake.approve(plan.nonce);
  w.fake.approveShared(plan.nonce);
  const before = w.launcher.programs.length;
  const applying = w.client.applySession(plan, approval, w.fake.approveShared(plan.nonce));
  w.launcher.programs[before]?.spawn();
  assert.ok((await applying).ok);
  assert.throws(() => w.fake.personPlan(plan.nonce), TypeError, 'a plan that was applied is retired');
});

test('the person plan of a plan that was issued before another step was applied is retired too', async () => {
  const w = await world();
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  assert.ok(sessionOf(w.fake.personPlan(plan.nonce)));
  const other = must(await w.client.planGrant('fixture-starter', ['sessions.start']));
  must(await w.client.applyGrant(other, w.fake.approve(other.nonce)));
  assert.throws(() => w.fake.personPlan(plan.nonce), TypeError);
});

test('the person plan is not on the seam: a Gauge cannot ask for it by any call', async () => {
  const w = await world();
  const plan = must(await w.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
  assert.equal('personPlan' in w.client, false);
  await assert.rejects(w.fake.call('bowerloom.sessions.person' as CoreMethod, { nonce: plan.nonce }), /unknown core method/);
});

// Everything a Gauge can read

/** A client over the seam that keeps every reply, refusal, and error that the Gauge can read, as text. */
function spied(w: World): { readonly client: CoreClient; readonly seen: string[] } {
  const seen: string[] = [];
  const spy: Core = {
    call: async (method, params) => {
      try {
        const reply = await w.fake.call(method, params);
        seen.push(JSON.stringify(reply));
        return reply as CoreReply;
      } catch (error) {
        seen.push(String(error instanceof Error ? error.message : error));
        throw error;
      }
    },
  };
  return { client: createCoreClient(spy), seen };
}

test('nothing a Gauge can read through the seam holds the real folder, the real program, or an engine that it may not read, in any reply, refusal, or error', async () => {
  const w = await world({ cap: 5 });
  w.occupy('fixture-other', LINK);
  w.occupy('fixture-third', LINK);
  w.occupy('fixture-engine', '/link/two');
  const starter = spied(w), viewer = spied(w), blind = spied(w);
  const attempts: (() => Promise<unknown>)[] = [
    () => starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }),
    () => starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: '/link/two' }),
    () => starter.client.planSessionStart('fixture-starter', { engine: 'fixture-other', folder: LINK }),
    () => starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: '/missing/folder' }),
    () => starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK, model: { provider: 'p', model: 'm' } }),
    () => starter.client.planSessionStop('fixture-starter', 's-1'),
    () => starter.client.listSessions('fixture-starter', 'fixture-engine'),
    () => starter.client.getSession('fixture-starter', 's-1'),
    async () => {
      const plan = must(await starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK }));
      await applyNow(starter.client, plan, w.fake.approve(plan.nonce));
      await applyNow(starter.client, { ...plan, folder: '/work/other' }, w.fake.approve(plan.nonce), w.fake.approveShared(plan.nonce));
      return starter.client.applySession(plan);
    },
  ];
  for (const attempt of attempts) await attempt().catch(() => undefined);
  await viewer.client.planSessionStart('fixture-viewer', { engine: 'fixture-engine', folder: LINK });
  await viewer.client.listSessions('fixture-viewer', 'fixture-other');
  await viewer.client.getSession('fixture-viewer', 's-1');
  // A run, through a Gauge that may start the engines of its job and may not read the sessions.
  const job = await makeJob(w, [entry('writer', 'fixture-engine', LINK), entry('checker', 'fixture-other', '/work/b')], 'fixture-blind');
  const plan = must(await blind.client.planRun('fixture-blind', job));
  await applyRunNow(blind.client, plan, w.fake.approve(plan.nonce));
  await applyRunNow(blind.client, { ...plan, title: 'Other' }, w.fake.approve(plan.nonce));
  await blind.client.listRuns('fixture-blind');
  await blind.client.getRun('fixture-blind', 'run-1');
  w.occupy('fixture-other', '/link/three');
  w.occupy('fixture-third', '/link/four');
  await starter.client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: LINK });
  await blind.client.planRun('fixture-blind', job);
  assert.ok(starter.seen.length >= 9 && viewer.seen.length >= 3 && blind.seen.length >= 6, 'each Gauge made its calls');
  const hidden = ['/real/', 'claude-1.2'];
  for (const secret of [...hidden, 'fixture-other', 'fixture-third']) assert.equal(starter.seen.join('\n').includes(secret), false, `starter: ${secret}`);
  // The viewer may read fixture-other, and not fixture-third. The blind Gauge names fixture-other in its own job, and may not read any session.
  for (const secret of [...hidden, 'fixture-third']) {
    assert.equal(viewer.seen.join('\n').includes(secret), false, `viewer: ${secret}`);
    assert.equal(blind.seen.join('\n').includes(secret), false, `blind: ${secret}`);
  }
  assert.ok(starter.seen.some(line => line.includes('ENGINE_LIMIT')) && starter.seen.some(line => line.includes('ENGINE_PAIR_BUSY')), 'the refusals of the pair and the limit were among what it read');
});

// A real link on disk

test('with a real link on disk, a Gauge reads the link and the person reads the folder behind it', async (t: TestContext) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-view-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'hidden-target', 'project'), link = path.join(root, 'shortcut');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  const programReal = path.join(root, 'engine-1.2'), programLink = path.join(root, 'engine');
  fs.writeFileSync(programReal, '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(programReal, programLink);
  const host = createEngineHost({ engines: [spec('fixture-engine', programLink)], launcher: manualLauncher(), log: () => undefined, schedule: () => () => undefined });
  const fake: FakeCore = createFakeCore({ folders: FOLDERS, engineHost: host });
  const client = createCoreClient(fake);
  for (const step of [() => client.planInstall('starter-folder'), () => client.planEnable('fixture-starter')]) {
    const planned = must(await step());
    must(await client.applyPlan(planned, fake.approve(planned.nonce)));
  }
  const grant = must(await client.planGrant('fixture-starter', ['sessions.start']));
  must(await client.applyGrant(grant, fake.approve(grant.nonce)));
  const plan = must(await client.planSessionStart('fixture-starter', { engine: 'fixture-engine', folder: link }));
  assert.equal(plan.folder, link);
  assert.equal(plan.program, programLink);
  assert.equal(JSON.stringify(plan).includes('hidden-target'), false);
  assert.equal(JSON.stringify(plan).includes('engine-1.2'), false);
  const person = sessionOf(fake.personPlan(plan.nonce));
  assert.equal(person.folder, real);
  assert.equal(person.program, programReal);
  assert.ok(person.steps.includes(`the Gauge named this folder as ${link}`));
});
