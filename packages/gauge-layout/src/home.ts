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

const everySize = ['small', 'medium', 'large', 'full'] as const;

/** The nine stock Gauges of v0.9.1, with what their tiles allow. A core holds all nine. The fake core holds them when it is made with `home: true`. */
export const HOME_GAUGES: readonly HomeGauge[] = Object.freeze([
  { id: 'engines-usage', title: 'Engines and usage', protected: false, tile: { resizable: true, sizes: ['large', 'medium', 'full'] } },
  { id: 'jobs', title: 'Jobs', protected: false, tile: { resizable: true, sizes: ['large', 'medium', 'full'] } },
  { id: 'harnesses', title: 'Harnesses', protected: true, tile: { resizable: true, sizes: ['medium', 'large', 'full'] } },
  { id: 'local-models', title: 'Local models', protected: false, tile: { resizable: true, sizes: ['small', 'medium', 'large'] } },
  { id: 'memory-explorer', title: 'Memory explorer', protected: false, tile: { resizable: true, sizes: ['small', 'medium', 'large'] } },
  { id: 'projects', title: 'Projects', protected: false, tile: { resizable: true, sizes: everySize } },
  { id: 'library', title: 'Library', protected: false, tile: { resizable: true, sizes: everySize } },
  { id: 'tracing', title: 'Tracing', protected: false, tile: { resizable: true, sizes: everySize } },
  { id: 'gauge-manager', title: 'Gauge manager', protected: true, tile: { resizable: false, sizes: ['medium'] } },
].map(gauge => Object.freeze({ ...gauge, tile: Object.freeze({ ...gauge.tile, sizes: Object.freeze([...gauge.tile.sizes]) }) })) as readonly HomeGauge[]);
