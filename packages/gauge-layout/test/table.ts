// A table of synthetic Gauges for the layout tests. It is written out here by hand, and it is not read from the source of the package, so a wrong default fails a test.
import type { GaugeInfo, GaugeTable } from '../src/index.js';
import type { TileSize } from '../../gauge-manifest/src/index.js';

const resizable = (...sizes: TileSize[]): GaugeInfo => ({ enabled: true, protected: false, tile: { resizable: true, sizes } });

export const TABLE: GaugeTable = new Map<string, GaugeInfo>([
  ['engines-usage', resizable('large', 'medium', 'full')],
  ['jobs', resizable('large', 'medium', 'full')],
  ['harnesses', { enabled: true, protected: true, tile: { resizable: true, sizes: ['medium', 'large', 'full'] } }],
  ['local-models', resizable('small', 'medium', 'large')],
  ['memory-explorer', resizable('small', 'medium', 'large')],
  ['projects', resizable('small', 'medium', 'large', 'full')],
  ['library', resizable('small', 'medium', 'large', 'full')],
  ['tracing', resizable('small', 'medium', 'large', 'full')],
  ['gauge-manager', { enabled: true, protected: true, tile: { resizable: false, sizes: ['medium'] } }],
  ['fixed-clock', { enabled: true, protected: false, tile: { resizable: false, sizes: ['small'] } }],
  ['page-only', { enabled: true, protected: false, tile: null }],
  ['sleeper', { enabled: false, protected: false, tile: { resizable: true, sizes: ['small', 'medium', 'large', 'full'] } }],
]);

/** The home that the spec names, as the plain data of a layout, written by hand. */
export const HOME = {
  format: 'bowerloom/layout/1',
  grid: { columns: 6, unit: 200, gap: 12 },
  tiles: [
    { place: 'engines', gauge: 'engines-usage', default: 'engines-usage', col: 0, row: 0, size: 'large' },
    { place: 'jobs', gauge: 'jobs', default: 'jobs', col: 2, row: 0, size: 'large' },
    { place: 'harnesses', gauge: 'harnesses', default: 'harnesses', col: 4, row: 0, size: 'medium' },
    { place: 'models', gauge: 'local-models', default: 'local-models', col: 4, row: 1, size: 'small' },
    { place: 'memory', gauge: 'memory-explorer', default: 'memory-explorer', col: 5, row: 1, size: 'small' },
  ],
  shelf: ['fixed-clock', 'gauge-manager', 'library', 'page-only', 'projects', 'settings', 'tracing'],
  hidden: [],
};

/** A copy of the home with some fields changed, as text. */
export const homeText = (change: (home: typeof HOME) => unknown = home => home): string => JSON.stringify(change(structuredClone(HOME)));
