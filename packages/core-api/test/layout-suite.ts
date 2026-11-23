// The layout suite: the layout file, the swap, the default Gauge, export and import, the way back, revisions, safe mode, and a Gauge that proposes to add itself, all through
// the client. Like the other suites, it takes the core as a parameter, so the same suite runs against the fake core now and against the real core later.
// The core it is given holds the nine stock Gauges of the bento home and the three fixture Gauges, and the folders given to `makeHarness`. Every expected value is written out
// here by hand, and none is read from the core, so a wrong core fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { Core, GaugePlan, LayoutPlan } from '../src/types.js';
import type { GaugeFolder } from '../src/fake-core.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { APPROVAL_TTL_MS } from './lifecycle-suite.js';

export interface LayoutHarness {
  readonly core: Core;
  /** The person approves one plan, the one they saw. Works for any kind of plan. Gives back the approval. */
  approve(plan: { readonly nonce: string }): string | Promise<string>;
  /** Moves the clock of the core forward, in milliseconds. */
  advance(milliseconds: number): void | Promise<void>;
  /** The raw bytes of the saved layout file that the core set aside when a change left safe mode, or `null` when it set none aside. */
  layoutBackup(): Uint8Array | null | Promise<Uint8Array | null>;
}
export interface LayoutHarnessOptions {
  /** The text of the saved layout file that the core finds when it starts. None means a first start. */
  readonly layoutFile?: string;
}

const FILE = 'export default 1;';
const base = JSON.parse(validManifest('tile-only')) as Record<string, unknown>;
const manifestOf = (fields: Record<string, unknown>): string => JSON.stringify({ ...base, ...fields });

/** The folders the suite loads. Written out here. */
export const LAYOUT_FOLDERS: readonly GaugeFolder[] = [
  // A Gauge that may propose itself, and whose tile allows two sizes, the medium one preferred.
  { name: 'proposer-folder', location: 'user', manifest: manifestOf({ id: 'fixture-proposer', title: 'Fixture Proposer', permissions: ['layout.propose'], tile: { expandable: false, resizable: true, entry: 'ui/tile.js', sizes: ['medium', 'small'] } }), files: { 'ui/tile.js': FILE } },
  // A Gauge with no permission at all.
  { name: 'quiet-folder', location: 'user', manifest: manifestOf({ id: 'fixture-quiet', title: 'Fixture Quiet', tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }), files: { 'ui/tile.js': FILE } },
  // A Gauge whose tile cannot be resized.
  { name: 'fixed-folder', location: 'user', manifest: manifestOf({ id: 'fixture-fixed', title: 'Fixture Fixed', permissions: ['layout.propose'], tile: { expandable: false, resizable: false, entry: 'ui/tile.js' } }), files: { 'ui/tile.js': FILE } },
  // A Gauge that is a page only.
  { name: 'page-folder', location: 'user', manifest: manifestOf({ id: 'fixture-pager', title: 'Fixture Pager', permissions: ['layout.propose'], tile: undefined, page: { entry: 'ui/page.js' } }), files: { 'ui/page.js': FILE } },
  // The same Gauge, one version later, whose tile can no longer be resized.
  { name: 'quiet-fixed-update', location: 'user', manifest: manifestOf({ id: 'fixture-quiet', title: 'Fixture Quiet', version: '1.1.0', tile: { expandable: false, resizable: false, entry: 'ui/tile.js' } }), files: { 'ui/tile.js': FILE } },
  // A stock Gauge that is protected.
  { name: 'guard-folder', location: 'bundled', manifest: manifestOf({ id: 'fixture-guard', title: 'Fixture Guard', protected: true, tile: { expandable: false, resizable: false, entry: 'ui/tile.js' } }), files: { 'ui/tile.js': FILE } },
  // A stock update that makes Jobs protected.
  { name: 'jobs-protected', location: 'bundled', manifest: manifestOf({ id: 'jobs', title: 'Jobs', version: '2.0.0', protected: true, tile: { expandable: false, resizable: true, entry: 'ui/tile.js', sizes: ['large', 'medium', 'full'] } }), files: { 'ui/tile.js': FILE } },
  // A Gauge that tries to take the id of the Settings page.
  { name: 'settings-folder', location: 'user', manifest: manifestOf({ id: 'settings', title: 'Fixture Settings', tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }), files: { 'ui/tile.js': FILE } },
];

/** The home that a first start opens on, written out here: the five default tiles, and every other Gauge and the Settings page one step away. */
export const HOME_DOC = {
  format: 'bowerloom/layout/1',
  grid: { columns: 6, unit: 200, gap: 12 },
  tiles: [
    { place: 'engines', gauge: 'engines-usage', default: 'engines-usage', col: 0, row: 0, size: 'large' },
    { place: 'jobs', gauge: 'jobs', default: 'jobs', col: 2, row: 0, size: 'large' },
    { place: 'harnesses', gauge: 'harnesses', default: 'harnesses', col: 4, row: 0, size: 'medium' },
    { place: 'models', gauge: 'local-models', default: 'local-models', col: 4, row: 1, size: 'small' },
    { place: 'memory', gauge: 'memory-explorer', default: 'memory-explorer', col: 5, row: 1, size: 'small' },
  ],
  shelf: ['fixture-clock', 'fixture-manager', 'fixture-preset', 'gauge-manager', 'library', 'projects', 'settings', 'tracing'],
  hidden: [],
};
const clone = <T>(value: T): T => structuredClone(value);
/** The home with a change, as the text of a layout. */
const homeText = (change: (home: typeof HOME_DOC) => unknown = home => home): string => JSON.stringify(change(clone(HOME_DOC)));
const tiles = (...more: object[]) => (home: typeof HOME_DOC) => ({ ...home, tiles: [...home.tiles, ...more] });

const HEX = /^[0-9a-f]{64}$/;
const LAYOUT_KEYS = ['action', 'baseHash', 'digest', 'gauge', 'kind', 'nextHash', 'nonce', 'place', 'revision', 'steps', 'text'];
const invalid = (reason: string) => ({ ok: false, code: 'GAUGE_LAYOUT_INVALID', reason });
const protectedBy = (reason: string) => ({ ok: false, code: 'GAUGE_PROTECTED', reason });
const outcome = (result: { ok: boolean; code?: string; reason?: string }) => (result.ok ? { ok: true } : result.reason === undefined ? { ok: false, code: result.code } : { ok: false, code: result.code, reason: result.reason });

/** Registers the layout tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runLayoutSuite(name: string, makeHarness: (folders: readonly GaugeFolder[], options: LayoutHarnessOptions) => LayoutHarness | Promise<LayoutHarness>): void {
  const start = async (options: LayoutHarnessOptions = {}) => {
    const harness = await makeHarness(LAYOUT_FOLDERS, options);
    return { harness, core: harness.core, client: createCoreClient(harness.core) };
  };
  type Session = Awaited<ReturnType<typeof start>>;

  const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  const read = async (client: CoreClient) => must(await client.readLayout());
  /** Plans a change, approves it as the person, and applies it. */
  const change = async (s: Session, planned: Promise<{ ok: true; value: LayoutPlan } | { ok: false; code: string; reason?: string }>) => {
    const plan = must(await planned);
    return { plan, applied: must(await s.client.applyLayout(plan, await s.harness.approve(plan))) };
  };
  const lifecycle = async (s: Session, planned: Promise<{ ok: true; value: GaugePlan } | { ok: false; code: string }>) => {
    const plan = must(await planned);
    must(await s.client.applyPlan(plan, await s.harness.approve(plan)));
    return plan;
  };
  const bring = async (s: Session, folder: string, id: string, enable = true) => {
    await lifecycle(s, s.client.planInstall(folder));
    if (enable) await lifecycle(s, s.client.planEnable(id));
  };
  const grantPropose = async (s: Session, id: string) => {
    const plan = must(await s.client.planGrant(id, ['layout.propose']));
    must(await s.client.applyGrant(plan, await s.harness.approve(plan)));
  };
  const placeOf = (state: { layout: { tiles: readonly { place: string; gauge: string }[] } }, place: string) => state.layout.tiles.find(tile => tile.place === place)?.gauge;
  /** The state a refused change must leave alone. */
  const frozenState = async (client: CoreClient) => ({ state: await read(client), revisions: must(await client.listLayoutRevisions()), file: must(await client.exportLayout()) });

  test(`${name}: makeHarness gives a distinct core on each call`, async () => {
    const one = await start(), two = await start();
    assert.notEqual(one.core, two.core);
  });

  // The home

  test(`${name}: a first start opens on the default home: five tiles in the arrangement of the home, revision 1, and not in safe mode`, async () => {
    const { client } = await start();
    const state = await read(client);
    assert.deepEqual(state.layout, HOME_DOC);
    assert.equal(state.revision, 1);
    assert.equal(state.safe, null);
    assert.deepEqual(must(await client.listLayoutRevisions()), []);
  });

  test(`${name}: the grid is 6 columns, a unit of 200 px, and a gap of 12 px, and the five default tiles fill the first two rows`, async () => {
    const { client } = await start();
    const { layout } = await read(client);
    assert.deepEqual(layout.grid, { columns: 6, unit: 200, gap: 12 });
    const cells = new Set<string>();
    for (const tile of layout.tiles) {
      const { w, h } = { small: { w: 1, h: 1 }, medium: { w: 2, h: 1 }, large: { w: 2, h: 2 }, full: { w: 6, h: 2 } }[tile.size];
      for (let row = tile.row; row < tile.row + h; row += 1) for (let col = tile.col; col < tile.col + w; col += 1) cells.add(`${col},${row}`);
    }
    assert.equal(cells.size, 12);
    assert.equal([...cells].every(cell => /^[0-5],[01]$/.test(cell)), true);
  });

  test(`${name}: the Gauge manager and Settings are one step away on a first start, and every Gauge of the layout is one the core holds`, async () => {
    const { client } = await start();
    const { layout } = await read(client);
    assert.ok(layout.shelf.includes('gauge-manager'));
    assert.ok(layout.shelf.includes('settings'));
    const held = new Set(must(await client.listGauges()).map(gauge => gauge.id));
    for (const id of [...layout.tiles.map(tile => tile.gauge), ...layout.shelf.filter(entry => entry !== 'settings'), ...layout.hidden]) assert.ok(held.has(id), id);
  });

  // Export and import

  test(`${name}: an export is one line of compact JSON that reads back as the layout, in canonical order`, async () => {
    const { client } = await start();
    const text = must(await client.exportLayout());
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.indexOf('\n'), text.length - 1);
    assert.deepEqual(JSON.parse(text), HOME_DOC);
    assert.deepEqual(Object.keys(JSON.parse(text) as object), ['format', 'grid', 'tiles', 'shelf', 'hidden']);
  });

  test(`${name}: export then import gives the same layout, in the same bytes`, async () => {
    const s = await start();
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    const exported = must(await s.client.exportLayout());
    const first = await read(s.client);
    await change(s, s.client.planLayoutSwap('models', 'library'));
    await change(s, s.client.planLayoutSwap('jobs', 'projects'));
    assert.notDeepEqual((await read(s.client)).layout, first.layout);
    const { applied } = await change(s, s.client.planLayoutSet(exported));
    assert.equal(applied.changed, true);
    assert.deepEqual((await read(s.client)).layout, first.layout);
    assert.equal(must(await s.client.exportLayout()), exported);
  });

  test(`${name}: importing the layout that is already in use changes nothing and writes no revision`, async () => {
    const s = await start();
    const before = await frozenState(s.client);
    const { applied } = await change(s, s.client.planLayoutSet(must(await s.client.exportLayout())));
    assert.deepEqual(applied, { kind: 'set', revision: 1, changed: false });
    assert.deepEqual(await frozenState(s.client), before);
  });

  test(`${name}: an import in another order is saved in the canonical order`, async () => {
    const s = await start();
    const shuffled = homeText(home => ({ ...home, tiles: [...home.tiles].reverse(), shelf: [...home.shelf].reverse() }));
    const { applied } = await change(s, s.client.planLayoutSet(shuffled));
    assert.equal(applied.changed, false);
    assert.deepEqual((await read(s.client)).layout, HOME_DOC);
  });

  test(`${name}: an import is validated like a manifest, with an exact code and reason, and a refused import changes nothing`, async () => {
    const s = await start();
    await bring(s, 'quiet-folder', 'fixture-quiet', false);
    const text = homeText();
    const long = Array.from({ length: 10_000 }, (_, index) => ({ place: `p${index}`, gauge: 'jobs', default: 'jobs', col: 0, row: 0, size: 'small' }));
    const cases: readonly (readonly [string, string, object])[] = [
      ['a byte order mark', `\uFEFF${text}`, invalid('syntax')],
      ['a text over the size cap', text + ' '.repeat(32768), invalid('too_large')],
      ['10,000 tiles', homeText(home => ({ ...home, tiles: long })), invalid('too_large')],
      ['a duplicate key', text.replace('{', '{"hidden":[],'), invalid('duplicate_key')],
      ['a comment', `// note\n${text}`, invalid('comment')],
      ['a trailing comma', `${text.slice(0, -1)},}`, invalid('trailing_comma')],
      ['not JSON', 'not json', invalid('syntax')],
      ['an empty text', '', invalid('syntax')],
      ['an unknown field', homeText(home => ({ ...home, extra: 1 })), invalid('unknown_field')],
      ['an unknown field in a tile', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], extra: 1 }] })), invalid('unknown_field')],
      ['a __proto__ key', text.replace('{', '{"__proto__":{"x":1},'), invalid('unknown_field')],
      ['another format', homeText(home => ({ ...home, format: 'bowerloom/layout/2' })), invalid('unsupported_format')],
      ['another grid', homeText(home => ({ ...home, grid: { columns: 4, unit: 200, gap: 12 } })), invalid('unsupported_grid')],
      ['an unknown size', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], size: 'huge' }] })), invalid('unknown_size')],
      ['a fractional column', text.replace('"col":2', '"col":1.5'), invalid('invalid_field')],
      ['a negative row', text.replace('"row":1', '"row":-1'), invalid('out_of_grid')],
      ['a huge column', text.replace('"col":2', '"col":1e300'), invalid('invalid_field')],
      ['a Gauge id that is not text', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], gauge: 5 }] })), invalid('invalid_field')],
      ['a tile larger than the grid', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], col: 1, size: 'full' }] })), invalid('out_of_grid')],
      ['two tiles that overlap', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], size: 'full' }, ...home.tiles.slice(1)] })), invalid('overlap')],
      ['a Gauge that does not exist', homeText(home => ({ ...home, shelf: [...home.shelf, 'no-such-gauge'] })), invalid('unknown_gauge')],
      ['a Gauge that is disabled', homeText(home => ({ ...home, shelf: [...home.shelf, 'fixture-quiet'] })), invalid('gauge_disabled')],
      ['a Gauge used twice', homeText(home => ({ ...home, shelf: [...home.shelf, 'jobs'] })), invalid('duplicate_gauge')],
      ['a Gauge with no tile in a place', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], gauge: 'fixture-clock', default: 'fixture-clock' }, ...home.tiles.slice(1)], shelf: home.shelf.filter(id => id !== 'fixture-clock') })), invalid('no_tile')],
      ['a size that the Gauge does not allow', homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], size: 'small' }] })), invalid('size_not_allowed')],
    ];
    for (const [label, input, expected] of cases) {
      const before = await frozenState(s.client);
      assert.deepEqual(outcome(await s.client.planLayoutSet(input)), expected, label);
      assert.deepEqual(await frozenState(s.client), before, label);
    }
  });

  test(`${name}: a layout text that is not a string is a bad request, with nothing changed`, async () => {
    const { core, client } = await start();
    for (const text of [undefined, null, 5, {}, [], Uint8Array.from([0xff, 0xfe])]) {
      assert.deepEqual(await core.call('bowerloom.layout.plan', { kind: 'set', text }), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_request' }, String(text));
    }
    assert.deepEqual(await read(client), { layout: HOME_DOC, revision: 1, safe: null });
  });

  // The way back

  test(`${name}: a layout that hides the Gauge manager or Settings is refused with GAUGE_PROTECTED and the reason hidden`, async () => {
    const { client } = await start();
    for (const id of ['gauge-manager', 'settings', 'harnesses']) {
      const hiding = homeText(home => ({ ...home, tiles: home.tiles.filter(tile => tile.gauge !== id), shelf: home.shelf.filter(entry => entry !== id), hidden: [id] }));
      assert.deepEqual(outcome(await client.planLayoutSet(hiding)), protectedBy('hidden'), id);
    }
  });

  test(`${name}: a layout that removes the Gauge manager or Settings is refused with GAUGE_PROTECTED and the reason removed`, async () => {
    const { client } = await start();
    for (const id of ['gauge-manager', 'settings']) assert.deepEqual(outcome(await client.planLayoutSet(homeText(home => ({ ...home, shelf: home.shelf.filter(entry => entry !== id) })))), protectedBy('removed'), id);
    assert.deepEqual(outcome(await client.planLayoutSet(homeText(home => ({ ...home, tiles: home.tiles.filter(tile => tile.gauge !== 'harnesses') })))), protectedBy('removed'));
  });

  test(`${name}: a layout that replaces a protected Gauge in its place is refused with GAUGE_PROTECTED and the reason replaced`, async () => {
    const { client } = await start();
    const replacing = homeText(home => ({ ...home, tiles: home.tiles.map(tile => (tile.place === 'harnesses' ? { ...tile, gauge: 'library' } : tile)), shelf: [...home.shelf.filter(id => id !== 'library'), 'harnesses'] }));
    assert.deepEqual(outcome(await client.planLayoutSet(replacing)), protectedBy('replaced'));
    assert.deepEqual(outcome(await client.planLayoutSwap('harnesses', 'library')), protectedBy('replaced'));
  });

  test(`${name}: the Gauge manager can be put on the home as a tile, and then it cannot be swapped out`, async () => {
    const s = await start();
    const withManager = homeText(home => ({ ...home, tiles: [...home.tiles, { place: 'manager', gauge: 'gauge-manager', default: 'gauge-manager', col: 0, row: 2, size: 'medium' }], shelf: home.shelf.filter(id => id !== 'gauge-manager') }));
    await change(s, s.client.planLayoutSet(withManager));
    assert.equal(placeOf(await read(s.client), 'manager'), 'gauge-manager');
    assert.deepEqual(outcome(await s.client.planLayoutSwap('manager', 'library')), protectedBy('replaced'));
  });

  test(`${name}: the id of the Settings page is reserved, so no Gauge can install under it`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('settings-folder'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
  });

  // The sizes that a Gauge allows

  test(`${name}: a layout may only use the sizes that a Gauge allows, and a tile that cannot be resized keeps its one size`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await bring(s, 'fixed-folder', 'fixture-fixed');
    const add = (gauge: string, size: string) => tiles({ place: 'extra', gauge, default: gauge, col: 0, row: 2, size });
    assert.deepEqual(outcome(await s.client.planLayoutSet(homeText(add('fixture-proposer', 'large')))), invalid('size_not_allowed'));
    assert.deepEqual(outcome(await s.client.planLayoutSet(homeText(add('fixture-proposer', 'full')))), invalid('size_not_allowed'));
    assert.deepEqual(outcome(await s.client.planLayoutSet(homeText(add('fixture-fixed', 'medium')))), invalid('not_resizable'));
    assert.deepEqual(outcome(await s.client.planLayoutSet(homeText(add('fixture-fixed', 'full')))), invalid('not_resizable'));
    assert.equal((await s.client.planLayoutSet(homeText(add('fixture-proposer', 'medium')))).ok, true);
    assert.equal((await s.client.planLayoutSet(homeText(add('fixture-proposer', 'small')))).ok, true);
    assert.equal((await s.client.planLayoutSet(homeText(add('fixture-fixed', 'small')))).ok, true);
  });

  // Swap

  test(`${name}: a swap is a plan that the person approves: it shows the change and changes nothing until it is applied with an approval`, async () => {
    const s = await start();
    const plan = must(await s.client.planLayoutSwap('models', 'tracing'));
    assert.deepEqual(Object.keys(plan).sort(), LAYOUT_KEYS);
    assert.deepEqual({ action: plan.action, kind: plan.kind, place: plan.place, gauge: plan.gauge, revision: plan.revision, text: plan.text }, { action: 'layout', kind: 'swap', place: 'models', gauge: 'tracing', revision: null, text: null });
    for (const field of ['digest', 'nonce', 'baseHash', 'nextHash'] as const) assert.match(plan[field], HEX, field);
    assert.notEqual(plan.baseHash, plan.nextHash);
    assert.equal(plan.steps[0], 'swap place models from local-models to tracing');
    assert.ok(plan.steps.includes('tile models: tracing small at column 4 row 1'));
    assert.ok(plan.steps.includes(`bind the change to layout ${plan.baseHash} and result ${plan.nextHash}`));
    for (const line of plan.steps) assert.equal(/[\n\r\u2028\u2029]/.test(line), false, line);
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
    assert.deepEqual(outcome(await s.client.applyLayout(plan)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(outcome(await s.client.applyLayout(plan, 'not-an-approval')), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
  });

  test(`${name}: an approved swap puts the Gauge in the place, keeps the default Gauge of the place, and keeps the earlier layout as revision 1`, async () => {
    const s = await start();
    const { applied } = await change(s, s.client.planLayoutSwap('models', 'tracing'));
    assert.deepEqual(applied, { kind: 'swap', revision: 2, changed: true });
    const state = await read(s.client);
    assert.deepEqual(state.layout.tiles.find(tile => tile.place === 'models'), { place: 'models', gauge: 'tracing', default: 'local-models', col: 4, row: 1, size: 'small' });
    assert.deepEqual(state.layout.shelf, ['fixture-clock', 'fixture-manager', 'fixture-preset', 'gauge-manager', 'library', 'local-models', 'projects', 'settings']);
    assert.equal(state.revision, 2);
    assert.deepEqual(must(await s.client.listLayoutRevisions()), [{ revision: 1, layout: HOME_DOC }]);
  });

  test(`${name}: the default Gauge stays one action away: the default action puts it back, and the layout is the one from before the swap`, async () => {
    const s = await start();
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    const plan = must(await s.client.planLayoutDefault('models'));
    assert.equal(plan.steps[0], 'put the default Gauge local-models back in place models');
    await s.client.applyLayout(plan, await s.harness.approve(plan));
    assert.deepEqual((await read(s.client)).layout, HOME_DOC);
    assert.equal((await read(s.client)).revision, 3);
  });

  test(`${name}: a swap keeps the size of the place when the new Gauge allows it, and takes the first size it allows otherwise`, async () => {
    const s = await start();
    await bring(s, 'fixed-folder', 'fixture-fixed');
    await change(s, s.client.planLayoutSwap('jobs', 'library'));
    assert.equal((await read(s.client)).layout.tiles.find(tile => tile.place === 'jobs')?.size, 'large');
    await change(s, s.client.planLayoutSwap('jobs', 'fixture-fixed'));
    assert.deepEqual((await read(s.client)).layout.tiles.find(tile => tile.place === 'jobs'), { place: 'jobs', gauge: 'fixture-fixed', default: 'jobs', col: 2, row: 0, size: 'small' });
  });

  test(`${name}: a swap that is refused leaves the layout, the revisions, and the file as they were`, async () => {
    const s = await start();
    await bring(s, 'quiet-folder', 'fixture-quiet', false);
    await bring(s, 'page-folder', 'fixture-pager');
    const cases: readonly (readonly [string, string, object])[] = [
      ['nowhere', 'tracing', invalid('unknown_place')],
      ['', 'tracing', invalid('unknown_place')],
      ['__proto__', 'tracing', invalid('unknown_place')],
      ['models', 'nowhere', { ok: false, code: 'UNKNOWN_GAUGE' }],
      ['models', 'settings', { ok: false, code: 'UNKNOWN_GAUGE' }],
      ['models', '__proto__', { ok: false, code: 'UNKNOWN_GAUGE' }],
      ['models', 'fixture-quiet', invalid('gauge_disabled')],
      ['models', 'fixture-pager', invalid('no_tile')],
      ['models', 'fixture-clock', invalid('no_tile')],
      ['models', 'jobs', invalid('duplicate_gauge')],
      ['harnesses', 'library', protectedBy('replaced')],
      ['models', 'gauge-manager', invalid('no_room')],
    ];
    for (const [place, gauge, expected] of cases) {
      const before = await frozenState(s.client);
      assert.deepEqual(outcome(await s.client.planLayoutSwap(place, gauge)), expected, `${place} ${gauge}`);
      assert.deepEqual(await frozenState(s.client), before, `${place} ${gauge}`);
    }
  });

  test(`${name}: a plan with a place or a Gauge that is not text is refused, and so is a kind that does not exist`, async () => {
    const { core, client } = await start();
    const before = await frozenState(client);
    for (const place of [undefined, null, 5, {}, [], true]) assert.deepEqual(await core.call('bowerloom.layout.plan', { kind: 'swap', place, gauge: 'tracing' }), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_place' }, String(place));
    for (const gauge of [undefined, null, 5, {}, [], true]) assert.deepEqual(await core.call('bowerloom.layout.plan', { kind: 'swap', place: 'models', gauge }), { ok: false, code: 'UNKNOWN_GAUGE' }, String(gauge));
    for (const kind of [undefined, null, 5, 'explode', 'Swap', '', '__proto__', {}]) assert.deepEqual(await core.call('bowerloom.layout.plan', { kind, place: 'models', gauge: 'tracing' }), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_request' }, String(kind));
    assert.deepEqual(await frozenState(client), before);
  });

  // Plans and approvals

  test(`${name}: an approval works once, and a used approval is refused`, async () => {
    const s = await start();
    const plan = must(await s.client.planLayoutSwap('models', 'tracing'));
    const approval = await s.harness.approve(plan);
    must(await s.client.applyLayout(plan, approval));
    assert.deepEqual(outcome(await s.client.applyLayout(plan, approval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await read(s.client)).revision, 2);
  });

  test(`${name}: an approval lasts 15 minutes, and not one millisecond more`, async () => {
    const s = await start();
    const plan = must(await s.client.planLayoutSwap('models', 'tracing'));
    const approval = await s.harness.approve(plan);
    await s.harness.advance(APPROVAL_TTL_MS);
    assert.deepEqual(outcome(await s.client.applyLayout(plan, approval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    const again = must(await s.client.planLayoutSwap('models', 'tracing'));
    const fresh = await s.harness.approve(again);
    await s.harness.advance(APPROVAL_TTL_MS - 1);
    assert.equal((await s.client.applyLayout(again, fresh)).ok, true);
  });

  test(`${name}: an approval is for one plan: another plan, a changed plan, and a plan with another nonce are GAUGE_PLAN_CHANGED`, async () => {
    const s = await start();
    const plan = must(await s.client.planLayoutSwap('models', 'tracing'));
    const other = must(await s.client.planLayoutSwap('models', 'library'));
    const approval = await s.harness.approve(plan);
    assert.deepEqual(outcome(await s.client.applyLayout(other, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(outcome(await s.client.applyLayout({ ...plan, gauge: 'library' }, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(outcome(await s.client.applyLayout({ ...plan, steps: [...plan.steps, 'drop every tile'] }, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(outcome(await s.client.applyLayout({ ...plan, nextHash: plan.baseHash }, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(outcome(await s.client.applyLayout({ ...plan, nonce: other.nonce }, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
    assert.equal((await s.client.applyLayout(plan, approval)).ok, true);
  });

  test(`${name}: an approval of a Gauge step cannot apply a layout plan, and the approval of a layout plan cannot apply a Gauge step`, async () => {
    const s = await start();
    const layoutPlan = must(await s.client.planLayoutSwap('models', 'tracing'));
    const gaugePlan = must(await s.client.planInstall('quiet-folder'));
    const layoutApproval = await s.harness.approve(layoutPlan);
    const gaugeApproval = await s.harness.approve(gaugePlan);
    assert.deepEqual(outcome(await s.client.applyLayout(layoutPlan, gaugeApproval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(outcome(await s.client.applyPlan(gaugePlan, layoutApproval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
  });

  test(`${name}: an applied change ends every approval given before it, and retires every plan issued before it`, async () => {
    const s = await start();
    const first = must(await s.client.planLayoutSwap('models', 'tracing'));
    const second = must(await s.client.planLayoutSwap('memory', 'library'));
    const firstApproval = await s.harness.approve(first), secondApproval = await s.harness.approve(second);
    must(await s.client.applyLayout(first, firstApproval));
    assert.deepEqual(outcome(await s.client.applyLayout(second, secondApproval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal(placeOf(await read(s.client), 'memory'), 'memory-explorer');
  });

  test(`${name}: a plan made before a Gauge step cannot be approved after it`, async () => {
    const s = await start();
    const stale = must(await s.client.planLayoutSwap('models', 'tracing'));
    await lifecycle(s, s.client.planInstall('quiet-folder'));
    // The core may refuse to give an approval for a plan that it has retired, or give one that no longer works. Either way the plan cannot be applied.
    const approval = await Promise.resolve().then(() => s.harness.approve(stale)).catch(() => 'refused');
    assert.deepEqual(outcome(await s.client.applyLayout(stale, approval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
  });

  // Revisions

  test(`${name}: the file keeps 10 revisions: the 11th drops the oldest, newest first, and the current layout is never lost`, async () => {
    const s = await start();
    const swaps = ['tracing', 'library', 'projects'];
    for (let step = 0; step < 12; step += 1) await change(s, s.client.planLayoutSwap('models', swaps[step % 3] ?? 'tracing'));
    const state = await read(s.client);
    assert.equal(state.revision, 13);
    const revisions = must(await s.client.listLayoutRevisions());
    assert.deepEqual(revisions.map(entry => entry.revision), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(revisions.length, 10);
    assert.equal(placeOf(state, 'models'), 'projects');
    assert.equal(revisions[0]?.layout.tiles.find(tile => tile.place === 'models')?.gauge, 'library');
    assert.equal(revisions[9]?.layout.tiles.find(tile => tile.place === 'models')?.gauge, 'library');
  });

  test(`${name}: exactly 10 earlier revisions are kept, and the first 10 changes drop nothing`, async () => {
    const s = await start();
    const swaps = ['tracing', 'library'];
    for (let step = 0; step < 10; step += 1) await change(s, s.client.planLayoutSwap('models', swaps[step % 2] ?? 'tracing'));
    assert.deepEqual(must(await s.client.listLayoutRevisions()).map(entry => entry.revision), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.deepEqual(must(await s.client.listLayoutRevisions()).at(-1)?.layout, HOME_DOC);
  });

  test(`${name}: a person can restore an earlier layout, which becomes a new revision and keeps the one it replaced`, async () => {
    const s = await start();
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    await change(s, s.client.planLayoutSwap('models', 'library'));
    const plan = must(await s.client.planLayoutRestore(1));
    assert.equal(plan.steps[0], 'restore revision 1 as the new layout');
    assert.deepEqual({ kind: plan.kind, revision: plan.revision, place: plan.place, gauge: plan.gauge, text: plan.text }, { kind: 'restore', revision: 1, place: null, gauge: null, text: null });
    const applied = must(await s.client.applyLayout(plan, await s.harness.approve(plan)));
    assert.deepEqual(applied, { kind: 'restore', revision: 4, changed: true });
    assert.deepEqual((await read(s.client)).layout, HOME_DOC);
    assert.deepEqual(must(await s.client.listLayoutRevisions()).map(entry => entry.revision), [3, 2, 1]);
  });

  test(`${name}: a restore of a revision that is not held, or of a number that is not one, is refused and changes nothing`, async () => {
    const s = await start();
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    const before = await frozenState(s.client);
    for (const revision of [2, 0, -1, 99, 1e9]) assert.deepEqual(outcome(await s.client.planLayoutRestore(revision)), invalid('unknown_revision'), String(revision));
    for (const revision of [undefined, null, '1', 1.5, NaN, {}, []]) assert.deepEqual(await s.core.call('bowerloom.layout.plan', { kind: 'restore', revision }), { ok: false, code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_request' }, String(revision));
    assert.deepEqual(await frozenState(s.client), before);
  });

  test(`${name}: a revision is checked against the Gauges when it is restored, so a Gauge that is gone refuses the restore`, async () => {
    const s = await start();
    await bring(s, 'quiet-folder', 'fixture-quiet');
    await change(s, s.client.planLayoutSwap('models', 'fixture-quiet'));
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    await lifecycle(s, s.client.planDisable('fixture-quiet'));
    await lifecycle(s, s.client.planRemove('fixture-quiet'));
    const before = await frozenState(s.client);
    assert.deepEqual(outcome(await s.client.planLayoutRestore(2)), invalid('unknown_gauge'));
    assert.deepEqual(await frozenState(s.client), before);
  });

  // Safe mode

  const BROKEN: readonly (readonly [string, string, object])[] = [
    ['text that is not JSON', 'not json at all', { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' }],
    ['an empty file', '', { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' }],
    ['a file with a byte order mark', `\uFEFF${JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 1, current: HOME_DOC, revisions: [] })}`, { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' }],
    ['a file over the size cap', ' '.repeat(11 * 32768 + 4097), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' }],
    ['a layout where a file is expected', homeText(), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' }],
    ['another file format', JSON.stringify({ format: 'bowerloom/layout-file/9', revision: 1, current: HOME_DOC, revisions: [] }), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unsupported_format' }],
    ['a layout with an unknown Gauge', JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 1, current: { ...HOME_DOC, shelf: [...HOME_DOC.shelf, 'no-such-gauge'] }, revisions: [] }), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_gauge' }],
    ['a layout that overlaps', JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 1, current: { ...HOME_DOC, tiles: [{ ...HOME_DOC.tiles[0], size: 'full' }, ...HOME_DOC.tiles.slice(1)] }, revisions: [] }), { code: 'GAUGE_LAYOUT_INVALID', reason: 'overlap' }],
    ['a layout that hides the Gauge manager', JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 1, current: { ...HOME_DOC, shelf: HOME_DOC.shelf.filter(id => id !== 'gauge-manager'), hidden: ['gauge-manager'] }, revisions: [] }), { code: 'GAUGE_PROTECTED', reason: 'hidden' }],
    ['a layout that drops Settings', JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 1, current: { ...HOME_DOC, shelf: HOME_DOC.shelf.filter(id => id !== 'settings') }, revisions: [] }), { code: 'GAUGE_PROTECTED', reason: 'removed' }],
    ['11 revisions', JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 12, current: HOME_DOC, revisions: Array.from({ length: 11 }, (_, index) => ({ revision: 11 - index, layout: HOME_DOC })) }), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_revisions' }],
  ];

  test(`${name}: a broken layout file makes the core start in safe mode with the default layout, and the cause is the exact code and reason`, async () => {
    for (const [label, file, cause] of BROKEN) {
      const { client } = await start({ layoutFile: file });
      const state = await read(client);
      assert.deepEqual(state.safe, cause, label);
      assert.deepEqual(state.layout, HOME_DOC, label);
      assert.equal(state.revision, 0, label);
      assert.deepEqual(must(await client.listLayoutRevisions()), [], label);
      assert.deepEqual(JSON.parse(must(await client.exportLayout())), HOME_DOC, label);
    }
  });

  test(`${name}: the core starts in safe mode and never refuses to start, and a layout file that is valid starts it as it was saved`, async () => {
    const swapped = { ...HOME_DOC, tiles: HOME_DOC.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'tracing' } : tile)), shelf: [...HOME_DOC.shelf.filter(id => id !== 'tracing'), 'local-models'].sort() };
    const file = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 3, current: swapped, revisions: [{ revision: 2, layout: HOME_DOC }] });
    const { client } = await start({ layoutFile: file });
    const state = await read(client);
    assert.deepEqual(state, { layout: swapped, revision: 3, safe: null });
    assert.deepEqual(must(await client.listLayoutRevisions()), [{ revision: 2, layout: HOME_DOC }]);
  });

  test(`${name}: a change from safe mode leaves safe mode: it saves the layout as revision 1, and keeps the saved file as a backup, byte for byte`, async () => {
    const s = await start({ layoutFile: 'not json at all' });
    assert.equal((await read(s.client)).safe?.reason, 'syntax');
    assert.equal(await s.harness.layoutBackup(), null);
    const plan = must(await s.client.planLayoutSwap('models', 'tracing'));
    assert.ok(plan.steps.includes('leave safe mode, keep the saved file as a backup, and save the layout as revision 1'));
    assert.equal(await s.harness.layoutBackup(), null);
    const applied = must(await s.client.applyLayout(plan, await s.harness.approve(plan)));
    assert.deepEqual(applied, { kind: 'swap', revision: 1, changed: true });
    const state = await read(s.client);
    assert.equal(state.safe, null);
    assert.equal(state.revision, 1);
    assert.equal(placeOf(state, 'models'), 'tracing');
    assert.deepEqual(must(await s.client.listLayoutRevisions()), []);
    assert.deepEqual(await s.harness.layoutBackup(), Uint8Array.from(Buffer.from('not json at all', 'utf8')));
  });

  test(`${name}: the backup holds a broken file with its valid revisions as they were, and a normal start sets nothing aside`, async () => {
    const broken = JSON.stringify({ format: 'bowerloom/layout-file/1', revision: 3, current: { ...HOME_DOC, shelf: [...HOME_DOC.shelf, 'no-such-gauge'] }, revisions: [{ revision: 2, layout: HOME_DOC }] });
    const s = await start({ layoutFile: broken });
    assert.equal((await read(s.client)).safe?.reason, 'unknown_gauge');
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    assert.deepEqual(await s.harness.layoutBackup(), Uint8Array.from(Buffer.from(broken, 'utf8')));
    const normal = await start();
    await change(normal, normal.client.planLayoutSwap('models', 'tracing'));
    assert.equal(await normal.harness.layoutBackup(), null);
  });

  test(`${name}: the default layout of safe mode can be saved as it is, which leaves safe mode`, async () => {
    const s = await start({ layoutFile: 'not json at all' });
    const { applied } = await change(s, s.client.planLayoutSet(must(await s.client.exportLayout())));
    assert.deepEqual(applied, { kind: 'set', revision: 1, changed: true });
    assert.deepEqual(await read(s.client), { layout: HOME_DOC, revision: 1, safe: null });
  });

  test(`${name}: the default layout of safe mode keeps the way back: Settings and the Gauge manager are one step away`, async () => {
    const { client } = await start({ layoutFile: '{' });
    const { layout } = await read(client);
    assert.ok(layout.shelf.includes('settings'));
    assert.ok(layout.shelf.includes('gauge-manager'));
    assert.deepEqual(layout.hidden, []);
  });

  // A Gauge proposes to add itself

  test(`${name}: a Gauge can propose to add itself only with the layout.propose grant, and only through a plan that the person approves`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    assert.deepEqual(outcome(await s.client.planLayoutPropose('fixture-proposer')), { ok: false, code: 'GAUGE_GRANT_MISSING' });
    await grantPropose(s, 'fixture-proposer');
    const base = await read(s.client);
    const plan = must(await s.client.planLayoutPropose('fixture-proposer'));
    assert.equal(plan.steps[0], 'add fixture-proposer to the layout, as the Gauge asked');
    assert.ok(plan.steps.includes('tile place-1: fixture-proposer medium at column 0 row 2'));
    assert.deepEqual({ kind: plan.kind, gauge: plan.gauge, place: plan.place }, { kind: 'propose', gauge: 'fixture-proposer', place: null });
    assert.deepEqual(await read(s.client), base);
    assert.deepEqual(outcome(await s.client.applyLayout(plan)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await read(s.client), base);
    const applied = must(await s.client.applyLayout(plan, await s.harness.approve(plan)));
    assert.deepEqual(applied, { kind: 'propose', revision: base.revision + 1, changed: true });
    assert.deepEqual((await read(s.client)).layout.tiles.at(-1), { place: 'place-1', gauge: 'fixture-proposer', default: 'fixture-proposer', col: 0, row: 2, size: 'medium' });
  });

  test(`${name}: a proposal is refused for a Gauge that has no layout.propose permission in its manifest, that is disabled, or that has no tile`, async () => {
    const s = await start();
    await bring(s, 'quiet-folder', 'fixture-quiet');
    await bring(s, 'page-folder', 'fixture-pager');
    await bring(s, 'proposer-folder', 'fixture-proposer', false);
    assert.deepEqual(outcome(await s.client.planLayoutPropose('fixture-quiet')), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'not_declared' });
    assert.deepEqual(outcome(await s.client.planLayoutPropose('fixture-proposer')), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'gauge_disabled' });
    await grantPropose(s, 'fixture-pager');
    assert.deepEqual(outcome(await s.client.planLayoutPropose('fixture-pager')), invalid('no_tile'));
    for (const id of ['no-such-gauge', '', '__proto__']) assert.deepEqual(outcome(await s.client.planLayoutPropose(id)), { ok: false, code: 'UNKNOWN_GAUGE' }, id);
  });

  test(`${name}: a proposal for a Gauge that already has a tile is refused, and a Gauge cannot choose where to go`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await grantPropose(s, 'fixture-proposer');
    const reply = await s.core.call('bowerloom.layout.plan', { kind: 'propose', gauge: 'fixture-proposer', place: 'harnesses' });
    assert.equal(reply.ok, true);
    assert.equal((reply as { result: { place: unknown } }).result.place, null);
    await change(s, s.client.planLayoutPropose('fixture-proposer'));
    assert.deepEqual((await read(s.client)).layout.tiles.find(tile => tile.gauge === 'harnesses')?.col, 4);
    assert.deepEqual(outcome(await s.client.planLayoutPropose('fixture-proposer')), invalid('duplicate_gauge'));
  });

  test(`${name}: a revoke takes effect first: the plan of a proposal and its approval die when the grant is revoked`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await grantPropose(s, 'fixture-proposer');
    const base = await read(s.client);
    const plan = must(await s.client.planLayoutPropose('fixture-proposer'));
    const approval = await s.harness.approve(plan);
    must(await s.client.revoke('fixture-proposer', ['layout.propose']));
    assert.deepEqual(outcome(await s.client.applyLayout(plan, approval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await read(s.client), base);
  });

  test(`${name}: disabling the Gauge after the plan is approved stops the proposal, with nothing changed`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await grantPropose(s, 'fixture-proposer');
    const base = await read(s.client);
    const plan = must(await s.client.planLayoutPropose('fixture-proposer'));
    const approval = await s.harness.approve(plan);
    await lifecycle(s, s.client.planDisable('fixture-proposer'));
    assert.deepEqual(outcome(await s.client.applyLayout(plan, approval)), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    // The step took the Gauge off the shelf, and nothing else changed: the proposal added no tile.
    const after = await read(s.client);
    assert.equal(after.revision, base.revision + 1);
    assert.equal(after.layout.tiles.length, 5);
    assert.equal(after.layout.shelf.includes('fixture-proposer'), false);
  });

  test(`${name}: a Gauge has no call that changes the layout without a plan, so the layout never changes by itself`, async () => {
    const s = await start();
    const before = await frozenState(s.client);
    for (const method of ['bowerloom.layout.set', 'bowerloom.layout.swap', 'bowerloom.layout.save', 'bowerloom.layout.import']) {
      await assert.rejects(s.core.call(method as never, { text: homeText(), place: 'models', gauge: 'tracing' }), /unknown core method/, method);
    }
    assert.deepEqual(await frozenState(s.client), before);
  });

  // The default Gauge, when it fills another place

  test(`${name}: the default Gauge is one action away even when it fills another place: the two places exchange their Gauges`, async () => {
    const s = await start();
    await change(s, s.client.planLayoutSwap('models', 'projects'));
    await change(s, s.client.planLayoutSwap('memory', 'local-models'));
    const plan = must(await s.client.planLayoutDefault('models'));
    assert.equal(plan.steps[0], 'put the default Gauge local-models back in place models');
    must(await s.client.applyLayout(plan, await s.harness.approve(plan)));
    const state = await read(s.client);
    assert.equal(placeOf(state, 'models'), 'local-models');
    assert.equal(placeOf(state, 'memory'), 'projects');
    const again = must(await s.client.planLayoutDefault('memory'));
    must(await s.client.applyLayout(again, await s.harness.approve(again)));
    const last = await read(s.client);
    assert.equal(placeOf(last, 'memory'), 'memory-explorer');
    assert.equal(placeOf(last, 'models'), 'local-models');
  });

  // Sizes in a swap

  test(`${name}: a swap takes the first size that the new Gauge allows when the size of the place is not one, and says so when no size fits`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await change(s, s.client.planLayoutSwap('jobs', 'fixture-proposer'));
    assert.equal((await read(s.client)).layout.tiles.find(tile => tile.place === 'jobs')?.size, 'medium');
    assert.deepEqual(outcome(await s.client.planLayoutSwap('models', 'gauge-manager')), invalid('no_room'));
  });

  // The file cannot vouch for itself

  test(`${name}: a place of the default home keeps its protected Gauge even when the text edits both the Gauge and the default of the place`, async () => {
    const { client } = await start();
    const edited = homeText(home => ({
      ...home, tiles: home.tiles.map(tile => (tile.place === 'harnesses' ? { ...tile, gauge: 'projects', default: 'projects' } : tile)),
      shelf: [...home.shelf.filter(id => id !== 'projects'), 'harnesses'].sort(),
    }));
    assert.deepEqual(outcome(await client.planLayoutSet(edited)), protectedBy('replaced'));
  });

  // The plan says what it drops and what it shows again

  test(`${name}: a plan names the revision that it will drop when the history is full, and says nothing before`, async () => {
    const s = await start();
    const swaps = ['tracing', 'library'];
    for (let step = 0; step < 9; step += 1) await change(s, s.client.planLayoutSwap('models', swaps[step % 2] ?? 'tracing'));
    assert.equal(must(await s.client.planLayoutSwap('models', 'projects')).steps.some(line => line.startsWith('drop revision')), false);
    await change(s, s.client.planLayoutSwap('models', 'projects'));
    const full = must(await s.client.planLayoutSwap('models', 'tracing'));
    assert.ok(full.steps.includes('drop revision 1, the oldest, because the file keeps at most 10 earlier revisions'));
    assert.equal(full.steps.at(-2), 'drop revision 1, the oldest, because the file keeps at most 10 earlier revisions');
    await s.client.applyLayout(full, await s.harness.approve(full));
    assert.deepEqual(must(await s.client.listLayoutRevisions()).map(entry => entry.revision), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const noChange = must(await s.client.planLayoutSet(must(await s.client.exportLayout())));
    assert.equal(noChange.steps.some(line => line.startsWith('drop revision')), false);
  });

  test(`${name}: a plan says when a Gauge that was hidden will show again`, async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await grantPropose(s, 'fixture-proposer');
    const hiding = homeText(home => ({ ...home, shelf: home.shelf.filter(id => id !== 'library'), hidden: ['fixture-proposer', 'library'].sort() }));
    await change(s, s.client.planLayoutSet(hiding));
    assert.ok(must(await s.client.planLayoutPropose('fixture-proposer')).steps.includes('fixture-proposer was hidden and will show again'));
    assert.ok(must(await s.client.planLayoutSwap('models', 'library')).steps.includes('library was hidden and will show again'));
    assert.equal(must(await s.client.planLayoutSwap('models', 'tracing')).steps.some(line => line.endsWith('will show again')), false);
  });

  // A lifecycle step keeps the layout in line with the Gauges, in the same approved plan

  /** Every change that a person can make works, and an export imports again. */
  const everyChangeWorks = async (s: Session) => {
    const state = await read(s.client);
    const free = ['projects', 'library', 'tracing'].find(id => state.layout.shelf.includes(id));
    assert.ok(free, 'a free Gauge on the shelf');
    const exported = must(await s.client.exportLayout());
    const imported = await change(s, s.client.planLayoutSet(exported));
    assert.equal(imported.applied.changed, false);
    await change(s, s.client.planLayoutSwap('models', free));
    await change(s, s.client.planLayoutDefault('models'));
    await change(s, s.client.planLayoutPropose('fixture-proposer'));
    assert.deepEqual(must(await s.client.exportLayout()).endsWith('\n'), true);
    await change(s, s.client.planLayoutSet(must(await s.client.exportLayout())));
  };
  const ready = async () => {
    const s = await start();
    await bring(s, 'proposer-folder', 'fixture-proposer');
    await grantPropose(s, 'fixture-proposer');
    return s;
  };
  const layoutLines = (plan: { steps: readonly string[] }) => plan.steps.filter(line => line.startsWith('layout: '));

  test(`${name}: disabling a Gauge on a tile drops the tile in the same approved plan, and every change still works`, async () => {
    const s = await ready();
    const before = await read(s.client);
    const plan = must(await s.client.planDisable('jobs'));
    assert.ok(plan.steps.includes('layout: drop tile jobs (jobs)'));
    assert.ok(plan.steps.includes(`layout: keep the layout now in use as revision ${before.revision}, and keep at most 10 earlier revisions`));
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    const after = await read(s.client);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.layout.tiles.some(tile => tile.gauge === 'jobs'), false);
    assert.deepEqual(must(await s.client.listLayoutRevisions())[0]?.layout, before.layout);
    await everyChangeWorks(s);
  });

  test(`${name}: disabling a Gauge on the shelf drops its shelf entry, and every change still works`, async () => {
    const s = await ready();
    const plan = must(await s.client.planDisable('tracing'));
    assert.deepEqual(layoutLines(plan).slice(0, 1), ['layout: remove tracing from the shelf']);
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    assert.equal((await read(s.client)).layout.shelf.includes('tracing'), false);
    await everyChangeWorks(s);
  });

  test(`${name}: removing a Gauge on a tile or on the shelf reconciles the layout the same way`, async () => {
    const s = await ready();
    const removeJobs = must(await s.client.planRemove('jobs'));
    assert.ok(removeJobs.steps.includes('layout: drop tile jobs (jobs)'));
    await lifecycle(s, Promise.resolve({ ok: true as const, value: removeJobs }));
    const removeTracing = must(await s.client.planRemove('tracing'));
    assert.deepEqual(layoutLines(removeTracing).slice(0, 1), ['layout: remove tracing from the shelf']);
    await lifecycle(s, Promise.resolve({ ok: true as const, value: removeTracing }));
    const state = await read(s.client);
    assert.equal(state.layout.tiles.some(tile => tile.gauge === 'jobs'), false);
    assert.equal(state.layout.shelf.includes('tracing'), false);
    await everyChangeWorks(s);
  });

  test(`${name}: a tile whose Gauge is disabled goes back to the default Gauge of its place when that Gauge is free`, async () => {
    const s = await ready();
    await bring(s, 'quiet-folder', 'fixture-quiet');
    await change(s, s.client.planLayoutSwap('models', 'fixture-quiet'));
    const plan = must(await s.client.planDisable('fixture-quiet'));
    assert.ok(plan.steps.includes('layout: tile models holds local-models small instead of fixture-quiet'));
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    const state = await read(s.client);
    assert.deepEqual(state.layout.tiles.find(tile => tile.place === 'models'), { place: 'models', gauge: 'local-models', default: 'local-models', col: 4, row: 1, size: 'small' });
    assert.equal(state.layout.shelf.includes('local-models'), false);
    await everyChangeWorks(s);
  });

  test(`${name}: an update that no longer allows the size of a tile shrinks the tile in the same approved plan, and every change still works`, async () => {
    const s = await ready();
    await bring(s, 'quiet-folder', 'fixture-quiet');
    const placing = homeText(tiles({ place: 'wide', gauge: 'fixture-quiet', default: 'fixture-quiet', col: 0, row: 2, size: 'large' }));
    await change(s, s.client.planLayoutSet(placing));
    const plan = must(await s.client.planUpdate('quiet-fixed-update'));
    assert.ok(plan.steps.includes('layout: tile wide changes from large to small'));
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    assert.deepEqual((await read(s.client)).layout.tiles.find(tile => tile.place === 'wide'), { place: 'wide', gauge: 'fixture-quiet', default: 'fixture-quiet', col: 0, row: 2, size: 'small' });
    await everyChangeWorks(s);
  });

  test(`${name}: enabling a protected stock Gauge puts it on the shelf in the same approved plan, and every change still works`, async () => {
    const s = await ready();
    await lifecycle(s, s.client.planInstall('guard-folder'));
    assert.equal((await read(s.client)).layout.shelf.includes('fixture-guard'), false);
    const plan = must(await s.client.planEnable('fixture-guard'));
    assert.ok(plan.steps.includes('layout: add fixture-guard to the shelf'));
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    assert.equal((await read(s.client)).layout.shelf.includes('fixture-guard'), true);
    await everyChangeWorks(s);
  });

  test(`${name}: a lifecycle step that does not touch the layout says nothing about it and saves no revision`, async () => {
    const s = await ready();
    const before = await read(s.client);
    const plan = must(await s.client.planInstall('quiet-folder'));
    assert.deepEqual(layoutLines(plan), []);
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    assert.deepEqual(await read(s.client), before);
  });

  test(`${name}: a lifecycle plan that changes the layout is bound to the change: a changed layout line is GAUGE_PLAN_CHANGED`, async () => {
    const s = await ready();
    const plan = must(await s.client.planDisable('jobs'));
    const approval = await s.harness.approve(plan);
    assert.deepEqual(outcome(await s.client.applyPlan({ ...plan, steps: plan.steps.filter(line => !line.startsWith('layout: drop tile')) }, approval)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.equal((await read(s.client)).layout.tiles.some(tile => tile.gauge === 'jobs'), true);
    assert.equal((await s.client.applyPlan(plan, approval)).ok, true);
  });

  test(`${name}: a lifecycle plan names the revision that it will drop when the history is full`, async () => {
    const s = await ready();
    const swaps = ['tracing', 'library'];
    for (let step = 0; step < 10; step += 1) await change(s, s.client.planLayoutSwap('models', swaps[step % 2] ?? 'tracing'));
    // After 10 changes the file holds 10 earlier revisions, so the step saves a revision and drops the oldest.
    const oldest = must(await s.client.listLayoutRevisions()).at(-1)?.revision;
    assert.equal(must(await s.client.listLayoutRevisions()).length, 10);
    const plan = must(await s.client.planDisable('jobs'));
    assert.ok(plan.steps.includes(`layout: drop revision ${oldest}, the oldest, because the file keeps at most 10 earlier revisions`));
  });

  test(`${name}: a stock update that makes a Gauge protected gives its place back in the same approved plan, and the arrangement of the person stays`, async () => {
    const s = await ready();
    await change(s, s.client.planLayoutSwap('jobs', 'library'));
    await change(s, s.client.planLayoutSwap('models', 'tracing'));
    const before = await read(s.client);
    const plan = must(await s.client.planUpdate('jobs-protected'));
    assert.deepEqual(layoutLines(plan), [
      'layout: tile jobs holds jobs large instead of library',
      'layout: remove jobs from the shelf',
      'layout: add library to the shelf',
      `layout: keep the layout now in use as revision ${before.revision}, and keep at most 10 earlier revisions`,
    ]);
    await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
    const after = await read(s.client);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.layout.tiles.find(tile => tile.place === 'jobs'), { place: 'jobs', gauge: 'jobs', default: 'jobs', col: 2, row: 0, size: 'large' });
    assert.equal(placeOf(after, 'models'), 'tracing');
    assert.equal(after.layout.shelf.includes('library'), true);
    for (const place of ['engines', 'harnesses', 'memory']) assert.deepEqual(after.layout.tiles.find(tile => tile.place === place), before.layout.tiles.find(tile => tile.place === place), place);
    assert.deepEqual(must(await s.client.listLayoutRevisions())[0]?.layout, before.layout);
    await everyChangeWorks(s);
  });

  test(`${name}: a Gauge that is disabled and then enabled again, or that was never on the layout, ends on the shelf, and swap and default then work`, async () => {
    const s = await ready();
    for (const id of ['fixture-clock', 'jobs']) {
      await lifecycle(s, s.client.planDisable(id));
      const plan = must(await s.client.planEnable(id));
      assert.ok(plan.steps.includes(`layout: add ${id} to the shelf`), id);
      await lifecycle(s, Promise.resolve({ ok: true as const, value: plan }));
      const state = await read(s.client);
      assert.equal(state.layout.shelf.includes(id), true, id);
      assert.equal(state.layout.tiles.some(tile => tile.gauge === id), false, id);
    }
    // The tile of Jobs stays gone. A swap puts Jobs on a tile again, and the default action then works.
    await change(s, s.client.planLayoutSwap('engines', 'jobs'));
    assert.equal(placeOf(await read(s.client), 'engines'), 'jobs');
    await change(s, s.client.planLayoutDefault('engines'));
    assert.equal(placeOf(await read(s.client), 'engines'), 'engines-usage');
    // A Gauge that is installed and enabled for the first time is on the shelf too.
    await bring(s, 'quiet-folder', 'fixture-quiet');
    assert.equal((await read(s.client)).layout.shelf.includes('fixture-quiet'), true);
  });

  test(`${name}: a plan says when a place gets another default, and when a hidden entry goes`, async () => {
    const s = await ready();
    await change(s, s.client.planLayoutSwap('models', 'projects'));
    await change(s, s.client.planLayoutSet(homeText(home => ({ ...home, tiles: home.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: home.shelf.filter(id => id !== 'projects' && id !== 'library' && id !== 'local-models'), hidden: ['library', 'local-models'] }))));
    const defaultGone = must(await s.client.planRemove('local-models'));
    assert.ok(defaultGone.steps.includes('layout: place models has the default projects'));
    assert.ok(defaultGone.steps.includes('layout: remove local-models from the hidden list'));
    const library = must(await s.client.planDisable('library'));
    assert.ok(library.steps.includes('layout: remove library from the hidden list'));
  });

  test(`${name}: a hidden Gauge stays hidden when a step on another Gauge would give its place back to it`, async () => {
    const s = await ready();
    await change(s, s.client.planLayoutSet(homeText(home => ({ ...home, tiles: home.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: home.shelf.filter(id => id !== 'projects' && id !== 'local-models'), hidden: ['local-models'] }))));
    await lifecycle(s, s.client.planDisable('projects'));
    const state = await read(s.client);
    assert.equal(state.layout.tiles.some(tile => tile.place === 'models'), false);
    assert.deepEqual(state.layout.hidden, ['local-models']);
  });

  // Reads

  test(`${name}: the same read gives the same answer twice, and a caller that changes an answer changes nothing for the next`, async () => {
    const { client } = await start();
    assert.deepEqual(await read(client), await read(client));
    const first = await read(client);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.layout.tiles), true);
    assert.deepEqual(await read(client), { layout: HOME_DOC, revision: 1, safe: null });
  });
}
