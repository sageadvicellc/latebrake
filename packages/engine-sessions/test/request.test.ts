// The checks on what a start request holds, before anything is built from it. Every value that a plan prints is checked here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_REASONS, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, isRequestReason, MAX_VARIABLES } from '../src/request.js';

const ok = (value: unknown) => ({ ok: true, value });
const bad = (reason: string) => ({ ok: false, reason });

test('the request reasons are exactly these five, in this order, and each is recognised', () => {
  assert.deepEqual([...REQUEST_REASONS], ['engine', 'folder', 'model', 'variables', 'session']);
  for (const reason of REQUEST_REASONS) assert.equal(isRequestReason(reason), true, reason);
  for (const value of ['Engine', '', 'toString', '__proto__', undefined, null, 5]) assert.equal(isRequestReason(value), false, String(value));
});

test('an engine id is lower-case words joined by single hyphens, at most 64 characters', () => {
  for (const id of ['claude-code', 'codex', 'a1', 'a', 'fixture-engine-2', 'constructor', 'a'.repeat(64)]) assert.deepEqual(checkEngineId(id), ok(id), id);
  for (const id of ['', 'Codex', 'a_b', 'a--b', '-a', 'a-', '1a', ' a', 'a\n', 'a b', '__proto__', 'a'.repeat(65), 5, null, undefined, {}, [], ['a']]) assert.deepEqual(checkEngineId(id), bad('engine'), String(id));
});

test('a folder is an absolute, normal path with no control or format character, and it is never the root', () => {
  for (const folder of ['/work/alpha', '/a', '/work/with space', '/work/\u00fcn\u00ef', '/a/b.c/d', '/a\\b', '/x'.repeat(100)]) assert.deepEqual(checkFolder(folder), ok(folder), folder);
  const refused = ['', 'work', './a', '../a', '/', '/a/', '/a//b', '/a/./b', '/a/../b', '/a/..', '/a/.', '/a\nb', '/a\rb', '/a\u0000b', '/a\u202eb', '/a\u2028b', '/a\u2029b', '/a\u200bb', '/' + 'x'.repeat(1100), 'C:\\a', ' /a', '/a ', 5, null, undefined, {}, ['/a']];
  for (const folder of refused) assert.deepEqual(checkFolder(folder), bad('folder'), JSON.stringify(folder));
  assert.deepEqual(checkFolder('/' + 'x'.repeat(1023)), ok('/' + 'x'.repeat(1023)), 'a path of exactly 1,024 characters passes');
  assert.deepEqual(checkFolder('/' + 'x'.repeat(1024)), bad('folder'), 'a path of 1,025 characters is refused');
});

test('a model choice is null, or exactly a provider and a model, each a short plain text', () => {
  assert.deepEqual(checkModel(null), ok(null));
  assert.deepEqual(checkModel(undefined), ok(null));
  assert.deepEqual(checkModel({ provider: 'local-llama', model: 'qwen3 7b' }), ok({ provider: 'local-llama', model: 'qwen3 7b' }));
  assert.deepEqual(checkModel({ provider: 'p', model: 'm'.repeat(128) }), ok({ provider: 'p', model: 'm'.repeat(128) }));
  const inherited = Object.create({ provider: 'p', model: 'm' }) as object;
  const symbol = { provider: 'p', model: 'm', [Symbol('x')]: 1 };
  const refused: unknown[] = [
    [], 'x', 5, true, {}, { provider: 'p' }, { model: 'm' }, { provider: 'p', model: 'm', extra: 1 }, JSON.parse('{"provider":"p","model":"m","__proto__":1}') as unknown,
    { provider: '', model: 'm' }, { provider: 'p', model: '' }, { provider: 5, model: 'm' }, { provider: 'p', model: null }, { provider: 'p'.repeat(129), model: 'm' }, { provider: 'p', model: 'm'.repeat(129) },
    { provider: 'p\nq', model: 'm' }, { provider: 'p', model: 'm\u202e' }, { provider: ' p', model: 'm' }, { provider: 'p', model: 'm ' }, inherited, symbol,
    { get provider() { throw new Error('boom'); }, model: 'm' },
  ];
  refused.forEach((value, index) => assert.deepEqual(checkModel(value), bad('model'), `refused value ${index}`));
});

test('a model choice holds own data properties: a getter is refused unread, and a good choice comes back as a new frozen object', () => {
  let reads = 0;
  const source = { get provider() { reads += 1; return 'p'; }, get model() { reads += 1; return 'm'; } };
  assert.deepEqual(checkModel(source), bad('model'));
  assert.equal(reads, 0);
  const given = { provider: 'p', model: 'm' };
  const result = checkModel(given);
  assert.ok(result.ok);
  assert.notEqual(result.value, given);
  assert.equal(Object.isFrozen(result.value), true);
});

test('the variables are none, or a list of plain names with no repeat, sorted by the core', () => {
  assert.deepEqual(checkVariables(undefined), ok([]));
  assert.deepEqual(checkVariables([]), ok([]));
  assert.deepEqual(checkVariables(['B_2', 'A', '_c', '__proto__', 'constructor']), ok(['A', 'B_2', '__proto__', '_c', 'constructor']));
  const many = Array.from({ length: MAX_VARIABLES }, (_, index) => `V${String(index).padStart(2, '0')}`);
  assert.deepEqual(checkVariables(many), ok(many));
  assert.equal(MAX_VARIABLES, 32);
  const refused: unknown[] = [
    null, 'A', 5, {}, { length: 1, 0: 'A' }, [...many, 'V99'], ['A', 'A'], ['1A'], ['A-B'], ['A B'], ['A='], [''], ['A'.repeat(65)], [5], [null], ['A', undefined], [['A']],
    ['LD_PRELOAD'], ['LD_LIBRARY_PATH'], ['DYLD_INSERT_LIBRARIES'], ['DYLD_'], ['NODE_OPTIONS'], ['A\nB'], ['\u00c4'],
    // eslint-disable-next-line no-sparse-arrays
    ['A', , 'B'],
  ];
  for (const value of refused) assert.deepEqual(checkVariables(value), bad('variables'), JSON.stringify(value));
  assert.deepEqual(checkVariables(['A'.repeat(64)]), ok(['A'.repeat(64)]), 'a name of exactly 64 characters passes');
  assert.deepEqual(checkVariables(['ld_preload', 'Node_Options', 'NODE_PATH']), ok(['NODE_PATH', 'Node_Options', 'ld_preload']), 'only the exact loader names are refused');
});

test('the variables are copied: a caller that changes its list afterwards changes nothing, and the input is not sorted in place', () => {
  const input = ['B', 'A'];
  const result = checkVariables(input);
  assert.deepEqual(input, ['B', 'A']);
  assert.ok(result.ok);
  assert.notEqual(result.value, input);
  assert.equal(Object.isFrozen(result.value), true);
});

test('a session id is a short lower-case token, and anything else is a malformed request', () => {
  for (const id of ['s-0123456789abcdef', 'a', 'a-b-c', '0a', 'x'.repeat(64)]) assert.deepEqual(checkSessionId(id), ok(id), id);
  for (const id of ['', '-a', 'A', 'a b', 'a\n', 'a_b', '../x', 'x'.repeat(65), 5, null, undefined, {}, []]) assert.deepEqual(checkSessionId(id), bad('session'), String(id));
});
