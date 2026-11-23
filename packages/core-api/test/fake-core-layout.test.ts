import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFakeCore, type GaugeFolder } from '../src/fake-core.js';
import { createCoreClient } from '../src/client.js';
import { layoutSteps } from '../src/layout-plan.js';
import { FIXTURE_GAUGES } from '../src/fixtures.js';
import type { LayoutPlan } from '../src/types.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { HOME_DOC, LAYOUT_FOLDERS, runLayoutSuite } from './layout-suite.js';

// The one layout suite, run against the fake core. The fake core gives the person's approval through its own `approve`, which no Gauge can reach.
runLayoutSuite('fake core layout', (folders, options) => {
  let now = 1_000_000;
  const core = createFakeCore({ folders, home: true, now: () => now, ...(options.layoutFile === undefined ? {} : { layoutFile: options.layoutFile }) });
  return { core, approve: plan => core.approve(plan.nonce), advance: milliseconds => { now += milliseconds; } };
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
  const steps = layoutSteps({ kind: 'swap', place: hostile, gauge: hostile, revision: null, base: layout, next: layout, baseHash: hostile, nextHash: hostile, baseRevision: 1, safe: false });
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

test('a counter that is full refuses the change with bad_revision, and nothing changes, so the approval stays good for a retry elsewhere', async () => {
  const full = FIRST_FILE.replace('"revision":1,"current"', '"revision":999999999,"current"');
  const { core, client } = home({ layoutFile: full });
  assert.equal(must(await client.readLayout()).revision, 999_999_999);
  const plan = must(await client.planLayoutSwap('models', 'tracing'));
  assert.deepEqual(await core.call('bowerloom.layout.apply', { plan, approval: core.approve(plan.nonce) }), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' });
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
