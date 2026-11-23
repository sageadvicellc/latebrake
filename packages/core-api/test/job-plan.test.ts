// The text of a job plan and of a run plan is a contract: the lines, their order, and the escape of every value. The expected lines are written out here by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobSteps, runSteps, type JobStepsInput, type RunStepsInput } from '../src/job-plan.js';
import { checkDefinition } from '../../jobs/src/definition.js';

const BREAKS = new RegExp('[\\n\\r\\u2028\\u2029\\u202e]');
function defined(extra: Record<string, unknown> = {}, taskText = 'Write the summary.') {
  const checked = checkDefinition({
    title: 'Morning review',
    sessions: [
      { label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: taskText, ...extra },
      { label: 'checker', engine: 'fixture-other', harness: 'strict-harness', folder: '/work/beta', model: { provider: 'local-llama', model: 'qwen-7b' }, task: 'Check it.' },
    ],
  });
  assert.ok(checked.ok);
  return checked.value;
}
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const CREATE: JobStepsInput = { kind: 'create', gauge: 'fixture-jobber', job: null, before: null, definition: defined(), baseHash: null, nextHash: HASH_B };

test('a create plan reads exactly like this', () => {
  assert.deepEqual(jobSteps(CREATE), [
    'Gauge fixture-jobber asks to create a job: Morning review',
    'the job holds 2 sessions',
    'session 1, writer: engine fixture-engine, harness plain-harness, folder /work/alpha, the model is the default of the engine',
    'task of session 1, 18 characters: Write the summary.',
    'session 2, checker: engine fixture-other, harness strict-harness, folder /work/beta, model local-llama qwen-7b',
    'task of session 2, 9 characters: Check it.',
    'a job is a saved definition: creating it starts no session, and a run needs a plan of its own',
    'the harness of each session is recorded and shown here, and nothing applies it to an engine yet',
    'the core makes the id of the job when you approve',
    `bind the change to job none and result ${HASH_B}`,
  ]);
});

test('an update plan names the job and the title that it replaces, shows the new title and both counts, and a delete plan says that runs go on', () => {
  const update = jobSteps({ kind: 'update', gauge: 'fixture-jobber', job: 'job-1', before: defined({}, 'Old.'), definition: defined(), baseHash: HASH_A, nextHash: HASH_B });
  assert.deepEqual(update.slice(0, 3), [
    'Gauge fixture-jobber asks to replace the job job-1, Morning review, with the job below',
    'new title: Morning review',
    'the job held 2 sessions and will hold 2 sessions',
  ]);
  assert.equal(update[update.length - 1], `bind the change to job ${HASH_A} and result ${HASH_B}`);
  assert.ok(update.includes('the job keeps its id, and a run that began already is not changed'));
  assert.ok(update.includes('the harness of each session is recorded and shown here, and nothing applies it to an engine yet'));
  assert.ok(!update.includes('the core makes the id of the job when you approve'));
  const one = checkDefinition({ title: 'Brand new title\u0301', sessions: [{ label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Do it.' }] });
  assert.ok(one.ok);
  const renamed = jobSteps({ kind: 'update', gauge: 'fixture-jobber', job: 'job-1', before: defined(), definition: one.value, baseHash: HASH_A, nextHash: HASH_B });
  assert.deepEqual(renamed.slice(0, 3), [
    'Gauge fixture-jobber asks to replace the job job-1, Morning review, with the job below',
    'new title: Brand new title\\u{301}',
    'the job held 2 sessions and will hold 1 session',
  ]);
  const remove = jobSteps({ kind: 'delete', gauge: 'fixture-jobber', job: 'job-1', before: defined(), definition: null, baseHash: HASH_A, nextHash: null });
  assert.deepEqual(remove, [
    'Gauge fixture-jobber asks to delete the job job-1, Morning review',
    'the job holds 2 sessions',
    'deleting a job stops no session: a run that began already goes on, and it keeps the title of the job',
    `bind the change to job ${HASH_A} and result none`,
  ]);
});

test('a task that is long shows its first 120 characters and the full count, and a task shows no line break', () => {
  const long = jobSteps({ ...CREATE, definition: defined({}, `${'x'.repeat(119)}\u{1F600}${'y'.repeat(50)}`) });
  assert.ok(long.includes(`task of session 1, 170 characters: ${'x'.repeat(119)}\u{1F600}...`), 'the cut is at 120 characters of text, never inside a character');
  const lines = jobSteps({ ...CREATE, definition: defined({}, 'one\ntwo\tthree') });
  assert.ok(lines.includes('task of session 1, 13 characters: one\\u{a}two\\u{9}three'));
  for (const line of jobSteps({ ...CREATE, definition: defined({}, 'a\nb') })) assert.doesNotMatch(line, BREAKS);
  const exact = jobSteps({ ...CREATE, definition: defined({}, 'z'.repeat(120)) });
  assert.ok(exact.includes(`task of session 1, 120 characters: ${'z'.repeat(120)}`), 'a task of exactly 120 characters is shown whole');
});

test('a value cannot add a line or forge one: the title, the folder, and the gauge are escaped', () => {
  const nasty = checkDefinition({ title: 'Plain', sessions: [{ label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/b\u0301 c', model: null, task: 'Do it.' }] });
  assert.ok(nasty.ok);
  const steps = jobSteps({ ...CREATE, gauge: 'g\u202e\nforged line', definition: nasty.value });
  for (const line of steps) assert.doesNotMatch(line, BREAKS);
  assert.equal(steps[0], 'Gauge g\\u{202e}\\u{a}forged line asks to create a job: Plain');
  assert.ok(steps.some(line => line.includes('folder /work/b\\u{301} c,')));
});

const SHARE = { sharedWith: [] as readonly string[] };
const RUN: RunStepsInput = {
  gauge: 'fixture-jobber', job: 'job-1', title: 'Morning review', shared: false,
  sessions: [
    { label: 'writer', engine: 'fixture-engine', engineTitle: 'Fixture Engine', harness: 'plain-harness', program: '/usr/bin/fake', folder: '/work/alpha', model: null, billing: 'engine-plan', variables: ['HOME'], ...SHARE, task: 'Write the summary.' },
    { label: 'checker', engine: 'fixture-other', engineTitle: 'Fixture Other', harness: 'strict-harness', program: '/usr/bin/other', folder: '/work/beta', model: { provider: 'local-llama', model: 'qwen-7b' }, billing: 'local', variables: [], ...SHARE, task: 'Check it.' },
  ],
};

test('a run plan reads exactly like this, with every session in the order of the job', () => {
  assert.deepEqual(runSteps(RUN), [
    'Gauge fixture-jobber asks to run the job job-1, Morning review: 2 sessions start together',
    'session 1 of 2, writer: the engine fixture-engine (Fixture Engine), harness plain-harness',
    'program: /usr/bin/fake',
    'folder: /work/alpha',
    "model: the engine's own default, and the core picks none",
    'billing source: the plan of the engine itself, so the core bills no key',
    'variables passed: HOME',
    'task of 18 characters: Write the summary.',
    'session 2 of 2, checker: the engine fixture-other (Fixture Other), harness strict-harness',
    'program: /usr/bin/other',
    'folder: /work/beta',
    'model: local-llama qwen-7b, as the job says',
    'billing source: local, so no provider is billed',
    'variables passed: none',
    'task of 9 characters: Check it.',
    'each program gets its variables only, and starts with an argument list and never through a shell',
    'the core never answers a permission prompt of an engine: you answer each yourself',
    'the core does not send a task to an engine: you give it in the pane of the engine',
    'the harness of each session is recorded and shown here, and nothing applies it to an engine yet',
    'the run waits until every session has said that it runs, and a session that has not said so when the start timeout of the host ends counts as failed',
    'if one session fails, or ends before it says it runs, the core stops the sessions that started and reports the first failure only; a session that cannot be stopped is left running, and you stop it yourself',
    'the run is interactive: you watch it, and nothing is scheduled and nothing runs unattended',
    'start every program in its folder at once, and keep each session until it stops or fails',
  ]);
});

test('a run plan with shared folders names the engines in each, and says that a second approval is needed once', () => {
  const steps = runSteps({
    ...RUN, shared: true,
    sessions: [{ ...RUN.sessions[0]!, sharedWith: ['fixture-other'] }, { ...RUN.sessions[1]!, sharedWith: ['fixture-engine', 'extra'] }],
  });
  assert.ok(steps.includes("notice for session 1: fixture-other also runs in this folder, and two engines in one folder can overwrite each other's files"));
  assert.ok(steps.includes("notice for session 2: fixture-engine, extra also run in this folder, and two engines in one folder can overwrite each other's files"));
  assert.equal(steps.filter(line => line === 'a second approval is needed, once for the whole run, for the shared folder').length, 1);
  const none = runSteps(RUN);
  assert.ok(!none.some(line => line.includes('second approval')));
});

test('every value of a run plan goes through the escape, and no line holds a break', () => {
  const steps = runSteps({
    ...RUN, gauge: 'g\nx', title: 'T x',
    sessions: [{ ...RUN.sessions[0]!, label: 'l', engineTitle: 'E\r\nF', program: '/p\nq', folder: '/f‮e', variables: ['A\nB'], task: 'a\nb‮c', sharedWith: ['s\nt'] }],
  });
  for (const line of steps) assert.doesNotMatch(line, BREAKS);
  assert.equal(steps[0], 'Gauge g\\u{a}x asks to run the job job-1, T\\u{2028}x: 1 session starts');
  assert.ok(steps.some(line => line.includes('program: /p\\u{a}q')));
  assert.ok(steps.some(line => line.includes('E\\u{d}\\u{a}F')));
});

test('a run of one session says so in the singular', () => {
  assert.equal(runSteps({ ...RUN, sessions: [RUN.sessions[0]!] })[0], 'Gauge fixture-jobber asks to run the job job-1, Morning review: 1 session starts');
  assert.equal(runSteps({ ...RUN, sessions: [RUN.sessions[0]!] })[1], 'session 1 of 1, writer: the engine fixture-engine (Fixture Engine), harness plain-harness');
});

test('a job of one session says so in the singular, in a create and in a delete', () => {
  const one = checkDefinition({ title: 'Solo', sessions: [{ label: 'writer', engine: 'fixture-engine', harness: 'plain-harness', folder: '/work/alpha', model: null, task: 'Do it.' }] });
  assert.ok(one.ok);
  assert.equal(jobSteps({ ...CREATE, definition: one.value })[1], 'the job holds 1 session');
  assert.equal(jobSteps({ kind: 'delete', gauge: 'g', job: 'job-1', before: one.value, definition: null, baseHash: HASH_A, nextHash: null })[1], 'the job holds 1 session');
});

test('a plan that is missing the definition or the job it needs is a bug of the caller, and throws, and never prints a blank title', () => {
  assert.throws(() => jobSteps({ ...CREATE, definition: null }), /definition/);
  assert.throws(() => jobSteps({ kind: 'update', gauge: 'g', job: 'job-1', before: defined(), definition: null, baseHash: HASH_A, nextHash: HASH_B }), /definition/);
  assert.throws(() => jobSteps({ kind: 'update', gauge: 'g', job: 'job-1', before: null, definition: defined(), baseHash: HASH_A, nextHash: HASH_B }), /job/);
  assert.throws(() => jobSteps({ kind: 'delete', gauge: 'g', job: 'job-1', before: null, definition: null, baseHash: HASH_A, nextHash: null }), /job/);
  assert.throws(() => jobSteps({ kind: 'delete', gauge: 'g', job: null, before: defined(), definition: null, baseHash: HASH_A, nextHash: null }), /id/);
});
