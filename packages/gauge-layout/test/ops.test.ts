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

test('a swap that fits in no size that the Gauge allows is refused with no_room, and changes nothing', () => {
  const layout = home();
  assert.deepEqual(refusal(swapPlace(layout, TABLE, 'models', 'gauge-manager')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_room' });
  assert.equal(canonicalText(layout), canonicalText(home()));
});

test('a swap tries the sizes of the new Gauge in the order its manifest gives, and takes the first that fits', () => {
  // The place holds a large tile. The new Gauge allows large, which would overlap nothing, so it keeps the large size.
  assert.equal(tileOf(done(swapPlace(home(), TABLE, 'jobs', 'library')), 'jobs')?.size, 'large');
  // Memory is a small tile at the end of row 1. The new Gauge allows medium, then large, and neither fits, so it takes the small size that it also allows.
  const table: GaugeTable = new Map(TABLE).set('wide', { enabled: true, protected: false, tile: { resizable: true, sizes: ['medium', 'large', 'small'] } });
  assert.equal(tileOf(done(swapPlace(home(), table, 'memory', 'wide')), 'memory')?.size, 'small');
  // Models is small at column 4, row 1: medium would overlap Memory, so the first size that fits is small.
  assert.equal(tileOf(done(swapPlace(home(), table, 'models', 'wide')), 'models')?.size, 'small');
});

test('a swap takes the first size in the manifest order when the size of the place is not one that the Gauge allows', () => {
  const table: GaugeTable = new Map(TABLE).set('narrow', { enabled: true, protected: false, tile: { resizable: true, sizes: ['medium', 'small'] } });
  assert.equal(tileOf(done(swapPlace(home(), table, 'jobs', 'narrow')), 'jobs')?.size, 'medium');
  const bigFirst: GaugeTable = new Map(TABLE).set('narrow', { enabled: true, protected: false, tile: { resizable: true, sizes: ['full', 'large', 'small'] } });
  // The place of Models is small: full does not fit, large does not fit, so small is the first that fits, and it is also the size of the place.
  assert.equal(tileOf(done(swapPlace(home(), bigFirst, 'models', 'narrow')), 'models')?.size, 'small');
  // The place of Engines is large: full overlaps its neighbours, and large is the size of the place.
  assert.equal(tileOf(done(swapPlace(home(), bigFirst, 'engines', 'narrow')), 'engines')?.size, 'large');
});

test('the default action swaps two places when the default Gauge fills another place, and a second action puts everything back', () => {
  const moved = done(swapPlace(done(swapPlace(home(), TABLE, 'models', 'projects')), TABLE, 'memory', 'local-models'));
  assert.equal(tileOf(moved, 'models')?.gauge, 'projects');
  assert.equal(tileOf(moved, 'memory')?.gauge, 'local-models');
  const first = done(defaultPlace(moved, TABLE, 'models'));
  assert.equal(tileOf(first, 'models')?.gauge, 'local-models');
  assert.equal(tileOf(first, 'memory')?.gauge, 'projects');
  assert.deepEqual(first.shelf, moved.shelf);
  // And the other way: the default action on the place that now holds the other Gauge.
  const second = done(defaultPlace(first, TABLE, 'memory'));
  assert.equal(tileOf(second, 'memory')?.gauge, 'memory-explorer');
  assert.equal(tileOf(second, 'models')?.gauge, 'local-models');
  assert.equal(tileOf(second, 'memory')?.default, 'memory-explorer');
});

test('the default action works from either place of a crossed pair', () => {
  const crossed = done(swapPlace(done(swapPlace(done(swapPlace(home(), TABLE, 'memory', 'projects')), TABLE, 'models', 'memory-explorer')), TABLE, 'memory', 'local-models'));
  assert.equal(tileOf(crossed, 'models')?.gauge, 'memory-explorer');
  assert.equal(tileOf(crossed, 'memory')?.gauge, 'local-models');
  for (const place of ['models', 'memory']) {
    const back = done(defaultPlace(crossed, TABLE, place));
    assert.equal(tileOf(back, 'models')?.gauge, 'local-models', place);
    assert.equal(tileOf(back, 'memory')?.gauge, 'memory-explorer', place);
  }
});

test('the default action that exchanges two places is refused with no_room when the default Gauge does not fit the place', () => {
  const table: GaugeTable = new Map(TABLE).set('big', { enabled: true, protected: false, tile: { resizable: true, sizes: ['large', 'full'] } });
  const layout = home(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects', default: 'big' } : tile.place === 'engines' ? { ...tile, gauge: 'big' } : tile)), shelf: copy.shelf.filter(id => id !== 'projects').concat('engines-usage', 'local-models').sort() }));
  assert.deepEqual(refusal(defaultPlace(layout, table, 'models')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_room' });
});
