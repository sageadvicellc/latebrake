import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TILES, canonicalText, defaultPlace, layoutOf, proposeTile, swapPlace, type GaugeInfo, type GaugeTable, type Layout } from '../src/index.js';
import { HOME, TABLE } from './table.js';

const home = (change: (copy: typeof HOME) => unknown = copy => copy): Layout => {
  const result = layoutOf(change(structuredClone(HOME)), { requireCanonical: false });
  assert.ok(result.ok);
  return result.layout;
};
type Result = { readonly ok: boolean; readonly code?: string; readonly reason?: string | undefined; readonly layout?: Layout };
const refusal = (result: Result) => (result.ok ? undefined : { code: result.code, reason: result.reason });
const done = (result: Result): Layout => {
  assert.ok(result.ok && result.layout, JSON.stringify(refusal(result)));
  return result.layout;
};
const tileOf = (layout: Layout, place: string) => layout.tiles.find(tile => tile.place === place);

test('a swap puts another Gauge in a place, keeps the default of the place, and puts the displaced Gauge on the shelf', () => {
  const layout = done(swapPlace(home(), TABLE, 'models', 'tracing'));
  assert.deepEqual(tileOf(layout, 'models'), { place: 'models', gauge: 'tracing', default: 'local-models', col: 4, row: 1, size: 'small' });
  assert.equal(layout.shelf.includes('local-models'), true);
  assert.equal(layout.shelf.includes('tracing'), false);
  assert.deepEqual(layout.shelf, ['fixed-clock', 'gauge-manager', 'library', 'local-models', 'page-only', 'projects', 'settings']);
  assert.equal(layout.tiles.length, 5);
});

test('a swap keeps the size of the place when the new Gauge allows it, and takes the first size the new Gauge allows when it does not', () => {
  assert.equal(tileOf(done(swapPlace(home(), TABLE, 'jobs', 'library')), 'jobs')?.size, 'large');
  assert.equal(tileOf(done(swapPlace(home(), TABLE, 'jobs', 'fixed-clock')), 'jobs')?.size, 'small');
});

test('a swap that would not fit the grid is refused with the reason of the grid and changes nothing', () => {
  const layout = home();
  assert.deepEqual(refusal(swapPlace(layout, TABLE, 'models', 'gauge-manager')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'overlap' });
  assert.equal(canonicalText(layout), canonicalText(home()));
});

test('a swap is refused for a place that does not exist, and for any place that is not text', () => {
  for (const place of ['nowhere', '', 'Models', '__proto__', 'constructor', 5, null, undefined, {}, []]) {
    assert.deepEqual(refusal(swapPlace(home(), TABLE, place, 'tracing')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_place' }, String(place));
  }
});

test('a swap is refused with UNKNOWN_GAUGE for a Gauge that does not exist, and for any id that is not text', () => {
  for (const gauge of ['nowhere', '', 'settings', '__proto__', 'constructor', 5, null, undefined, {}, ['tracing']]) {
    assert.deepEqual(refusal(swapPlace(home(), TABLE, 'models', gauge)), { code: 'UNKNOWN_GAUGE', reason: undefined }, String(gauge));
  }
});

test('a swap is refused for a Gauge that is disabled, that has no tile, or that already fills another place', () => {
  assert.deepEqual(refusal(swapPlace(home(), TABLE, 'models', 'sleeper')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
  assert.deepEqual(refusal(swapPlace(home(), TABLE, 'models', 'page-only')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_tile' });
  assert.deepEqual(refusal(swapPlace(home(), TABLE, 'models', 'jobs')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
});

test('a swap that would replace a protected Gauge is refused with GAUGE_PROTECTED and the reason replaced', () => {
  assert.deepEqual(refusal(swapPlace(home(), TABLE, 'harnesses', 'library')), { code: 'GAUGE_PROTECTED', reason: 'replaced' });
  const withManager = home(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'manager', gauge: 'gauge-manager', default: 'gauge-manager', col: 0, row: 2, size: 'medium' }], shelf: copy.shelf.filter(id => id !== 'gauge-manager') }));
  assert.deepEqual(refusal(swapPlace(withManager, TABLE, 'manager', 'library')), { code: 'GAUGE_PROTECTED', reason: 'replaced' });
});

test('a swap to the Gauge that is already in the place changes nothing', () => {
  assert.equal(canonicalText(done(swapPlace(home(), TABLE, 'models', 'local-models'))), canonicalText(home()));
});

test('a swap of a Gauge that was hidden puts it in the place and takes it off the hidden list', () => {
  const hiddenLibrary = home(copy => ({ ...copy, shelf: copy.shelf.filter(id => id !== 'library'), hidden: ['library'] }));
  const layout = done(swapPlace(hiddenLibrary, TABLE, 'models', 'library'));
  assert.deepEqual(layout.hidden, []);
  assert.equal(tileOf(layout, 'models')?.gauge, 'library');
});

test('the default Gauge of a place is one action away: the action puts it back, and the layout is the one before the swap', () => {
  const swapped = done(swapPlace(home(), TABLE, 'models', 'tracing'));
  const back = done(defaultPlace(swapped, TABLE, 'models'));
  assert.equal(canonicalText(back), canonicalText(home()));
  assert.equal(swapped.shelf.includes('local-models'), true);
});

test('the default action changes nothing when the place already holds its default Gauge', () => {
  assert.equal(canonicalText(done(defaultPlace(home(), TABLE, 'jobs'))), canonicalText(home()));
});

test('the default action is refused for a place that does not exist, and for a default that fills another place', () => {
  assert.deepEqual(refusal(defaultPlace(home(), TABLE, 'nowhere')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_place' });
  assert.deepEqual(refusal(defaultPlace(home(), TABLE, 7)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_place' });
  const moved = home(copy => ({ ...copy, tiles: [...copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), { place: 'extra', gauge: 'local-models', default: 'library', col: 0, row: 2, size: 'small' }], shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'library') }));
  assert.deepEqual(refusal(defaultPlace(moved, TABLE, 'models')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
});

test('the default action cannot replace a protected Gauge that sits in a place that is not its own', () => {
  const layout = home(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'manager', gauge: 'gauge-manager', default: 'library', col: 0, row: 2, size: 'medium' }], shelf: copy.shelf.filter(id => id !== 'gauge-manager' && id !== 'library').concat('library') }));
  assert.deepEqual(refusal(defaultPlace(layout, TABLE, 'manager')), { code: 'GAUGE_PROTECTED', reason: 'replaced' });
});

test('a proposal adds the Gauge as a new tile of its first allowed size, in the first free cell, and takes it off the shelf', () => {
  const layout = done(proposeTile(home(), TABLE, 'tracing'));
  assert.deepEqual(tileOf(layout, 'place-1'), { place: 'place-1', gauge: 'tracing', default: 'tracing', col: 0, row: 2, size: 'small' });
  assert.equal(layout.shelf.includes('tracing'), false);
  const manager = done(proposeTile(home(), TABLE, 'gauge-manager'));
  assert.deepEqual(tileOf(manager, 'place-1'), { place: 'place-1', gauge: 'gauge-manager', default: 'gauge-manager', col: 0, row: 2, size: 'medium' });
});

test('a proposal names its place with the smallest number that is free, and the first free cell moves along', () => {
  const first = done(proposeTile(home(), TABLE, 'tracing'));
  const second = done(proposeTile(first, TABLE, 'library'));
  assert.deepEqual(tileOf(second, 'place-2'), { place: 'place-2', gauge: 'library', default: 'library', col: 1, row: 2, size: 'small' });
  const gap = home(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'place-1', gauge: 'projects', default: 'projects', col: 0, row: 2, size: 'small' }], shelf: copy.shelf.filter(id => id !== 'projects') }));
  assert.equal(tileOf(done(proposeTile(gap, TABLE, 'tracing')), 'place-2')?.gauge, 'tracing');
});

test('a proposal moves a hidden Gauge off the hidden list', () => {
  const hiddenLibrary = home(copy => ({ ...copy, shelf: copy.shelf.filter(id => id !== 'library'), hidden: ['library'] }));
  assert.deepEqual(done(proposeTile(hiddenLibrary, TABLE, 'library')).hidden, []);
});

test('a proposal is refused for a Gauge that is not there, is disabled, has no tile, or already has a tile', () => {
  for (const gauge of ['nowhere', 'settings', '', 5, null, undefined, {}]) assert.deepEqual(refusal(proposeTile(home(), TABLE, gauge)), { code: 'UNKNOWN_GAUGE', reason: undefined }, String(gauge));
  assert.deepEqual(refusal(proposeTile(home(), TABLE, 'sleeper')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
  assert.deepEqual(refusal(proposeTile(home(), TABLE, 'page-only')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_tile' });
  assert.deepEqual(refusal(proposeTile(home(), TABLE, 'jobs')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
});

test('a proposal is refused with no_room when no cell is free, and with too_many_tiles at the cap', () => {
  const many = (count: number): GaugeTable => new Map(Array.from({ length: count }, (_, index): [string, GaugeInfo] => [`g${index}`, { enabled: true, protected: false, tile: { resizable: false, sizes: ['full'] } }]));
  const table = many(MAX_TILES + 2);
  const fullRows = Array.from({ length: 16 }, (_, index) => ({ place: `r${index}`, gauge: `g${index}`, default: `g${index}`, col: 0, row: index * 2, size: 'full' }));
  const packed = layoutOf({ ...HOME, tiles: fullRows, shelf: ['settings', 'g16'], hidden: [] }, { requireCanonical: false });
  assert.ok(packed.ok);
  assert.deepEqual(refusal(proposeTile(packed.layout, table, 'g16')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_room' });
  const smalls: GaugeTable = new Map(Array.from({ length: MAX_TILES + 2 }, (_, index): [string, GaugeInfo] => [`g${index}`, { enabled: true, protected: false, tile: { resizable: false, sizes: ['small'] } }]));
  const tiles = Array.from({ length: MAX_TILES }, (_, index) => ({ place: `r${index}`, gauge: `g${index}`, default: `g${index}`, col: index % 6, row: Math.floor(index / 6), size: 'small' }));
  const filled = layoutOf({ ...HOME, tiles, shelf: ['settings', `g${MAX_TILES}`], hidden: [] }, { requireCanonical: false });
  assert.ok(filled.ok);
  assert.deepEqual(refusal(proposeTile(filled.layout, smalls, `g${MAX_TILES}`)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_tiles' });
});

test('an operation never changes the layout it was given', () => {
  const layout = home();
  const before = canonicalText(layout);
  swapPlace(layout, TABLE, 'models', 'tracing');
  defaultPlace(layout, TABLE, 'models');
  proposeTile(layout, TABLE, 'tracing');
  assert.equal(canonicalText(layout), before);
  assert.equal(Object.isFrozen(done(swapPlace(layout, TABLE, 'models', 'tracing'))), true);
});
