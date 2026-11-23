import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalText, checkLayout, layoutOf, reconcileLayout, type GaugeInfo, type GaugeTable, type Layout } from '../src/index.js';
import { HOME, TABLE } from './table.js';

const layoutFrom = (change: (copy: typeof HOME) => unknown = copy => copy): Layout => {
  const result = layoutOf(change(structuredClone(HOME)), { requireCanonical: false });
  assert.ok(result.ok);
  return result.layout;
};
const home = layoutFrom();
/** A layout that the person arranged, so that the default layout cannot stand in for it: Models holds Projects, and Local models is on the shelf. */
const arranged = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'local-models'].sort() }));
const without = (...ids: string[]): GaugeTable => new Map([...TABLE].filter(([id]) => !ids.includes(id)));
const changed = (id: string, change: Partial<GaugeInfo>): GaugeTable => new Map(TABLE).set(id, { ...(TABLE.get(id) as GaugeInfo), ...change });
const tileOf = (layout: Layout, place: string) => layout.tiles.find(tile => tile.place === place);
const valid = (layout: Layout, table: GaugeTable) => assert.equal(checkLayout(layout, table), undefined);

test('a layout that still fits the Gauges is returned as it is', () => {
  assert.equal(canonicalText(reconcileLayout(home, TABLE)), canonicalText(home));
});

test('a Gauge on a tile that is disabled or removed leaves it, and the place goes back to its default Gauge when that Gauge is free', () => {
  const swapped = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'local-models'].sort() }));
  for (const table of [changed('projects', { enabled: false }), without('projects')]) {
    const next = reconcileLayout(swapped, table);
    assert.deepEqual(tileOf(next, 'models'), { place: 'models', gauge: 'local-models', default: 'local-models', col: 4, row: 1, size: 'small' });
    assert.equal(next.shelf.includes('local-models'), false);
    assert.equal(next.shelf.includes('projects'), false);
    valid(next, table);
  }
});

test('a Gauge on a tile that is disabled or removed, whose default is the same Gauge, leaves the tile and the tile is dropped', () => {
  for (const table of [changed('jobs', { enabled: false }), without('jobs')]) {
    const next = reconcileLayout(home, table);
    assert.equal(tileOf(next, 'jobs'), undefined);
    assert.deepEqual(next.tiles.map(tile => tile.place), ['engines', 'harnesses', 'models', 'memory']);
    valid(next, table);
  }
});

test('a place whose default Gauge is already on another tile drops its tile when its own Gauge goes', () => {
  const crossed = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile.place === 'memory' ? { ...tile, gauge: 'local-models' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'memory-explorer'].sort() }));
  const next = reconcileLayout(crossed, changed('projects', { enabled: false }));
  assert.equal(tileOf(next, 'models'), undefined);
  assert.equal(tileOf(next, 'memory')?.gauge, 'local-models');
});

test('a Gauge that is disabled or removed leaves the shelf and the hidden list, and Settings stays', () => {
  const hiding = layoutFrom(copy => ({ ...copy, tiles: arranged.tiles, shelf: arranged.shelf.filter(id => id !== 'library'), hidden: ['library'] }));
  for (const table of [changed('library', { enabled: false }), without('library')]) {
    assert.deepEqual(reconcileLayout(hiding, table).hidden, []);
    assert.equal(tileOf(reconcileLayout(hiding, table), 'models')?.gauge, 'projects');
    assert.equal(reconcileLayout(hiding, table).shelf.includes('library'), false);
    assert.equal(reconcileLayout(home, table).shelf.includes('library'), false);
    assert.equal(reconcileLayout(home, table).shelf.includes('settings'), true);
  }
});

test('a tile whose Gauge no longer allows its size takes the first allowed size that fits, in the same cell', () => {
  const big = layoutFrom(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'wide', gauge: 'library', default: 'library', col: 0, row: 2, size: 'large' }], shelf: copy.shelf.filter(id => id !== 'library') }));
  const fixed = changed('library', { tile: { resizable: false, sizes: ['small'] } });
  assert.deepEqual(tileOf(reconcileLayout(big, fixed), 'wide'), { place: 'wide', gauge: 'library', default: 'library', col: 0, row: 2, size: 'small' });
  const hinted = changed('library', { tile: { resizable: true, sizes: ['full', 'medium'] } });
  assert.equal(tileOf(reconcileLayout(big, hinted), 'wide')?.size, 'medium');
  valid(reconcileLayout(big, hinted), hinted);
});

test('a tile that fits in no allowed size goes to the shelf, and so does a Gauge that lost its tile', () => {
  const big = layoutFrom(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'wide', gauge: 'library', default: 'library', col: 2, row: 2, size: 'small' }], shelf: copy.shelf.filter(id => id !== 'library') }));
  const full = changed('library', { tile: { resizable: false, sizes: ['full'] } });
  const next = reconcileLayout(big, full);
  assert.equal(tileOf(next, 'wide'), undefined);
  assert.equal(next.shelf.includes('library'), true);
  valid(next, full);
  const pageOnly = changed('library', { tile: null });
  const lost = reconcileLayout(big, pageOnly);
  assert.equal(tileOf(lost, 'wide'), undefined);
  assert.equal(lost.shelf.includes('library'), true);
  valid(lost, pageOnly);
});

test('a protected Gauge is never dropped: it goes to the shelf when its tile cannot hold it', () => {
  const noTile = changed('harnesses', { tile: null });
  const next = reconcileLayout(home, noTile);
  assert.equal(tileOf(next, 'harnesses'), undefined);
  assert.equal(next.shelf.includes('harnesses'), true);
  valid(next, noTile);
});

test('a protected Gauge that is newly enabled goes to the shelf, also from the hidden list', () => {
  const table = new Map(TABLE).set('guard', { enabled: true, protected: true, tile: { resizable: false, sizes: ['small'] } });
  assert.equal(reconcileLayout(arranged, table).shelf.includes('guard'), true);
  assert.equal(tileOf(reconcileLayout(arranged, table), 'models')?.gauge, 'projects');
  valid(reconcileLayout(arranged, table), table);
  const hidden = layoutFrom(copy => ({ ...copy, tiles: arranged.tiles, shelf: arranged.shelf, hidden: ['guard'] }));
  const next = reconcileLayout(hidden, table);
  assert.deepEqual(next.hidden, []);
  assert.equal(next.shelf.includes('guard'), true);
  assert.equal(tileOf(next, 'models')?.gauge, 'projects');
  // An enabled Gauge that is not protected is left alone, so the person adds it.
  const plain = new Map(TABLE).set('extra', { enabled: true, protected: false, tile: null });
  assert.equal(canonicalText(reconcileLayout(home, plain)), canonicalText(home));
});

test('a default Gauge that is gone becomes the Gauge that fills the place, so the layout stays valid', () => {
  const swapped = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'local-models'].sort() }));
  const table = without('local-models');
  const next = reconcileLayout(swapped, table);
  assert.deepEqual(tileOf(next, 'models'), { place: 'models', gauge: 'projects', default: 'projects', col: 4, row: 1, size: 'small' });
  valid(next, table);
});

test('two places that would share a default are given their own Gauge as default', () => {
  const clash = layoutFrom(copy => ({
    ...copy,
    tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects', default: 'ghost' } : tile.place === 'memory' ? { ...tile, gauge: 'library', default: 'projects' } : tile)),
    shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'library'),
  }));
  const next = reconcileLayout(clash, TABLE);
  assert.equal(tileOf(next, 'models')?.default, 'projects');
  assert.equal(tileOf(next, 'memory')?.default, 'library');
  valid(next, TABLE);
});

test('whatever Gauge changes, the result is a valid layout that holds every protected Gauge, and a second pass changes nothing', () => {
  const tables: GaugeTable[] = [];
  for (const id of TABLE.keys()) {
    tables.push(without(id), changed(id, { enabled: false }), changed(id, { tile: null }), changed(id, { tile: { resizable: false, sizes: ['full'] } }), changed(id, { tile: { resizable: false, sizes: ['small'] } }), changed(id, { protected: true }));
  }
  tables.push(new Map(), without('jobs', 'projects', 'library', 'tracing'));
  for (const table of tables) {
    const next = reconcileLayout(home, table);
    valid(next, table);
    assert.equal(canonicalText(reconcileLayout(next, table)), canonicalText(next));
  }
});

test('reconcile never changes the layout it was given', () => {
  const before = canonicalText(home);
  reconcileLayout(home, without('jobs'));
  assert.equal(canonicalText(home), before);
  assert.equal(Object.isFrozen(reconcileLayout(home, without('jobs'))), true);
});
