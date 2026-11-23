// The strict reply checks of the job and run calls. A scripted core gives the reply, so each check is proven on its own: a reply that breaks the contract is a protocol error that names the method.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply, JobPlan, JobRecord, RunPlan, RunSummary } from '../src/types.js';
import { checkDefinition, hashDefinition, JOB_REASONS, NOT_INTERACTIVE_REASONS } from '../../jobs/src/definition.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}
const ok = (result: unknown) => scripted({ ok: true, result });
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const session = (extra: Record<string, unknown> = {}) => ({ label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Write the summary.', ...extra });
const DEFINITION = { title: 'Morning review', sessions: [session()] };
const checked = checkDefinition(DEFINITION);
assert.ok(checked.ok);
const NEXT = hashDefinition(checked.value);
const bind = (base: string | null, next: string | null) => `bind the change to job ${base ?? 'none'} and result ${next ?? 'none'}`;

const CREATE: JobPlan = { action: 'job', kind: 'create', gauge: 'fixture-jobber', job: null, definition: DEFINITION as JobPlan['definition'], baseHash: null, nextHash: NEXT, steps: ['one', bind(null, NEXT)], digest: A, nonce: B };
const UPDATE: JobPlan = { ...CREATE, kind: 'update', job: 'job-1', baseHash: C, steps: ['one', bind(C, NEXT)] };
const DELETE: JobPlan = { ...CREATE, kind: 'delete', job: 'job-1', definition: null, baseHash: C, nextHash: null, steps: ['one', bind(C, null)] };
const RECORD: JobRecord = { id: 'job-1', title: 'Morning review', sessions: [session()] as unknown as JobRecord['sessions'] };
const RUN_SESSION = { label: 'writer', engine: 'fixture-engine', engineTitle: 'Fixture Engine', harness: 'plain-harness', program: '/usr/bin/fake', folder: '/work/alpha', model: null, billing: 'engine-plan', variables: ['HOME'], sharedWith: [], task: 'Write the summary.' };
const RUN: RunPlan = { action: 'run', gauge: 'fixture-jobber', job: 'job-1', title: 'Morning review', shared: false, sessions: [RUN_SESSION] as unknown as RunPlan['sessions'], steps: ['one', 'two'], digest: A, nonce: B };
const SUMMARY: RunSummary = { id: 'run-1', job: 'job-1', title: 'Morning review', sessions: [{ label: 'writer', engine: 'fixture-engine', session: 's-1', state: 'running' }] };

const protocolError = (method: string) => (error: unknown) => error instanceof CoreProtocolError && error.method === method && error.message.startsWith(`${method}: `);
const planning = (kind: 'create' | 'update' | 'delete', result: unknown, definition: unknown = DEFINITION) => {
  const client = createCoreClient(ok(result));
  return kind === 'create' ? client.planJobCreate('fixture-jobber', definition) : kind === 'update' ? client.planJobUpdate('fixture-jobber', 'job-1', definition) : client.planJobDelete('fixture-jobber', 'job-1');
};
const patch = <T extends object>(base: T, changes: Record<string, unknown>): unknown => ({ ...base, ...changes });

test('each job and run call sends its params under a bowerloom wire name', async () => {
  const core = scripted({ ok: false, code: 'GAUGE_JOB_UNKNOWN' });
  const client = createCoreClient(core);
  await client.listJobs('g');
  await client.getJob('g', 'job-1');
  await client.planJobCreate('g', DEFINITION);
  await client.planJobUpdate('g', 'job-1', DEFINITION);
  await client.planJobDelete('g', 'job-1');
  await client.applyJob(CREATE, 'approval-1');
  await client.applyJob(CREATE);
  await client.planRun('g', 'job-1');
  await client.applyRun(RUN, 'approval-1');
  await client.applyRun(RUN, 'approval-1', 'shared-1');
  await client.listRuns('g');
  await client.getRun('g', 'run-1');
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.jobs.list', params: { gauge: 'g' } },
    { method: 'bowerloom.jobs.get', params: { gauge: 'g', job: 'job-1' } },
    { method: 'bowerloom.jobs.plan', params: { kind: 'create', gauge: 'g', definition: DEFINITION } },
    { method: 'bowerloom.jobs.plan', params: { kind: 'update', gauge: 'g', job: 'job-1', definition: DEFINITION } },
    { method: 'bowerloom.jobs.plan', params: { kind: 'delete', gauge: 'g', job: 'job-1' } },
    { method: 'bowerloom.jobs.apply', params: { plan: CREATE, approval: 'approval-1' } },
    { method: 'bowerloom.jobs.apply', params: { plan: CREATE } },
    { method: 'bowerloom.runs.plan', params: { gauge: 'g', job: 'job-1' } },
    { method: 'bowerloom.runs.apply', params: { plan: RUN, approval: 'approval-1' } },
    { method: 'bowerloom.runs.apply', params: { plan: RUN, approval: 'approval-1', sharedApproval: 'shared-1' } },
    { method: 'bowerloom.runs.list', params: { gauge: 'g' } },
    { method: 'bowerloom.runs.get', params: { gauge: 'g', run: 'run-1' } },
  ]);
});

test('a definition is sent as a copy of its own data: a field the client does not know is sent too, so the core can refuse it, and nothing of the caller is shared', async () => {
  const core = scripted({ ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'schedule' });
  const model = { provider: 'p', model: 'm' };
  const definition = { title: 'T', schedule: 'daily', sessions: [session({ model, unattended: true })] };
  const result = await createCoreClient(core).planJobCreate('g', definition);
  assert.deepEqual(result, { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'schedule' });
  const sent = (core.calls[0]?.params as unknown as { definition: { sessions: { model: object }[] } }).definition;
  const sentModel = sent.sessions[0]?.model;
  assert.notEqual(sent, definition);
  assert.notEqual(sent.sessions, definition.sessions);
  assert.notEqual(sent.sessions[0], definition.sessions[0]);
  assert.notEqual(sentModel, model);
  assert.deepEqual(sent, definition);
});

test('a definition that is not a record is sent as it is, so the core refuses it with a reason', async () => {
  for (const value of [null, undefined, 'x', 7, [1]]) {
    const core = scripted({ ok: false, code: 'GAUGE_JOB_INVALID', reason: 'request' });
    await createCoreClient(core).planJobCreate('g', value);
    assert.deepEqual((core.calls[0]?.params as { definition: unknown }).definition, value);
  }
});

test('a definition with an accessor is not read, and a list that cannot be read is a bug of the caller that throws', async () => {
  let reads = 0;
  const entry = session();
  Object.defineProperty(entry, 'task', { get() { reads += 1; return 'x'; }, enumerable: true });
  const core = scripted({ ok: false, code: 'GAUGE_JOB_INVALID', reason: 'request' });
  await createCoreClient(core).planJobCreate('g', { title: 'T', sessions: [entry] });
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn((core.calls[0]?.params as { definition: { sessions: object[] } }).definition.sessions[0] ?? {}, 'task'), false);
  const holey = [session()];
  holey.length = 2;
  const accessor = [session()];
  Object.defineProperty(accessor, 0, { get: () => session(), enumerable: true });
  const cycle: Record<string, unknown> = { title: 'T' };
  cycle['self'] = cycle;
  for (const bad of [{ title: 'T', sessions: holey }, { title: 'T', sessions: accessor }, cycle, { title: 'T', sessions: Array.from({ length: 5000 }, () => session()) }]) {
    const quiet = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
    await assert.rejects(createCoreClient(quiet).planJobCreate('g', bad), TypeError);
    assert.equal(quiet.calls.length, 0, 'nothing is sent');
  }
});

test('a create, an update, and a delete plan that keep the contract are read into a frozen plan', async () => {
  for (const [kind, plan] of [['create', CREATE], ['update', UPDATE], ['delete', DELETE]] as const) {
    const result = await planning(kind, plan);
    assert.ok(result.ok, kind);
    assert.deepEqual(result.value, plan);
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.steps), true);
    if (result.value.definition !== null) {
      assert.equal(Object.isFrozen(result.value.definition), true);
      assert.equal(Object.isFrozen(result.value.definition.sessions), true);
    }
  }
});

test('a job plan that breaks the contract is a protocol error that names the method', async () => {
  const method = 'bowerloom.jobs.plan';
  const other = { ...DEFINITION, title: 'Another title' };
  const otherChecked = checkDefinition(other);
  assert.ok(otherChecked.ok);
  const cases: readonly (readonly [string, 'create' | 'update' | 'delete', unknown])[] = [
    ['not a record', 'create', 'plan'],
    ['null', 'create', null],
    ['a list', 'create', [CREATE]],
    ['another action', 'create', patch(CREATE, { action: 'grant' })],
    ['another kind', 'create', patch(CREATE, { kind: 'update' })],
    ['an unknown kind', 'create', patch(CREATE, { kind: 'merge' })],
    ['another gauge', 'create', patch(CREATE, { gauge: 'someone-else' })],
    ['a bad gauge', 'create', patch(CREATE, { gauge: 'Bad Gauge' })],
    ['a create with a job id', 'create', patch(CREATE, { job: 'job-1' })],
    ['a create with no definition', 'create', patch(CREATE, { definition: null })],
    ['a create with a base hash', 'create', patch(CREATE, { baseHash: C, steps: ['one', bind(C, NEXT)] })],
    ['a create with no next hash', 'create', patch(CREATE, { nextHash: null, steps: ['one', bind(null, null)] })],
    ['a next hash that is not the hash of the definition', 'create', patch(CREATE, { nextHash: C, steps: ['one', bind(null, C)] })],
    ['a definition that is not valid', 'create', patch(CREATE, { definition: { title: 'x', sessions: [] } })],
    ['a definition with a field more', 'create', patch(CREATE, { definition: { ...DEFINITION, extra: 1 } })],
    ['a definition that is another one than asked', 'create', patch(CREATE, { definition: other, nextHash: hashDefinition(otherChecked.value), steps: ['one', bind(null, hashDefinition(otherChecked.value))] })],
    ['an update for another job', 'update', patch(UPDATE, { job: 'job-2' })],
    ['an update with no job', 'update', patch(UPDATE, { job: null })],
    ['an update with a malformed job', 'update', patch(UPDATE, { job: 'Job 1' })],
    ['an update with no base hash', 'update', patch(UPDATE, { baseHash: null, steps: ['one', bind(null, NEXT)] })],
    ['an update with a base hash that is not hex', 'update', patch(UPDATE, { baseHash: 'xyz', steps: ['one', bind('xyz', NEXT)] })],
    ['a delete with a definition', 'delete', patch(DELETE, { definition: DEFINITION })],
    ['a delete with a next hash', 'delete', patch(DELETE, { nextHash: B, steps: ['one', bind(C, B)] })],
    ['a delete for another job', 'delete', patch(DELETE, { job: 'job-2' })],
    ['no steps', 'create', patch(CREATE, { steps: [] })],
    ['steps that are not text', 'create', patch(CREATE, { steps: [1] })],
    ['a step with a line break', 'create', patch(CREATE, { steps: ['a\nb', bind(null, NEXT)] })],
    ['a step with a format character', 'create', patch(CREATE, { steps: ['a‮b', bind(null, NEXT)] })],
    ['a last step that does not bind the hashes', 'create', patch(CREATE, { steps: ['one', 'two'] })],
    ['a last step that binds other hashes', 'create', patch(CREATE, { steps: ['one', bind(null, C)] })],
    ['a digest that is not hex', 'create', patch(CREATE, { digest: 'x'.repeat(64) })],
    ['a short digest', 'create', patch(CREATE, { digest: 'abc' })],
    ['an upper-case digest', 'create', patch(CREATE, { digest: 'A'.repeat(64) })],
    ['a nonce that is not hex', 'create', patch(CREATE, { nonce: 'x'.repeat(64) })],
    ['no nonce', 'create', patch(CREATE, { nonce: undefined })],
  ];
  for (const [name, kind, reply] of cases) await assert.rejects(planning(kind, reply), protocolError(method), name);
});

test('a job plan is read from own data properties only: an accessor and an inherited field read as missing', async () => {
  let reads = 0;
  const accessor = { ...CREATE } as Record<string, unknown>;
  Object.defineProperty(accessor, 'nonce', { get() { reads += 1; return B; }, enumerable: true });
  await assert.rejects(planning('create', accessor), protocolError('bowerloom.jobs.plan'));
  assert.equal(reads, 0);
  const inherited = Object.create({ nonce: B }) as Record<string, unknown>;
  Object.assign(inherited, { ...CREATE, nonce: undefined });
  await assert.rejects(planning('create', inherited), protocolError('bowerloom.jobs.plan'));
});

test('a list of steps with a hole, an accessor, or too many items is a protocol error', async () => {
  const holey = ['one', bind(null, NEXT)];
  holey.length = 3;
  const accessor = ['one', bind(null, NEXT)];
  Object.defineProperty(accessor, 0, { get: () => 'one', enumerable: true });
  for (const steps of [holey, accessor, Array.from({ length: 5000 }, () => 'x')]) await assert.rejects(planning('create', patch(CREATE, { steps })), protocolError('bowerloom.jobs.plan'));
});

test('an applied job plan gives the change and the job id, and it must answer the plan', async () => {
  const apply = (plan: JobPlan, result: unknown) => createCoreClient(ok(result)).applyJob(plan, 'approval-1');
  assert.deepEqual(await apply(CREATE, { kind: 'create', job: 'job-7' }), { ok: true, value: { kind: 'create', job: 'job-7' } });
  assert.deepEqual(await apply(UPDATE, { kind: 'update', job: 'job-1' }), { ok: true, value: { kind: 'update', job: 'job-1' } });
  assert.deepEqual(await apply(DELETE, { kind: 'delete', job: 'job-1' }), { ok: true, value: { kind: 'delete', job: 'job-1' } });
  const bad: readonly (readonly [JobPlan, unknown])[] = [
    [CREATE, null], [CREATE, 'x'], [CREATE, { kind: 'update', job: 'job-7' }], [CREATE, { kind: 'create' }], [CREATE, { kind: 'create', job: 'Job 7' }], [CREATE, { kind: 'create', job: 7 }],
    [UPDATE, { kind: 'update', job: 'job-2' }], [DELETE, { kind: 'delete', job: 'job-2' }], [DELETE, { kind: 'create', job: 'job-1' }], [UPDATE, { kind: 'merge', job: 'job-1' }],
  ];
  for (const [plan, result] of bad) await assert.rejects(apply(plan, result), protocolError('bowerloom.jobs.apply'), JSON.stringify(result));
});

test('the apply calls refuse a plan that is not a plan before they send anything', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  const client = createCoreClient(core);
  await assert.rejects(client.applyJob(null as unknown as JobPlan), TypeError);
  await assert.rejects(client.applyJob({ ...CREATE, kind: 'merge' } as unknown as JobPlan), TypeError);
  await assert.rejects(client.applyJob({ ...UPDATE, kind: 'merge' } as unknown as JobPlan), TypeError);
  await assert.rejects(client.applyJob({ ...UPDATE, job: 7 } as unknown as JobPlan), TypeError);
  await assert.rejects(client.applyJob({ ...DELETE, job: null }), TypeError);
  await assert.rejects(client.applyRun(null as unknown as RunPlan), TypeError);
  await assert.rejects(client.applyRun({ ...RUN, job: 7 } as unknown as RunPlan), TypeError);
  let reads = 0;
  const hidden = { ...UPDATE } as Record<string, unknown>;
  Object.defineProperty(hidden, 'kind', { get() { reads += 1; return 'update'; }, enumerable: true });
  await assert.rejects(client.applyJob(hidden as unknown as JobPlan), TypeError);
  assert.equal(reads, 0, 'a getter of the caller never runs');
  assert.equal(core.calls.length, 0);
});

test('a job plan sent back is copied from own data properties, with its lists copied, so a core that changes it changes nothing for the caller', async () => {
  const plan = { ...UPDATE, definition: { title: 'T', sessions: [session()] } } as unknown as JobPlan;
  const core: Core = {
    call: async (_method, params) => {
      const sent = params['plan'] as { steps: string[]; definition: { sessions: { task: string }[] } };
      sent.steps.push('x');
      sent.definition.sessions[0]!.task = 'changed';
      return { ok: false, code: 'UNKNOWN_GAUGE' };
    },
  };
  await createCoreClient(core).applyJob(plan);
  assert.deepEqual(plan, { ...UPDATE, definition: { title: 'T', sessions: [session()] } });
});

test('the job list and one job are read strictly', async () => {
  const list = await createCoreClient(ok([{ id: 'job-1', title: 'A', sessions: 1 }, { id: 'job-2', title: 'B', sessions: 8 }])).listJobs('g');
  assert.deepEqual(list, { ok: true, value: [{ id: 'job-1', title: 'A', sessions: 1 }, { id: 'job-2', title: 'B', sessions: 8 }] });
  assert.ok(list.ok && Object.isFrozen(list.value) && Object.isFrozen(list.value[0]));
  const holey = [{ id: 'job-1', title: 'A', sessions: 1 }];
  holey.length = 2;
  const tooMany = Array.from({ length: 65 }, (_value, index) => ({ id: `job-${index}`, title: 'A', sessions: 1 }));
  const badLists: unknown[] = [
    null, 'x', {}, holey, tooMany,
    [{ id: 'job-1', title: 'A', sessions: 0 }], [{ id: 'job-1', title: 'A', sessions: 9 }], [{ id: 'job-1', title: 'A', sessions: 1.5 }], [{ id: 'Job 1', title: 'A', sessions: 1 }], [{ id: 'job-1', title: '', sessions: 1 }],
    [{ id: 'job-1', title: 'A\nB', sessions: 1 }], [{ id: 'job-1', title: 'A', sessions: 1 }, { id: 'job-1', title: 'B', sessions: 1 }], [7], [{ id: 'job-1', title: 'A' }], [{ id: 'job-1', title: 'A', sessions: 1, extra: 1 }],
  ];
  for (const bad of badLists) await assert.rejects(createCoreClient(ok(bad)).listJobs('g'), protocolError('bowerloom.jobs.list'), JSON.stringify(bad)?.slice(0, 60));
  assert.deepEqual(await createCoreClient(ok(RECORD)).getJob('g', 'job-1'), { ok: true, value: RECORD });
  const read = await createCoreClient(ok(RECORD)).getJob('g', 'job-1');
  assert.ok(read.ok && Object.isFrozen(read.value) && Object.isFrozen(read.value.sessions) && Object.isFrozen(read.value.sessions[0]));
  const badRecords: unknown[] = [
    null, 'x', patch(RECORD, { id: 'job-2' }), patch(RECORD, { id: 'Job 1' }), patch(RECORD, { title: '' }), patch(RECORD, { sessions: [] }), patch(RECORD, { extra: 1 }), patch(RECORD, { sessions: [session({ extra: 1 })] }),
    patch(RECORD, { sessions: [session({ folder: 'relative' })] }), patch(RECORD, { schedule: 'daily' }),
  ];
  for (const bad of badRecords) await assert.rejects(createCoreClient(ok(bad)).getJob('g', 'job-1'), protocolError('bowerloom.jobs.get'), JSON.stringify(bad)?.slice(0, 60));
});

test('a run plan that keeps the contract is read into a frozen plan', async () => {
  const result = await createCoreClient(ok(RUN)).planRun('fixture-jobber', 'job-1');
  assert.ok(result.ok);
  assert.deepEqual(result.value, RUN);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.sessions), true);
  assert.equal(Object.isFrozen(result.value.sessions[0]), true);
  assert.equal(Object.isFrozen(result.value.sessions[0]?.variables), true);
  assert.equal(Object.isFrozen(result.value.sessions[0]?.sharedWith), true);
  const shared = patch(RUN, { shared: true, sessions: [{ ...RUN_SESSION, sharedWith: ['fixture-other'] }] });
  assert.ok((await createCoreClient(ok(shared)).planRun('fixture-jobber', 'job-1')).ok);
});

test('a run plan that breaks the contract is a protocol error that names the method', async () => {
  const method = 'bowerloom.runs.plan';
  const withSession = (changes: Record<string, unknown>) => patch(RUN, { sessions: [{ ...RUN_SESSION, ...changes }] });
  const eight = Array.from({ length: 8 }, (_value, index) => ({ ...RUN_SESSION, label: `s-${index}`, engine: `e-${index}` }));
  const cases: readonly (readonly [string, unknown])[] = [
    ['not a record', 'x'], ['null', null],
    ['another action', patch(RUN, { action: 'job' })], ['another gauge', patch(RUN, { gauge: 'someone-else' })], ['another job', patch(RUN, { job: 'job-2' })], ['a malformed job', patch(RUN, { job: 'Job 1' })],
    ['an empty title', patch(RUN, { title: '' })], ['a title with a line break', patch(RUN, { title: 'a\nb' })], ['a title too long', patch(RUN, { title: 'a'.repeat(81) })],
    ['shared is not a boolean', patch(RUN, { shared: 'no' })], ['shared with nothing shared', patch(RUN, { shared: true })], ['something shared and shared false', patch(RUN, { sessions: [{ ...RUN_SESSION, sharedWith: ['x'] }] })],
    ['no sessions', patch(RUN, { sessions: [] })], ['nine sessions', patch(RUN, { sessions: [...eight, { ...RUN_SESSION, label: 'nine', engine: 'e-9' }] })], ['sessions that are not a list', patch(RUN, { sessions: RUN_SESSION })],
    ['a repeated label', patch(RUN, { sessions: [RUN_SESSION, { ...RUN_SESSION, engine: 'fixture-other' }] })],
    ['a bad label', withSession({ label: 'Writer' })], ['a bad engine', withSession({ engine: 'Engine' })], ['an empty engine title', withSession({ engineTitle: '' })], ['an engine title with a break', withSession({ engineTitle: 'a\nb' })],
    ['a long engine title', withSession({ engineTitle: 'a'.repeat(65) })], ['a bad harness', withSession({ harness: 'A B' })], ['no program', withSession({ program: '' })], ['a program with a break', withSession({ program: '/a\nb' })], ['a program that is too long', withSession({ program: `/${'a'.repeat(4096)}` })],
    ['a relative folder', withSession({ folder: 'relative' })], ['a model that is not a choice', withSession({ model: { provider: 'p' } })], ['a billing that is not known', withSession({ billing: 'provider-key' })],
    ['variables that are not sorted', withSession({ variables: ['B', 'A'] })], ['variables with a repeat', withSession({ variables: ['A', 'A'] })], ['a bad variable', withSession({ variables: ['1A'] })],
    ['shared that is not sorted', patch(RUN, { shared: true, sessions: [{ ...RUN_SESSION, sharedWith: ['b', 'a'] }] })], ['a bad shared engine', patch(RUN, { shared: true, sessions: [{ ...RUN_SESSION, sharedWith: ['B'] }] })],
    ['an empty task', withSession({ task: '' })], ['a task with a control character', withSession({ task: 'a\u0000b' })], ['a task that looks like a secret', withSession({ task: `use sk-${'a1'.repeat(15)} now` })],
    ['no steps', patch(RUN, { steps: [] })], ['a step with a break', patch(RUN, { steps: ['a\nb'] })], ['a bad digest', patch(RUN, { digest: 'abc' })], ['a bad nonce', patch(RUN, { nonce: 'abc' })],
    ['an unknown field of a session is kept out, so a session with a field more', withSession({ extra: 1 })],
  ];
  for (const [name, reply] of cases) await assert.rejects(createCoreClient(ok(reply)).planRun('fixture-jobber', 'job-1'), protocolError(method), name);
  const accessor = { ...RUN_SESSION } as Record<string, unknown>;
  let reads = 0;
  Object.defineProperty(accessor, 'task', { get() { reads += 1; return 'x'; }, enumerable: true });
  await assert.rejects(createCoreClient(ok(patch(RUN, { sessions: [accessor] }))).planRun('fixture-jobber', 'job-1'), protocolError(method));
  assert.equal(reads, 0);
});

test('a run plan with eight sessions is read', async () => {
  const eight = Array.from({ length: 8 }, (_value, index) => ({ ...RUN_SESSION, label: `s-${index}`, engine: `e-${index}` }));
  assert.ok((await createCoreClient(ok(patch(RUN, { sessions: eight }))).planRun('fixture-jobber', 'job-1')).ok);
});

test('a run plan sent back is copied: its lists and its sessions are new, so a core that changes them changes nothing for the caller', async () => {
  const plan = { ...RUN, sessions: [{ ...RUN_SESSION, variables: ['A'], sharedWith: ['x'], model: { provider: 'p', model: 'm' } }], steps: ['one'], shared: true } as unknown as RunPlan;
  const core: Core = {
    call: async (_method, params) => {
      const sent = params['plan'] as { steps: string[]; sessions: { variables: string[]; sharedWith: string[]; model: { provider: string }; task: string }[] };
      sent.steps.push('x');
      sent.sessions[0]!.variables.push('x');
      sent.sessions[0]!.sharedWith.push('y');
      sent.sessions[0]!.model.provider = 'changed';
      sent.sessions[0]!.task = 'changed';
      return { ok: false, code: 'UNKNOWN_GAUGE' };
    },
  };
  await createCoreClient(core).applyRun(plan);
  assert.deepEqual(plan, { ...RUN, sessions: [{ ...RUN_SESSION, variables: ['A'], sharedWith: ['x'], model: { provider: 'p', model: 'm' } }], steps: ['one'], shared: true });
});

test('an applied run is read as a group of its sessions, and it must answer the plan: the job, and the labels and engines in the order of the plan', async () => {
  const apply = (result: unknown, plan: RunPlan = RUN) => createCoreClient(ok(result)).applyRun(plan, 'approval-1');
  assert.deepEqual(await apply(SUMMARY), { ok: true, value: SUMMARY });
  const hidden = patch(SUMMARY, { sessions: [{ label: 'writer', engine: 'fixture-engine', session: null, state: 'hidden' }] });
  assert.ok((await apply(hidden)).ok);
  const second = { label: 'checker', engine: 'fixture-other', session: 's-2', state: 'running' };
  const two = { ...RUN, sessions: [RUN_SESSION, { ...RUN_SESSION, label: 'checker', engine: 'fixture-other' }] } as unknown as RunPlan;
  assert.deepEqual((await apply(patch(SUMMARY, { sessions: [SUMMARY.sessions[0], second] }), two)).ok, true);
  await assert.rejects(apply(patch(SUMMARY, { sessions: [SUMMARY.sessions[0]] }), two), protocolError('bowerloom.runs.apply'), 'a run with fewer sessions than the plan');
  await assert.rejects(apply(patch(SUMMARY, { sessions: [SUMMARY.sessions[0], second] })), protocolError('bowerloom.runs.apply'), 'a run with more sessions than the plan');
  const bad: readonly unknown[] = [
    null, 'x', patch(SUMMARY, { job: 'job-2' }), patch(SUMMARY, { sessions: [] }), patch(SUMMARY, { sessions: [{ ...SUMMARY.sessions[0], label: 'other' }] }), patch(SUMMARY, { sessions: [{ ...SUMMARY.sessions[0], engine: 'fixture-other' }] }),
    patch(SUMMARY, { sessions: [SUMMARY.sessions[0], SUMMARY.sessions[0]] }), patch(SUMMARY, { id: 'Run 1' }), patch(SUMMARY, { title: '' }),
  ];
  for (const result of bad) await assert.rejects(apply(result), protocolError('bowerloom.runs.apply'), JSON.stringify(result)?.slice(0, 60));
});

test('a run summary is read strictly: the states, hidden with no session id, and a session id with a state', async () => {
  const withSession = (changes: Record<string, unknown>) => patch(SUMMARY, { sessions: [{ ...SUMMARY.sessions[0], ...changes }] });
  for (const state of ['detected', 'ready', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'failed', 'forgotten']) assert.ok((await createCoreClient(ok(withSession({ state }))).getRun('g', 'run-1')).ok, state);
  assert.ok((await createCoreClient(ok(withSession({ session: null, state: 'hidden' }))).getRun('g', 'run-1')).ok);
  const bad: readonly unknown[] = [
    null, 'x', patch(SUMMARY, { id: 'run-2' }), patch(SUMMARY, { job: 'Job 1' }), patch(SUMMARY, { sessions: 'x' }), patch(SUMMARY, { sessions: [] }), patch(SUMMARY, { extra: 1 }),
    withSession({ state: 'hidden' }), withSession({ session: null }), withSession({ extra: 1 }), withSession({ state: 'sleeping' }), withSession({ session: 'S 1' }), withSession({ label: 'Writer' }), withSession({ engine: 'Engine' }), withSession({ state: 7 }),
  ];
  for (const result of bad) await assert.rejects(createCoreClient(ok(result)).getRun('g', 'run-1'), protocolError('bowerloom.runs.get'), JSON.stringify(result)?.slice(0, 80));
  const list = await createCoreClient(ok([SUMMARY, patch(SUMMARY, { id: 'run-2' })])).listRuns('g');
  assert.ok(list.ok && list.value.length === 2 && Object.isFrozen(list.value) && Object.isFrozen(list.value[0]) && Object.isFrozen(list.value[0]?.sessions));
  const tooMany = Array.from({ length: 321 }, (_value, index) => patch(SUMMARY, { id: `run-${index}` }));
  const holey = [SUMMARY];
  holey.length = 2;
  for (const bad of [null, 'x', {}, [SUMMARY, SUMMARY], tooMany, holey, [7]]) await assert.rejects(createCoreClient(ok(bad)).listRuns('g'), protocolError('bowerloom.runs.list'));
  assert.ok((await createCoreClient(ok(Array.from({ length: 320 }, (_value, index) => patch(SUMMARY, { id: `run-${index}` })))).listRuns('g')).ok, 'the longest list is the most sessions that the host keeps');
});

test('a refusal keeps its code, and the reason must belong to the code', async () => {
  const refused = (reply: unknown, call: (client: ReturnType<typeof createCoreClient>) => Promise<unknown>) => call(createCoreClient(scripted(reply)));
  for (const reason of JOB_REASONS) assert.deepEqual(await refused({ ok: false, code: 'GAUGE_JOB_INVALID', reason }, client => client.planJobCreate('g', DEFINITION)), { ok: false, code: 'GAUGE_JOB_INVALID', reason });
  for (const reason of NOT_INTERACTIVE_REASONS) assert.deepEqual(await refused({ ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason }, client => client.planRun('g', 'job-1')), { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason });
  for (const code of ['GAUGE_JOB_UNKNOWN', 'GAUGE_JOB_LIMIT', 'GAUGE_RUN_UNKNOWN']) assert.deepEqual(await refused({ ok: false, code }, client => client.getJob('g', 'job-1')), { ok: false, code });
  const mismatches: readonly unknown[] = [
    { ok: false, code: 'GAUGE_JOB_INVALID' }, { ok: false, code: 'GAUGE_JOB_INVALID', reason: 'schedule' }, { ok: false, code: 'GAUGE_JOB_INVALID', reason: 'toString' },
    { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE' }, { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'title' }, { ok: false, code: 'GAUGE_JOB_UNKNOWN', reason: 'job' },
    { ok: false, code: 'GAUGE_JOB_LIMIT', reason: 'schedule' }, { ok: false, code: 'GAUGE_RUN_UNKNOWN', reason: 'x' }, { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', reason: 'x' },
  ];
  for (const reply of mismatches) await assert.rejects(refused(reply, client => client.planJobCreate('g', DEFINITION)), protocolError('bowerloom.jobs.plan'), JSON.stringify(reply));
});

// The session that a refusal is about, the run that a failed apply leaves behind, and the cause of an undo that failed.

test('a refusal of a run names the session, and a failed apply names the run: they are passed on when they are right', async () => {
  const member = { index: 0, label: 'writer' };
  const plan = await createCoreClient(scripted({ ok: false, code: 'ENGINE_LIMIT', member })).planRun('fixture-jobber', 'job-1');
  assert.deepEqual(plan, { ok: false, code: 'ENGINE_LIMIT', member });
  const notFound = await createCoreClient(scripted({ ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', member })).planRun('fixture-jobber', 'job-1');
  assert.deepEqual(notFound, { ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', member });
  for (const reason of ['exited', 'stopped', 'illegal_claim', 'timed_out']) {
    const failed = await createCoreClient(scripted({ ok: false, code: 'ENGINE_START_FAILED', reason, member, run: 'run-1' })).applyRun(RUN, 'approval-1');
    assert.deepEqual(failed, { ok: false, code: 'ENGINE_START_FAILED', reason, member, run: 'run-1' }, reason);
  }
  const rollback = await createCoreClient(scripted({ ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member, cause: 'exited' })).applyRun(RUN, 'approval-1');
  assert.deepEqual(rollback, { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member, cause: 'exited' });
  assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'ENGINE_FOLDER_SHARED', member })).applyRun(RUN, 'approval-1'), { ok: false, code: 'ENGINE_FOLDER_SHARED', member });
});

test('a rollback refusal must hold the run, the session, and a cause of the closed set, and nothing else may hold a cause', async () => {
  const member = { index: 0, label: 'writer' };
  const apply = (reply: unknown) => createCoreClient(scripted(reply)).applyRun(RUN, 'approval-1');
  const bad: readonly unknown[] = [
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED' },
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member },
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', cause: 'exited' },
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', member, cause: 'exited' },
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member, cause: 'toString' },
    { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', member, cause: 'exited', reason: 'exited' },
    { ok: false, code: 'ENGINE_START_FAILED', reason: 'exited', member, run: 'run-1', cause: 'exited' },
    { ok: false, code: 'GAUGE_PLAN_CHANGED', cause: 'exited' },
  ];
  for (const reply of bad) await assert.rejects(apply(reply), protocolError('bowerloom.runs.apply'), JSON.stringify(reply));
});

test('the session and the run of a refusal are checked: the place and the label, where they may appear, and for the plan that was sent', async () => {
  const member = { index: 0, label: 'writer' };
  const apply = (reply: unknown) => createCoreClient(scripted(reply)).applyRun(RUN, 'approval-1');
  const badMembers: readonly unknown[] = [
    { index: 1, label: 'writer' }, { index: 0, label: 'other' }, { index: -1, label: 'writer' }, { index: 8, label: 'writer' }, { index: 0.5, label: 'writer' }, { index: '0', label: 'writer' }, { index: 0, label: 'Writer' },
    { index: 0 }, { label: 'writer' }, { index: 0, label: 'writer', extra: 1 }, null, 'writer', [],
  ];
  for (const bad of badMembers) await assert.rejects(apply({ ok: false, code: 'ENGINE_START_FAILED', reason: 'exited', member: bad, run: 'run-1' }), protocolError('bowerloom.runs.apply'), JSON.stringify(bad));
  for (const run of ['Run 1', '', 7, null, 'x'.repeat(65)]) await assert.rejects(apply({ ok: false, code: 'ENGINE_START_FAILED', reason: 'exited', member, run }), protocolError('bowerloom.runs.apply'), JSON.stringify(run));
  // A run belongs to a failed start, and a session belongs to a run call.
  await assert.rejects(apply({ ok: false, code: 'ENGINE_LIMIT', member, run: 'run-1' }), protocolError('bowerloom.runs.apply'), 'a run id on a refusal of another kind');
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'ENGINE_START_FAILED', reason: 'shutting_down', member, run: 'run-1' })).planRun('fixture-jobber', 'job-1'), protocolError('bowerloom.runs.plan'), 'a plan has no run yet');
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'ENGINE_LIMIT', member })).getRun('fixture-jobber', 'run-1'), protocolError('bowerloom.runs.get'));
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'ENGINE_LIMIT', member })).planSessionStart('fixture-jobber', { engine: 'fixture-engine', folder: '/work/alpha' }), protocolError('bowerloom.sessions.plan'));
  await assert.rejects(createCoreClient(scripted({ ok: false, code: 'GAUGE_JOB_LIMIT', member })).planJobCreate('g', DEFINITION), protocolError('bowerloom.jobs.plan'));
});

test('the session of a plan refusal is checked on its own, where no plan was sent: the place, the label, the code, and a run that has no session', async () => {
  const planning = (reply: unknown) => createCoreClient(scripted(reply)).planRun('fixture-jobber', 'job-1');
  const good = { index: 7, label: 'writer' };
  assert.deepEqual(await planning({ ok: false, code: 'ENGINE_LIMIT', member: good }), { ok: false, code: 'ENGINE_LIMIT', member: good }, 'the last place of a job');
  for (const index of [-1, 8, 0.5, Number.NaN, Infinity, 2 ** 40]) await assert.rejects(planning({ ok: false, code: 'ENGINE_LIMIT', member: { index, label: 'writer' } }), protocolError('bowerloom.runs.plan'), String(index));
  await assert.rejects(planning({ ok: false, code: 'ENGINE_LIMIT', member: { index: 0, label: 'Writer' } }), protocolError('bowerloom.runs.plan'));
  for (const code of ['GAUGE_JOB_UNKNOWN', 'GAUGE_GRANT_MISSING', 'GAUGE_PLAN_CHANGED', 'GAUGE_JOB_INVALID']) {
    await assert.rejects(planning({ ok: false, code, member: good, ...(code === 'GAUGE_JOB_INVALID' ? { reason: 'request' } : {}) }), protocolError('bowerloom.runs.plan'), `${code} is not a refusal about a session`);
  }
  const apply = (reply: unknown) => createCoreClient(scripted(reply)).applyRun(RUN, 'approval-1');
  await assert.rejects(apply({ ok: false, code: 'ENGINE_START_FAILED', reason: 'exited', run: 'run-1' }), protocolError('bowerloom.runs.apply'), 'a run with no session');
  await assert.rejects(apply({ ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: 'run-1', cause: 'exited' }), protocolError('bowerloom.runs.apply'));
  await assert.rejects(apply({ ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', member: { index: 0, label: 'writer' }, run: 'run-1' }), protocolError('bowerloom.runs.apply'), 'a run belongs to a failed start only');
});
