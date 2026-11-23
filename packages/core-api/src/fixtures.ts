import { HOME_GAUGES } from '../../gauge-layout/src/index.js';
import type { TileInfo } from '../../gauge-layout/src/index.js';
import type { GaugeSummary } from './types.js';

/** Synthetic Gauges for the fake core and for the client suite. No real names, clients, or people. */
export const FIXTURE_GAUGES: readonly GaugeSummary[] = Object.freeze([
  Object.freeze({ id: 'fixture-manager', title: 'Fixture Manager', version: '1.0.0', kind: 'ui', origin: 'stock', protected: true }),
  Object.freeze({ id: 'fixture-clock', title: 'Fixture Clock', version: '1.2.0', kind: 'ui', origin: 'stock', protected: false }),
  Object.freeze({ id: 'fixture-preset', title: 'Fixture Preset', version: '0.1.0', kind: 'data', origin: 'third-party', protected: false }),
] as const satisfies readonly GaugeSummary[]);

/** The nine stock Gauges of the bento home, as the fake core holds them when it is made with `home: true`. Each has a tile, and the tile says which sizes it allows. */
export const HOME_STOCK: readonly { readonly summary: GaugeSummary; readonly tile: TileInfo }[] = Object.freeze(HOME_GAUGES.map(gauge => Object.freeze({
  summary: Object.freeze({ id: gauge.id, title: gauge.title, version: '1.0.0', kind: 'ui', origin: 'stock', protected: gauge.protected } as const satisfies GaugeSummary),
  tile: gauge.tile,
})));
