// The job store: the jobs the core holds, at most 64, in the order they were made. It holds definitions that were checked, and it makes the ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_JOBS, checkJobId, createJobStore } from '../src/store.js';
import { checkDefinition, type JobDefinition } from '../src/definition.js';

const make = (title: string, label = 'writer'): JobDefinition => {
  const checked = checkDefinition({ title, sessions: [{ label, engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Do it.' }] });
  assert.ok(checked.ok);
  return checked.value;
};
const counter = () => { let n = 0; return () => `job-${(n += 1)}`; };

test('a job is made with an id the store chooses, and it reads back with its definition', () => {
  const store = createJobStore({ newId: counter() });
  const made = store.create(make('First'));
  assert.deepEqual(made, { ok: true, id: 'job-1' });
  assert.deepEqual(store.get('job-1'), { id: 'job-1', definition: make('First') });
  assert.equal(Object.isFrozen(store.get('job-1')), true);
  assert.equal(store.size, 1);
});

test('the list is in the order the jobs were made, with the id, the title, and the count of sessions, and it is a new list each time', () => {
  const store = createJobStore({ newId: counter() });
  store.create(make('First'));
  store.create(checkDefinitionOf('Second', 2));
  const list = store.list();
  assert.deepEqual(list, [{ id: 'job-1', title: 'First', sessions: 1 }, { id: 'job-2', title: 'Second', sessions: 2 }]);
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list[0]), true);
  assert.notEqual(store.list(), list);
});

function checkDefinitionOf(title: string, sessions: number): JobDefinition {
  const checked = checkDefinition({ title, sessions: Array.from({ length: sessions }, (_value, index) => ({ label: `s-${index}`, engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Do it.' })) });
  assert.ok(checked.ok);
  return checked.value;
}

test('the store holds at most 64 jobs, and a full store refuses with GAUGE_JOB_LIMIT and changes nothing; a delete frees a place', () => {
  assert.equal(MAX_JOBS, 64);
  const store = createJobStore({ newId: counter() });
  for (let index = 0; index < MAX_JOBS; index += 1) assert.equal(store.create(make(`Job ${index}`)).ok, true);
  assert.deepEqual(store.create(make('One too many')), { ok: false, code: 'GAUGE_JOB_LIMIT' });
  assert.equal(store.size, MAX_JOBS);
  assert.equal(store.list().some(job => job.title === 'One too many'), false);
  assert.equal(store.remove('job-5'), true);
  assert.equal(store.size, MAX_JOBS - 1);
  assert.deepEqual(store.create(make('Fits now')), { ok: true, id: `job-${MAX_JOBS + 1}` });
});

test('the store says when it is full, and a delete makes room', () => {
  const store = createJobStore({ cap: 2, newId: counter() });
  assert.equal(store.full, false);
  store.create(make('A'));
  assert.equal(store.full, false);
  store.create(make('B'));
  assert.equal(store.full, true);
  store.remove('job-1');
  assert.equal(store.full, false);
});

test('the cap can be lowered, and it is a whole number from 1 to 64', () => {
  const store = createJobStore({ cap: 2, newId: counter() });
  store.create(make('A'));
  store.create(make('B'));
  assert.deepEqual(store.create(make('C')), { ok: false, code: 'GAUGE_JOB_LIMIT' });
  for (const bad of [0, -1, 65, 1.5, NaN, Infinity, '4' as unknown as number]) assert.throws(() => createJobStore({ cap: bad }), RangeError, String(bad));
});

test('a replace keeps the id and the place in the list, and a replace or remove of an id that is not there says so', () => {
  const store = createJobStore({ newId: counter() });
  store.create(make('First'));
  store.create(make('Second'));
  assert.equal(store.replace('job-1', make('First, again')), true);
  assert.deepEqual(store.list().map(job => job.id), ['job-1', 'job-2']);
  assert.equal(store.get('job-1')?.definition.title, 'First, again');
  assert.equal(store.replace('job-9', make('x')), false);
  assert.equal(store.remove('job-9'), false);
  assert.equal(store.remove('job-1'), true);
  assert.equal(store.get('job-1'), undefined);
  assert.deepEqual(store.list().map(job => job.id), ['job-2']);
});

test('a replace of a full store still works: it adds no job', () => {
  const store = createJobStore({ cap: 1, newId: counter() });
  store.create(make('A'));
  assert.equal(store.replace('job-1', make('B')), true);
  assert.equal(store.get('job-1')?.definition.title, 'B');
});

test('an id that is not a job reads as missing: a name from the prototype, a non-string, and a malformed id', () => {
  const store = createJobStore({ newId: counter() });
  store.create(make('First'));
  for (const id of ['toString', '__proto__', 'constructor', '', 'JOB-1', 'job 1', undefined, null, 1, {}]) {
    assert.equal(store.get(id as string), undefined, String(id));
    assert.equal(store.remove(id as string), false, String(id));
    assert.equal(store.replace(id as string, make('x')), false, String(id));
  }
  assert.equal(store.size, 1);
});

test('a bad or repeated id from newId is a bug, and throws without changing the store', () => {
  const ids = ['job-1', 'job-1', 'Bad Id', '__proto__', ''];
  const store = createJobStore({ newId: () => ids.shift() ?? 'job-9' });
  store.create(make('A'));
  for (const _ of [1, 2, 3, 4]) assert.throws(() => store.create(make('B')), /job id/);
  assert.equal(store.size, 1);
  assert.deepEqual(store.create(make('C')), { ok: true, id: 'job-9' });
});

test('a newId that throws leaves the store as it was', () => {
  const store = createJobStore({ newId: () => { throw new Error('no ids'); } });
  assert.throws(() => store.create(make('A')), /no ids/);
  assert.equal(store.size, 0);
});

test('the default id is job- and sixteen hexadecimal characters, and two ids differ', () => {
  const store = createJobStore();
  const one = store.create(make('A')), two = store.create(make('B'));
  assert.ok(one.ok && two.ok);
  assert.match(one.id, /^job-[0-9a-f]{16}$/);
  assert.notEqual(one.id, two.id);
  assert.equal(checkJobId(one.id).ok, true);
});

test('checkJobId accepts a short lower-case token and refuses anything else with the reason job', () => {
  for (const good of ['job-1', 'a', '0', 'a-b-c', 'a'.repeat(64)]) assert.deepEqual(checkJobId(good), { ok: true, value: good }, good);
  for (const bad of ['', '-a', 'A', 'a b', 'a_b', 'a'.repeat(65), 'a\n', 7, null, undefined, {}, ['a']]) assert.deepEqual(checkJobId(bad), { ok: false, reason: 'job' }, String(bad));
});
