import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalText, checkLayout, defaultPlace, layoutObject, layoutOf, proposeTile, reconcileLayout, swapPlace, type GaugeInfo, type GaugeTable, type Layout, type LayoutTile } from '../src/index.js';
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

/** A layout that a person arranged: tiles moved, a Gauge hidden, a place swapped. Nothing here is the default layout. */
const personal = layoutFrom(copy => ({
  ...copy,
  tiles: [
    { place: 'engines', gauge: 'engines-usage', default: 'engines-usage', col: 0, row: 0, size: 'large' },
    { place: 'jobs', gauge: 'tracing', default: 'jobs', col: 2, row: 0, size: 'medium' },
    { place: 'harnesses', gauge: 'harnesses', default: 'harnesses', col: 4, row: 0, size: 'medium' },
    { place: 'models', gauge: 'local-models', default: 'local-models', col: 0, row: 2, size: 'small' },
    { place: 'memory', gauge: 'memory-explorer', default: 'memory-explorer', col: 3, row: 3, size: 'small' },
  ],
  shelf: ['fixed-clock', 'gauge-manager', 'jobs', 'page-only', 'projects', 'settings'],
  hidden: ['library'],
}));
const key = (tile: LayoutTile | undefined) => (tile === undefined ? undefined : `${tile.place} ${tile.gauge} ${tile.default} ${tile.col} ${tile.row} ${tile.size}`);

test('a person-arranged layout keeps what the step did not touch: tiles keep their place, cell, and size, the hidden list stays, and nothing new appears', () => {
  valid(personal, TABLE);
  // A step on a Gauge that the layout does not hold at all changes nothing.
  for (const table of [changed('sleeper', { enabled: true }), without('sleeper'), changed('fixed-clock', { tile: { resizable: false, sizes: ['small'] } })]) {
    assert.equal(canonicalText(reconcileLayout(personal, table)), canonicalText(personal));
  }
  // Models goes away: only its tile goes, and every other tile, the shelf, and the hidden list are as they were.
  const next = reconcileLayout(personal, changed('local-models', { enabled: false }));
  for (const place of ['engines', 'jobs', 'harnesses', 'memory']) assert.equal(key(tileOf(next, place)), key(tileOf(personal, place)), place);
  assert.equal(tileOf(next, 'models'), undefined);
  assert.deepEqual(next.hidden, ['library']);
  assert.deepEqual(next.shelf, personal.shelf);
  // Tracing goes away: its place goes back to Jobs, which is free on the shelf, in the cell of the place. Nothing else moves.
  const back = reconcileLayout(personal, changed('tracing', { enabled: false }));
  assert.equal(key(tileOf(back, 'jobs')), 'jobs jobs jobs 2 0 medium');
  assert.deepEqual(back.shelf, ['fixed-clock', 'gauge-manager', 'page-only', 'projects', 'settings']);
  for (const place of ['engines', 'harnesses', 'models', 'memory']) assert.equal(key(tileOf(back, place)), key(tileOf(personal, place)), place);
  assert.deepEqual(back.hidden, ['library']);
});

test('a hidden Gauge stays hidden when a step on another Gauge would give its place back to it', () => {
  const hiddenDefault = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'library'), hidden: ['library', 'local-models'] }));
  const next = reconcileLayout(hiddenDefault, changed('projects', { enabled: false }));
  assert.equal(tileOf(next, 'models'), undefined);
  assert.deepEqual(next.hidden, ['library', 'local-models']);
  assert.equal(next.tiles.some(tile => tile.gauge === 'local-models'), false);
});

test('a Gauge that a step just enabled and that is on no tile, shelf, or hidden entry goes to the shelf, and a hidden one stays hidden', () => {
  const missing = layoutFrom(copy => ({ ...copy, shelf: copy.shelf.filter(id => id !== 'library' && id !== 'tracing'), hidden: ['tracing'] }));
  const next = reconcileLayout(missing, TABLE, { enabled: 'library' });
  assert.equal(next.shelf.includes('library'), true);
  assert.deepEqual(next.hidden, ['tracing']);
  assert.equal(reconcileLayout(missing, TABLE, { enabled: 'tracing' }).shelf.includes('tracing'), false);
  assert.equal(reconcileLayout(missing, TABLE).shelf.includes('library'), false);
  assert.equal(reconcileLayout(missing, TABLE, { enabled: 'sleeper' }).shelf.includes('sleeper'), false);
  assert.equal(reconcileLayout(missing, TABLE, { enabled: 'no-such-gauge' }).shelf.includes('no-such-gauge'), false);
  assert.equal(reconcileLayout(home, TABLE, { enabled: 'jobs' }).tiles.filter(tile => tile.gauge === 'jobs').length, 1);
});

test('a tile that is replaced by the default Gauge of its place takes the first size that fits: the size of the place, then the manifest order', () => {
  const swapped = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'local-models'].sort() }));
  // The default Gauge allows large and then small. Large at column 4, row 1 would leave the grid and overlap Memory, so it takes small.
  const table = changed('local-models', { tile: { resizable: true, sizes: ['large', 'small'] } });
  const next = reconcileLayout(swapped, changed('projects', { enabled: false }), {});
  assert.equal(tileOf(next, 'models')?.size, 'small');
  const hinted = new Map(table).set('projects', { ...(TABLE.get('projects') as GaugeInfo), enabled: false });
  assert.equal(tileOf(reconcileLayout(swapped, hinted), 'models')?.size, 'small');
  // With Memory gone there is room in the row, so the size of the place is kept.
  const roomy = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.filter(tile => tile.place !== 'memory').map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects', size: 'medium' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'local-models', 'memory-explorer'].sort() }));
  const roomyNext = reconcileLayout(roomy, new Map(TABLE).set('projects', { ...(TABLE.get('projects') as GaugeInfo), enabled: false }));
  assert.equal(tileOf(roomyNext, 'models')?.size, 'medium');
  // A default Gauge that allows only a size that overlaps a neighbour cannot take the place, and the tile is dropped.
  const onlyLarge = new Map(TABLE).set('projects', { ...(TABLE.get('projects') as GaugeInfo), enabled: false }).set('local-models', { enabled: true, protected: false, tile: { resizable: false, sizes: ['large'] } });
  assert.equal(tileOf(reconcileLayout(swapped, onlyLarge), 'models'), undefined);
});

test('a stock update that makes a Gauge protected gives its place back: a protected Gauge on the shelf takes the place, and the Gauge that was there goes to the shelf', () => {
  const arrangedJobs = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'jobs' ? { ...tile, gauge: 'library' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'library'), 'jobs'].sort(), hidden: [] }));
  const table = changed('jobs', { protected: true });
  const next = reconcileLayout(arrangedJobs, table);
  assert.equal(key(tileOf(next, 'jobs')), 'jobs jobs jobs 2 0 large');
  assert.equal(next.shelf.includes('library'), true);
  assert.equal(next.shelf.includes('jobs'), false);
  for (const place of ['engines', 'harnesses', 'models', 'memory']) assert.equal(key(tileOf(next, place)), key(tileOf(arrangedJobs, place)), place);
  valid(next, table);
});

test('a place of the default home for a protected Gauge is given back too, whatever default the file gives it', () => {
  const edited = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'jobs' ? { ...tile, gauge: 'library', default: 'library' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'library'), 'jobs'].sort() }));
  const next = reconcileLayout(edited, changed('jobs', { protected: true }));
  assert.equal(tileOf(next, 'jobs')?.gauge, 'jobs');
  assert.equal(tileOf(next, 'jobs')?.default, 'jobs');
  assert.equal(next.shelf.includes('library'), true);
});

test('a protected Gauge on another tile exchanges places with the Gauge that holds its place', () => {
  const crossed = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects' } : tile.place === 'memory' ? { ...tile, gauge: 'local-models' } : tile)), shelf: [...copy.shelf.filter(id => id !== 'projects'), 'memory-explorer'].sort() }));
  const table = changed('local-models', { protected: true });
  const next = reconcileLayout(crossed, table);
  assert.equal(key(tileOf(next, 'models')), 'models local-models local-models 4 1 small');
  assert.equal(tileOf(next, 'memory')?.gauge, 'projects');
  valid(next, table);
});

test('when a protected Gauge fits nowhere in its place, the tile is dropped and the Gauge that was there goes to the shelf', () => {
  const table = new Map(TABLE).set('jobs', { enabled: true, protected: true, tile: { resizable: false, sizes: ['large'] } });
  const placedJobs = layoutFrom(copy => ({
    ...copy, tiles: copy.tiles.filter(tile => tile.place !== 'jobs').map(tile => (tile.place === 'models' ? { ...tile, gauge: 'projects', default: 'jobs' } : tile)),
    shelf: [...copy.shelf.filter(id => id !== 'projects'), 'jobs'].sort(),
  }));
  const next = reconcileLayout(placedJobs, table);
  assert.equal(tileOf(next, 'models'), undefined);
  assert.equal(next.shelf.includes('projects'), true);
  assert.equal(next.shelf.includes('jobs'), true);
  valid(next, table);
});

/** A small deterministic random number generator, so a failure can be run again. */
const random = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

test('whatever Gauge changes, reconcile keeps a valid layout with every protected Gauge reachable, and it never needs a fallback: it throws when a case is not foreseen', () => {
  const pick = random(7);
  const choose = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length)] as T;
  const ids = [...TABLE.keys()];
  let checked = 0;
  for (let round = 0; round < 3000; round += 1) {
    // A person-arranged layout: a few random swaps, proposals, and hides, each of them valid by construction.
    let layout: Layout = home;
    for (let step = 0; step < 4; step += 1) {
      const result = choose([() => swapPlace(layout, TABLE, choose(layout.tiles).place, choose(ids)), () => proposeTile(layout, TABLE, choose(ids)), () => defaultPlace(layout, TABLE, choose(layout.tiles).place)])();
      if (result.ok) layout = result.layout;
    }
    // Hide a Gauge that is free and not protected.
    const hide = layout.shelf.filter(id => id !== 'settings' && TABLE.get(id)?.protected !== true);
    if (hide.length > 0 && pick() < 0.5) {
      const id = choose(hide);
      layout = layoutFrom(() => ({ ...layoutObject(layout), shelf: layout.shelf.filter(entry => entry !== id), hidden: [...layout.hidden, id].sort() }));
    }
    valid(layout, TABLE);
    // Then one or two changes of the Gauges.
    const table = new Map(TABLE);
    for (let change = 0; change < 1 + Math.floor(pick() * 2); change += 1) {
      const id = choose(ids), info = table.get(id);
      if (!info) continue;
      table.set(id, choose<GaugeInfo>([
        { ...info, enabled: !info.enabled }, { ...info, protected: !info.protected }, { ...info, tile: null }, { ...info, tile: { resizable: false, sizes: ['full'] } },
        { ...info, tile: { resizable: false, sizes: ['small'] } }, { ...info, tile: { resizable: true, sizes: ['large', 'small'] } }, { ...info, enabled: true, tile: info.tile ?? { resizable: true, sizes: ['medium'] } },
      ]));
      if (pick() < 0.2) table.delete(choose(ids));
    }
    const justEnabled = pick() < 0.3 ? choose(ids) : undefined;
    const next = reconcileLayout(layout, table, justEnabled === undefined ? {} : { enabled: justEnabled });
    valid(next, table);
    assert.equal(canonicalText(reconcileLayout(next, table)), canonicalText(next));
    // Nothing is invented: every Gauge on the result was on the layout before, or is a place's default.
    const before = new Set([...layout.tiles.flatMap(tile => [tile.gauge, tile.default]), ...layout.shelf, ...layout.hidden]);
    for (const id of [...next.tiles.map(tile => tile.gauge), ...next.shelf, ...next.hidden]) assert.ok(before.has(id) || table.get(id)?.protected === true || id === 'settings' || id === justEnabled, id);
    checked += 1;
  }
  assert.equal(checked, 3000);
});

test('reconcile never changes the layout it was given', () => {
  const before = canonicalText(home);
  reconcileLayout(home, without('jobs'));
  assert.equal(canonicalText(home), before);
  assert.equal(Object.isFrozen(reconcileLayout(home, without('jobs'))), true);
});

test('a case that the rules cannot serve throws, and never gives back another layout: more protected Gauges than the shelf can hold', () => {
  const table = new Map(TABLE);
  for (let index = 0; index < 101; index += 1) table.set(`guard-${index}`, { enabled: true, protected: true, tile: null });
  assert.throws(() => reconcileLayout(home, table), /not valid for the Gauges/);
});

test('an exchange that gives a protected Gauge its place ends, for any number of tiles: the tile that takes the displaced Gauge does not claim the protected one again', () => {
  // Engines holds Projects. The protected Gauge, Engines and usage, fills the place of Jobs, whose own Gauge is gone. Before the exchange both places claim it.
  const extra = [
    { place: 'extra-1', gauge: 'library', default: 'library', col: 0, row: 2, size: 'small' },
    { place: 'extra-2', gauge: 'tracing', default: 'tracing', col: 1, row: 2, size: 'small' },
  ];
  for (const count of [0, 1, 2]) {
    const layout = layoutFrom(copy => ({
      ...copy,
      tiles: [...copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, gauge: 'projects', default: 'projects' } : tile.place === 'jobs' ? { ...tile, gauge: 'engines-usage', default: 'engines-usage' } : tile)), ...extra.slice(0, count)],
      shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'library' && id !== 'tracing' && id !== 'engines-usage'),
    }));
    const table = new Map(TABLE).set('jobs', { ...(TABLE.get('jobs') as GaugeInfo), enabled: false }).set('engines-usage', { ...(TABLE.get('engines-usage') as GaugeInfo), protected: true });
    assert.equal(layout.tiles.length, 5 + count);
    const next = reconcileLayout(layout, table);
    assert.equal(key(tileOf(next, 'engines')), 'engines engines-usage engines-usage 0 0 large', String(layout.tiles.length));
    assert.equal(key(tileOf(next, 'jobs')), 'jobs projects projects 2 0 large', String(layout.tiles.length));
    valid(next, table);
    // The Gauges that were on the layout and are not on a tile are on the shelf: nothing was lost.
    assert.deepEqual(next.tiles.length, 5 + count);
  }
});

test('several places that are claimed at once are all given back, one round for each', () => {
  // Jobs and Local models both become protected while other Gauges fill their places. Each repair takes a round, so a bound of one round would leave the second place claimed.
  const layout = layoutFrom(copy => ({
    ...copy,
    tiles: copy.tiles.map(tile => (tile.place === 'jobs' ? { ...tile, gauge: 'library', default: 'jobs' } : tile.place === 'models' ? { ...tile, gauge: 'projects', default: 'local-models' } : tile)),
    shelf: [...copy.shelf.filter(id => id !== 'library' && id !== 'projects'), 'jobs', 'local-models'].sort(),
  }));
  const table = new Map(changed('jobs', { protected: true })).set('local-models', { ...(TABLE.get('local-models') as GaugeInfo), protected: true });
  const next = reconcileLayout(layout, table);
  assert.equal(tileOf(next, 'jobs')?.gauge, 'jobs');
  assert.equal(tileOf(next, 'models')?.gauge, 'local-models');
  assert.equal(next.shelf.includes('library'), true);
  assert.equal(next.shelf.includes('projects'), true);
  valid(next, table);
});

test('the shelf stays within its cap: a protected Gauge that must be added pushes out a plain Gauge, never a protected one or Settings', () => {
  const table = new Map<string, GaugeInfo>(TABLE);
  const plain = Array.from({ length: 120 }, (_, index) => `plain-${String(index).padStart(3, '0')}`);
  for (const id of plain) table.set(id, { enabled: true, protected: false, tile: null });
  table.set('newly-guarded', { enabled: true, protected: true, tile: null });
  const full = layoutFrom(copy => ({ ...copy, tiles: [], shelf: ['gauge-manager', 'harnesses', 'settings', ...plain.slice(0, 97)], hidden: [] }));
  assert.equal(full.shelf.length, 100);
  const next = reconcileLayout(full, table);
  assert.equal(next.shelf.length, 100);
  assert.equal(next.shelf.includes('newly-guarded'), true);
  assert.equal(next.shelf.includes('settings'), true);
  assert.equal(next.shelf.includes('gauge-manager'), true);
  assert.equal(next.shelf.includes('harnesses'), true);
});

/** Five places that each hold a plain Gauge `g<n>` and have a default `d<n>`. Flipping the first `flips` home Gauges and defaults to protected gives every one of those places two claims. */
const claimed = (flips: number, extraProtected: readonly string[] = []) => {
  const homeIds = ['engines-usage', 'jobs', 'harnesses', 'local-models', 'memory-explorer'];
  const places = ['engines', 'jobs', 'harnesses', 'models', 'memory'];
  const cells = [[0, 0], [2, 0], [4, 0], [4, 1], [5, 1]] as const;
  const plain = (isProtected: boolean): GaugeInfo => ({ enabled: true, protected: isProtected, tile: { resizable: true, sizes: ['small', 'medium', 'large', 'full'] } });
  const table = new Map<string, GaugeInfo>();
  for (const id of [...homeIds, 'd1', 'd2', 'd3', 'd4', 'd5', 'g1', 'g2', 'g3', 'g4', 'g5']) table.set(id, plain(false));
  for (let index = 0; index < flips; index += 1) { table.set(homeIds[index] as string, plain(true)); table.set(`d${index + 1}`, plain(true)); }
  for (const id of extraProtected) table.set(id, plain(true));
  const layout = layoutFrom(() => ({
    ...HOME,
    tiles: places.map((place, index) => ({ place, gauge: `g${index + 1}`, default: `d${index + 1}`, col: cells[index]?.[0] ?? 0, row: cells[index]?.[1] ?? 0, size: 'small' })),
    shelf: ['settings', ...homeIds, 'd1', 'd2', 'd3', 'd4', 'd5'].sort(),
    hidden: [],
  }));
  return { layout, table };
};

test('places that each have two claims by protected Gauges are all given back, for one to five flips at once', () => {
  const expected = [
    ['engines-usage', 'g2', 'g3', 'g4', 'g5'],
    ['engines-usage', 'jobs', 'g3', 'g4', 'g5'],
    ['engines-usage', 'jobs', 'harnesses', 'g4', 'g5'],
    ['engines-usage', 'jobs', 'harnesses', 'local-models', 'g5'],
    ['engines-usage', 'jobs', 'harnesses', 'local-models', 'memory-explorer'],
  ];
  for (let flips = 1; flips <= 5; flips += 1) {
    const { layout, table } = claimed(flips);
    const next = reconcileLayout(layout, table);
    assert.deepEqual(next.tiles.map(tile => tile.gauge), expected[flips - 1], String(flips));
    valid(next, table);
  }
});

test('places that name one protected Gauge as their default and that also have a protected home Gauge are given back, with four flips and an extra claim', () => {
  const { layout, table } = claimed(3, ['d4']);
  const next = reconcileLayout(layout, table);
  assert.deepEqual(next.tiles.map(tile => tile.gauge), ['engines-usage', 'jobs', 'harnesses', 'd4', 'g5']);
  valid(next, table);
  assert.equal(next.shelf.includes('g4'), true);
});

test('an exchange keeps the default of the other place when that default is not the protected Gauge, and takes the displaced Gauge as default when it is', () => {
  const projectsHold = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, gauge: 'projects', default: 'projects' } : tile.place === 'jobs' ? { ...tile, gauge: 'engines-usage', default: 'jobs' } : tile)), shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'engines-usage').concat('jobs').sort() }));
  const table = changed('engines-usage', { protected: true });
  const next = reconcileLayout(projectsHold, table);
  assert.equal(key(tileOf(next, 'engines')), 'engines engines-usage engines-usage 0 0 large');
  assert.equal(key(tileOf(next, 'jobs')), 'jobs projects jobs 2 0 large');
  valid(next, table);
  const named = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, gauge: 'projects', default: 'projects' } : tile.place === 'jobs' ? { ...tile, gauge: 'engines-usage', default: 'engines-usage' } : tile)), shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'engines-usage' && id !== 'jobs') }));
  assert.equal(key(tileOf(reconcileLayout(named, table), 'jobs')), 'jobs projects projects 2 0 large');
});

test('an exchange gives the other tile a size that the displaced Gauge allows, and takes the size of the tile first', () => {
  const fixed = layoutFrom(copy => ({ ...copy, tiles: copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, gauge: 'fixed-clock', default: 'fixed-clock', size: 'small' } : tile.place === 'jobs' ? { ...tile, gauge: 'engines-usage', default: 'engines-usage' } : tile)), shelf: copy.shelf.filter(id => id !== 'fixed-clock' && id !== 'engines-usage') }));
  const table = changed('engines-usage', { protected: true });
  const next = reconcileLayout(fixed, table);
  assert.equal(key(tileOf(next, 'engines')), 'engines engines-usage engines-usage 0 0 large');
  assert.equal(key(tileOf(next, 'jobs')), 'jobs fixed-clock fixed-clock 2 0 small');
  valid(next, table);
});

test('a tile that must shrink takes the first size of the manifest that is no bigger, and not the last', () => {
  const big = layoutFrom(copy => ({ ...copy, tiles: [...copy.tiles, { place: 'wide', gauge: 'library', default: 'library', col: 0, row: 2, size: 'large' }], shelf: copy.shelf.filter(id => id !== 'library') }));
  const table = changed('library', { tile: { resizable: true, sizes: ['medium', 'small'] } });
  assert.equal(tileOf(reconcileLayout(big, table), 'wide')?.size, 'medium');
  const reversed = changed('library', { tile: { resizable: true, sizes: ['small', 'medium'] } });
  assert.equal(tileOf(reconcileLayout(big, reversed), 'wide')?.size, 'small');
});

test('an exchange resets the default of the other place when that default is any protected Gauge, so the place does not claim a third protected Gauge', () => {
  // Engines holds Projects. Library fills Models, whose default is Tracing, which is on the shelf. Both Library and Tracing are protected.
  const layout = layoutFrom(copy => ({
    ...copy,
    tiles: copy.tiles.map(tile => (tile.place === 'engines' ? { ...tile, gauge: 'projects', default: 'library' } : tile.place === 'models' ? { ...tile, gauge: 'library', default: 'tracing' } : tile)),
    shelf: copy.shelf.filter(id => id !== 'projects' && id !== 'library'),
  }));
  const table = new Map(changed('library', { protected: true })).set('tracing', { ...(TABLE.get('tracing') as GaugeInfo), protected: true });
  const next = reconcileLayout(layout, table);
  assert.equal(key(tileOf(next, 'engines')), 'engines library library 0 0 large');
  assert.equal(key(tileOf(next, 'models')), 'models projects projects 4 1 small');
  assert.equal(next.shelf.includes('tracing'), true);
  valid(next, table);
});
