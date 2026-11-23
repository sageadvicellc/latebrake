// The checks on what a start request holds, before anything is built from it. Every value that a plan prints is checked here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_REASONS, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, isRequestReason, isRefusedVariable, readList, MAX_VARIABLES } from '../src/request.js';

const ok = (value: unknown) => ({ ok: true, value });
const bad = (reason: string) => ({ ok: false, reason });
const bad_ = bad;

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
  assert.deepEqual(checkModel({ provider: 'local-llama', model: 'qwen3-7b' }), ok({ provider: 'local-llama', model: 'qwen3-7b' }));
  assert.deepEqual(checkModel({ provider: 'p', model: 'm'.repeat(128) }), ok({ provider: 'p', model: 'm'.repeat(128) }));
  const inherited = Object.create({ provider: 'p', model: 'm' }) as object;
  const symbol = { provider: 'p', model: 'm', [Symbol('x')]: 1 };
  const refused: unknown[] = [
    [], 'x', 5, true, {}, { provider: 'p' }, { model: 'm' }, { provider: 'p', model: 'm', extra: 1 }, JSON.parse('{"provider":"p","model":"m","__proto__":1}') as unknown,
    { provider: '', model: 'm' }, { provider: 'p', model: '' }, { provider: 5, model: 'm' }, { provider: 'p', model: null }, { provider: 'p'.repeat(129), model: 'm' }, { provider: 'p', model: 'm'.repeat(129) },
    { provider: 'p\nq', model: 'm' }, { provider: 'p', model: 'two words' }, { provider: 'p', model: 'm;rm' }, { provider: 'p', model: 'm$(x)' }, { provider: 'p', model: '--flag' }, { provider: '-p', model: 'm' },
    { provider: 'p', model: '=m' }, { provider: 'p', model: 'm"q' }, { provider: 'p', model: 'm\\q' }, { provider: 'p', model: 'm`x`' }, { provider: 'p', model: 'caf\u00e9' }, { provider: 'p', model: 'm|n' }, { provider: 'p', model: 'm\u202e' }, { provider: ' p', model: 'm' }, { provider: 'p', model: 'm ' }, inherited, symbol,
    { get provider() { throw new Error('boom'); }, model: 'm' },
  ];
  refused.forEach((value, index) => assert.deepEqual(checkModel(value), bad('model'), `refused value ${index}`));
});

test('a model choice uses a plain charset: letters, digits, and . _ : / @ + - only, and its first character is a letter or a digit', () => {
  for (const model of ['gpt-4.1', 'claude-sonnet-4-5', 'org/model:tag@v1+x', 'A_b.c', 'a'.repeat(128), '9']) assert.deepEqual(checkModel({ provider: 'p', model }), ok({ provider: 'p', model }), model);
  for (const bad of ['-x', '=x', '@x', '+x', '/x', '.x', ':x', '_x', '.hidden', '/abs/path', ':1', '@org/model', '+1', '--model', ' x', 'x ', 'a b', "a'b", 'a#b', 'a%b', 'a&b', 'a*b', 'a?b', 'a~b', 'a<b', 'a>b', 'a(b', 'a,b', 'a!b', 'a{b', 'a[b']) {
    assert.deepEqual(checkModel({ provider: 'p', model: bad }), bad_('model'), bad);
    assert.deepEqual(checkModel({ provider: bad, model: 'm' }), bad_('model'), `provider ${bad}`);
  }
  assert.deepEqual(checkModel({ provider: 'p', model: 'x'.repeat(129) }), bad_('model'));
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
    ['BASH_ENV'], ['ENV'], ['PYTHONSTARTUP'], ['PYTHONPATH'], ['PERL5OPT'], ['PERL5LIB'], ['RUBYOPT'], ['RUBYLIB'], ['JAVA_TOOL_OPTIONS'], ['_JAVA_OPTIONS'], ['NODE_PATH'], ['SSL_CERT_FILE'], ['SSL_CERT_DIR'], ['PATH'],
    ['ld_preload'], ['Node_Options'], ['path'], ['Path'], ['bash_env'], ['dyld_insert_libraries'],
    // eslint-disable-next-line no-sparse-arrays
    ['A', , 'B'],
  ];
  for (const value of refused) assert.deepEqual(checkVariables(value), bad('variables'), JSON.stringify(value));
  assert.deepEqual(checkVariables(['A'.repeat(64)]), ok(['A'.repeat(64)]), 'a name of exactly 64 characters passes');
  assert.deepEqual(checkVariables(['HOME', 'MY_PATH', 'PATHS', 'ENVIRON', 'LDX', 'NODE', 'API_KEY']), ok(['API_KEY', 'ENVIRON', 'HOME', 'LDX', 'MY_PATH', 'NODE', 'PATHS']), 'a name that only contains or resembles a refused one is fine');
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

test('the refused names are a denylist, and it is exactly this: the loader prefixes and these names, in any case', () => {
  const refused = ['LD_X', 'DYLD_X', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'NODE_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PATH'];
  for (const name of refused) {
    assert.equal(isRefusedVariable(name), true, name);
    assert.equal(isRefusedVariable(name.toLowerCase()), true, name.toLowerCase());
  }
  for (const name of ['HOME', 'USER', 'LANG', 'TERM', 'EDITOR', 'LDX', 'PATHX', 'MYENV', 'NODE', 'XDG_CONFIG_HOME']) assert.equal(isRefusedVariable(name), false, name);
});

test('a list is read once, by index, from own data properties: an iterator, a subclass, an accessor, a hole, and a proxy that lies are not followed', () => {
  assert.deepEqual(readList(['A', 'B']), ['A', 'B']);
  assert.deepEqual(readList([]), []);
  const iterating = ['A'];
  Object.defineProperty(iterating, Symbol.iterator, { value: function* () { for (let i = 0; i < 100; i += 1) yield `N${i}`; } });
  assert.deepEqual(readList(iterating), ['A'], 'the iterator of the list is never used');
  class Sub extends Array {}
  assert.equal(readList(Sub.from(['A'])), undefined, 'a subclass is refused');
  const accessor: unknown[] = ['A'];
  Object.defineProperty(accessor, 0, { get() { return 'A'; }, enumerable: true });
  assert.equal(readList(accessor), undefined, 'an accessor index is refused, unread');
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(readList(['A', , 'B']), undefined, 'a hole is refused');
  assert.equal(readList('A'), undefined);
  assert.equal(readList({ length: 1, 0: 'A' }), undefined);
  assert.equal(readList(new Proxy(['A'], { getOwnPropertyDescriptor() { throw new Error('boom'); } })), undefined, 'a proxy that throws is refused');
  assert.equal(readList(['A', 'B', 'C'], 2), undefined, 'a list over the cap is refused before any item is read');
  const copy = ['A'];
  assert.notEqual(readList(copy), copy);
});

test('the variables are read by index: an iterator, a subclass, an accessor, and a list of 100 names with a short length are not followed', () => {
  const iterating = ['A'];
  Object.defineProperty(iterating, Symbol.iterator, { value: function* () { for (let i = 0; i < 100; i += 1) yield `N${i}`; } });
  assert.deepEqual(checkVariables(iterating), ok(['A']));
  class Sub extends Array {}
  assert.deepEqual(checkVariables(Sub.from(['A'])), bad('variables'));
  const accessor: unknown[] = ['A'];
  Object.defineProperty(accessor, 0, { get() { return 'A'; }, enumerable: true });
  assert.deepEqual(checkVariables(accessor), bad('variables'));
  assert.deepEqual(checkVariables(Array.from({ length: 100 }, (_, i) => `N${i}`)), bad('variables'));
});
