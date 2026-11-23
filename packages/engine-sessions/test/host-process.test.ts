// The host with real processes: the scriptable fake engine is started as a child process, and every test ends by proving that no process of the test is left behind.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineHost, type EngineHost, type HostOptions } from '../src/host.js';
import { fakeEngine, type FakeStep } from '../src/fixtures.js';
import { createProcessLauncher } from '../src/process-launcher.js';
import { assertNoDescendants, assertNoLeaks, killWithTag, liveWithTag } from './leaks.js';
import { newTag, recording, waitFor } from './support.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sessions-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const folder = (name: string): string => { const full = path.join(root, name); fs.mkdirSync(full, { recursive: true }); return full; };

/** Runs a test body with a host over the process launcher. The body gets the host and the tag. At the end every process is killed, and any that stays alive fails the test. */
async function withHost(engines: readonly (readonly [string, readonly FakeStep[], Partial<Parameters<typeof fakeEngine>[0]>?])[], options: Partial<HostOptions>, body: (host: EngineHost, tag: string, launcher: ReturnType<typeof recording>) => Promise<void>): Promise<void> {
  const tag = newTag();
  const launcher = recording(createProcessLauncher());
  const host = createEngineHost({ engines: engines.map(([id, steps, extra]) => fakeEngine({ id, tag, steps, ...(extra ?? {}) })), launcher, ...options });
  try {
    await body(host, tag, launcher);
    // Before anything is killed: a process that lives behind a session that has ended is a leak of the host, and it must fail the test, not be hidden by the clean-up below.
    const live = host.list().filter(item => item.state !== 'stopped' && item.state !== 'failed').length;
    if (live === 0) await assertNoLeaks(tag, 1000);
  } finally {
    const survivors = await host.killAll();
    await assertNoLeaks(tag);
    await assertNoDescendants();
    assert.equal(survivors, 0, 'a program survived the kill signal');
  }
}
async function begin(host: EngineHost, engine: string, dir: string, extra: Record<string, unknown> = {}, sharedApproved = false): Promise<string> {
  const planned = host.planStart({ engine, folder: dir, ...extra });
  assert.ok(planned.ok, JSON.stringify(planned));
  const begun = host.beginStart(planned.plan, { sharedApproved });
  assert.ok(begun.ok, JSON.stringify(begun));
  const settled = await begun.settled;
  assert.ok(settled.ok, JSON.stringify(settled));
  return begun.session;
}
const state = (host: EngineHost, id: string) => host.get(id)?.state;

test('a real engine starts in its folder, the session reads running from its own line, and the engine got a clean environment', async () => {
  const dir = folder('alpha');
  process.env['SHOULD_NOT_PASS'] = 'secret';
  try {
    await withHost([['alpha', [{ printCwd: true }, { printEnv: true }, { say: 'state:running' }, { hold: true }], { env: ['ALLOWED_BY_ENGINE'] }]], {
      environment: () => ({ ALLOWED_BY_ENGINE: 'one', ALLOWED_BY_PERSON: 'two', NOT_ALLOWED: 'three', SHOULD_NOT_PASS: 'secret' }),
    }, async (host, _tag, launcher) => {
      const id = await begin(host, 'alpha', dir, { variables: ['ALLOWED_BY_PERSON', 'MISSING_VARIABLE'] });
      await waitFor(() => state(host, id) === 'running', 'the session to run');
      assert.deepEqual(launcher.lines[0], [`cwd:${dir}`, `env:${JSON.stringify({ ALLOWED_BY_ENGINE: 'one', ALLOWED_BY_PERSON: 'two' })}`, 'state:running']);
    });
  } finally {
    delete process.env['SHOULD_NOT_PASS'];
  }
});

test('with no environment given, variables pass from the environment of this process', async () => {
  const dir = folder('default-env');
  process.env['ENGINE_SESSIONS_DEFAULT_ENV'] = 'from-this-process';
  try {
    await withHost([['alpha', [{ printEnv: true }, { say: 'state:running' }, { hold: true }], { env: ['ENGINE_SESSIONS_DEFAULT_ENV', 'ENGINE_SESSIONS_NOT_SET'] }]], {}, async (host, _tag, launcher) => {
      const id = await begin(host, 'alpha', dir);
      await waitFor(() => state(host, id) === 'running', 'running');
      assert.deepEqual(launcher.lines[0]?.[0], `env:${JSON.stringify({ ENGINE_SESSIONS_DEFAULT_ENV: 'from-this-process' })}`);
    });
  } finally {
    delete process.env['ENGINE_SESSIONS_DEFAULT_ENV'];
  }
});

test('a model choice reaches the engine as an argument, and the engine is started with an argument list', async () => {
  const dir = folder('model');
  await withHost([['alpha', [{ printArgs: true }, { say: 'state:running' }, { hold: true }], { takesModel: true }]], {}, async (host, tag, launcher) => {
    const id = await begin(host, 'alpha', dir, { model: { provider: 'local-llama', model: 'qwen3-7b' } });
    await waitFor(() => state(host, id) === 'running', 'running');
    const printed = JSON.parse((launcher.lines[0]?.[0] ?? '').slice('args:'.length)) as string[];
    assert.deepEqual(printed, ['--tag', tag, '--script', JSON.stringify([{ printArgs: true }, { say: 'state:running' }, { hold: true }]), '--model', 'local-llama/qwen3-7b']);
  });
});

test('the engine can read no input, so the core never answers a prompt of the engine, and the session waits for the person', async () => {
  const dir = folder('prompt');
  await withHost([['alpha', [{ say: 'state:waiting' }, { readStdin: true }, { hold: true }]]], {}, async (host, _tag, launcher) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => launcher.lines[0]?.includes('stdin:0') === true, 'the engine to read its input');
    assert.equal(state(host, id), 'waiting');
  });
});

test('a stop asks the engine to go, and the session is stopped with the process gone', async () => {
  const dir = folder('stop');
  await withHost([['alpha', [{ say: 'state:running' }, { hold: true }]]], {}, async (host, tag) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => state(host, id) === 'running', 'running');
    assert.equal(liveWithTag(tag).length, 1);
    const stopped = await host.stop(id);
    assert.ok(stopped.ok);
    assert.equal(stopped.info.state, 'stopped');
    assert.deepEqual(liveWithTag(tag), []);
    assert.equal(host.get(id)?.failure, null);
  });
});

test('a stop that times out leaves the session stopping with the process alive, and a second stop kills it', async () => {
  const dir = folder('stubborn');
  await withHost([['alpha', [{ ignoreTerm: true }, { say: 'state:running' }, { hold: true }]]], { stopTimeoutMs: 250 }, async (host, tag) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => state(host, id) === 'running', 'running');
    assert.deepEqual(await host.stop(id), { ok: false, code: 'ENGINE_STOP_TIMEOUT' });
    assert.equal(state(host, id), 'stopping');
    assert.equal(liveWithTag(tag).length, 1, 'the engine ignored the signal and is alive');
    const forced = await host.stop(id);
    assert.ok(forced.ok);
    assert.equal(forced.info.state, 'stopped');
    assert.deepEqual(liveWithTag(tag), []);
  });
});

test('a stop reaches the helper that the engine started, so no orphan is left', async () => {
  const dir = folder('helper');
  await withHost([['alpha', [{ spawnChild: true }, { say: 'state:running' }, { hold: true }]]], {}, async (host, tag) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => state(host, id) === 'running', 'running');
    assert.equal(liveWithTag(tag).length, 2);
    assert.ok((await host.stop(id)).ok);
    await assertNoLeaks(tag);
  });
});

test('an engine that ends on its own leaves no helper behind', async () => {
  const dir = folder('ends');
  await withHost([['alpha', [{ spawnChild: true }, { say: 'state:running' }, { sleep: 80 }, { exit: 0 }]]], {}, async (host, tag) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => state(host, id) === 'stopped', 'stopped');
    await assertNoLeaks(tag);
  });
});

test('a crash by signal fails the session with crashed, and an error code does too', async () => {
  await withHost([['alpha', [{ say: 'state:running' }, { sleep: 50 }, { crash: 'SIGABRT' }]], ['beta', [{ say: 'state:running' }, { sleep: 50 }, { exit: 7 }]]], {}, async (host) => {
    const one = await begin(host, 'alpha', folder('crash-one')), two = await begin(host, 'beta', folder('crash-two'));
    await waitFor(() => state(host, one) === 'failed' && state(host, two) === 'failed', 'both to fail');
    assert.deepEqual([host.get(one)?.failure, host.get(two)?.failure], ['crashed', 'crashed']);
  });
});

test('an engine that ends before it says it runs is a failed start', async () => {
  await withHost([['alpha', [{ exit: 0 }]]], {}, async (host) => {
    const id = await begin(host, 'alpha', folder('early'));
    await waitFor(() => state(host, id) === 'failed', 'failed');
    assert.equal(host.get(id)?.failure, 'start_failed');
  });
});

test('an illegal move claimed by a real engine fails the session, logs it, and kills the engine', async () => {
  const faults: string[] = [];
  await withHost([['alpha', [{ say: 'state:running' }, { say: 'state:ready' }, { hold: true }]]], { log: entry => faults.push(entry.message) }, async (host, tag) => {
    const id = await begin(host, 'alpha', folder('fault'));
    await waitFor(() => state(host, id) === 'failed', 'failed');
    assert.equal(host.get(id)?.failure, 'illegal_move');
    assert.deepEqual(faults, [`engine session ${id}: illegal move running -> ready`]);
    await assertNoLeaks(tag);
  });
});

test('a program that is not there fails the start with ENGINE_START_FAILED', async () => {
  const tag = newTag();
  const spec = { ...fakeEngine({ id: 'alpha', tag, steps: [] }), program: path.join(root, 'no-such-program') };
  const host = createEngineHost({ engines: [spec], launcher: createProcessLauncher(), locate: program => program });
  try {
    const planned = host.planStart({ engine: 'alpha', folder: folder('gone') });
    assert.ok(planned.ok);
    const begun = host.beginStart(planned.plan, { sharedApproved: false });
    assert.ok(begun.ok);
    assert.deepEqual(await begun.settled, { ok: false, code: 'ENGINE_START_FAILED' });
    assert.deepEqual(host.list().map(item => [item.state, item.failure]), [['failed', 'start_failed']]);
  } finally {
    await host.killAll();
    await assertNoLeaks(tag);
  }
});

test('the default locate finds the real path of a program, and the default folder check uses the real path, so two names for one folder are one folder', async () => {
  const real = folder('real-folder');
  const alias = path.join(root, 'alias-folder');
  fs.symlinkSync(real, alias);
  await withHost([['alpha', [{ say: 'state:running' }, { hold: true }]], ['beta', [{ say: 'state:running' }, { hold: true }]]], {}, async (host) => {
    const planned = host.planStart({ engine: 'alpha', folder: alias });
    assert.ok(planned.ok);
    assert.equal(planned.plan.folder, real, 'the plan shows the real folder, not the link');
    assert.equal(planned.plan.program, fs.realpathSync(process.execPath), 'and the real path of the program');
    await begin(host, 'alpha', real);
    assert.deepEqual(host.planStart({ engine: 'alpha', folder: alias }), { ok: false, code: 'ENGINE_PAIR_BUSY' });
    const second = host.planStart({ engine: 'beta', folder: alias });
    assert.ok(second.ok);
    assert.deepEqual(second.plan.sharedWith, ['alpha']);
  });
});

test('a folder that does not exist, or that is a file, is a folder refusal with the default check', async () => {
  const file = path.join(root, 'a-file');
  fs.writeFileSync(file, 'x');
  await withHost([['alpha', []]], {}, async (host) => {
    for (const bad of [path.join(root, 'does-not-exist'), file]) assert.deepEqual(host.planStart({ engine: 'alpha', folder: bad }), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder' }, bad);
  });
});

test('the default locate refuses a program that is not an executable file, and finds a bare name on PATH', async () => {
  const plain = path.join(root, 'not-executable');
  fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
  const tag = newTag();
  const make = (program: string) => createEngineHost({ engines: [{ ...fakeEngine({ id: 'alpha', tag, steps: [] }), program }], launcher: createProcessLauncher() });
  const dir = folder('locate');
  assert.deepEqual(make(plain).planStart({ engine: 'alpha', folder: dir }), { ok: false, code: 'ENGINE_NOT_FOUND' });
  assert.deepEqual(make(root).planStart({ engine: 'alpha', folder: dir }), { ok: false, code: 'ENGINE_NOT_FOUND' }, 'a folder is not a program');
  assert.deepEqual(make('no-such-program-anywhere-on-path').planStart({ engine: 'alpha', folder: dir }), { ok: false, code: 'ENGINE_NOT_FOUND' });
  const found = make('node').planStart({ engine: 'alpha', folder: dir });
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(path.basename(found.plan.program).startsWith('node'), true);
});

test('four real sessions run side by side, a fifth is refused, and killAll ends them all with no orphan', async () => {
  await withHost([['alpha', [{ spawnChild: true }, { say: 'state:running' }, { hold: true }]]], {}, async (host, tag) => {
    const ids: string[] = [];
    for (const name of ['one', 'two', 'three', 'four']) ids.push(await begin(host, 'alpha', folder(`side-${name}`)));
    await waitFor(() => ids.every(id => state(host, id) === 'running'), 'all running');
    assert.equal(liveWithTag(tag).length, 8, 'four engines and four helpers');
    assert.deepEqual(host.planStart({ engine: 'alpha', folder: folder('side-five') }), { ok: false, code: 'ENGINE_LIMIT' });
    await host.killAll();
    await waitFor(() => ids.every(id => ['stopped', 'failed'].includes(state(host, id) ?? '')), 'all ended');
    await assertNoLeaks(tag);
  });
});

test('a real engine that claims it has stopped, while its process lives, is failed with illegal_move and killed, and nothing lives behind it', async () => {
  for (const claim of ['stopped', 'failed', 'stopping']) {
    const faults: string[] = [];
    await withHost([['alpha', [{ say: 'state:running' }, { say: `state:${claim}` }, { hold: true }]]], { log: entry => faults.push(entry.message) }, async (host, tag) => {
      const id = await begin(host, 'alpha', folder(`claim-${claim}`));
      await waitFor(() => state(host, id) === 'failed', 'failed');
      assert.equal(host.get(id)?.failure, 'illegal_move');
      assert.deepEqual(faults, [`engine session ${id}: illegal move running -> ${claim}`]);
      await assertNoLeaks(tag);
    });
  }
});

test('a pair stays busy while the process of a failed session lives, and is free once it has gone', async () => {
  const dir = folder('pair-claim');
  await withHost([['alpha', [{ say: 'state:running' }, { ignoreTerm: true }, { say: 'state:stopped' }, { hold: true }]]], { cap: 1 }, async (host, tag) => {
    const id = await begin(host, 'alpha', dir);
    await waitFor(() => state(host, id) === 'failed', 'failed');
    await assertNoLeaks(tag);
    await waitFor(() => host.planStart({ engine: 'alpha', folder: dir }).ok, 'the slot to free once the exit is seen');
  });
});

test('a session that never says it runs fails after the start timeout, and its process is killed', async () => {
  const faults: string[] = [];
  await withHost([['alpha', [{ hold: true }]]], { startTimeoutMs: 250, log: entry => faults.push(entry.message) }, async (host, tag) => {
    const id = await begin(host, 'alpha', folder('never-runs'));
    assert.equal(state(host, id), 'starting');
    await waitFor(() => state(host, id) === 'failed', 'the start timeout');
    assert.equal(host.get(id)?.failure, 'start_failed');
    assert.deepEqual(faults, [`engine session ${id}: the program did not say it runs within 250 ms`]);
    await assertNoLeaks(tag);
  });
});

test('a helper that leaves the group of the engine survives a stop: this is a known limit, and the detector finds it', async () => {
  await withHost([['alpha', [{ spawnEscaped: true }, { say: 'state:running' }, { hold: true }]]], {}, async (host, tag) => {
    try {
      const id = await begin(host, 'alpha', folder('escaped'));
      await waitFor(() => state(host, id) === 'running', 'running');
      assert.equal(liveWithTag(tag).length, 2);
      assert.ok((await host.stop(id)).ok);
      await waitFor(() => liveWithTag(tag).length === 1, 'the engine to go, and the helper to stay');
      assert.equal(liveWithTag(tag).length, 1, 'the escaped helper is out of reach of the group kill');
    } finally {
      killWithTag(tag);
    }
  });
});

/** Starts alpha in `first`, and checks that another spelling of the folder is the same folder for the pair rule and the shared folder rule. */
async function sameFolder(first: string, other: string): Promise<void> {
  await withHost([['alpha', [{ say: 'state:running' }, { hold: true }]], ['beta', [{ say: 'state:running' }, { hold: true }]]], {}, async (host) => {
    await begin(host, 'alpha', first);
    assert.deepEqual(host.planStart({ engine: 'alpha', folder: other }), { ok: false, code: 'ENGINE_PAIR_BUSY' }, 'the pair rule');
    const shared = host.planStart({ engine: 'beta', folder: other });
    assert.ok(shared.ok);
    assert.deepEqual(shared.plan.sharedWith, ['alpha'], 'the shared folder rule');
  });
}

test('two spellings that differ only in case are one folder on a volume that ignores case', async t => {
  const dir = folder('casedir');
  const upper = path.join(root, 'CASEDIR');
  if (!fs.existsSync(upper) || fs.realpathSync.native(upper) !== fs.realpathSync.native(dir)) { t.skip('this volume tells the two spellings apart'); return; }
  await sameFolder(dir, upper);
});

test('two spellings that differ only in the normal form of a letter are one folder on a volume that ignores it', async t => {
  const composed = path.join(root, 'café-nfc');
  const decomposed = path.join(root, 'cafe\u0301-nfc'.normalize('NFD'));
  fs.mkdirSync(composed, { recursive: true });
  if (composed === decomposed || !fs.existsSync(decomposed)) { t.skip('this volume tells the two spellings apart'); return; }
  await sameFolder(composed, decomposed);
});

test('a path through a firmlink and the same path without it are one folder', async t => {
  const dir = folder('firm');
  const through = `/System/Volumes/Data${dir}`;
  if (process.platform !== 'darwin' || !fs.existsSync(through)) { t.skip('this computer has no firmlink to this folder'); return; }
  await sameFolder(dir, through);
});

test('a link and its target are one folder, and a second link to the same target is too', async () => {
  const real = folder('link-target');
  const one = path.join(root, 'link-one'), two = path.join(root, 'link-two');
  fs.symlinkSync(real, one);
  fs.symlinkSync(real, two);
  await sameFolder(one, two);
});

test('two folders that only share a prefix, or a name in different places, are two folders', async () => {
  await withHost([['alpha', [{ say: 'state:running' }, { hold: true }]]], {}, async (host) => {
    await begin(host, 'alpha', folder('prefix'));
    const other = host.planStart({ engine: 'alpha', folder: folder('prefix-longer') });
    assert.ok(other.ok);
    assert.deepEqual(other.plan.sharedWith, []);
    const nested = host.planStart({ engine: 'alpha', folder: folder('prefix/inner') });
    assert.ok(nested.ok, 'a folder inside another is not the same folder');
    assert.deepEqual(nested.plan.sharedWith, []);
  });
});
