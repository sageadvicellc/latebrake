import { GRID, sizeUnits } from './grid.js';
import {
  LAYOUT_FORMAT, MAX_LISTED, PAGE_IDS, checkLayout, defaultLayout, fitsAmong, layoutOf, type GaugeInfo, type GaugeTable, type Layout, type LayoutTile, type TileInfo,
} from './layout.js';
import { sizesToTry } from './ops.js';

type Usable = GaugeInfo & { readonly tile: TileInfo };
const area = (size: LayoutTile['size']): number => sizeUnits(size).w * sizeUnits(size).h;
/** The sizes to try after a step: the ones that the Gauge allows and that are no bigger than the tile it had, so a step never makes a tile grow into its neighbours. */
const shrinkTo = (tile: LayoutTile, allowed: TileInfo['sizes']): LayoutTile['size'][] => sizesToTry(tile.size, allowed).filter(size => area(size) <= area(tile.size));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Brings a layout back in line with the Gauges the core holds, after a lifecycle step changed them. The core does this inside the same approved plan, and saves the result as a normal revision.
 *
 * - A Gauge that is disabled, removed, or has lost its tile leaves its tile. The place goes back to its default Gauge when that Gauge is enabled, has a tile, and is not on another tile.
 *   Otherwise the tile is dropped. A Gauge that is enabled and lost only its tile goes to the shelf.
 * - A tile whose Gauge no longer allows its size takes the first allowed size that is no bigger than the tile and that fits, in the same cell. When none does, the Gauge goes to the shelf.
 * - A default Gauge that is gone becomes the Gauge that fills the place, and two places never share a default.
 * - A Gauge that is disabled or removed leaves the shelf and the hidden list. `settings` stays.
 * - A protected Gauge that is enabled and on no tile goes to the shelf, from the hidden list too. A protected Gauge is never dropped.
 *
 * It never edits the layout it was given. The result is valid for the Gauges. If a case that these rules do not foresee ever gave an invalid layout, the default layout is given instead,
 * and a test holds every single-Gauge change to this.
 */
export function reconcileLayout(layout: Layout, table: GaugeTable): Layout {
  const usable = (id: string): Usable | undefined => {
    const info = table.get(id);
    return info !== undefined && info.enabled && info.tile !== null ? { ...info, tile: info.tile } : undefined;
  };
  const kept: LayoutTile[] = [], resize: LayoutTile[] = [], gone: LayoutTile[] = [];
  for (const tile of layout.tiles) {
    const info = usable(tile.gauge);
    if (!info) gone.push(tile);
    else if (info.tile.sizes.includes(tile.size)) kept.push(tile);
    else resize.push(tile);
  }
  const placed: LayoutTile[] = [...kept];
  const onTiles = new Set<string>([...kept, ...resize].map(tile => tile.gauge));
  const toShelf = new Set<string>();
  for (const tile of resize) {
    const info = usable(tile.gauge);
    const next = info ? shrinkTo(tile, info.tile.sizes).map(size => ({ ...tile, size })).find(candidate => fitsAmong(candidate, placed)) : undefined;
    if (next) placed.push(next);
    else { onTiles.delete(tile.gauge); toShelf.add(tile.gauge); }
  }
  for (const tile of gone) {
    // A Gauge that is enabled and only lost its tile stays reachable from the shelf.
    if (table.get(tile.gauge)?.enabled === true) toShelf.add(tile.gauge);
    const fallback = usable(tile.default);
    if (!fallback || onTiles.has(tile.default)) continue;
    const next = shrinkTo(tile, fallback.tile.sizes).map(size => ({ ...tile, gauge: tile.default, size })).find(candidate => fitsAmong(candidate, placed));
    if (next) { placed.push(next); onTiles.add(tile.default); }
  }
  // Every default is a Gauge that is there, and no two places share one. A default that is gone becomes the Gauge in the place.
  let tiles = placed.map(tile => (usable(tile.default) ? tile : { ...tile, default: tile.gauge }));
  for (;;) {
    const counts = new Map<string, number>();
    for (const tile of tiles) counts.set(tile.default, (counts.get(tile.default) ?? 0) + 1);
    const clash = tiles.filter(tile => (counts.get(tile.default) ?? 0) > 1 && tile.default !== tile.gauge);
    if (clash.length === 0) break;
    tiles = tiles.map(tile => (clash.includes(tile) ? { ...tile, default: tile.gauge } : tile));
  }
  const onHome = new Set(tiles.map(tile => tile.gauge));
  const listed = (id: string): boolean => PAGE_IDS.includes(id) || table.get(id)?.enabled === true;
  const protectedIds = [...table].filter(([, info]) => info.enabled && info.protected).map(([id]) => id);
  const shelfAll = new Set([...layout.shelf, ...toShelf, ...protectedIds.filter(id => !onHome.has(id))].filter(id => listed(id) && !onHome.has(id)));
  const first = [...shelfAll].filter(id => PAGE_IDS.includes(id) || table.get(id)?.protected === true).sort(compare), rest = [...shelfAll].filter(id => !first.includes(id)).sort(compare);
  const shelf = [...first, ...rest].slice(0, MAX_LISTED);
  const hidden = layout.hidden.filter(id => table.get(id)?.enabled === true && table.get(id)?.protected !== true && !onHome.has(id) && !shelfAll.has(id));
  const result = layoutOf({ format: LAYOUT_FORMAT, grid: GRID, tiles, shelf, hidden }, { requireCanonical: false });
  if (result.ok && checkLayout(result.layout, table) === undefined) return result.layout;
  return defaultLayout(table);
}
