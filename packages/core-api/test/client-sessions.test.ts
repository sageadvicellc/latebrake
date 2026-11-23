// The strict reply checks of the session calls. A scripted core gives the reply, so each check is proven on its own: a reply that breaks the contract is a protocol error that names the method.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, CoreProtocolError } from '../src/client.js';
import type { Core, CoreReply, SessionPlan, SessionSummary } from '../src/types.js';
import { REQUEST_REASONS } from '../../engine-sessions/src/index.js';

function scripted(reply: unknown): Core & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return { calls, call: async (method, params) => { calls.push({ method, params }); return reply as CoreReply; } };
}
const ok = (result: unknown) => scripted({ ok: true, result });
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const START: SessionPlan = {
  action: 'start', gauge: 'fixture-sessioner', engine: 'fixture-engine', folder: '/work/alpha', session: null, program: '/usr/bin/fake', model: null, billing: 'engine-plan',
  variables: ['FIXTURE_DECLARED'], sharedWith: [], force: false, steps: ['one', 'two'], digest: A, nonce: B,
};
const STOP: SessionPlan = {
  action: 'stop', gauge: 'fixture-sessioner', engine: 'fixture-engine', folder: '/work/alpha', session: 's-1', program: null, model: null, billing: 'engine-plan',
  variables: [], sharedWith: [], force: false, steps: ['one'], digest: A, nonce: B,
};
const SESSION: SessionSummary = { id: 's-1', engine: 'fixture-engine', folder: '/work/alpha', state: 'running', billing: 'engine-plan', model: null, failure: null };
const starting = (result: unknown, request: Parameters<ReturnType<typeof createCoreClient>['planSessionStart']>[1] = { engine: 'fixture-engine', folder: '/work/alpha' }) => createCoreClient(ok(result)).planSessionStart('fixture-sessioner', request);
const stopping = (result: unknown) => createCoreClient(ok(result)).planSessionStop('fixture-sessioner', 's-1');
const applying = (result: unknown, plan: SessionPlan = START) => createCoreClient(ok(result)).applySession(plan, 'approval-1');
const listing = (result: unknown) => createCoreClient(ok(result)).listSessions('fixture-sessioner', 'fixture-engine');
const reading = (result: unknown) => createCoreClient(ok(result)).getSession('fixture-sessioner', 's-1');
const protocolError = (method: string) => (error: unknown) => error instanceof CoreProtocolError && error.method === method && error.message.startsWith(`${method}: `);

test('each session call sends its params under a bowerloom wire name', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  const client = createCoreClient(core);
  await client.planSessionStart('g', { engine: 'e', folder: '/f' });
  await client.planSessionStart('g', { engine: 'e', folder: '/f', model: { provider: 'p', model: 'm' }, variables: ['B', 'A'] });
  await client.planSessionStart('g', { engine: 'e', folder: '/f', model: null, variables: [] });
  await client.planSessionStop('g', 's-1');
  await client.applySession(START, 'approval-1');
  await client.applySession(START);
  await client.applySession(START, 'approval-1', 'shared-1');
  await client.listSessions('g', 'e');
  await client.getSession('g', 's-1');
  assert.deepEqual(core.calls, [
    { method: 'bowerloom.sessions.plan', params: { action: 'start', gauge: 'g', engine: 'e', folder: '/f' } },
    { method: 'bowerloom.sessions.plan', params: { action: 'start', gauge: 'g', engine: 'e', folder: '/f', model: { provider: 'p', model: 'm' }, variables: ['B', 'A'] } },
    { method: 'bowerloom.sessions.plan', params: { action: 'start', gauge: 'g', engine: 'e', folder: '/f', model: null, variables: [] } },
    { method: 'bowerloom.sessions.plan', params: { action: 'stop', gauge: 'g', session: 's-1' } },
    { method: 'bowerloom.sessions.apply', params: { plan: START, approval: 'approval-1' } },
    { method: 'bowerloom.sessions.apply', params: { plan: START } },
    { method: 'bowerloom.sessions.apply', params: { plan: START, approval: 'approval-1', sharedApproval: 'shared-1' } },
    { method: 'bowerloom.sessions.list', params: { gauge: 'g', engine: 'e' } },
    { method: 'bowerloom.sessions.get', params: { gauge: 'g', session: 's-1' } },
  ]);
});

test('the client sends a copy of the plan, the model included, so a core that changes it changes nothing for the caller', async () => {
  const plan: SessionPlan = { ...START, model: { provider: 'p', model: 'm' }, variables: ['A'], sharedWith: ['x'], steps: ['one'] };
  const core: Core = {
    call: async (_method, params) => {
      const sent = params['plan'] as { steps: string[]; variables: string[]; sharedWith: string[]; model: { provider: string } };
      sent.steps.push('x');
      sent.variables.push('x');
      sent.sharedWith.push('y');
      sent.model.provider = 'changed';
      return { ok: false, code: 'UNKNOWN_GAUGE' };
    },
  };
  await createCoreClient(core).applySession(plan);
  assert.deepEqual(plan, { ...START, model: { provider: 'p', model: 'm' }, variables: ['A'], sharedWith: ['x'], steps: ['one'] });
});

test('a start plan sent back is copied from own data properties: an accessor and an inherited field are not sent, and __proto__ stays an own key of the copy', async () => {
  const core = scripted({ ok: false, code: 'UNKNOWN_GAUGE' });
  let reads = 0;
  const plan = { ...START } as Record<string, unknown>;
  Object.defineProperty(plan, 'force', { get() { reads += 1; return false; }, enumerable: true });
  Object.defineProperty(plan, '__proto__', { value: 'x', enumerable: true });
  await createCoreClient(core).applySession(plan as unknown as SessionPlan);
  const sent = (core.calls[0]?.params as { plan: Record<string, unknown> }).plan;
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(sent, 'force'), false);
  assert.equal(Object.getPrototypeOf(sent), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(sent, '__proto__')?.value, 'x');
});

// The plan

test('a well-formed start plan comes back as a frozen copy, and a field beyond the contract is dropped', async () => {
  const result = await starting({ ...START, extra: 'x' });
  assert.deepEqual(result, { ok: true, value: START });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.steps), true);
  assert.equal(Object.isFrozen(result.value.variables), true);
  assert.equal(Object.isFrozen(result.value.sharedWith), true);
  assert.equal('extra' in result.value, false);
});

test('a start plan with a model, a local billing source, and a shared folder is read as it is', async () => {
  const plan = { ...START, model: { provider: 'p', model: 'm' }, billing: 'local', sharedWith: ['a-engine', 'b-engine'], variables: ['A', 'B_2', '_c', 'a'] };
  const result = await starting(plan, { engine: 'fixture-engine', folder: '/work/alpha', model: { provider: 'p', model: 'm' }, variables: ['A'] });
  assert.deepEqual(result, { ok: true, value: plan });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value.model), true);
});

test('a well-formed stop plan comes back as a frozen copy', async () => {
  const result = await stopping({ ...STOP, force: true });
  assert.deepEqual(result, { ok: true, value: { ...STOP, force: true } });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
});

test('a start plan that breaks the contract is a protocol error that names the method', async () => {
  const bad: readonly [string, unknown][] = [
    ['null', null], ['text', 'x'], ['a list', []], ['a number', 5], ['empty', {}],
    ['no action', { ...START, action: undefined }], ['unknown action', { ...START, action: 'restart' }], ['an upper-case action', { ...START, action: 'Start' }],
    ['a gauge that is not an id', { ...START, gauge: 'Bad Gauge' }], ['an engine that is not an id', { ...START, engine: 'Bad Engine' }], ['an engine that is not text', { ...START, engine: 5 }],
    ['a relative folder', { ...START, folder: 'work/alpha' }], ['a folder with a line break', { ...START, folder: '/work/a\nb' }], ['the root folder', { ...START, folder: '/' }],
    ['a session on a start', { ...START, session: 's-1' }], ['no program', { ...START, program: null }], ['an empty program', { ...START, program: '' }], ['a program with a line break', { ...START, program: '/bin/a\nb' }],
    ['a program that is too long', { ...START, program: `/${'x'.repeat(4096)}` }], ['a missing program field', { ...START, program: undefined }],
    ['a missing model field', { ...START, model: undefined }], ['a model that is text', { ...START, model: 'p/m' }], ['a model with a field missing', { ...START, model: { provider: 'p' } }],
    ['a model with an extra field', { ...START, model: { provider: 'p', model: 'm', extra: 1 } }],
    ['an unknown billing source', { ...START, billing: 'provider-key' }], ['a billing source that is not text', { ...START, billing: 1 }],
    ['variables that are not a list', { ...START, variables: 'A' }], ['variables with a hole', { ...START, variables: ['A', , 'B'] }], ['variables out of order', { ...START, variables: ['B', 'A'] }],
    ['variables with a repeat', { ...START, variables: ['A', 'A'] }], ['a variable that is not a name', { ...START, variables: ['1A'] }], ['a variable that is not text', { ...START, variables: [5] }],
    ['a variable that is too long', { ...START, variables: ['A'.repeat(65)] }],
    ['sharedWith that is not a list', { ...START, sharedWith: 'x' }], ['sharedWith out of order', { ...START, sharedWith: ['b', 'a'] }], ['sharedWith with a repeat', { ...START, sharedWith: ['a', 'a'] }],
    ['sharedWith with a bad id', { ...START, sharedWith: ['Bad'] }],
    ['force on a start', { ...START, force: true }], ['force that is not a boolean', { ...START, force: 'no' }], ['no force', { ...START, force: undefined }],
    ['no steps', { ...START, steps: [] }], ['steps that are not a list', { ...START, steps: 'one' }], ['a step that is not text', { ...START, steps: [1] }], ['a step with a line break', { ...START, steps: ['a\nb'] }],
    ['a step with a carriage return', { ...START, steps: ['a\rb'] }], ['a step with a line separator', { ...START, steps: ['a\u2028b'] }],
    ['a digest that is short', { ...START, digest: 'abc' }], ['a digest in capitals', { ...START, digest: A.toUpperCase() }], ['no nonce', { ...START, nonce: undefined }], ['a nonce that is short', { ...START, nonce: 'abc' }],
  ];
  for (const [label, value] of bad) await assert.rejects(starting(value), protocolError('bowerloom.sessions.plan'), label);
});

test('a stop plan that breaks the contract is a protocol error that names the method', async () => {
  const bad: readonly [string, unknown][] = [
    ['no session', { ...STOP, session: null }], ['a session that is not an id', { ...STOP, session: 'S-1' }], ['a session that is not text', { ...STOP, session: 5 }],
    ['a program on a stop', { ...STOP, program: '/bin/x' }], ['a model on a stop', { ...STOP, model: { provider: 'p', model: 'm' } }], ['variables on a stop', { ...STOP, variables: ['A'] }],
    ['sharedWith on a stop', { ...STOP, sharedWith: ['x'] }], ['a force that is not a boolean', { ...STOP, force: 1 }], ['a start plan', START],
  ];
  for (const [label, value] of bad) await assert.rejects(stopping(value), protocolError('bowerloom.sessions.plan'), label);
});

test('a plan for another action, Gauge, engine, session, model, or variable than was asked is a protocol error', async () => {
  const model = { provider: 'p', model: 'm' };
  await assert.rejects(starting(STOP), protocolError('bowerloom.sessions.plan'), 'a stop for a start');
  await assert.rejects(starting({ ...START, gauge: 'fixture-other' }), protocolError('bowerloom.sessions.plan'), 'another Gauge');
  await assert.rejects(starting({ ...START, engine: 'fixture-other' }), protocolError('bowerloom.sessions.plan'), 'another engine');
  await assert.rejects(starting({ ...START, model }), protocolError('bowerloom.sessions.plan'), 'a model that was not asked');
  await assert.rejects(starting(START, { engine: 'fixture-engine', folder: '/work/alpha', model }), protocolError('bowerloom.sessions.plan'), 'a model left out');
  await assert.rejects(starting({ ...START, model: { provider: 'p', model: 'other' } }, { engine: 'fixture-engine', folder: '/work/alpha', model }), protocolError('bowerloom.sessions.plan'), 'another model');
  await assert.rejects(starting({ ...START, model: { provider: 'other', model: 'm' } }, { engine: 'fixture-engine', folder: '/work/alpha', model }), protocolError('bowerloom.sessions.plan'), 'another provider');
  await assert.rejects(starting(START, { engine: 'fixture-engine', folder: '/work/alpha', variables: ['ASKED'] }), protocolError('bowerloom.sessions.plan'), 'a variable left out');
  assert.ok((await starting({ ...START, variables: ['ASKED', 'FIXTURE_DECLARED'] }, { engine: 'fixture-engine', folder: '/work/alpha', variables: ['ASKED'] })).ok);
  await assert.rejects(stopping(START), protocolError('bowerloom.sessions.plan'), 'a start for a stop');
  await assert.rejects(stopping({ ...STOP, gauge: 'fixture-other' }), protocolError('bowerloom.sessions.plan'), 'another Gauge on a stop');
  await assert.rejects(stopping({ ...STOP, session: 's-2' }), protocolError('bowerloom.sessions.plan'), 'another session');
});

test('a plan reads own properties only: a field that the reply inherits reads as missing', async () => {
  const inherited = Object.create(START) as object;
  await assert.rejects(starting(inherited), protocolError('bowerloom.sessions.plan'));
  const partial = Object.create({ nonce: B }) as Record<string, unknown>;
  for (const [key, value] of Object.entries({ ...START, nonce: undefined })) if (value !== undefined) partial[key] = value;
  await assert.rejects(starting(partial), protocolError('bowerloom.sessions.plan'));
});

test('a getter in a reply is never run: an own accessor reads as missing, so the reply is refused, for a plan, an applied plan, and a session', async () => {
  let runs = 0;
  const accessor = (base: object, key: string) => { const copy = { ...base }; Object.defineProperty(copy, key, { get() { runs += 1; return (base as Record<string, unknown>)[key]; }, enumerable: true }); return copy; };
  for (const key of Object.keys(START)) await assert.rejects(starting(accessor(START, key)), protocolError('bowerloom.sessions.plan'), `plan ${key}`);
  for (const key of Object.keys(STOP)) await assert.rejects(stopping(accessor(STOP, key)), protocolError('bowerloom.sessions.plan'), `stop plan ${key}`);
  const applied = { action: 'start', session: 's-1', engine: 'fixture-engine', state: 'running' };
  for (const key of Object.keys(applied)) await assert.rejects(applying(accessor(applied, key)), protocolError('bowerloom.sessions.apply'), `applied ${key}`);
  for (const key of Object.keys(SESSION)) {
    await assert.rejects(reading(accessor(SESSION, key)), protocolError('bowerloom.sessions.get'), `session ${key}`);
    await assert.rejects(listing([accessor(SESSION, key)]), protocolError('bowerloom.sessions.list'), `listed session ${key}`);
  }
  await assert.rejects(starting({ ...START, model: accessor({ provider: 'p', model: 'm' }, 'provider') }, { engine: 'fixture-engine', folder: '/work/alpha', model: { provider: 'p', model: 'm' } }), protocolError('bowerloom.sessions.plan'), 'a model accessor');
  assert.equal(runs, 0, 'no getter ran');
});

test('a getter that throws while a reply is read is a protocol error', async () => {
  const reply = { ...START };
  Object.defineProperty(reply, 'steps', { get() { throw new Error('boom'); }, enumerable: true });
  await assert.rejects(starting(reply), protocolError('bowerloom.sessions.plan'));
});

test('a list in a reply is read by index once: an iterator, a subclass, a list that changes between two reads, and a hole are not followed', async () => {
  const iterating = ['one'];
  Object.defineProperty(iterating, Symbol.iterator, { value: function* () { yield 'x'; yield 42; } });
  const plan = (steps: unknown) => starting({ ...START, steps });
  assert.deepEqual((await plan(iterating)), { ok: true, value: { ...START, steps: ['one'] } }, 'the iterator is ignored');
  class Sub extends Array {}
  await assert.rejects(plan(Sub.from(['one'])), protocolError('bowerloom.sessions.plan'), 'a subclass');
  let reads = 0;
  const changing = new Proxy(['fine'], { get(target, key, receiver) { if (key === '0') { reads += 1; return reads === 1 ? 'fine' : 42; } return Reflect.get(target, key, receiver); }, getOwnPropertyDescriptor(target, key) { const d = Reflect.getOwnPropertyDescriptor(target, key); if (key === '0' && d) { reads += 1; return { ...d, value: reads === 1 ? 'fine' : 42 }; } return d; } });
  const result = await plan(changing);
  assert.ok(result.ok);
  assert.deepEqual(result.value.steps, ['fine'], 'the list is read once, so the frozen plan holds text only');
  assert.equal(reads, 1);
  await assert.rejects(plan(['a', , 'b']), protocolError('bowerloom.sessions.plan'), 'a hole');
  await assert.rejects(listing(Object.assign(Object.create(Array.prototype) as object, { length: 0 })), protocolError('bowerloom.sessions.list'));
  class Many extends Array {}
  await assert.rejects(listing(Many.from([SESSION])), protocolError('bowerloom.sessions.list'), 'a subclass of sessions');
});

test('a plan program and a step may not hold a control, format, or separator character, and a step may not hold a look-alike space or a combining mark', async () => {
  for (const bad of ['\u0000', '\u202e', '\u200b', '\u2028', '\n', '\u0085']) {
    await assert.rejects(starting({ ...START, program: `/bin/a${bad}b` }), protocolError('bowerloom.sessions.plan'), `program ${JSON.stringify(bad)}`);
    await assert.rejects(starting({ ...START, steps: [`one${bad}two`] }), protocolError('bowerloom.sessions.plan'), `step ${JSON.stringify(bad)}`);
  }
  for (const bad of ['\u00a0', '\u3000', '\u3164', '\u2800', '\u115f', '\u1160', '\uffa0', 'e\u0301']) {
    await assert.rejects(starting({ ...START, steps: [`one${bad}two`] }), protocolError('bowerloom.sessions.plan'), `step ${JSON.stringify(bad)}`);
  }
  assert.ok((await starting({ ...START, steps: ['one two', 'caf\u00e9 \u{1F680}', 'escaped \\u{a0}'] })).ok);
});

test('a request is read once: a getter on the request runs once, and the plan is checked against the values that were sent', async () => {
  let engineReads = 0, folderReads = 0, modelReads = 0, variableReads = 0;
  const flipping = {
    get engine() { engineReads += 1; return engineReads === 1 ? 'fixture-engine' : 'fixture-other'; },
    get folder() { folderReads += 1; return '/work/alpha'; },
    get model() { modelReads += 1; return modelReads === 1 ? { provider: 'p', model: 'm' } : null; },
    get variables() { variableReads += 1; return variableReads === 1 ? ['ASKED'] : []; },
  };
  const core = scripted({ ok: true, result: { ...START, model: { provider: 'p', model: 'm' }, variables: ['ASKED', 'FIXTURE_DECLARED'] } });
  const result = await createCoreClient(core).planSessionStart('fixture-sessioner', flipping);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual([engineReads, folderReads, modelReads, variableReads], [1, 1, 1, 1]);
  assert.deepEqual(core.calls[0]?.params, { action: 'start', gauge: 'fixture-sessioner', engine: 'fixture-engine', folder: '/work/alpha', model: { provider: 'p', model: 'm' }, variables: ['ASKED'] });
});

test('an applied plan is checked against the copy that was sent: a plan whose fields change between reads cannot make a result fit', async () => {
  let reads = 0;
  const moving = { ...START } as Record<string, unknown>;
  Object.defineProperty(moving, 'engine', { get() { reads += 1; return reads === 1 ? 'fixture-engine' : 'fixture-other'; }, enumerable: true });
  await assert.rejects(createCoreClient(ok({ action: 'start', session: 's-1', engine: 'fixture-other', state: 'running' })).applySession(moving as unknown as SessionPlan), TypeError);
  const noAction = { ...START } as Record<string, unknown>;
  Object.defineProperty(noAction, 'action', { get() { return 'start'; }, enumerable: true });
  await assert.rejects(createCoreClient(ok({ action: 'start', session: 's-1', engine: 'fixture-engine', state: 'running' })).applySession(noAction as unknown as SessionPlan), /plan needs an own action/);
  await assert.rejects(createCoreClient(ok({})).applySession({ ...START, engine: 5 } as unknown as SessionPlan), TypeError);
});

// The apply

test('an applied start gives the session and its state, and any state past ready is fine', async () => {
  for (const state of ['starting', 'running', 'waiting', 'stopping', 'stopped', 'failed']) {
    assert.deepEqual(await applying({ action: 'start', session: 's-1', engine: 'fixture-engine', state }), { ok: true, value: { action: 'start', session: 's-1', engine: 'fixture-engine', state } }, state);
  }
});

test('an applied stop gives stopped for the session of the plan, and nothing else', async () => {
  assert.deepEqual(await applying({ action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'stopped' }, STOP), { ok: true, value: { action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'stopped' } });
  const result = await applying({ action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'stopped', extra: 1 }, STOP);
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal('extra' in result.value, false);
});

test('an applied plan that breaks the contract is a protocol error that names the method', async () => {
  const good = { action: 'start', session: 's-1', engine: 'fixture-engine', state: 'running' };
  const bad: readonly [string, unknown, SessionPlan][] = [
    ['null', null, START], ['text', 'x', START], ['a list', [], START], ['empty', {}, START],
    ['another action', { ...good, action: 'stop' }, START], ['another engine', { ...good, engine: 'fixture-other' }, START], ['an unknown action', { ...good, action: 'x' }, START],
    ['no session', { ...good, session: undefined }, START], ['a session that is not an id', { ...good, session: 'S 1' }, START], ['a session that is not text', { ...good, session: 5 }, START],
    ['a state that is not one', { ...good, state: 'dead' }, START], ['a state that is not text', { ...good, state: 5 }, START], ['a start that is still detected', { ...good, state: 'detected' }, START],
    ['a start that is only ready', { ...good, state: 'ready' }, START],
    ['a stop for another session', { action: 'stop', session: 's-2', engine: 'fixture-engine', state: 'stopped' }, STOP],
    ['a stop that is not stopped', { action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'stopping' }, STOP], ['a stop that is running', { action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'running' }, STOP],
    ['a stop that failed', { action: 'stop', session: 's-1', engine: 'fixture-engine', state: 'failed' }, STOP],
  ];
  for (const [label, value, plan] of bad) await assert.rejects(applying(value, plan), protocolError('bowerloom.sessions.apply'), label);
});

// The reads

test('a list of sessions comes back as frozen copies, in order, and an extra field is dropped', async () => {
  const second = { ...SESSION, id: 's-2', state: 'failed', failure: 'crashed', model: { provider: 'p', model: 'm' } };
  const result = await listing([{ ...SESSION, extra: 1 }, second]);
  assert.deepEqual(result, { ok: true, value: [SESSION, second] });
  assert.ok(result.ok);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[0]), true);
  assert.equal(Object.isFrozen(result.value[1]?.model), true);
  assert.deepEqual(await listing([]), { ok: true, value: [] });
});

test('a session that breaks the contract is a protocol error that names the method', async () => {
  const bad: readonly [string, unknown][] = [
    ['null', null], ['text', 'x'], ['a list', []], ['empty', {}],
    ['an id that is not an id', { ...SESSION, id: 'S 1' }], ['an id that is not text', { ...SESSION, id: 1 }], ['an engine that is not an id', { ...SESSION, engine: 'Bad' }],
    ['a relative folder', { ...SESSION, folder: 'a' }], ['a state that is not one', { ...SESSION, state: 'dead' }], ['no state', { ...SESSION, state: undefined }],
    ['a billing source that is not one', { ...SESSION, billing: 'provider-key' }], ['no billing source', { ...SESSION, billing: undefined }],
    ['no model field', { ...SESSION, model: undefined }], ['a model that is text', { ...SESSION, model: 'x' }], ['a model with a field missing', { ...SESSION, model: { provider: 'p' } }],
    ['a failure that is not one', { ...SESSION, state: 'failed', failure: 'broken' }], ['a failure that is not text', { ...SESSION, state: 'failed', failure: 5 }], ['no failure field', { ...SESSION, failure: undefined }],
    ['a failed session with no failure', { ...SESSION, state: 'failed', failure: null }], ['a session with a failure that has not failed', { ...SESSION, failure: 'crashed' }],
    ['a stopped session with a failure', { ...SESSION, state: 'stopped', failure: 'crashed' }],
  ];
  for (const [label, value] of bad) {
    await assert.rejects(reading(value), protocolError('bowerloom.sessions.get'), `read: ${label}`);
    await assert.rejects(listing([value]), protocolError('bowerloom.sessions.list'), `list: ${label}`);
  }
});

test('a list that is not a list, has a hole, repeats a session, or holds a session of another engine is a protocol error', async () => {
  for (const value of [null, 'x', {}, 5]) await assert.rejects(listing(value), protocolError('bowerloom.sessions.list'), String(value));
  await assert.rejects(listing([SESSION, , SESSION]), protocolError('bowerloom.sessions.list'), 'a hole');
  await assert.rejects(listing([SESSION, SESSION]), protocolError('bowerloom.sessions.list'), 'a repeat');
  await assert.rejects(listing([{ ...SESSION, engine: 'fixture-other' }]), protocolError('bowerloom.sessions.list'), 'another engine');
});

test('a read of a session for another id is a protocol error', async () => {
  assert.deepEqual(await reading(SESSION), { ok: true, value: SESSION });
  await assert.rejects(reading({ ...SESSION, id: 's-2' }), protocolError('bowerloom.sessions.get'));
});

// The refusals

test('a refusal of ENGINE_REQUEST_INVALID needs a reason of the closed set, and every other engine code needs none', async () => {
  for (const reason of REQUEST_REASONS) {
    assert.deepEqual(await createCoreClient(scripted({ ok: false, code: 'ENGINE_REQUEST_INVALID', reason })).planSessionStop('g', 's-1'), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason }, reason);
  }
  const refused = (reply: unknown) => createCoreClient(scripted(reply)).planSessionStop('g', 's-1');
  for (const reply of [
    { ok: false, code: 'ENGINE_REQUEST_INVALID' }, { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'syntax' }, { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'Folder' }, { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 5 },
    { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: undefined },
  ]) await assert.rejects(refused(reply), CoreProtocolError, JSON.stringify(reply));
  for (const code of ['ENGINE_NOT_FOUND', 'MODEL_NOT_FOR_ENGINE', 'ENGINE_LIMIT', 'ENGINE_PAIR_BUSY', 'ENGINE_FOLDER_SHARED', 'ENGINE_START_FAILED', 'ENGINE_SESSION_UNKNOWN', 'ENGINE_SESSION_ENDED', 'ENGINE_STOP_TIMEOUT']) {
    assert.deepEqual(await refused({ ok: false, code }), { ok: false, code }, code);
    assert.deepEqual(await refused({ ok: false, code, reason: undefined }), { ok: false, code }, `${code} with an undefined reason`);
    await assert.rejects(refused({ ok: false, code, reason: 'folder' }), CoreProtocolError, `${code} with a request reason`);
    await assert.rejects(refused({ ok: false, code, reason: 'duplicate_key' }), CoreProtocolError, `${code} with a manifest reason`);
  }
});

test('a request reason goes with no other code', async () => {
  const refused = (reply: unknown) => createCoreClient(scripted(reply)).planSessionStop('g', 's-1');
  for (const code of ['GAUGE_PLAN_CHANGED', 'UNKNOWN_GAUGE', 'GAUGE_GRANT_MISSING', 'GAUGE_PROTECTED']) await assert.rejects(refused({ ok: false, code, reason: 'folder' }), CoreProtocolError, code);
});
