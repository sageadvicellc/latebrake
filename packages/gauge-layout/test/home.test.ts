import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TILES, HOME_GAUGES, tileInfoOf } from '../src/index.js';
import { TABLE } from './table.js';

test('the nine stock Gauges are the ones that the spec names, and each has the tile that the table says', () => {
  assert.deepEqual(HOME_GAUGES.map(gauge => gauge.id), ['engines-usage', 'jobs', 'harnesses', 'local-models', 'memory-explorer', 'projects', 'library', 'tracing', 'gauge-manager']);
  assert.deepEqual(HOME_GAUGES.map(gauge => gauge.title), ['Engines and usage', 'Jobs', 'Harnesses', 'Local models', 'Memory explorer', 'Projects', 'Library', 'Tracing', 'Gauge manager']);
  for (const gauge of HOME_GAUGES) {
    const info = TABLE.get(gauge.id);
    assert.equal(info?.protected, gauge.protected, gauge.id);
    assert.deepEqual(info?.tile, gauge.tile, gauge.id);
  }
});

test('the protected stock Gauges are Harnesses and the Gauge manager', () => {
  assert.deepEqual(HOME_GAUGES.filter(gauge => gauge.protected).map(gauge => gauge.id), ['harnesses', 'gauge-manager']);
});

test('each stock Gauge describes a tile that is one that a manifest could declare', () => {
  for (const gauge of HOME_GAUGES) {
    assert.deepEqual(tileInfoOf(gauge.tile), gauge.tile, gauge.id);
    if (!gauge.tile.resizable) assert.equal(gauge.tile.sizes.length, 1, gauge.id);
  }
  assert.equal(Object.isFrozen(HOME_GAUGES), true);
  assert.equal(Object.isFrozen(HOME_GAUGES[0]), true);
  assert.equal(Object.isFrozen(HOME_GAUGES[0]?.tile.sizes), true);
});

test('the five default tiles fill the first two rows of the grid exactly, with the sizes of the home', () => {
  assert.deepEqual(DEFAULT_TILES, [
    { place: 'engines', gauge: 'engines-usage', col: 0, row: 0, size: 'large' },
    { place: 'jobs', gauge: 'jobs', col: 2, row: 0, size: 'large' },
    { place: 'harnesses', gauge: 'harnesses', col: 4, row: 0, size: 'medium' },
    { place: 'models', gauge: 'local-models', col: 4, row: 1, size: 'small' },
    { place: 'memory', gauge: 'memory-explorer', col: 5, row: 1, size: 'small' },
  ]);
  // 2x2 + 2x2 + 2x1 + 1x1 + 1x1 = 12 cells, the whole of a 6 x 2 block.
  const cells = DEFAULT_TILES.reduce((sum, tile) => sum + { small: 1, medium: 2, large: 4, full: 12 }[tile.size], 0);
  assert.equal(cells, 12);
});
