// The job definition check. A definition is what a Gauge sends and what the core stores: a title and one to eight sessions. Every field is read from own data properties, once, and every refusal has one
// word of a closed set that says which field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_REASONS, MAX_JOB_SESSIONS, MAX_LABEL_LENGTH, MAX_TASK_LENGTH, MAX_TITLE_LENGTH, NOT_INTERACTIVE_REASONS, canonicalDefinition, checkDefinition, hashDefinition, isJobReason, isNotInteractiveReason } from '../src/definition.js';

const session = (extra: Record<string, unknown> = {}) => ({ label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Write the summary.', ...extra });
const definition = (extra: Record<string, unknown> = {}) => ({ title: 'Morning review', sessions: [session()], ...extra });
const invalid = (reason: string) => ({ ok: false, code: 'GAUGE_JOB_INVALID', reason });
const interactive = (reason: string) => ({ ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason });

test('a good definition is read into a new frozen copy that holds exactly its fields', () => {
  const input = definition({ sessions: [session(), session({ label: 'checker', engine: 'fixture-other', model: { provider: 'p', model: 'm' }, task: 'Check it.\nTwice.\tOk.' })] });
  const result = checkDefinition(input);
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    title: 'Morning review',
    sessions: [
      { label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Write the summary.' },
      { label: 'checker', engine: 'fixture-other', harness: 'plain-harness', folder: '/work/alpha', model: { provider: 'p', model: 'm' }, task: 'Check it.\nTwice.\tOk.' },
    ],
  });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.sessions), true);
  assert.equal(Object.isFrozen(result.value.sessions[0]), true);
  assert.equal(Object.isFrozen(result.value.sessions[1]?.model), true);
  assert.notEqual(result.value.sessions[0], input.sessions[0]);
});

test('the limits are 8 sessions, a title of 80, a label of 32, and a task of 4,096 characters', () => {
  assert.deepEqual([MAX_JOB_SESSIONS, MAX_TITLE_LENGTH, MAX_LABEL_LENGTH, MAX_TASK_LENGTH], [8, 80, 32, 4096]);
  const eight = Array.from({ length: 8 }, (_value, index) => session({ label: `s-${index}` }));
  assert.ok(checkDefinition(definition({ sessions: eight })).ok);
  assert.deepEqual(checkDefinition(definition({ sessions: [...eight, session({ label: 'ninth' })] })), invalid('sessions'));
  assert.ok(checkDefinition(definition({ title: 'a'.repeat(80) })).ok);
  assert.deepEqual(checkDefinition(definition({ title: 'a'.repeat(81) })), invalid('title'));
  assert.ok(checkDefinition(definition({ sessions: [session({ label: 'a'.repeat(32) })] })).ok);
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ label: 'a'.repeat(33) })] })), invalid('label'));
  assert.ok(checkDefinition(definition({ sessions: [session({ task: 'a'.repeat(4096) })] })).ok);
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ task: 'a'.repeat(4097) })] })), invalid('task'));
});

test('a definition that is not a plain record is a request refusal', () => {
  class Odd { title = 'x'; sessions = [session()]; }
  const withSymbol = { ...definition(), [Symbol('x')]: 1 };
  const accessor = {};
  Object.defineProperty(accessor, 'title', { get: () => 'x', enumerable: true });
  Object.defineProperty(accessor, 'sessions', { value: [session()], enumerable: true });
  for (const bad of [undefined, null, 'x', 7, true, [], [definition()], new Odd(), Object.create(definition()), withSymbol, accessor, new Proxy({}, { ownKeys() { throw new Error('trap'); } })]) {
    assert.deepEqual(checkDefinition(bad), invalid('request'), String(bad));
  }
});

test('an unknown field is a request refusal, in the definition and in a session, and a missing field names itself', () => {
  assert.deepEqual(checkDefinition(definition({ extra: 1 })), invalid('request'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ extra: 1 })] })), invalid('request'));
  assert.deepEqual(checkDefinition(definition({ ['__proto__']: null })), invalid('request'));
  assert.deepEqual(checkDefinition({ sessions: [session()] }), invalid('title'));
  assert.deepEqual(checkDefinition({ title: 'x' }), invalid('sessions'));
  for (const field of ['label', 'engine', 'harness', 'folder', 'model', 'task']) {
    const rest: Record<string, unknown> = session();
    delete rest[field];
    assert.deepEqual(checkDefinition(definition({ sessions: [rest] })), invalid(field), field);
  }
});

test('an inherited field and an accessor field read as missing: no getter runs', () => {
  let reads = 0;
  const entry = session();
  Object.defineProperty(entry, 'task', { get() { reads += 1; return 'x'; }, enumerable: true });
  assert.deepEqual(checkDefinition(definition({ sessions: [entry] })), invalid('request'));
  assert.equal(reads, 0);
});

test('each field is checked, with its own reason', () => {
  const bad = (field: string, value: unknown) => checkDefinition(definition({ sessions: [session({ [field]: value })] }));
  for (const value of ['', 'Writer', 'two words', 'a_b', '-a', 'a--b', 7, null, undefined, 'a\n']) assert.deepEqual(bad('label', value), invalid('label'), String(value));
  for (const value of ['', 'Engine', 'a b', 7, null, 'x'.repeat(65)]) assert.deepEqual(bad('engine', value), invalid('engine'), String(value));
  for (const value of ['', 'Harness', 'a b', 7, null, 'x'.repeat(65)]) assert.deepEqual(bad('harness', value), invalid('harness'), String(value));
  for (const value of ['', 'relative', '/', '/a/../b', '/a//b', '/a/b/', 'C:\\x', '/a\nb', 7, null, `/${'a'.repeat(1030)}`]) assert.deepEqual(bad('folder', value), invalid('folder'), String(value));
  for (const value of [{}, { provider: 'p' }, { provider: 'p', model: 'm', extra: 1 }, { provider: '-p', model: 'm' }, 'p/m', 7, [], undefined]) assert.deepEqual(bad('model', value), invalid('model'), JSON.stringify(value));
  for (const value of ['', 7, null, 'a\u0000b', 'a\u202eb', 'a\u2028b', 'a\rb']) assert.deepEqual(bad('task', value), invalid('task'), JSON.stringify(value));
  for (const value of ['', ' x', 'x ', 'x\ny', 'x\u0000', 'x\u202e', 7, null]) assert.deepEqual(checkDefinition(definition({ title: value })), invalid('title'), JSON.stringify(value));
});

test('a model choice is null or exactly a provider and a model, copied', () => {
  const choice = { provider: 'p', model: 'm' };
  const result = checkDefinition(definition({ sessions: [session({ model: choice })] }));
  assert.ok(result.ok);
  assert.deepEqual(result.value.sessions[0]?.model, { provider: 'p', model: 'm' });
  assert.notEqual(result.value.sessions[0]?.model, choice);
});

test('a label is used once in a job', () => {
  assert.deepEqual(checkDefinition(definition({ sessions: [session(), session({ engine: 'fixture-other' })] })), invalid('label'));
  assert.ok(checkDefinition(definition({ sessions: [session(), session({ label: 'second' })] })).ok);
});

test('the sessions are a plain list of one to eight: a hole, an accessor, a subclass, a repeat of one object, and an empty list are refused', () => {
  const holey = [session()];
  holey.length = 2;
  const accessor = [session()];
  Object.defineProperty(accessor, 0, { get: () => session(), enumerable: true });
  class Sub extends Array {}
  const sub = Sub.from([session()]);
  for (const bad of [[], holey, accessor, sub, 'x', {}, null, undefined, 7]) assert.deepEqual(checkDefinition(definition({ sessions: bad })), invalid('sessions'), String(bad));
  const one = session();
  assert.deepEqual(checkDefinition(definition({ sessions: [one, one] })), invalid('label'), 'the same object twice repeats its label');
});

test('a list with an iterator that lies is read by index, and the iterator never runs', () => {
  const sessions = [session()];
  Object.defineProperty(sessions, Symbol.iterator, { value: () => { throw new Error('the iterator ran'); } });
  assert.ok(checkDefinition(definition({ sessions })).ok);
});

test('a task that looks like a secret is refused as a secret, and not as a bad task', () => {
  const key = `sk-${'a1'.repeat(15)}`;
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ task: `Use ${key} to call it` })] })), invalid('secret'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ task: 'x'.repeat(4097) + key })] })), invalid('task'), 'a task that is too long is refused for its length first');
  assert.ok(checkDefinition(definition({ sessions: [session({ task: 'Use the key that the engine already holds' })] })).ok);
});

test('a schedule is refused as not interactive, wherever it sits, and before any other field is checked', () => {
  assert.deepEqual(checkDefinition(definition({ schedule: '0 * * * *' })), interactive('schedule'));
  assert.deepEqual(checkDefinition(definition({ schedule: null })), interactive('schedule'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ schedule: 'daily' })] })), interactive('schedule'));
  assert.deepEqual(checkDefinition({ schedule: 'daily' }), interactive('schedule'), 'a definition with no other field');
  assert.deepEqual(checkDefinition(definition({ title: '', schedule: 'daily' })), interactive('schedule'));
});

test('an unattended flag is refused as not interactive, with its own reason, for any value', () => {
  for (const value of [true, false, null, 'yes', 0]) {
    assert.deepEqual(checkDefinition(definition({ unattended: value })), interactive('unattended'), JSON.stringify(value));
    assert.deepEqual(checkDefinition(definition({ sessions: [session({ unattended: value })] })), interactive('unattended'), JSON.stringify(value));
  }
});

test('the closed sets are written out, and a reason is only a word of its set', () => {
  assert.deepEqual([...JOB_REASONS], ['request', 'title', 'sessions', 'label', 'engine', 'harness', 'folder', 'model', 'task', 'secret', 'job']);
  assert.deepEqual([...NOT_INTERACTIVE_REASONS], ['schedule', 'unattended']);
  for (const reason of JOB_REASONS) assert.equal(isJobReason(reason), true);
  for (const value of ['', 'toString', '__proto__', 'schedule', 7, null, undefined]) assert.equal(isJobReason(value), false, String(value));
  for (const reason of NOT_INTERACTIVE_REASONS) assert.equal(isNotInteractiveReason(reason), true);
  for (const value of ['', 'request', 'toString', 7, null]) assert.equal(isNotInteractiveReason(value), false, String(value));
});

test('the hash of a definition is the SHA-256 of its canonical text, and any change to any field changes it', () => {
  const base = checkDefinition(definition());
  assert.ok(base.ok);
  const text = canonicalDefinition(base.value);
  assert.equal(text, '["Morning review",[["writer","fixture-engine","plain-harness","/work/alpha",null,"Write the summary."]]]');
  assert.match(hashDefinition(base.value), /^[0-9a-f]{64}$/);
  const seen = new Set([hashDefinition(base.value)]);
  const variants: Record<string, unknown>[] = [
    definition({ title: 'Other' }),
    definition({ sessions: [session({ label: 'other' })] }),
    definition({ sessions: [session({ engine: 'fixture-other' })] }),
    definition({ sessions: [session({ harness: 'other-harness' })] }),
    definition({ sessions: [session({ folder: '/work/beta' })] }),
    definition({ sessions: [session({ model: { provider: 'p', model: 'm' } })] }),
    definition({ sessions: [session({ task: 'Other.' })] }),
    definition({ sessions: [session(), session({ label: 'second' })] }),
  ];
  for (const variant of variants) {
    const checked = checkDefinition(variant);
    assert.ok(checked.ok);
    seen.add(hashDefinition(checked.value));
  }
  assert.equal(seen.size, 1 + variants.length);
  const again = checkDefinition(definition());
  assert.ok(again.ok);
  assert.equal(hashDefinition(again.value), hashDefinition(base.value));
});

test('a schedule or an unattended flag in a later session is found first, before the reason of an earlier invalid field', () => {
  const bad = session({ engine: 'Engine', task: '', folder: 'relative' });
  assert.deepEqual(checkDefinition(definition({ sessions: [bad, session({ label: 'second', schedule: 'daily' })] })), interactive('schedule'));
  assert.deepEqual(checkDefinition(definition({ sessions: [bad, session({ label: 'second', unattended: true })] })), interactive('unattended'));
  assert.deepEqual(checkDefinition(definition({ title: '', sessions: [bad, bad, session({ label: 'third', schedule: null })] })), interactive('schedule'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ label: 'first', unattended: true }), session({ label: 'second', schedule: 'daily' })] })), interactive('schedule'), 'a schedule wins over an unattended flag, wherever each sits');
  assert.deepEqual(checkDefinition(definition({ unattended: true, sessions: [bad, session({ label: 'second', schedule: 'daily' })] })), interactive('schedule'));
  for (const hostile of [session({ label: 'second', schedule: 'daily', task: 7 })]) assert.deepEqual(checkDefinition(definition({ sessions: [bad, hostile] })), interactive('schedule'));
  // A session list that cannot be read is still a refusal of the list.
  const holey = [session()];
  holey.length = 2;
  assert.deepEqual(checkDefinition(definition({ sessions: holey })), invalid('sessions'));
  // A session that is not a record cannot hold a flag, and is refused as a request when the scan is done.
  assert.deepEqual(checkDefinition(definition({ sessions: [7, session({ label: 'second', schedule: 'x' })] })), interactive('schedule'));
  assert.deepEqual(checkDefinition(definition({ sessions: [7] })), invalid('request'));
});

test('a secret is found in the title, the label, the folder, and the model, and not only in the task', () => {
  const key = `sk-${'a1'.repeat(15)}`;
  assert.deepEqual(checkDefinition(definition({ title: `Use ${key}` })), invalid('secret'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ label: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa' })] })), invalid('secret'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ folder: `/work/${key}` })] })), invalid('secret'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ model: { provider: key, model: 'm' } })] })), invalid('secret'));
  assert.deepEqual(checkDefinition(definition({ sessions: [session({ model: { provider: 'p', model: key } })] })), invalid('secret'));
  assert.ok(checkDefinition(definition({ title: 'The key lives in the vault', sessions: [session({ folder: '/work/keys', model: { provider: 'local', model: 'llama-3' } })] })).ok);
  // A field that is wrong is refused for that field first, and a secret is only looked for in a field that is otherwise good.
  assert.deepEqual(checkDefinition(definition({ title: ` ${key}` })), invalid('title'));
});

test('a long mixed-case word is a false alarm of the scan, in any field, and the refusal says secret', () => {
  assert.deepEqual(checkDefinition(definition({ title: 'a1B2'.repeat(8) })), invalid('secret'));
  assert.ok(checkDefinition(definition({ title: 'a1B2'.repeat(7) })).ok, 'under 32 characters it is not');
});

test('a proxy whose trap throws is a request refusal and never a throw: its prototype, its list check, and a revoked proxy', () => {
  const protoTrap = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const listProxy = Proxy.revocable([], {});
  listProxy.revoke();
  for (const bad of [protoTrap, revoked.proxy, definition({ sessions: [protoTrap] }), definition({ sessions: [revoked.proxy] })]) {
    let result: unknown;
    assert.doesNotThrow(() => { result = checkDefinition(bad); });
    assert.deepEqual(result, invalid('request'));
  }
  assert.doesNotThrow(() => checkDefinition(definition({ sessions: listProxy.proxy })));
  assert.deepEqual(checkDefinition(definition({ sessions: listProxy.proxy })), invalid('sessions'));
});
