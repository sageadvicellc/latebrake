// The process launcher: lines, no shell, the environment, no standard input, the process group, and the orphan detector that guards them all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CLOSE_GRACE_MS, MAX_LINE_CHARS, STDERR_TAIL_CHARS, createProcessLauncher, killLiveGroups, lineSplitter } from '../src/process-launcher.js';
import { FAKE_ENGINE_PROGRAM, type FakeStep } from '../src/fixtures.js';
import type { Launched } from '../src/launcher.js';
import { assertNoDescendants, assertNoLeaks, killWithTag, leavesBehind, liveDescendants, liveWithTag } from './leaks.js';
import { newTag, waitFor } from './support.js';

/** Runs a fake engine to its end through the process launcher, and gives what it wrote and how it ended. */
async function run(steps: readonly FakeStep[], tag: string, extra: readonly string[] = [], env: Record<string, string> = {}) {
  const lines: string[] = [];
  let ended: { code: number | null; signal: string | null } | undefined;
  let tail: string | undefined;
  const handle = createProcessLauncher().launch({ program: process.execPath, args: [FAKE_ENGINE_PROGRAM, '--tag', tag, '--script', JSON.stringify(steps), ...extra], cwd: process.cwd(), env });
  handle.onLine(line => lines.push(line));
  handle.onExit((code, signal, stderrTail) => { ended = { code, signal }; tail = stderrTail; });
  await waitFor(() => ended !== undefined, 'the program to end');
  return { lines, ended, handle, tail };
}

function splitting(chunks: readonly string[]): string[] {
  const lines: string[] = [];
  const split = lineSplitter(line => lines.push(line));
  for (const chunk of chunks) split.push(Buffer.from(chunk));
  split.end();
  return lines;
}

test('lines split on a line feed, a carriage return before it is dropped, and a last line without a line feed is kept', () => {
  assert.deepEqual(splitting(['one\ntwo\r\nthree']), ['one', 'two', 'three']);
  assert.deepEqual(splitting(['a\n', '\n', 'b\n']), ['a', '', 'b']);
  assert.deepEqual(splitting([]), []);
  assert.deepEqual(splitting(['x\n']), ['x']);
});

test('a line that arrives in pieces, even in the middle of a multi-byte character, comes out whole', () => {
  const bytes = Buffer.from('café \u{1F680}\nnext\n');
  const lines: string[] = [];
  const split = lineSplitter(line => lines.push(line));
  for (const byte of bytes) split.push(Buffer.from([byte]));
  split.end();
  assert.deepEqual(lines, ['café \u{1F680}', 'next']);
});

test('a line longer than 4,096 characters is cut once, and the rest of it is dropped up to the next line feed', () => {
  assert.equal(MAX_LINE_CHARS, 4096);
  const long = 'x'.repeat(10_000);
  assert.deepEqual(splitting([`${long}\nshort\n`]), ['x'.repeat(4096), 'short']);
  assert.deepEqual(splitting([long.slice(0, 5000), long.slice(5000), '\nshort\n']), ['x'.repeat(4096), 'short']);
  assert.deepEqual(splitting(['y'.repeat(4096), '\nz\n']), ['y'.repeat(4096), 'z'], 'a line of exactly 4,096 characters is kept whole');
  assert.deepEqual(splitting(['y'.repeat(4097), '\nz\n']), ['y'.repeat(4096), 'z']);
});

test('the launcher gives the lines a program writes, then its exit code, and the program ran in the folder it was given', async () => {
  const tag = newTag();
  try {
    const { lines, ended } = await run([{ say: 'hello' }, { printCwd: true }, { exit: 3 }], tag);
    assert.deepEqual(lines, ['hello', `cwd:${process.cwd()}`]);
    assert.deepEqual(ended, { code: 3, signal: null });
  } finally {
    await assertNoLeaks(tag);
  }
});

test('the program gets exactly the environment it was given, and nothing from this process', async () => {
  const tag = newTag();
  process.env['LEAK_CANARY'] = 'must-not-pass';
  try {
    const { lines } = await run([{ printEnv: true }], tag, [], { ONE: '1', TWO: 'two' });
    assert.deepEqual(lines, [`env:${JSON.stringify({ ONE: '1', TWO: 'two' })}`]);
  } finally {
    delete process.env['LEAK_CANARY'];
    await assertNoLeaks(tag);
  }
});

test('arguments are passed as a list and never through a shell: a shell word in an argument stays a plain word', async () => {
  const tag = newTag();
  const hostile = ['; echo pwned', '$(echo pwned)', '`echo pwned`', '| cat', '> /dev/null', "'quoted'", '*', 'two words'];
  try {
    const { lines } = await run([{ printArgs: true }], tag, hostile);
    assert.equal(lines.length, 1);
    const printed = JSON.parse((lines[0] ?? '').slice('args:'.length)) as string[];
    assert.deepEqual(printed.slice(-hostile.length), hostile);
  } finally {
    await assertNoLeaks(tag);
  }
});

test('the program has no standard input: it reads nothing, so the host can never answer a prompt', async () => {
  const tag = newTag();
  try {
    const { lines, ended } = await run([{ readStdin: true }], tag);
    assert.deepEqual(lines, ['stdin:0']);
    assert.deepEqual(ended, { code: 0, signal: null });
  } finally {
    await assertNoLeaks(tag);
  }
});

test('a program that is not there gives an error and no exit', async () => {
  let error: Error | undefined, exits = 0, spawns = 0;
  const handle = createProcessLauncher().launch({ program: '/no/such/program/anywhere', args: [], cwd: process.cwd(), env: {} });
  handle.onError(found => { error = found; });
  handle.onExit(() => { exits += 1; });
  handle.onSpawn(() => { spawns += 1; });
  await waitFor(() => error !== undefined, 'the error');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(error?.message ?? '', /ENOENT/);
  assert.equal(exits, 0);
  assert.equal(spawns, 0);
});

test('a folder that is not there is an error too, and the program never runs', async () => {
  let error: Error | undefined;
  const handle = createProcessLauncher().launch({ program: process.execPath, args: ['-e', ''], cwd: '/no/such/folder/anywhere', env: {} });
  handle.onError(found => { error = found; });
  await waitFor(() => error !== undefined, 'the error');
  assert.match(error?.message ?? '', /ENOENT/);
});

test('a term signal reaches the program and its helper, and both are gone after', async () => {
  const tag = newTag();
  try {
    const lines: string[] = [];
    let ended = false;
    const handle: Launched = createProcessLauncher().launch({ program: process.execPath, args: [FAKE_ENGINE_PROGRAM, '--tag', tag, '--script', JSON.stringify([{ spawnChild: true }, { say: 'ready' }, { hold: true }])], cwd: process.cwd(), env: {} });
    handle.onLine(line => lines.push(line));
    handle.onExit(() => { ended = true; });
    await waitFor(() => lines.includes('ready'), 'the engine to be ready');
    assert.equal(liveWithTag(tag).length, 2, 'the engine and its helper are alive');
    handle.signal('term');
    await waitFor(() => ended, 'the exit');
    assert.deepEqual(await leavesBehind(tag), []);
  } finally {
    await assertNoLeaks(tag);
  }
});

test('when the program ends on its own, the helper it left behind is killed, so no orphan is left', async () => {
  const tag = newTag();
  try {
    const { ended } = await run([{ spawnChild: true }, { sleep: 100 }, { exit: 0 }], tag);
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.deepEqual(await leavesBehind(tag), []);
  } finally {
    await assertNoLeaks(tag);
  }
});

test('a signal that ends the program is reported as the signal, with no exit code', async () => {
  const tag = newTag();
  try {
    const { ended } = await run([{ crash: 'SIGABRT' }], tag);
    assert.deepEqual(ended, { code: null, signal: 'SIGABRT' });
  } finally {
    await assertNoLeaks(tag);
  }
});

test('a signal sent after the program has gone does nothing and does not throw', async () => {
  const tag = newTag();
  try {
    const { handle } = await run([{ say: 'x' }], tag);
    assert.doesNotThrow(() => { handle.signal('term'); handle.signal('kill'); });
  } finally {
    await assertNoLeaks(tag);
  }
});

test('the orphan detector finds a process that was deliberately left running, and finds nothing once the test has killed it', async () => {
  const tag = newTag();
  assert.deepEqual(liveWithTag(tag), [], 'nothing runs with a new tag');
  // A fake engine started by hand, outside any host, and left running on purpose.
  const leaked = spawn(process.execPath, [FAKE_ENGINE_PROGRAM, '--tag', tag, '--script', JSON.stringify([{ hold: true }])], { stdio: 'ignore', detached: true });
  const exited = new Promise<void>(resolve => leaked.once('exit', () => resolve()));
  try {
    assert.ok(leaked.pid !== undefined);
    await waitFor(() => liveWithTag(tag).length === 1, 'the leaked process to show');
    const found = liveWithTag(tag);
    assert.deepEqual(found.map(item => item.pid), [leaked.pid], 'the detector names the process by its pid');
    assert.ok(found[0]?.args.includes(tag));
    await assert.rejects(assertNoLeaks(tag, 100), /a process was left behind: \d+ /, 'assertNoLeaks fails when a process is left');
  } finally {
    // The test kills what it leaked on purpose, so the proof leaves nothing behind.
    leaked.kill('SIGKILL');
    killWithTag(tag);
    await exited;
  }
  assert.deepEqual(await leavesBehind(tag), [], 'after the kill the detector finds nothing');
});

test('the last 2,048 characters of standard error come with the exit, and a short standard error comes whole', async () => {
  assert.equal(STDERR_TAIL_CHARS, 2048);
  const tag = newTag();
  try {
    const small = await run([{ stderr: 'one\ntwo\n' }], tag);
    assert.equal(small.tail, 'one\ntwo\n');
    const big = await run([{ stderr: `${'x'.repeat(5000)}END` }], tag);
    assert.equal(big.tail?.length, 2048);
    assert.equal(big.tail?.endsWith('xxxEND'), true);
    assert.equal(big.tail?.startsWith('x'), true);
    const none = await run([{ say: 'quiet' }], tag);
    assert.equal(none.tail, '');
  } finally {
    await assertNoLeaks(tag);
  }
});

test('the end of standard error never starts in the middle of a character: a lone half of a pair is dropped, and a character cut off at the end is not lost silently', async () => {
  const tag = newTag();
  try {
    const cut = await run([{ stderr: `\u{1F600}${'y'.repeat(2047)}` }], tag);
    assert.equal(cut.tail, 'y'.repeat(2047), 'the cut falls inside the pair, so the low half is dropped');
    const whole = await run([{ stderr: `${'x'.repeat(5)}\u{1F600}` }], tag);
    assert.equal(whole.tail, `${'x'.repeat(5)}\u{1F600}`);
    const truncated = await run([{ stderrHex: '6f6bf09f98' }], tag);
    assert.equal(truncated.tail, 'ok\ufffd', 'a character cut off at the end of the stream is flushed as the replacement character');
  } finally {
    await assertNoLeaks(tag);
  }
});

test('standard error is drained: a program that writes two megabytes to it still ends', async () => {
  const tag = newTag();
  try {
    const { ended, tail } = await run([{ stderrBytes: 2_000_000 }, { say: 'done' }], tag);
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.equal(tail?.length, 2048);
  } finally {
    await assertNoLeaks(tag);
  }
});

test('a helper that left the group and holds the output pipe cannot hold the exit: it is reported after the grace, and the helper is out of reach', async () => {
  assert.equal(CLOSE_GRACE_MS, 500);
  const tag = newTag();
  try {
    const began = Date.now();
    const { ended, lines } = await run([{ spawnEscapedHolding: true }, { say: 'last' }, { exit: 0 }], tag);
    const took = Date.now() - began;
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.equal(lines.includes('last'), true, 'the output that came before the exit is not lost');
    assert.ok(took >= CLOSE_GRACE_MS - 50, `the exit waited for the output to close: ${took} ms`);
    assert.ok(took < 4000, `and did not wait for ever: ${took} ms`);
    assert.equal(liveWithTag(tag).length, 1, 'the helper left the group, so no signal to the group reached it: this is a known limit');
  } finally {
    killWithTag(tag);
    await assertNoLeaks(tag);
  }
});

test('a helper that left the group without holding the pipe also survives the program, and the detector finds it', async () => {
  const tag = newTag();
  try {
    await run([{ spawnEscaped: true }, { say: 'x' }, { exit: 0 }], tag);
    await waitFor(() => liveWithTag(tag).length === 1, 'the escaped helper to show');
    assert.equal(liveWithTag(tag).length, 1);
  } finally {
    killWithTag(tag);
    await assertNoLeaks(tag);
  }
});

test('killLiveGroups kills every program that is still running, at once, and reports each as a signal exit', async () => {
  const tag = newTag();
  try {
    const exits: (string | null)[] = [];
    const launcher = createProcessLauncher();
    for (let index = 0; index < 2; index += 1) {
      const handle = launcher.launch({ program: process.execPath, args: [FAKE_ENGINE_PROGRAM, '--tag', tag, '--script', JSON.stringify([{ spawnChild: true }, { hold: true }])], cwd: process.cwd(), env: {} });
      handle.onExit((_code, signal) => { exits.push(signal); });
    }
    await waitFor(() => liveWithTag(tag).length === 4, 'two programs and two helpers');
    killLiveGroups();
    await waitFor(() => exits.length === 2, 'both exits');
    assert.deepEqual(exits, ['SIGKILL', 'SIGKILL']);
    assert.deepEqual(await leavesBehind(tag), []);
    assert.doesNotThrow(() => killLiveGroups(), 'nothing is left, so it does nothing');
  } finally {
    await assertNoLeaks(tag);
  }
});

test('the orphan detector finds a leaked process by its parent links alone, with no tag in its arguments', async () => {
  const { spawn: start } = await import('node:child_process');
  const parent = start(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  try {
    await waitFor(() => liveDescendants(process.pid).length === 2, 'the untagged parent and its child to show');
    const found = liveDescendants(process.pid);
    assert.equal(found.some(item => item.pid === parent.pid), true, 'the child of this process');
    assert.equal(found.some(item => item.pid !== parent.pid), true, 'and its own child, one level down');
    assert.equal(found.some(item => /^ps\s/.test(item.args)), false, 'the ps that lists them is not one of them');
    await assert.rejects(assertNoDescendants(100), /a child process was left behind: \d+ /);
  } finally {
    parent.kill('SIGKILL');
    for (const { pid } of liveDescendants(process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  await assertNoDescendants(2000);
});

test('a kill that fails for a reason other than the group being gone goes to the log channel, and a group that is gone does not', async () => {
  const tag = newTag();
  const messages: string[] = [];
  const kill = process.kill;
  const launcher = createProcessLauncher({ log: message => messages.push(message) });
  const handle = launcher.launch({ program: process.execPath, args: [FAKE_ENGINE_PROGRAM, '--tag', tag, '--script', JSON.stringify([{ hold: true }])], cwd: process.cwd(), env: {} });
  let ended = false;
  handle.onExit(() => { ended = true; });
  try {
    await waitFor(() => liveWithTag(tag).length === 1, 'the program');
    for (const code of ['EPERM', 'ESRCH']) {
      process.kill = ((pid: number, signal?: string | number) => { if (pid < 0) throw Object.assign(new Error(`kill ${code}`), { code }); return kill(pid, signal); }) as typeof process.kill;
      handle.signal('term');
    }
    process.kill = kill;
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /could not send SIGTERM to the group of the program: EPERM/);
  } finally {
    process.kill = kill;
    handle.signal('kill');
    await waitFor(() => ended, 'the exit');
    await assertNoLeaks(tag);
  }
});
