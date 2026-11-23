import { TILE_SIZES, parseStrictJson, type TileSize } from '../../gauge-manifest/src/index.js';
import { COLUMNS, GAP_PX, GRID, MAX_ROWS, UNIT_PX, sizeUnits } from './grid.js';
import { DEFAULT_TILES } from './home.js';
import { invalid, protectedRefusal, type LayoutReason, type LayoutRefusal } from './reasons.js';

/** The format of a layout, which is also the format of an export. New formats keep the `bowerloom/` prefix until the rename. */
export const LAYOUT_FORMAT = 'bowerloom/layout/1' as const;
/** The largest layout text, in bytes of UTF-8. A text of exactly this size passes. */
export const MAX_LAYOUT_BYTES = 32 * 1024;
/** The most tiles on the home. */
export const MAX_TILES = 48;
/** The most Gauges on the shelf, and the most on the hidden list. */
export const MAX_LISTED = 100;
/** Core pages. A page is not a Gauge and has no tile, but it must always have a reachable place on the shelf, and it cannot be hidden. */
export const PAGE_IDS: readonly string[] = Object.freeze(['settings']);

export interface LayoutTile {
  /** The place. It is the name of a spot on the home, and it stays when the Gauge in it is swapped. */
  readonly place: string;
  /** The Gauge that fills the place now. */
  readonly gauge: string;
  /** The Gauge that the place goes back to. The person can always put it back in one action. */
  readonly default: string;
  readonly col: number;
  readonly row: number;
  readonly size: TileSize;
}

export interface Layout {
  readonly format: typeof LAYOUT_FORMAT;
  readonly grid: { readonly columns: number; readonly unit: number; readonly gap: number };
  /** The tiles on the home, in the order of row, then column, then place. */
  readonly tiles: readonly LayoutTile[];
  /** The Gauges and pages one step away, sorted, once each. */
  readonly shelf: readonly string[];
  /** The Gauges that the person hides, sorted, once each. A protected Gauge and a page cannot be hidden. */
  readonly hidden: readonly string[];
}

/** What a layout needs to know about a Gauge: whether it is enabled and protected, and what its tile allows. `tile` is `null` for a Gauge with no tile. */
export interface GaugeInfo {
  readonly enabled: boolean;
  readonly protected: boolean;
  readonly tile: TileInfo | null;
}
/** The sizes a tile allows, the first one preferred. A tile that cannot be resized allows exactly one. */
export interface TileInfo {
  readonly resizable: boolean;
  readonly sizes: readonly TileSize[];
}
export type GaugeTable = ReadonlyMap<string, GaugeInfo>;

/** The sizes a tile allows from its manifest: the hints when there are some, else every size for a resizable tile and `small` for a fixed one. */
export function tileInfoOf(tile: { readonly resizable: boolean; readonly sizes?: readonly TileSize[] }): TileInfo {
  const sizes = tile.sizes ?? (tile.resizable ? TILE_SIZES : (['small'] as const));
  return Object.freeze({ resizable: tile.resizable, sizes: Object.freeze([...sizes]) });
}

export type LayoutResult = { readonly ok: true; readonly layout: Layout } | LayoutRefusal;

// Reading

class Stop extends Error {
  constructor(readonly refusal: LayoutRefusal) { super(refusal.reason); }
}
const stop = (reason: LayoutReason): never => { throw new Stop(invalid(reason)); };

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareTiles = (a: LayoutTile, b: LayoutTile): number => a.row - b.row || a.col - b.col || compare(a.place, b.place);

/** Reads the own properties of an object once, as a map. Anything that is not a plain object is refused, and an inherited field reads as missing. */
function fieldsOf(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return stop('invalid_field');
  const found = new Map<string, unknown>();
  for (const key of Object.keys(value)) found.set(key, (value as Record<string, unknown>)[key]);
  if ([...found.keys()].some(key => !keys.includes(key))) return stop('unknown_field');
  if (keys.some(key => !found.has(key))) return stop('missing_field');
  return found;
}
/** Reads a list, with no hole. A list over the cap is refused before any element is read. */
function listOf(value: unknown, most: number, tooMany: LayoutReason): unknown[] {
  if (!Array.isArray(value)) return stop('invalid_field');
  if (value.length > most) return stop(tooMany);
  return Array.from(value as unknown[]);
}
function nameOf(value: unknown): string {
  return typeof value === 'string' && value.length <= 64 && NAME.test(value) ? value : stop('invalid_field');
}
/** A whole number that a computer can hold exactly. Negative zero is not one. */
function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) ? value : stop('invalid_field');
}
function readTile(value: unknown): LayoutTile {
  const fields = fieldsOf(value, ['place', 'gauge', 'default', 'col', 'row', 'size']);
  const place = nameOf(fields.get('place')), gauge = nameOf(fields.get('gauge')), fallback = nameOf(fields.get('default'));
  const col = wholeNumber(fields.get('col')), row = wholeNumber(fields.get('row'));
  const sizeText = fields.get('size');
  if (typeof sizeText !== 'string') return stop('invalid_field');
  const size = TILE_SIZES.find(name => name === sizeText);
  if (size === undefined) return stop('unknown_size');
  return Object.freeze({ place, gauge, default: fallback, col, row, size });
}
const overlapping = (a: LayoutTile, b: LayoutTile): boolean => {
  const sa = sizeUnits(a.size), sb = sizeUnits(b.size);
  return a.col < b.col + sb.w && b.col < a.col + sa.w && a.row < b.row + sb.h && b.row < a.row + sa.h;
};
/** True when the tile is inside the grid and shares no cell with any tile of the list that has another place. */
export function fitsAmong(tile: LayoutTile, others: readonly LayoutTile[]): boolean {
  const { w, h } = sizeUnits(tile.size);
  if (tile.col < 0 || tile.row < 0 || tile.col + w > COLUMNS || tile.row + h > MAX_ROWS) return false;
  return others.every(other => other.place === tile.place || !overlapping(tile, other));
}
function checkGrid(value: unknown): void {
  const fields = fieldsOf(value, ['columns', 'unit', 'gap']);
  const columns = fields.get('columns'), unit = fields.get('unit'), gap = fields.get('gap');
  if (typeof columns !== 'number' || typeof unit !== 'number' || typeof gap !== 'number') stop('invalid_field');
  if (columns !== COLUMNS || unit !== UNIT_PX || gap !== GAP_PX) stop('unsupported_grid');
}
const hasRepeat = (items: readonly string[]): boolean => new Set(items).size !== items.length;

export interface ReadOptions {
  /** When true, a list or the tiles that are not in canonical order are refused with `not_canonical`. When false, they are sorted. */
  readonly requireCanonical: boolean;
}

/**
 * Reads a layout from a value, checking the shape and the grid, and no Gauge. It reads only the own properties of each object, once each. The checks run in a fixed order:
 * the fields and their types, then that no place and no Gauge repeats, then that each tile is in the grid, then that no two tiles overlap. It gives a new frozen layout in canonical order.
 */
export function layoutOf(value: unknown, options: ReadOptions): LayoutResult {
  try {
    return { ok: true, layout: readLayout(value, options) };
  } catch (error) {
    if (error instanceof Stop) return error.refusal;
    throw error;
  }
}

function readLayout(value: unknown, options: ReadOptions): Layout {
  const fields = fieldsOf(value, ['format', 'grid', 'tiles', 'shelf', 'hidden']);
  const format = fields.get('format');
  if (typeof format !== 'string') stop('invalid_field');
  if (format !== LAYOUT_FORMAT) stop('unsupported_format');
  checkGrid(fields.get('grid'));
  const tiles = listOf(fields.get('tiles'), MAX_TILES, 'too_many_tiles').map(readTile);
  const shelf = listOf(fields.get('shelf'), MAX_LISTED, 'too_many_listed').map(nameOf);
  const hidden = listOf(fields.get('hidden'), MAX_LISTED, 'too_many_listed').map(nameOf);
  if (hasRepeat(tiles.map(tile => tile.place))) stop('duplicate_place');
  if (hasRepeat([...tiles.map(tile => tile.gauge), ...shelf, ...hidden]) || hasRepeat(tiles.map(tile => tile.default))) stop('duplicate_gauge');
  for (const tile of tiles) {
    const { w, h } = sizeUnits(tile.size);
    if (tile.col < 0 || tile.row < 0 || tile.col + w > COLUMNS || tile.row + h > MAX_ROWS) stop('out_of_grid');
  }
  for (const [index, a] of tiles.entries()) {
    for (const b of tiles.slice(index + 1)) {
      if (overlapping(a, b)) stop('overlap');
    }
  }
  const sortedTiles = [...tiles].sort(compareTiles), sortedShelf = [...shelf].sort(compare), sortedHidden = [...hidden].sort(compare);
  if (options.requireCanonical && (sortedTiles.some((tile, index) => tile !== tiles[index]) || sortedShelf.some((id, index) => id !== shelf[index]) || sortedHidden.some((id, index) => id !== hidden[index]))) stop('not_canonical');
  return Object.freeze({
    format: LAYOUT_FORMAT, grid: GRID, tiles: Object.freeze(sortedTiles), shelf: Object.freeze(sortedShelf), hidden: Object.freeze(sortedHidden),
  });
}

/** The layout as plain data, with the fields in a fixed order. */
export function layoutObject(layout: Layout): { format: string; grid: { columns: number; unit: number; gap: number }; tiles: { place: string; gauge: string; default: string; col: number; row: number; size: string }[]; shelf: string[]; hidden: string[] } {
  return {
    format: layout.format,
    grid: { columns: layout.grid.columns, unit: layout.grid.unit, gap: layout.grid.gap },
    tiles: layout.tiles.map(({ place, gauge, default: fallback, col, row, size }) => ({ place, gauge, default: fallback, col, row, size })),
    shelf: [...layout.shelf],
    hidden: [...layout.hidden],
  };
}

/** The canonical text of a layout, which is what an export holds: one line of compact JSON and one line feed. The same layout always gives the same bytes. */
export const canonicalText = (layout: Layout): string => `${JSON.stringify(layoutObject(layout))}\n`;

/**
 * Reads JSON from text or UTF-8 bytes: the size cap in bytes first, then UTF-8, then strict JSON (no duplicate key, comment, or trailing comma, and a byte order mark is a
 * syntax problem). It gives the value, or the refusal. It never throws: a bug of its own is `internal`.
 */
export function readJsonText(input: string | Uint8Array, maxBytes: number): { readonly ok: true; readonly value: unknown } | LayoutRefusal {
  try {
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('input is not text or bytes');
    // A text has at least one byte for each UTF-16 unit, so a text longer than the cap in units is too large, and nothing is encoded for it.
    if (typeof input === 'string' && input.length > maxBytes) return invalid('too_large');
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    if (bytes.byteLength > maxBytes) return invalid('too_large');
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return invalid('not_utf8');
    }
    const parsed = parseStrictJson(source);
    return parsed.ok ? { ok: true, value: parsed.value } : invalid(parsed.reason);
  } catch {
    return invalid('internal');
  }
}

/** Reads a layout from text or bytes, with the shape and the grid checked and no Gauge. It sorts an order that is not canonical. It never throws. */
export function parseLayoutText(input: string | Uint8Array): LayoutResult {
  const json = readJsonText(input, MAX_LAYOUT_BYTES);
  if (!json.ok) return json;
  try {
    return layoutOf(json.value, { requireCanonical: false });
  } catch {
    return invalid('internal');
  }
}

// Checking against the Gauges

export const isProtectedId = (id: string, table: GaugeTable): boolean => PAGE_IDS.includes(id) || table.get(id)?.protected === true;

function gaugeProblem(id: string, table: GaugeTable, needsTile: boolean): LayoutReason | undefined {
  if (PAGE_IDS.includes(id)) return needsTile ? 'no_tile' : undefined;
  const info = table.get(id);
  if (!info) return 'unknown_gauge';
  if (!info.enabled) return 'gauge_disabled';
  if (needsTile && !info.tile) return 'no_tile';
  return undefined;
}

/**
 * Checks a layout against the Gauges the core holds. The checks run in a fixed order, and the first that fails refuses:
 * 1. Every Gauge id exists and is enabled, and a place is filled by a Gauge that has a tile (`unknown_gauge`, `gauge_disabled`, `no_tile`). A page can only be on the shelf or hidden.
 * 2. Every tile has a size that its Gauge allows (`size_not_allowed`), and a Gauge that cannot be resized keeps its one size (`not_resizable`).
 * 3. The way back, with `GAUGE_PROTECTED`: a protected Gauge or a page is on the hidden list (`hidden`); a place whose default is a protected Gauge holds another Gauge, or a place of the
 *    default home (`DEFAULT_TILES`) that the core holds for a protected Gauge holds another Gauge, whatever default the file gives it (`replaced`);
 *    a protected Gauge that is enabled, or a page, is on no tile and not on the shelf (`removed`).
 */
export function checkLayout(layout: Layout, table: GaugeTable): LayoutRefusal | undefined {
  for (const tile of layout.tiles) {
    const problem = gaugeProblem(tile.gauge, table, true) ?? gaugeProblem(tile.default, table, true);
    if (problem) return invalid(problem);
  }
  for (const id of [...layout.shelf, ...layout.hidden]) {
    const problem = gaugeProblem(id, table, false);
    if (problem) return invalid(problem);
  }
  for (const tile of layout.tiles) {
    const allowed = table.get(tile.gauge)?.tile;
    if (!allowed) return invalid('no_tile');
    if (!allowed.sizes.includes(tile.size)) return invalid(allowed.resizable ? 'size_not_allowed' : 'not_resizable');
  }
  if (layout.hidden.some(id => isProtectedId(id, table))) return protectedRefusal('hidden');
  if (layout.tiles.some(tile => tile.gauge !== tile.default && isProtectedId(tile.default, table))) return protectedRefusal('replaced');
  // The file cannot vouch for itself: a place of the default home keeps its protected Gauge, whatever `default` the file gives it.
  if (DEFAULT_TILES.some(home => isProtectedId(home.gauge, table) && layout.tiles.some(tile => tile.place === home.place && tile.gauge !== home.gauge))) return protectedRefusal('replaced');
  const reachable = new Set([...layout.tiles.map(tile => tile.gauge), ...layout.shelf]);
  const required = [...PAGE_IDS, ...[...table].filter(([, info]) => info.enabled && info.protected).map(([id]) => id)];
  if (required.some(id => !reachable.has(id))) return protectedRefusal('removed');
  return undefined;
}

/** Reads a layout from text or bytes and checks it against the Gauges: what an import and the start of the core do. */
export function parseLayout(input: string | Uint8Array, table: GaugeTable): LayoutResult {
  const read = parseLayoutText(input);
  if (!read.ok) return read;
  return checkLayout(read.layout, table) ?? read;
}

/**
 * The default layout: the five default tiles in the arrangement of the home, and every other enabled Gauge and every page on the shelf. A default Gauge that the core does not hold,
 * that is disabled, or whose tile does not allow its default size is left off the home and goes on the shelf if it is enabled. The result is a valid layout for any set of Gauges.
 */
export function defaultLayout(table: GaugeTable): Layout {
  const known = (id: string): boolean => id.length <= 64 && NAME.test(id);
  const tiles = DEFAULT_TILES.filter(tile => {
    const info = table.get(tile.gauge);
    return info?.enabled === true && info.tile?.sizes.includes(tile.size) === true;
  }).map(tile => ({ ...tile, default: tile.gauge }));
  const onHome = new Set(tiles.map(tile => tile.gauge));
  const others = [...table].filter(([id, info]) => info.enabled && known(id) && !onHome.has(id));
  // The protected Gauges come first, so a cap on the shelf could never leave one out.
  const shelf = [...PAGE_IDS, ...others.filter(([, info]) => info.protected).map(([id]) => id).sort(compare), ...others.filter(([, info]) => !info.protected).map(([id]) => id).sort(compare)].slice(0, MAX_LISTED);
  const result = layoutOf({ format: LAYOUT_FORMAT, grid: GRID, tiles, shelf, hidden: [] }, { requireCanonical: false });
  if (!result.ok) throw new Error(`the default layout is not valid: ${result.reason}`);
  return result.layout;
}
