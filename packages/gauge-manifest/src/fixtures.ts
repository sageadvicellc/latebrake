import { MAX_MANIFEST_BYTES } from './manifest.js';

/** Synthetic manifests for tests and for the fake core. No real names, clients, or people. */
const base = {
  format: 'bowerloom/gauge/1', version: '1.0.0', coreApi: '>=1.0.0 <2.0.0', kind: 'ui', protected: false, engines: [], permissions: [], dependencies: [],
};
const make = (fields: Record<string, unknown>): string => JSON.stringify({ ...base, ...fields });

export const VALID_MANIFESTS = Object.freeze({
  'tile-only': make({ id: 'fixture-tile', title: 'Fixture Tile', tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }),
  'page-only': make({ id: 'fixture-page', title: 'Fixture Page', page: { entry: 'ui/page.js' } }),
  'tile-and-page': make({
    id: 'fixture-both', title: 'Fixture Both', engines: ['fixture-engine'], permissions: ['engines.read'], dependencies: [{ id: 'fixture-clock', range: '>=1.0.0' }],
    tile: { expandable: true, resizable: true, entry: 'ui/tile.js' }, page: { entry: 'ui/page.js' },
  }),
  'tile-neither': make({ id: 'fixture-quiet', title: 'Fixture Quiet', tile: { expandable: false, resizable: false, entry: 'ui/tile.js' } }),
  'tile-expandable-only': make({ id: 'fixture-open', title: 'Fixture Open', tile: { expandable: true, resizable: false, entry: 'ui/tile.js' }, page: { entry: 'ui/page.js' } }),
  'data-preset': make({ id: 'fixture-layout', title: 'Fixture Layout', kind: 'data', tile: { expandable: false, resizable: true } }),
} as const);
export type ValidManifestName = keyof typeof VALID_MANIFESTS;

/** The text of one valid fixture. */
export const validManifest = (name: ValidManifestName): string => VALID_MANIFESTS[name];

const tile = VALID_MANIFESTS['tile-only'];
const withEntry = (entry: string) => make({ id: 'fixture-tile', title: 'Fixture Tile', tile: { expandable: false, resizable: true, entry } });
// A synthetic secret shape, built from pieces so that no file holds the whole value.
const syntheticKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

/** One fixture for each refusal the ticket names, and for the two rules about origin and the Core API version. Each has one defect. */
export const INVALID_MANIFESTS = Object.freeze({
  'duplicate-key': tile.replace('{', '{"title":"Fixture Twice",'),
  'comment': `// a note\n${tile}`,
  'trailing-comma': `${tile.slice(0, -1)},}`,
  'unknown-field': tile.replace('{', '{"extra":1,'),
  'secret-value': make({ id: 'fixture-tile', title: syntheticKey, tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }),
  'link': withEntry('https://example.test/tile.js'),
  'hidden-name': withEntry('ui/.hidden.js'),
  'dotdot-name': withEntry('ui/a..b.js'),
  'over-size': tile + ' '.repeat(MAX_MANIFEST_BYTES + 1 - Buffer.byteLength(tile)),
  'origin-set': tile.replace('{', '{"origin":"stock",'),
  'newer-api': make({ id: 'fixture-tile', title: 'Fixture Tile', coreApi: '>=2.0.0', tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }),
} as const);
export type InvalidManifestName = keyof typeof INVALID_MANIFESTS;
