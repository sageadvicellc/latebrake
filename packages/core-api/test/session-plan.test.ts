// The text of a session plan is a contract: the lines, their order, and the escape of every value. The expected lines are written out here by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSteps, stopSteps, type StartStepsInput } from '../src/session-plan.js';
import { escapeForPlan } from '../src/plan-text.js';

const BREAKS = new RegExp('[\\n\\r\\u2028\\u2029\\u202e]');
const BASE: StartStepsInput = {
  gauge: 'fixture-sessioner', engine: 'fixture-engine', title: 'Fixture Engine', program: '/usr/bin/fake', folder: '/work/alpha', model: null, billing: 'engine-plan', variables: ['HOME', 'PATH'], sharedWith: [],
};

test('a plain start plan reads exactly like this', () => {
  assert.deepEqual(startSteps(BASE), [
    'Gauge fixture-sessioner asks for a new session of the engine fixture-engine (Fixture Engine)',
    'program: /usr/bin/fake',
    'folder: /work/alpha',
    "model: the engine's own default, and the core picks none",
    'billing source: the plan of the engine itself, so the core bills no key',
    'variables passed: HOME, PATH',
    'the program gets these variables only, and it starts with an argument list and never through a shell',
    'the core never answers a permission prompt of the engine: you answer it yourself',
    'start the program in the folder, and keep the session until it stops or fails',
  ]);
});

test('a start plan with a model choice, a local billing source, no variables, and a shared folder reads exactly like this', () => {
  assert.deepEqual(startSteps({ ...BASE, model: { provider: 'local-llama', model: 'qwen-7b' }, billing: 'local', variables: [], sharedWith: ['fixture-other'] }), [
    'Gauge fixture-sessioner asks for a new session of the engine fixture-engine (Fixture Engine)',
    'program: /usr/bin/fake',
    'folder: /work/alpha',
    'model: local-llama qwen-7b, as the Gauge asks',
    'billing source: local, so no provider is billed',
    'variables passed: none',
    'the program gets these variables only, and it starts with an argument list and never through a shell',
    'the core never answers a permission prompt of the engine: you answer it yourself',
    "notice: fixture-other already runs in this folder, and two engines in one folder can overwrite each other's files",
    'a second approval is needed, for the shared folder',
    'start the program in the folder, and keep the session until it stops or fails',
  ]);
  const two = startSteps({ ...BASE, sharedWith: ['one', 'two'] });
  assert.ok(two.includes("notice: one, two already run in this folder, and two engines in one folder can overwrite each other's files"));
});

test('a stop plan reads exactly like this, for a first stop and for a session that is stopping already', () => {
  const input = { gauge: 'fixture-sessioner', session: 's-1', engine: 'fixture-engine', folder: '/work/alpha', force: false, ended: false, timeoutMs: 5000 };
  assert.deepEqual(stopSteps(input), [
    'Gauge fixture-sessioner asks to stop session s-1 of the engine fixture-engine',
    'folder: /work/alpha',
    'send the stop signal to the program and everything it started, and wait up to 5000 ms for them to go',
    'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
  assert.deepEqual(stopSteps({ ...input, force: true }), [
    'Gauge fixture-sessioner asks to stop session s-1 of the engine fixture-engine',
    'folder: /work/alpha',
    'the session is stopping already: send the kill signal, which the program cannot ignore, to the program and everything it started',
    'if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
  assert.deepEqual(stopSteps({ ...input, force: true, ended: true }), [
    'Gauge fixture-sessioner asks to stop session s-1 of the engine fixture-engine',
    'folder: /work/alpha',
    'the session has ended, but its program may still be running: send the kill signal again, which the program cannot ignore, to the program and everything it started',
    'the session keeps its state, and its place is free when the program has gone; if it does not go in time, the core refuses with ENGINE_STOP_TIMEOUT',
  ]);
});

test('every value is escaped, so no value can add or forge a line of the plan', () => {
  const hostile = 'x\n\u2028forged line\r\\\u202e';
  const escaped = 'x\\u{a}\\u{2028}forged line\\u{d}\\\\\\u{202e}';
  const lines = startSteps({ gauge: hostile, engine: hostile, title: hostile, program: hostile, folder: hostile, model: { provider: hostile, model: hostile }, billing: 'local', variables: [hostile], sharedWith: [hostile] });
  assert.equal(lines.length, 11);
  for (const line of lines) assert.equal(BREAKS.test(line), false, line);
  assert.equal(lines[0], `Gauge ${escaped} asks for a new session of the engine ${escaped} (${escaped})`);
  assert.equal(lines[1], `program: ${escaped}`);
  assert.equal(lines[2], `folder: ${escaped}`);
  assert.equal(lines[3], `model: ${escaped} ${escaped}, as the Gauge asks`);
  assert.equal(lines[5], `variables passed: ${escaped}`);
  assert.equal(lines[8], `notice: ${escaped} already runs in this folder, and two engines in one folder can overwrite each other's files`);
  const stop = stopSteps({ gauge: hostile, session: hostile, engine: hostile, folder: hostile, force: false, ended: false, timeoutMs: 1 });
  for (const line of stop) assert.equal(BREAKS.test(line), false, line);
  assert.equal(stop[0], `Gauge ${escaped} asks to stop session ${escaped} of the engine ${escaped}`);
  assert.equal(stop[1], `folder: ${escaped}`);
});

test('the look-alike spaces, the blank letters, and the combining marks are escaped in a plan, and the plain space and precomposed letters are not', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['a\u00a0b', 'a\\u{a0}b'], ['a\u3000b', 'a\\u{3000}b'], ['\u3164', '\\u{3164}'], ['\u2800', '\\u{2800}'], ['\u115f\u1160\uffa0', '\\u{115f}\\u{1160}\\u{ffa0}'],
    ['e\u0301', 'e\\u{301}'], ['a b', 'a b'], ['caf\u00e9', 'caf\u00e9'], ['\u202f', '\\u{202f}'],
  ];
  for (const [value, expected] of cases) assert.equal(escapeForPlan(value), expected, JSON.stringify(value));
  const lines = startSteps({ ...BASE, folder: '/work/a\u00a0b\u3164' });
  assert.equal(lines[2], 'folder: /work/a\\u{a0}b\\u{3164}');
});
