import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createCoreClient } from '../src/client.js';
import { layoutChangeSteps, layoutSteps } from '../src/layout-plan.js';
import { HOME_GAUGES, defaultLayout, defaultPlace, layoutObject, layoutOf, proposeTile, reconcileLayout, swapPlace, type Layout } from '../../gauge-layout/src/index.js';
import { FIXTURE_GAUGES } from '../src/fixtures.js';
import type { LayoutPlan } from '../src/types.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { HOME_DOC, LAYOUT_FOLDERS, runLayoutSuite } from './layout-suite.js';

// The one layout suite, run against the fake core. The fake core gives the person's approval through its own `approve`, which no Gauge can reach.
runLayoutSuite('fake core layout', (folders, options) => {
  let now = 1_000_000;
  const core = createFakeCore({ folders, home: true, now: () => now, ...(options.layoutFile === undefined ? {} : { layoutFile: options.layoutFile }) });
  return { core, approve: plan => core.approve(plan.nonce), advance: milliseconds => { now += milliseconds; }, layoutBackup: () => core.layoutBackup() };
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const home = (options: { layoutFile?: string | Uint8Array; folders?: readonly GaugeFolder[] } = {}) => {
  const core = createFakeCore({ home: true, folders: LAYOUT_FOLDERS, ...options });
  return { core, client: createCoreClient(core) };
};

const FIRST_FILE = '{"format":"bowerloom/layout-file/1","revision":1,"current":{"format":"bowerloom/layout/1","grid":{"columns":6,"unit":200,"gap":12},"tiles":['
  + '{"place":"engines","gauge":"engines-usage","default":"engines-usage","col":0,"row":0,"size":"large"},'
  + '{"place":"jobs","gauge":"jobs","default":"jobs","col":2,"row":0,"size":"large"},'
  + '{"place":"harnesses","gauge":"harnesses","default":"harnesses","col":4,"row":0,"size":"medium"},'
  + '{"place":"models","gauge":"local-models","default":"local-models","col":4,"row":1,"size":"small"},'
  + '{"place":"memory","gauge":"memory-explorer","default":"memory-explorer","col":5,"row":1,"size":"small"}],'
  + '"shelf":["fixture-clock","fixture-manager","fixture-preset","gauge-manager","library","projects","settings","tracing"],"hidden":[]},"revisions":[]}\n';

test('the home option installs the nine stock Gauges after the fixture Gauges, and no home option leaves the fixture Gauges alone', async () => {
  const bare = createCoreClient(createFakeCore());
  assert.deepEqual(must(await bare.listGauges()), FIXTURE_GAUGES);
  const { client } = home();
  assert.deepEqual(must(await client.listGauges()).map(gauge => gauge.id), [
    'fixture-manager', 'fixture-clock', 'fixture-preset', 'engines-usage', 'jobs', 'harnesses', 'local-models', 'memory-explorer', 'projects', 'library', 'tracing', 'gauge-manager',
  ]);
  const harnesses = must(await client.getGauge('harnesses'));
  assert.deepEqual(harnesses, { id: 'harnesses', title: 'Harnesses', version: '1.0.0', kind: 'ui', origin: 'stock', protected: true });
  assert.equal(must(await client.getGauge('gauge-manager')).protected, true);
  assert.equal(must(await client.getGauge('jobs')).protected, false);
  assert.ok(must(await client.listRoutes()).includes('/gauges/gauge-manager'));
});

test('a core with only the fixture Gauges still has a layout: no tile, and every Gauge and Settings on the shelf', async () => {
  const client = createCoreClient(createFakeCore());
  const state = must(await client.readLayout());
  assert.deepEqual(state.layout.tiles, []);
  assert.deepEqual(state.layout.shelf, ['fixture-clock', 'fixture-manager', 'fixture-preset', 'settings']);
  assert.equal(state.revision, 1);
});

test('the file of a first start is the default layout as revision 1, in the exact bytes of the contract', () => {
  assert.equal(home().core.layoutFile(), FIRST_FILE);
});

test('each applied change writes the file: the new current layout, and the old one as the newest revision', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  assert.equal(core.layoutFile(), FIRST_FILE);
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  const file = JSON.parse(core.layoutFile()) as { revision: number; current: { tiles: { place: string; gauge: string }[] }; revisions: { revision: number; layout: unknown }[] };
  assert.equal(file.revision, 2);
  assert.equal(file.current.tiles.find(tile => tile.place === 'models')?.gauge, 'tracing');
  assert.deepEqual(file.revisions, [{ revision: 1, layout: HOME_DOC }]);
  assert.equal(core.layoutFile().endsWith('}\n'), true);
});

test('a layout file that was saved starts the core as it was saved, and the text it keeps is the saved text', () => {
  const { core } = home({ layoutFile: FIRST_FILE });
  assert.equal(core.layoutFile(), FIRST_FILE);
});

test('a broken file stays on disk until the first change, and then it is replaced', async () => {
  const { core, client } = home({ layoutFile: '{broken' });
  assert.equal(core.layoutFile(), '{broken');
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  assert.equal(core.layoutFile(), '{broken');
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  assert.equal((JSON.parse(core.layoutFile()) as { revision: number }).revision, 1);
});

test('a file given as bytes is read as UTF-8, and bytes that are not UTF-8 start safe mode with not_utf8', async () => {
  const bytes = Buffer.from(FIRST_FILE, 'utf8');
  assert.equal(must(await home({ layoutFile: bytes }).client.readLayout()).safe, null);
  const bad = home({ layoutFile: Uint8Array.from([0xff, 0xfe, 0x7b]) });
  assert.deepEqual(must(await bad.client.readLayout()).safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_utf8' });
});

test('the core keeps a copy of the file bytes it is given, so a caller that changes them changes nothing', async () => {
  const bytes = Uint8Array.from(Buffer.from(FIRST_FILE, 'utf8'));
  const { client } = home({ layoutFile: bytes });
  bytes.fill(0);
  assert.equal(must(await client.readLayout()).safe, null);
  assert.deepEqual(must(await client.readLayout()).layout, HOME_DOC);
});

test('the default layout of safe mode follows the Gauges the core holds now', async () => {
  const { core, client } = home({ layoutFile: '{broken' });
  assert.equal(must(await client.readLayout()).layout.shelf.includes('fixture-quiet'), false);
  for (const plan of [() => client.planInstall('quiet-folder'), () => client.planEnable('fixture-quiet')]) {
    const planned = must(await plan());
    must(await client.applyPlan(planned, core.approve(planned.nonce)));
  }
  const state = must(await client.readLayout());
  assert.equal(state.safe?.reason, 'syntax');
  assert.equal(state.layout.shelf.includes('fixture-quiet'), true);
});

test('a plan binds to the layout it was made for, and to the result: both hashes are the hashes of the exported text', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  assert.equal(plan.baseHash, sha256(must(await client.exportLayout())));
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  assert.equal(plan.nextHash, sha256(must(await client.exportLayout())));
  const same = must(await client.planLayoutSet(must(await client.exportLayout())));
  assert.equal(same.baseHash, same.nextHash);
});

test('the full text of a swap plan reads exactly like this', async () => {
  const { client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  assert.deepEqual(plan.steps, [
    'swap place models from local-models to tracing',
    'after the change: 5 tiles, 8 on the shelf, 0 hidden',
    'tile engines: engines-usage large at column 0 row 0',
    'tile jobs: jobs large at column 2 row 0',
    'tile harnesses: harnesses medium at column 4 row 0',
    'tile models: tracing small at column 4 row 1',
    'tile memory: memory-explorer small at column 5 row 1',
    'shelf: fixture-clock, fixture-manager, fixture-preset, gauge-manager, library, local-models, projects, settings',
    'hidden: none',
    'keep the layout now in use as revision 1, and keep at most 10 earlier revisions',
    `bind the change to layout ${plan.baseHash} and result ${plan.nextHash}`,
  ]);
});

test('the text of an import plan, of a restore plan, and of a change that changes nothing', async () => {
  const { core, client } = home();
  const swap = must(await client.planLayoutSwap('models', 'tracing'));
  must(await client.applyLayout(swap, core.approve(swap.nonce)));
  const restore = must(await client.planLayoutRestore(1));
  assert.equal(restore.steps[0], 'restore revision 1 as the new layout');
  assert.equal(restore.steps.at(-2), 'keep the layout now in use as revision 2, and keep at most 10 earlier revisions');
  const same = must(await client.planLayoutSet(must(await client.exportLayout())));
  assert.equal(same.steps[0], 'replace the layout with the layout in the text given');
  assert.equal(same.steps.at(-2), 'no change: the layout stays as it is');
});

test('every value in the text of a plan goes through the one escape helper, so no value can forge a line', () => {
  const hostile = 'a\nb\u2028c\u0085d\\e\u202Ef';
  const layout = {
    format: 'bowerloom/layout/1', grid: { columns: 6, unit: 200, gap: 12 },
    tiles: [{ place: hostile, gauge: hostile, default: hostile, col: 0, row: 0, size: 'small' }], shelf: [hostile], hidden: [hostile],
  } as const;
  const steps = layoutSteps({ kind: 'swap', place: hostile, gauge: hostile, revision: null, base: layout, next: layout, baseHash: hostile, nextHash: hostile, baseRevision: 1, safe: false, backup: false, dropped: null });
  for (const line of steps) assert.equal(/[\n\r\u2028\u2029\u0085\u202E]/.test(line), false, JSON.stringify(line));
  assert.ok(steps.includes('swap place a\\u{a}b\\u{2028}c\\u{85}d\\\\e\\u{202e}f from a\\u{a}b\\u{2028}c\\u{85}d\\\\e\\u{202e}f to a\\u{a}b\\u{2028}c\\u{85}d\\\\e\\u{202e}f'));
  assert.equal(steps.length, 7);
});

test('two plans for the same change have the same content and a new random nonce each', async () => {
  const { client } = home();
  const one = must(await client.planLayoutSwap('models', 'tracing')), two = must(await client.planLayoutSwap('models', 'tracing'));
  assert.deepEqual({ ...one, nonce: '' }, { ...two, nonce: '' });
  assert.notEqual(one.nonce, two.nonce);
  assert.match(one.nonce, HEX);
  assert.match(one.digest, HEX);
});

test('the digest that a caller sends is ignored: the core works it out from the content, so a forged digest changes nothing', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  const forged: LayoutPlan = { ...plan, digest: 'f'.repeat(64) };
  assert.equal((await client.applyLayout(forged, core.approve(plan.nonce))).ok, true);
});

test('an apply with a malformed plan is refused with GAUGE_PLAN_CHANGED, and a malformed approval with GAUGE_PLAN_NOT_APPROVED', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  const approval = core.approve(plan.nonce);
  for (const bad of [undefined, null, 'x', [], {}, { action: 'layout' }, { ...plan, kind: 'explode' }, { ...plan, steps: 'x' }, { ...plan, steps: [5] }, { ...plan, nonce: 5 }, { ...plan, place: 5 }, { ...plan, revision: '1' }, { ...plan, text: 5 }, { ...plan, action: 'grant' }]) {
    assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: bad, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, JSON.stringify(bad));
  }
  for (const bad of [undefined, null, 5, {}, [], '', 'x'.repeat(64)]) assert.deepEqual(await core.call('bowerloom.layout.apply', { plan, approval: bad }), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, String(bad));
  assert.equal((await client.applyLayout(plan, approval)).ok, true);
});

test('a plan with a hole in its steps is refused, and the sparse list is not read as a line of text', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  const approval = core.approve(plan.nonce);
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [plan.steps[0], , plan.steps[2]];
  assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: { ...plan, steps: sparse }, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
});

test('a counter that is full refuses a change that would write a revision at plan time, with bad_revision, and still plans a change that writes none', async () => {
  const full = FIRST_FILE.replace('"revision":1,"current"', '"revision":999999999,"current"');
  const { core, client } = home({ layoutFile: full });
  assert.equal(must(await client.readLayout()).revision, 999_999_999);
  for (const plan of [client.planLayoutSwap('models', 'tracing'), client.planLayoutDefault('models').then(() => client.planLayoutSwap('jobs', 'library')), client.planLayoutPropose('fixture-proposer')]) {
    const result = await plan;
    assert.equal(result.ok, false);
  }
  assert.deepEqual(await client.planLayoutSwap('models', 'tracing'), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' });
  assert.deepEqual(await client.planLayoutSet(JSON.stringify({ ...HOME_DOC, shelf: HOME_DOC.shelf.filter(id => id !== 'library') })), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' });
  // A change that gives the layout already in use writes no revision, so it has a plan.
  const same = must(await client.planLayoutSwap('models', 'local-models'));
  assert.equal(same.steps.at(-2), 'no change: the layout stays as it is');
  assert.equal(core.layoutFile(), full);
  assert.equal(must(await client.readLayout()).layout.tiles.find(tile => tile.place === 'models')?.gauge, 'local-models');
});

test('no Gauge can take the id of the Settings page, from a user folder or a stock folder', async () => {
  const folder = (location: 'user' | 'bundled'): GaugeFolder => ({ name: `settings-${location}`, location, manifest: validManifest('tile-only').replace('fixture-tile', 'settings') });
  const client = createCoreClient(createFakeCore({ folders: [folder('user'), folder('bundled')] }));
  assert.deepEqual(await client.planInstall('settings-user'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
  assert.deepEqual(await client.planInstall('settings-bundled'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
});

test('an installed Gauge with size hints is held to them: the first hint is its first allowed size', async () => {
  const { core, client } = home();
  for (const folder of ['proposer-folder']) {
    for (const plan of [() => client.planInstall(folder), () => client.planEnable('fixture-proposer')]) {
      const planned = must(await plan());
      must(await client.applyPlan(planned, core.approve(planned.nonce)));
    }
  }
  const swap = must(await client.planLayoutSwap('jobs', 'fixture-proposer'));
  assert.ok(swap.steps.includes('tile jobs: fixture-proposer medium at column 2 row 0'));
});

test('a caller that changes what the core returned changes nothing for the next call', async () => {
  const { core } = home();
  const first = await core.call('bowerloom.layout.read', {});
  assert.ok(first.ok);
  const result = first.result as { layout: { tiles: { gauge: string }[]; shelf: string[] }; revision: number };
  result.layout.tiles.length = 0;
  result.layout.shelf.push('x');
  result.revision = 99;
  const second = await core.call('bowerloom.layout.read', {});
  assert.ok(second.ok);
  assert.deepEqual((second.result as { layout: unknown }).layout, HOME_DOC);
  assert.equal((second.result as { revision: number }).revision, 1);
  const revisions = await core.call('bowerloom.layout.revisions', {});
  assert.deepEqual(revisions, { ok: true, result: [] });
});

test('a proposal for an id that is not text is refused with UNKNOWN_GAUGE, and nothing changes', async () => {
  const { core, client } = home();
  const before = await core.call('bowerloom.layout.read', {});
  for (const gauge of [undefined, null, 5, {}, [], true, Symbol.iterator as unknown as string]) {
    assert.deepEqual(await core.call('bowerloom.layout.plan', { kind: 'propose', gauge }), { ok: false, code: 'UNKNOWN_GAUGE' }, String(gauge));
  }
  assert.deepEqual(await core.call('bowerloom.layout.read', {}), before);
  assert.equal(must(await client.readLayout()).revision, 1);
});

test('a start with a value that is not a file starts in safe mode with the reason syntax, and the core never throws', async () => {
  for (const found of [null, 5, true, {}, [], () => 1, Symbol('x')]) {
    const client = createCoreClient(createFakeCore({ home: true, layoutFile: found as unknown as string }));
    const state = must(await client.readLayout());
    assert.deepEqual(state.safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' }, String(found));
    assert.equal(state.revision, 0);
  }
});

test('bytes that are not UTF-8 start safe mode with not_utf8, and the backup holds the raw bytes and not a lossy decode', async () => {
  const raw = Uint8Array.from([0xff, 0xfe, 0x7b, 0x80]);
  const { core, client } = home({ layoutFile: raw });
  assert.equal(core.layoutBackup(), null);
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  assert.deepEqual(core.layoutBackup(), raw);
  raw.fill(0);
  assert.deepEqual(core.layoutBackup(), Uint8Array.from([0xff, 0xfe, 0x7b, 0x80]));
  // The copy that the core gives out is its own, so a caller that changes it changes nothing.
  core.layoutBackup()?.fill(1);
  assert.deepEqual(core.layoutBackup(), Uint8Array.from([0xff, 0xfe, 0x7b, 0x80]));
});

test('a start that breaks inside the reader is the reason internal, and a plan is refused while it is, so nothing overwrites the file', async () => {
  const hostile = new Proxy(new Uint8Array(4), { get() { throw new Error('boom'); } });
  const { core, client } = home({ layoutFile: hostile });
  const state = must(await client.readLayout());
  assert.deepEqual(state.safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' });
  for (const plan of [client.planLayoutSwap('models', 'tracing'), client.planLayoutSet(must(await client.exportLayout())), client.planLayoutDefault('models'), client.planLayoutRestore(1), client.planLayoutPropose('fixture-proposer')]) {
    assert.deepEqual(await plan, { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' });
  }
  assert.equal(core.layoutBackup(), null);
});

test('a start that finds a plain syntax problem is not blocked: the person can still change the layout', async () => {
  const { core, client } = home({ layoutFile: '{' });
  assert.equal((await client.planLayoutSwap('models', 'tracing')).ok, true);
  assert.equal(core.layoutBackup(), null);
});

test('the check that a next start would make follows the Gauges: after each lifecycle step the saved file still starts the core', async () => {
  const core = createFakeCore({ home: true, folders: LAYOUT_FOLDERS });
  const client = createCoreClient(core);
  const steps = [() => client.planDisable('jobs'), () => client.planRemove('tracing'), () => client.planDisable('projects')];
  assert.equal(core.layoutStartCheck(), null);
  for (const step of steps) {
    const plan = must(await step());
    must(await client.applyPlan(plan, core.approve(plan.nonce)));
    assert.equal(core.layoutStartCheck(), null);
  }
  const quiet = must(await client.planInstall('quiet-folder'));
  must(await client.applyPlan(quiet, core.approve(quiet.nonce)));
  const enable = must(await client.planEnable('fixture-quiet'));
  must(await client.applyPlan(enable, core.approve(enable.nonce)));
  const place = must(await client.planLayoutSet(JSON.stringify({ ...HOME_DOC, tiles: [...HOME_DOC.tiles.filter(tile => tile.gauge !== 'jobs'), { place: 'wide', gauge: 'fixture-quiet', default: 'fixture-quiet', col: 0, row: 2, size: 'large' }], shelf: HOME_DOC.shelf.filter(id => id !== 'tracing' && id !== 'projects' && id !== 'fixture-quiet') })));
  must(await client.applyLayout(place, core.approve(place.nonce)));
  const update = must(await client.planUpdate('quiet-fixed-update'));
  must(await client.applyPlan(update, core.approve(update.nonce)));
  assert.equal(core.layoutStartCheck(), null);
  assert.equal(must(await client.readLayout()).layout.tiles.find(tile => tile.place === 'wide')?.size, 'small');
});

test('a plan read for apply uses own properties only: an inherited field reads as missing, and a revision that is not a whole number is refused', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  const approval = core.approve(plan.nonce);
  assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: Object.create(plan), approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  const rest: Record<string, unknown> = { ...plan };
  delete rest['gauge'];
  const partly = Object.assign(Object.create({ gauge: 'tracing' }) as object, rest);
  assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: partly, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  for (const revision of [NaN, Infinity, -Infinity, 1.5, 2 ** 53, -0.5]) assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: { ...plan, revision }, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, String(revision));
  assert.equal((await client.applyLayout(plan, approval)).ok, true);
});

test('every value in the lines that a lifecycle step adds goes through the escape helper too', () => {
  const hostile = 'a\nb\u2028c\\d';
  const tile = (gauge: string, size: 'small' | 'medium') => ({ place: hostile, gauge, default: gauge, col: 0, row: 0, size });
  const before = { format: 'bowerloom/layout/1', grid: { columns: 6, unit: 200, gap: 12 }, tiles: [tile(hostile, 'small')], shelf: [hostile], hidden: [hostile] } as const;
  const after = { ...before, tiles: [tile('other', 'medium')], shelf: ['x\ny'], hidden: [] } as const;
  const lines = layoutChangeSteps(before, after, 3, 1);
  assert.ok(lines.length >= 6);
  for (const line of lines) assert.equal(/[\n\r\u2028\u2029]/.test(line), false, JSON.stringify(line));
  assert.ok(lines.includes('layout: drop revision 1, the oldest, because the file keeps at most 10 earlier revisions'));
  assert.deepEqual(layoutChangeSteps(before, before, 3, null), []);
});

test('a lifecycle step is never refused because the revision counter is full: the layout is reconciled in place, with no new revision', async () => {
  const full = FIRST_FILE.replace('"revision":1,"current"', '"revision":999999999,"current"');
  const { core, client } = home({ layoutFile: full });
  const plan = must(await client.planDisable('jobs'));
  must(await client.applyPlan(plan, core.approve(plan.nonce)));
  const state = must(await client.readLayout());
  assert.equal(state.revision, 999_999_999);
  assert.equal(state.layout.tiles.some(tile => tile.gauge === 'jobs'), false);
  assert.equal(core.layoutStartCheck(), null);
});

test('a lifecycle step in safe mode changes nothing about the saved file, and says nothing about the layout', async () => {
  const { core, client } = home({ layoutFile: '{broken' });
  const plan = must(await client.planDisable('jobs'));
  assert.equal(plan.steps.some(line => line.startsWith('layout: ')), false);
  must(await client.applyPlan(plan, core.approve(plan.nonce)));
  assert.equal(core.layoutFile(), '{broken');
  const state = must(await client.readLayout());
  assert.equal(state.safe?.reason, 'syntax');
  assert.equal(state.layout.tiles.some(tile => tile.gauge === 'jobs'), false);
});

// Round two

const quietFolders = LAYOUT_FOLDERS;
const lifecycleStep = async (core: ReturnType<typeof createFakeCore>, client: ReturnType<typeof createCoreClient>, plan: Parameters<typeof client.applyPlan>[0]) => must(await client.applyPlan(plan, core.approve(plan.nonce)));
const ids = (state: { layout: { shelf: readonly string[] } }) => state.layout.shelf;

test('a saved layout that the Gauges make readable again is loaded after a lifecycle step, and the plan says so', async () => {
  const doc = JSON.parse(JSON.stringify(HOME_DOC)) as typeof HOME_DOC;
  doc.shelf.push('fixture-quiet');
  doc.shelf.sort();
  const file = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 5, current: doc, revisions: [{ revision: 4, layout: HOME_DOC }, { revision: 3, layout: HOME_DOC }] }) + '\n';
  const core = createFakeCore({ home: true, folders: quietFolders, layoutFile: file });
  const client = createCoreClient(core);
  assert.deepEqual(must(await client.readLayout()).safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_gauge' });
  const install = must(await client.planInstall('quiet-folder'));
  assert.deepEqual(install.steps.filter(line => line.startsWith('layout: ')), []);
  await lifecycleStep(core, client, install);
  // The Gauge is installed and still disabled, so the file is still not valid.
  assert.deepEqual(must(await client.readLayout()).safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
  const enable = must(await client.planEnable('fixture-quiet'));
  assert.deepEqual(enable.steps.filter(line => line.startsWith('layout: ')), ['layout: the saved layout can be read again']);
  await lifecycleStep(core, client, enable);
  const state = must(await client.readLayout());
  assert.equal(state.safe, null);
  assert.equal(state.revision, 5);
  assert.equal(state.layout.shelf.includes('fixture-quiet'), true);
  assert.deepEqual(must(await client.listLayoutRevisions()).map(entry => entry.revision), [4, 3]);
  assert.equal(core.layoutFile(), file);
  assert.equal(core.layoutBackup(), null);
  // A change after that is an ordinary change: revision 6, and no backup.
  const swap = must(await client.planLayoutSwap('models', 'tracing'));
  assert.equal(swap.steps.at(-2), 'keep the layout now in use as revision 5, and keep at most 10 earlier revisions');
  must(await client.applyLayout(swap, core.approve(swap.nonce)));
  assert.equal(must(await client.readLayout()).revision, 6);
  assert.equal(core.layoutBackup(), null);
});

test('a file that stays broken after a step stays in safe mode, and a step says nothing about it', async () => {
  const { core, client } = home({ layoutFile: '{broken' });
  const plan = must(await client.planDisable('library'));
  assert.deepEqual(plan.steps.filter(line => line.startsWith('layout: ')), []);
  await lifecycleStep(core, client, plan);
  assert.equal(must(await client.readLayout()).safe?.reason, 'syntax');
});

test('the start check reads the raw bytes: a file with a byte order mark is refused by a start and by the check', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FIRST_FILE, 'utf8')]);
  const { core, client } = home({ layoutFile: bytes });
  assert.equal(must(await client.readLayout()).safe?.reason, 'syntax');
  assert.deepEqual(core.layoutStartCheck(), { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' });
  // A file that the core wrote starts the core.
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  assert.equal(core.layoutStartCheck(), null);
  assert.deepEqual(core.layoutBackup(), Uint8Array.from(bytes));
});

test('a backup is a copy of the bytes that the caller gave: changing them before the change leaves the backup as it was', async () => {
  const raw = Uint8Array.from([0x7b, 0xff, 0x80]);
  const { core, client } = home({ layoutFile: raw });
  raw.fill(0);
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  must(await client.applyLayout(plan, core.approve(plan.nonce)));
  assert.deepEqual(core.layoutBackup(), Uint8Array.from([0x7b, 0xff, 0x80]));
});

test('a start with no file at all sets no backup aside, and the plan does not claim that a saved file was kept', async () => {
  for (const found of [null, 5, {}, '', new Uint8Array(0)]) {
    const { core, client } = home({ layoutFile: found as unknown as string });
    const plan = must(await client.planLayoutSwap('models', 'tracing'));
    assert.ok(plan.steps.includes('leave safe mode and save the layout as revision 1'), String(found));
    must(await client.applyLayout(plan, core.approve(plan.nonce)));
    assert.equal(core.layoutBackup(), null, String(found));
  }
  const { client } = home({ layoutFile: '{x' });
  assert.ok(must(await client.planLayoutSwap('models', 'tracing')).steps.includes('leave safe mode, keep the saved file as a backup, and save the layout as revision 1'));
});

test('a lifecycle step at a full revision counter says that the layout is replaced in place and the old one is not kept, and keeps no other line about revisions', async () => {
  const full = FIRST_FILE.replace('"revision":1,"current"', '"revision":999999999,"current"');
  const { core, client } = home({ layoutFile: full });
  const plan = must(await client.planDisable('jobs'));
  assert.deepEqual(plan.steps.filter(line => line.startsWith('layout: ')), [
    'layout: drop tile jobs (jobs)',
    'layout: replace revision 999999999 in place, the revision counter is full and the old layout is not kept',
  ]);
  await lifecycleStep(core, client, plan);
  assert.equal(must(await client.readLayout()).revision, 999_999_999);
});

test('a lifecycle plan with a full file names the revision that it drops, and says the layout is kept as a revision', async () => {
  const revisions = Array.from({ length: 10 }, (_, index) => ({ revision: 10 - index, layout: HOME_DOC }));
  const file = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 11, current: HOME_DOC, revisions }) + '\n';
  const { client } = home({ layoutFile: file });
  const plan = must(await client.planDisable('jobs'));
  assert.deepEqual(plan.steps.filter(line => line.startsWith('layout: ')), [
    'layout: drop tile jobs (jobs)',
    'layout: keep the layout now in use as revision 11, and keep at most 10 earlier revisions',
    'layout: drop revision 1, the oldest, because the file keeps at most 10 earlier revisions',
  ]);
});

test('lifecycle and grant plans are read from own properties only: a plan that inherits its fields is refused', async () => {
  const { core, client } = home();
  const install = must(await client.planInstall('proposer-folder'));
  const approval = core.approve(install.nonce);
  assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan: Object.create(install), approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  await lifecycleStep(core, client, install);
  const enable = must(await client.planEnable('fixture-proposer'));
  await lifecycleStep(core, client, enable);
  const grant = must(await client.planGrant('fixture-proposer', ['layout.propose']));
  const grantApproval = core.approve(grant.nonce);
  assert.deepEqual(await core.call('bowerloom.grants.apply', { plan: Object.create(grant), approval: grantApproval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
  assert.equal((await client.applyGrant(grant, grantApproval)).ok, true);
});

test('a plan sent for a layout change with a field missing is refused, and so is one with a field of the wrong type', async () => {
  const { core, client } = home();
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  const approval = core.approve(plan.nonce);
  for (const field of ['place', 'gauge', 'text', 'revision', 'kind', 'steps', 'baseHash', 'nextHash', 'nonce', 'action']) {
    const copy: Record<string, unknown> = { ...plan };
    delete copy[field];
    assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: copy, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, field);
  }
  for (const [field, value] of [['text', 5], ['text', []], ['place', 5], ['gauge', {}]] as const) {
    assert.deepEqual(await core.call('bowerloom.layout.apply', { plan: { ...plan, [field]: value }, approval }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, field);
  }
  assert.equal((await client.applyLayout(plan, approval)).ok, true);
});

test('a step whose layout work throws changes nothing: the Gauges, the grants, the audit file, the layout, and the approval are as they were, and the approval still works', async () => {
  let broken = false;
  const core = createFakeCore({
    home: true, folders: LAYOUT_FOLDERS, now: () => 1_000_000,
    reconcile: (layout, table, options) => { if (broken) throw new Error('boom'); return reconcileLayout(layout, table, options); },
  });
  const client = createCoreClient(core);
  for (const plan of [() => client.planInstall('proposer-folder'), () => client.planEnable('fixture-proposer')]) await lifecycleStep(core, client, must(await plan()));
  const grant = must(await client.planGrant('fixture-proposer', ['layout.propose']));
  must(await client.applyGrant(grant, core.approve(grant.nonce)));
  const plan = must(await client.planDisable('jobs'));
  const approval = core.approve(plan.nonce);
  const snapshot = async () => JSON.stringify([must(await client.listGauges()), must(await client.listGrants('fixture-proposer')), must(await client.readAudit()), must(await client.readLayout()), must(await client.listLayoutRevisions()), core.layoutFile(), must(await client.listRoutes())]);
  const before = await snapshot();
  broken = true;
  await assert.rejects(client.applyPlan(plan, approval), /boom/);
  assert.equal(await snapshot(), before);
  broken = false;
  assert.equal((await client.applyPlan(plan, approval)).ok, true);
  assert.equal(must(await client.readLayout()).layout.tiles.some(tile => tile.gauge === 'jobs'), false);
  // The same holds for an update, which drops grants, and for a removal.
  const second = createFakeCore({ home: true, folders: LAYOUT_FOLDERS, reconcile: () => { throw new Error('boom'); } });
  const secondClient = createCoreClient(second);
  const remove = must(await secondClient.planInstall('proposer-folder'));
  await lifecycleStep(second, secondClient, remove);
  assert.equal(must(await secondClient.listGauges()).some(gauge => gauge.id === 'fixture-proposer'), true);
});

test('a Gauge that is removed while the layout work fails is still installed, with its grants', async () => {
  let broken = false;
  const core = createFakeCore({ home: true, folders: LAYOUT_FOLDERS, reconcile: (layout, table, options) => { if (broken) throw new Error('boom'); return reconcileLayout(layout, table, options); } });
  const client = createCoreClient(core);
  for (const plan of [() => client.planInstall('proposer-folder'), () => client.planEnable('fixture-proposer')]) await lifecycleStep(core, client, must(await plan()));
  const grant = must(await client.planGrant('fixture-proposer', ['layout.propose']));
  must(await client.applyGrant(grant, core.approve(grant.nonce)));
  // Place the Gauge on a tile, so that its removal changes the layout.
  const swap = must(await client.planLayoutSwap('models', 'fixture-proposer'));
  must(await client.applyLayout(swap, core.approve(swap.nonce)));
  const remove = must(await client.planRemove('fixture-proposer'));
  const approval = core.approve(remove.nonce);
  const audit = core.auditFile();
  broken = true;
  await assert.rejects(client.applyPlan(remove, approval), /boom/);
  assert.equal(must(await client.listGauges()).some(gauge => gauge.id === 'fixture-proposer'), true);
  assert.deepEqual(must(await client.listGrants('fixture-proposer')).map(entry => entry.permission), ['layout.propose']);
  assert.equal(core.auditFile(), audit);
  broken = false;
  assert.equal((await client.applyPlan(remove, approval)).ok, true);
  assert.equal(must(await client.listGauges()).some(gauge => gauge.id === 'fixture-proposer'), false);
  assert.equal(ids(must(await client.readLayout())).includes('fixture-proposer'), false);
});

// The lines of a lifecycle plan: every difference between two layouts has a line

const doc = (change: (copy: typeof HOME_DOC) => unknown) => {
  const result = layoutOf(change(structuredClone(HOME_DOC)), { requireCanonical: false });
  assert.ok(result.ok);
  return result.layout;
};
const only = (lines: string[]) => lines.filter(line => !line.startsWith('layout: keep ') && !line.startsWith('layout: drop revision'));

test('each kind of difference between two layouts has its own line, with literal text', () => {
  const before = doc(copy => copy);
  const cases: readonly (readonly [string, Layout, string[]])[] = [
    ['a tile moves', doc(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'memory' ? { ...tile, col: 0, row: 2 } : tile)) })), ['layout: tile memory moves from column 5 row 1 to column 0 row 2']],
    ['a tile is added', doc(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'extra', gauge: 'library', default: 'library', col: 0, row: 2, size: 'medium' }], shelf: copy.shelf.filter(id => id !== 'library') })), ['layout: add tile extra (library medium at column 0 row 2)', 'layout: remove library from the shelf']],
    ['a tile is dropped', doc(copy => ({ ...copy, tiles: copy.tiles.filter(tile => tile.place !== 'jobs') })), ['layout: drop tile jobs (jobs)']],
    ['a tile changes size', doc(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, size: 'medium' } : tile)) })), ['layout: tile engines changes from large to medium']],
    ['a tile holds another Gauge', doc(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'library' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'library'), 'local-models'].sort() })), ['layout: tile models holds library small instead of local-models', 'layout: remove library from the shelf', 'layout: add local-models to the shelf']],
    ['a place has another default', doc(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, default: 'library' } : tile)) })), ['layout: place models has the default library']],
    ['a Gauge is hidden', doc(copy => ({ ...copy, shelf: copy.shelf.filter(id => id !== 'library'), hidden: ['library'] })), ['layout: remove library from the shelf', 'layout: add library to the hidden list']],
  ];
  for (const [label, after, expected] of cases) assert.deepEqual(only(layoutChangeSteps(before, after, 1, null)), expected, label);
  const hiding = cases[6]?.[1] as Layout;
  assert.deepEqual(only(layoutChangeSteps(hiding, before, 1, null)), ['layout: add library to the shelf', 'layout: remove library from the hidden list']);
  assert.deepEqual(layoutChangeSteps(before, before, 1, null), []);
});

test('the lines describe every difference between two random layouts, worked out here by another route', () => {
  const table = new Map(HOME_GAUGES.map(gauge => [gauge.id, { enabled: true, protected: gauge.protected, tile: gauge.tile }]));
  const ids = [...table.keys()];
  let seed = 11;
  const pick = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const choose = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length)] as T;
  const arrange = (): Layout => {
    let layout = defaultLayout(table);
    for (let step = 0; step < 1 + Math.floor(pick() * 6); step += 1) {
      const result = choose([() => swapPlace(layout, table, choose(layout.tiles).place, choose(ids)), () => proposeTile(layout, table, choose(ids)), () => defaultPlace(layout, table, choose(layout.tiles).place)])();
      if (result.ok) layout = result.layout;
    }
    return layout;
  };
  const expected = (before: Layout, after: Layout): string[] => {
    const out: string[] = [];
    const places = new Set([...before.tiles.map(tile => tile.place), ...after.tiles.map(tile => tile.place)]);
    for (const place of [...places].sort()) {
      const b = before.tiles.find(tile => tile.place === place), a = after.tiles.find(tile => tile.place === place);
      if (b && !a) out.push(`layout: drop tile ${place} (${b.gauge})`);
      else if (!b && a) out.push(`layout: add tile ${place} (${a.gauge} ${a.size} at column ${a.col} row ${a.row})`);
      else if (b && a) {
        if (b.gauge !== a.gauge) out.push(`layout: tile ${place} holds ${a.gauge} ${a.size} instead of ${b.gauge}`);
        else if (b.size !== a.size) out.push(`layout: tile ${place} changes from ${b.size} to ${a.size}`);
        if (b.col !== a.col || b.row !== a.row) out.push(`layout: tile ${place} moves from column ${b.col} row ${b.row} to column ${a.col} row ${a.row}`);
        if (b.default !== a.default) out.push(`layout: place ${place} has the default ${a.default}`);
      }
    }
    for (const id of before.shelf) if (!after.shelf.includes(id)) out.push(`layout: remove ${id} from the shelf`);
    for (const id of after.shelf) if (!before.shelf.includes(id)) out.push(`layout: add ${id} to the shelf`);
    for (const id of before.hidden) if (!after.hidden.includes(id)) out.push(`layout: remove ${id} from the hidden list`);
    for (const id of after.hidden) if (!before.hidden.includes(id)) out.push(`layout: add ${id} to the hidden list`);
    return out.sort();
  };
  let different = 0;
  for (let round = 0; round < 400; round += 1) {
    const before = arrange(), after = arrange();
    const lines = only(layoutChangeSteps(before, after, 1, null)).sort();
    assert.deepEqual(lines, expected(before, after));
    if (lines.length > 0) different += 1;
  }
  assert.ok(different > 300, String(different));
});

test('each field of a lifecycle plan and of a grant plan is read from own properties: a plan that inherits any one field is refused', async () => {
  const { core, client } = home();
  const install = must(await client.planInstall('proposer-folder'));
  // The digest is worked out by the core, and the one a caller sends is ignored, so it is not a field to forge.
  for (const field of Object.keys(install).filter(key => key !== 'digest')) {
    const rest: Record<string, unknown> = { ...install };
    const inherited = rest[field];
    delete rest[field];
    const forged = Object.assign(Object.create({ [field]: inherited }) as object, rest);
    assert.deepEqual(await core.call('bowerloom.gauges.apply', { plan: forged, approval: core.approve(install.nonce) }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, field);
  }
  await lifecycleStep(core, client, install);
  await lifecycleStep(core, client, must(await client.planEnable('fixture-proposer')));
  const grant = must(await client.planGrant('fixture-proposer', ['layout.propose']));
  for (const field of Object.keys(grant).filter(key => key !== 'digest')) {
    const rest: Record<string, unknown> = { ...grant };
    const inherited = rest[field];
    delete rest[field];
    const forged = Object.assign(Object.create({ [field]: inherited }) as object, rest);
    assert.deepEqual(await core.call('bowerloom.grants.apply', { plan: forged, approval: core.approve(grant.nonce) }), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, field);
  }
  assert.equal((await client.applyGrant(grant, core.approve(grant.nonce))).ok, true);
});

test('a start that broke inside the reader stays in safe mode with the reason internal after a lifecycle step', async () => {
  const hostile = new Proxy(new Uint8Array(4), { get() { throw new Error('boom'); } });
  const { core, client } = home({ layoutFile: hostile });
  await lifecycleStep(core, client, must(await client.planDisable('library')));
  assert.deepEqual(must(await client.readLayout()).safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' });
  assert.deepEqual(core.layoutStartCheck(), { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' });
});

// Round three

test('a bundled update that makes Engines and usage protected, after the four steps that put it on another place, plans and applies with the exact lines', async () => {
  const { core, client } = home();
  for (const [place, gauge] of [['engines', 'projects'], ['jobs', 'engines-usage']] as const) {
    const plan = must(await client.planLayoutSwap(place, gauge));
    must(await client.applyLayout(plan, core.approve(plan.nonce)));
  }
  await lifecycleStep(core, client, must(await client.planDisable('jobs')));
  const before = must(await client.readLayout());
  assert.deepEqual(before.layout.tiles.map(tile => `${tile.place} ${tile.gauge} ${tile.default}`), ['engines projects projects', 'jobs engines-usage engines-usage', 'harnesses harnesses harnesses', 'models local-models local-models', 'memory memory-explorer memory-explorer']);
  const plan = must(await client.planUpdate('engines-protected'));
  assert.deepEqual(plan.steps.filter(line => line.startsWith('layout: ')), [
    'layout: tile engines holds engines-usage large instead of projects',
    'layout: place engines has the default engines-usage',
    'layout: tile jobs holds projects large instead of engines-usage',
    'layout: place jobs has the default projects',
    `layout: keep the layout now in use as revision ${before.revision}, and keep at most 10 earlier revisions`,
  ]);
  await lifecycleStep(core, client, plan);
  const after = must(await client.readLayout());
  assert.deepEqual(after.layout.tiles.map(tile => `${tile.place} ${tile.gauge} ${tile.default} ${tile.size}`), [
    'engines engines-usage engines-usage large', 'jobs projects projects large', 'harnesses harnesses harnesses medium', 'models local-models local-models small', 'memory memory-explorer memory-explorer small',
  ]);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(core.layoutStartCheck(), null);
});

/** The lines that a lifecycle plan should have, worked out here from the layout before and after the step, by another route than the code. */
const lineDiff = (before: Layout, after: Layout): string[] => {
  const out: string[] = [];
  const places = new Set([...before.tiles.map(tile => tile.place), ...after.tiles.map(tile => tile.place)]);
  for (const place of [...places].sort()) {
    const b = before.tiles.find(tile => tile.place === place), a = after.tiles.find(tile => tile.place === place);
    if (b && !a) out.push(`layout: drop tile ${place} (${b.gauge})`);
    else if (!b && a) out.push(`layout: add tile ${place} (${a.gauge} ${a.size} at column ${a.col} row ${a.row})`);
    else if (b && a) {
      if (b.gauge !== a.gauge) out.push(`layout: tile ${place} holds ${a.gauge} ${a.size} instead of ${b.gauge}`);
      else if (b.size !== a.size) out.push(`layout: tile ${place} changes from ${b.size} to ${a.size}`);
      if (b.col !== a.col || b.row !== a.row) out.push(`layout: tile ${place} moves from column ${b.col} row ${b.row} to column ${a.col} row ${a.row}`);
      if (b.default !== a.default) out.push(`layout: place ${place} has the default ${a.default}`);
    }
  }
  for (const id of before.shelf) if (!after.shelf.includes(id)) out.push(`layout: remove ${id} from the shelf`);
  for (const id of after.shelf) if (!before.shelf.includes(id)) out.push(`layout: add ${id} to the shelf`);
  for (const id of before.hidden) if (!after.hidden.includes(id)) out.push(`layout: remove ${id} from the hidden list`);
  for (const id of after.hidden) if (!before.hidden.includes(id)) out.push(`layout: add ${id} to the hidden list`);
  return out.sort();
};

test('a long sequence of swaps, disables, enables, and protect flips on one core never throws, and every lifecycle plan describes exactly what changed', async () => {
  let flipsTotal = 0, stepsTotal = 0, swapsTotal = 0;
  for (const seed of [3, 17, 91]) {
    let state = seed;
    const pick = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const choose = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length)] as T;
    const core = createFakeCore({ home: true, folders: LAYOUT_FOLDERS });
    const client = createCoreClient(core);
    const gauges = ['engines-usage', 'jobs', 'local-models', 'memory-explorer', 'projects', 'library', 'tracing', 'fixture-clock'];
    let flips = 0, lifecycleSteps = 0;
    for (let step = 0; step < 80; step += 1) {
      const layout = must(await client.readLayout());
      const kind = choose(['swap', 'swap', 'default', 'disable', 'enable', 'flip', 'hide']);
      if (kind === 'swap' || kind === 'default') {
        const place = choose(layout.layout.tiles).place;
        const plan = kind === 'swap' ? await client.planLayoutSwap(place, choose(gauges)) : await client.planLayoutDefault(place);
        if (plan.ok) { must(await client.applyLayout(plan.value, core.approve(plan.value.nonce))); swapsTotal += 1; }
      } else if (kind === 'hide') {
        const id = choose(layout.layout.shelf.filter(entry => entry !== 'settings' && !['gauge-manager', 'harnesses', 'jobs-protected', 'engines-usage'].includes(entry) || entry === 'library'));
        const plan = await client.planLayoutSet(JSON.stringify({ ...layoutObject(layout.layout), shelf: layout.layout.shelf.filter(entry => entry !== id), hidden: [...layout.layout.hidden, id].sort() }));
        if (plan.ok) must(await client.applyLayout(plan.value, core.approve(plan.value.nonce)));
      } else {
        const id = choose(gauges);
        const plan = kind === 'disable' ? await client.planDisable(id) : kind === 'enable' ? await client.planEnable(id) : await client.planUpdate(id === 'jobs' || (flips % 2 === 0 && pick() < 0.5) ? 'jobs-protected' : 'engines-protected');
        if (!plan.ok) continue;
        const lines = plan.value.steps.filter(line => line.startsWith('layout: ') && !line.startsWith('layout: keep ') && !line.startsWith('layout: drop revision') && !line.startsWith('layout: replace revision')).sort();
        must(await client.applyPlan(plan.value, core.approve(plan.value.nonce)));
        const after = must(await client.readLayout());
        lifecycleSteps += 1;
        if (kind === 'flip') flips += 1;
        const expected = lineDiff(layout.layout, after.layout);
        // A plan names a Gauge that was just enabled and changed nothing else only through the shelf, so the lines and the difference are the same set.
        assert.deepEqual(lines, expected, `seed ${seed} step ${step} ${kind}`);
        assert.equal(core.layoutStartCheck(), null);
      }
    }
    assert.ok(lifecycleSteps > 5, String(lifecycleSteps));
    flipsTotal += flips;
    stepsTotal += lifecycleSteps;
  }
  // The run reaches what it is meant to: protect flips, other lifecycle steps, and swaps.
  assert.ok(flipsTotal >= 2 && stepsTotal >= 30 && swapsTotal >= 30, `${flipsTotal} ${stepsTotal} ${swapsTotal}`);
});

test('a file with a byte order mark stays in safe mode through the step that installs the missing Gauge, and is not loaded', async () => {
  const doc = JSON.parse(JSON.stringify(HOME_DOC)) as typeof HOME_DOC;
  doc.shelf.push('fixture-quiet');
  doc.shelf.sort();
  const body = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 5, current: doc, revisions: [] }) + '\n';
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
  const core = createFakeCore({ home: true, folders: quietFolders, layoutFile: bytes });
  const client = createCoreClient(core);
  assert.equal(must(await client.readLayout()).safe?.reason, 'syntax');
  await lifecycleStep(core, client, must(await client.planInstall('quiet-folder')));
  const enable = must(await client.planEnable('fixture-quiet'));
  assert.deepEqual(enable.steps.filter(line => line.startsWith('layout: ')), []);
  await lifecycleStep(core, client, enable);
  assert.deepEqual(must(await client.readLayout()).safe, { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' });
  assert.equal(must(await client.readLayout()).revision, 0);
});

test('loading a saved layout that a step made readable does not write the file again: a file that is not in canonical form stays as it was', async () => {
  const doc = JSON.parse(JSON.stringify(HOME_DOC)) as typeof HOME_DOC;
  doc.shelf.push('fixture-quiet');
  doc.shelf.sort();
  const pretty = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 7, current: { ...doc, tiles: [...doc.tiles].reverse() }, revisions: [] }, null, 2);
  const core = createFakeCore({ home: true, folders: quietFolders, layoutFile: pretty });
  const client = createCoreClient(core);
  assert.ok(must(await client.readLayout()).safe);
  await lifecycleStep(core, client, must(await client.planInstall('quiet-folder')));
  await lifecycleStep(core, client, must(await client.planEnable('fixture-quiet')));
  const state = must(await client.readLayout());
  assert.equal(state.safe, null);
  assert.equal(state.revision, 7);
  assert.equal(core.layoutFile(), pretty);
  assert.deepEqual(core.layoutBackup(), null);
});

test('the client sends only the own lists of a plan: a plan that inherits its steps or permissions is not sent with them, and the core refuses it', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const spy = { call: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return { ok: false as const, code: 'GAUGE_PLAN_CHANGED' }; } };
  const client = createCoreClient(spy as never);
  const A = 'a'.repeat(64);
  const lifecycle = { action: 'install', id: 'x', folder: 'f', from: null, to: '1.0.0', origin: 'user', steps: ['one'], digest: A, manifestHash: A, folderHash: A, nonce: A };
  const grant = { action: 'grant', id: 'x', version: '1.0.0', permissions: ['engines.read'], steps: ['one'], digest: A, manifestHash: A, folderHash: A, nonce: A };
  const layout = { action: 'layout', kind: 'swap', place: 'p', gauge: 'g', revision: null, text: null, steps: ['one'], digest: A, baseHash: A, nextHash: A, nonce: A };
  await client.applyPlan(Object.create(lifecycle) as never, 'a');
  await client.applyGrant(Object.create(grant) as never, 'a');
  await client.applyLayout(Object.create(layout) as never, 'a');
  for (const call of calls) assert.deepEqual(call.params['plan'], {}, call.method);
  calls.length = 0;
  const { steps, ...rest } = lifecycle;
  await client.applyPlan(Object.assign(Object.create({ steps }) as object, rest) as never, 'a');
  assert.equal(Object.hasOwn(calls[0]?.params['plan'] as object, 'steps'), false);
  calls.length = 0;
  await client.applyPlan(lifecycle as never, 'a');
  assert.deepEqual((calls[0]?.params['plan'] as { steps: string[] }).steps, ['one']);
});

test('the same four steps end, with a sixth and a seventh tile on the layout, whatever the parity of the tile count', async () => {
  const extra = [
    { place: 'extra-1', gauge: 'library', default: 'library', col: 0, row: 2, size: 'small' },
    { place: 'extra-2', gauge: 'tracing', default: 'tracing', col: 1, row: 2, size: 'small' },
  ];
  for (const count of [1, 2]) {
    const { core, client } = home();
    const given = extra.slice(0, count);
    const set = must(await client.planLayoutSet(JSON.stringify({ ...HOME_DOC, tiles: [...HOME_DOC.tiles, ...given], shelf: HOME_DOC.shelf.filter(id => !given.some(tile => tile.gauge === id)) })));
    must(await client.applyLayout(set, core.approve(set.nonce)));
    for (const [place, gauge] of [['engines', 'projects'], ['jobs', 'engines-usage']] as const) {
      const plan = must(await client.planLayoutSwap(place, gauge));
      must(await client.applyLayout(plan, core.approve(plan.nonce)));
    }
    await lifecycleStep(core, client, must(await client.planDisable('jobs')));
    const plan = must(await client.planUpdate('engines-protected'));
    await lifecycleStep(core, client, plan);
    const after = must(await client.readLayout());
    assert.equal(after.layout.tiles.length, 5 + count);
    assert.equal(after.layout.tiles.find(tile => tile.place === 'engines')?.gauge, 'engines-usage', String(count));
    assert.equal(after.layout.tiles.find(tile => tile.place === 'jobs')?.gauge, 'projects', String(count));
    assert.equal(core.layoutStartCheck(), null);
  }
});
