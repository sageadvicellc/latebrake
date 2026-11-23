import { COLUMNS, MAX_ROWS, sizeUnits } from './grid.js';
import {
  LAYOUT_FORMAT, MAX_TILES, checkLayout, isProtectedId, layoutOf, type GaugeInfo, type GaugeTable, type Layout, type LayoutTile,
} from './layout.js';
import { GRID } from './grid.js';
import { invalid, protectedRefusal, unknownGauge, type LayoutRefusal, type UnknownGaugeRefusal } from './reasons.js';

/** What a change gives: the new layout, or a refusal. A refusal changes nothing: every operation builds a new layout and never edits the one it was given. */
export type OpResult = { readonly ok: true; readonly layout: Layout } | LayoutRefusal | UnknownGaugeRefusal;

/** Builds the layout with changes, then checks it as a whole, against the grid and against the Gauges. */
function rebuild(base: Layout, changes: { readonly tiles?: readonly LayoutTile[]; readonly shelf?: readonly string[]; readonly hidden?: readonly string[] }, table: GaugeTable): OpResult {
  const next = layoutOf({ format: LAYOUT_FORMAT, grid: GRID, tiles: changes.tiles ?? base.tiles, shelf: changes.shelf ?? base.shelf, hidden: changes.hidden ?? base.hidden }, { requireCanonical: false });
  if (!next.ok) return next;
  return checkLayout(next.layout, table) ?? next;
}

/** Reads the Gauge that a change names. An id that is not text, or that no Gauge has, is `UNKNOWN_GAUGE`. The Gauge must be enabled and must have a tile. */
function tiled(table: GaugeTable, gauge: unknown): { readonly ok: true; readonly id: string; readonly info: GaugeInfo & { readonly tile: NonNullable<GaugeInfo['tile']> } } | LayoutRefusal | UnknownGaugeRefusal {
  const info = typeof gauge === 'string' ? table.get(gauge) : undefined;
  if (typeof gauge !== 'string' || !info) return unknownGauge();
  if (!info.enabled) return invalid('gauge_disabled');
  if (!info.tile) return invalid('no_tile');
  return { ok: true, id: gauge, info: { ...info, tile: info.tile } };
}

/**
 * A person swaps which Gauge fills a place. The place keeps its position and its default Gauge. The new Gauge keeps the size of the place when its tile allows it, and takes its first
 * allowed size when it does not. The Gauge that was in the place goes to the shelf, and the new Gauge leaves the shelf or the hidden list. A Gauge that already fills another place is refused
 * (`duplicate_gauge`), and so is a swap that would replace a protected Gauge (`GAUGE_PROTECTED`, `replaced`). A swap to the Gauge that is already there changes nothing.
 */
export function swapPlace(layout: Layout, table: GaugeTable, place: unknown, gauge: unknown): OpResult {
  const tile = typeof place === 'string' ? layout.tiles.find(candidate => candidate.place === place) : undefined;
  if (!tile) return invalid('unknown_place');
  const target = tiled(table, gauge);
  if (!target.ok) return target;
  if (target.id === tile.gauge) return { ok: true, layout };
  if (isProtectedId(tile.gauge, table)) return protectedRefusal('replaced');
  if (layout.tiles.some(candidate => candidate.gauge === target.id)) return invalid('duplicate_gauge');
  const size = target.info.tile.sizes.includes(tile.size) ? tile.size : target.info.tile.sizes[0] ?? tile.size;
  return rebuild(layout, {
    tiles: layout.tiles.map(candidate => (candidate === tile ? { ...candidate, gauge: target.id, size } : candidate)),
    shelf: [...layout.shelf.filter(id => id !== target.id), tile.gauge],
    hidden: layout.hidden.filter(id => id !== target.id),
  }, table);
}

/** The default Gauge of a place is one action away: this puts it back. It changes nothing when the place already holds it, and it is a swap to the default otherwise. */
export function defaultPlace(layout: Layout, table: GaugeTable, place: unknown): OpResult {
  const tile = typeof place === 'string' ? layout.tiles.find(candidate => candidate.place === place) : undefined;
  if (!tile) return invalid('unknown_place');
  if (tile.gauge === tile.default) return { ok: true, layout };
  return swapPlace(layout, table, tile.place, tile.default);
}

/** The first cell, by row and then column, where a tile of this size fits among the tiles. */
function firstFree(tiles: readonly LayoutTile[], size: LayoutTile['size']): { readonly col: number; readonly row: number } | undefined {
  const taken = Array.from({ length: MAX_ROWS }, () => new Array<boolean>(COLUMNS).fill(false));
  for (const tile of tiles) {
    const { w, h } = sizeUnits(tile.size);
    for (let row = tile.row; row < tile.row + h; row += 1) for (let col = tile.col; col < tile.col + w; col += 1) { const line = taken[row]; if (line) line[col] = true; }
  }
  const { w, h } = sizeUnits(size);
  for (let row = 0; row + h <= MAX_ROWS; row += 1) {
    for (let col = 0; col + w <= COLUMNS; col += 1) {
      let free = true;
      for (let y = row; y < row + h && free; y += 1) for (let x = col; x < col + w; x += 1) if (taken[y]?.[x] !== false) { free = false; break; }
      if (free) return { col, row };
    }
  }
  return undefined;
}

/**
 * The layout that a Gauge asks for when it proposes to add itself. The Gauge gets a new tile of its first allowed size, in the first free cell, in a place named `place-<n>` with the
 * smallest free number, and leaves the shelf or the hidden list. It is refused when the Gauge already fills a place, when the home has the most tiles, and with `no_room` when no cell is free.
 * This builds the layout only. The core shows it to the person as a plan, and the person approves it.
 */
export function proposeTile(layout: Layout, table: GaugeTable, gauge: unknown): OpResult {
  const target = tiled(table, gauge);
  if (!target.ok) return target;
  if (layout.tiles.some(candidate => candidate.gauge === target.id)) return invalid('duplicate_gauge');
  if (layout.tiles.length >= MAX_TILES) return invalid('too_many_tiles');
  const size = target.info.tile.sizes[0] ?? 'small';
  const spot = firstFree(layout.tiles, size);
  if (!spot) return invalid('no_room');
  const used = new Set(layout.tiles.map(tile => tile.place));
  let number = 1;
  while (used.has(`place-${number}`)) number += 1;
  return rebuild(layout, {
    tiles: [...layout.tiles, { place: `place-${number}`, gauge: target.id, default: target.id, col: spot.col, row: spot.row, size }],
    shelf: layout.shelf.filter(id => id !== target.id),
    hidden: layout.hidden.filter(id => id !== target.id),
  }, table);
}
