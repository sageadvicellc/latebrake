// What happens to the engines when the core process ends: they are killed, so a core that exits or is stopped leaves no engine behind. A core that is killed with SIGKILL cannot do this, and that is a known limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoLeaks, killWithTag, liveWithTag } from './leaks.js';
import { newTag, waitFor } from './support.js';

const PARENT = fileURLToPath(new URL('./launcher-parent.js', import.meta.url));

async function ends(mode: 'exit' | 'term' | 'int'): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  const tag = newTag();
  const parent = spawn(process.execPath, [PARENT, mode, tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = new Promise<{ code: number | null; signal: string | null }>(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
  let ready = false;
  parent.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) ready = true; });
  try {
    await waitFor(() => ready, 'the parent to run its engine');
    // In the mode `exit` the parent leaves at once, so there is nothing to wait for. A signal is sent only when the engine and its helper are both up.
    if (mode !== 'exit') await waitFor(() => liveWithTag(tag).length === 2, 'the engine and its helper');
    if (mode === 'term') parent.kill('SIGTERM');
    if (mode === 'int') parent.kill('SIGINT');
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
