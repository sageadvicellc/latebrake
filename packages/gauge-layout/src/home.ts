import type { TileSize } from '../../gauge-manifest/src/index.js';

/**
 * The five tiles that the bento home opens with, in the arrangement of the home: Engines and usage, Jobs, Harnesses, Local models, and Memory explorer, which fill the first
 * two rows of the 6-column grid with no gap. Projects, Library, Tracing, and the Gauge manager are one step away, on the shelf.
 */
export const DEFAULT_TILES: readonly { readonly place: string; readonly gauge: string; readonly col: number; readonly row: number; readonly size: TileSize }[] = Object.freeze([
  Object.freeze({ place: 'engines', gauge: 'engines-usage', col: 0, row: 0, size: 'large' }),
  Object.freeze({ place: 'jobs', gauge: 'jobs', col: 2, row: 0, size: 'large' }),
  Object.freeze({ place: 'harnesses', gauge: 'harnesses', col: 4, row: 0, size: 'medium' }),
  Object.freeze({ place: 'models', gauge: 'local-models', col: 4, row: 1, size: 'small' }),
  Object.freeze({ place: 'memory', gauge: 'memory-explorer', col: 5, row: 1, size: 'small' }),
] as const);

export interface HomeGauge {
  readonly id: string;
  readonly title: string;
  /** Three of the stock Gauges are protected: Harnesses and the Gauge manager here, and Settings, which is a core page and not a Gauge. */
  readonly protected: boolean;
  readonly tile: { readonly resizable: boolean; readonly sizes: readonly TileSize[] };
}

const everySize: readonly TileSize[] = ['small', 'medium', 'large', 'full'];
const gauge = (id: string, title: string, isProtected: boolean, resizable: boolean, sizes: readonly TileSize[]): HomeGauge =>
  Object.freeze({ id, title, protected: isProtected, tile: Object.freeze({ resizable, sizes: Object.freeze([...sizes]) }) });

/** The nine stock Gauges of v0.9.1, with what their tiles allow. A core holds all nine. The fake core holds them when it is made with `home: true`. */
export const HOME_GAUGES: readonly HomeGauge[] = Object.freeze([
  gauge('engines-usage', 'Engines and usage', false, true, ['large', 'medium', 'full']),
  gauge('jobs', 'Jobs', false, true, ['large', 'medium', 'full']),
  gauge('harnesses', 'Harnesses', true, true, ['medium', 'large', 'full']),
  gauge('local-models', 'Local models', false, true, ['small', 'medium', 'large']),
  gauge('memory-explorer', 'Memory explorer', false, true, ['small', 'medium', 'large']),
  gauge('projects', 'Projects', false, true, everySize),
  gauge('library', 'Library', false, true, everySize),
  gauge('tracing', 'Tracing', false, true, everySize),
  gauge('gauge-manager', 'Gauge manager', true, false, ['medium']),
]);
