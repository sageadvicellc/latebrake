// What happens to the engines when the core process ends: they are killed, so a core that exits or is stopped leaves no engine behind. A core that is killed with SIGKILL cannot do this, and that is a known limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoLeaks, killWithTag, liveWithTag } from './leaks.js';
import { newTag, waitFor } from './support.js';

const PARENT = fileURLToPath(new URL('./launcher-parent.js', import.meta.url));

async function ends(mode: 'exit' | 'term' | 'int' | 'hup' | 'quit'): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, mode, tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  let ready = false;
  parent.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) ready = true; });
  try {
    await waitFor(() => ready, 'the parent to run its engine');
    // `ready` means that the engine and its helper are both up. The tag is in the arguments of the parent too, so three processes hold it. In the mode `exit` the parent leaves at once, so the check below is of the state it left behind.
    if (mode !== 'exit') await waitFor(() => liveWithTag(tag).length === 3, 'the parent, its engine, and the helper of the engine');
    if (mode === 'term') parent.kill('SIGTERM');
    if (mode === 'int') parent.kill('SIGINT');
    if (mode === 'hup') parent.kill('SIGHUP');
    if (mode === 'quit') parent.kill('SIGQUIT');
    const ended = await result;
    await assertNoLeaks(tag, 3000);
    return ended;
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
}

test('a core that exits kills every engine it started', async () => {
  assert.deepEqual(await ends('exit'), { code: 0, signal: null });
});

test('a core that gets SIGTERM kills every engine, and then ends by the signal, as it would have without the handler', async () => {
  assert.deepEqual(await ends('term'), { code: null, signal: 'SIGTERM' });
});

test('a core that gets SIGINT kills every engine, and then ends by the signal', async () => {
  assert.deepEqual(await ends('int'), { code: null, signal: 'SIGINT' });
});

test('a core that gets SIGHUP or SIGQUIT kills every engine, and then ends by the signal', async () => {
  assert.deepEqual(await ends('hup'), { code: null, signal: 'SIGHUP' });
  assert.deepEqual(await ends('quit'), { code: null, signal: 'SIGQUIT' });
});

test('a core that calls exit in the same tick that it starts an engine leaves no engine: the group is known from the moment the program is made', async () => {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, 'immediate', tag], { stdio: 'ignore' });
  try {
    await new Promise<void>(resolve => parent.once('exit', () => resolve()));
    await assertNoLeaks(tag, 3000);
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
});

test('a core that has a signal listener of its own keeps its engines: the signal is the listener\'s, and the engines go when the core exits', async () => {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, 'own', tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const seen: string[] = [];
  parent.stdout.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line !== '') seen.push(line); });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => seen.includes('ready'), 'the first engine');
    parent.kill('SIGTERM');
    await waitFor(() => seen.includes('ready-second'), 'the second engine');
    assert.equal(parent.exitCode, null, 'the core is still alive, since a listener of its own took the signal');
    assert.equal(liveWithTag(tag).filter(item => !item.args.includes('launcher-parent')).length >= 4, true, 'both engines and both helpers are still up: the core left them to its own listener');
    parent.kill('SIGTERM');
    await waitFor(() => seen.includes('got:2'), 'the second signal');
    assert.equal(liveWithTag(tag).filter(item => !item.args.includes('launcher-parent')).length >= 4, true);
    parent.kill('SIGTERM');
    assert.deepEqual(await result, { code: 0, signal: null });
    await assertNoLeaks(tag, 3000);
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
});

test('two copies of the launcher module share one cover: a signal ends the core as it would have, and kills the engines of both', async () => {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, 'twice', tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  let ready = false;
  parent.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) ready = true; });
  try {
    await waitFor(() => ready, 'both engines');
    await waitFor(() => liveWithTag(tag).length === 5, 'the parent, two engines, and two helpers');
    parent.kill('SIGTERM');
    assert.deepEqual(await result, { code: null, signal: 'SIGTERM' });
    await assertNoLeaks(tag, 3000);
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
});

test('a listener that the core registered with once for SIGTERM runs to its end: the launcher does not take the signal from it', async () => {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, 'once', tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const seen: string[] = [];
  parent.stdout.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line !== '') seen.push(line); });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => seen.includes('ready'), 'the engine');
    parent.kill('SIGTERM');
    assert.deepEqual(await result, { code: 0, signal: null });
    assert.deepEqual(seen.filter(line => line !== 'ready'), ['flushing', 'flushed']);
    await assertNoLeaks(tag, 3000);
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
});

test('a core with its own SIGHUP listener keeps its engines alive when it gets SIGHUP', async () => {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, 'hup-app', tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const seen: string[] = [];
  parent.stdout.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line !== '') seen.push(line); });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => seen.includes('ready'), 'the engine');
    parent.kill('SIGHUP');
    await waitFor(() => seen.includes('hup'), 'the listener of the core');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(parent.exitCode, null);
    assert.equal(liveWithTag(tag).length, 3, 'the parent, the engine, and its helper are all alive');
    parent.kill('SIGTERM');
    assert.deepEqual(await result, { code: null, signal: 'SIGTERM' });
    await assertNoLeaks(tag, 3000);
  } finally {
    parent.kill('SIGKILL');
    killWithTag(tag);
  }
});
