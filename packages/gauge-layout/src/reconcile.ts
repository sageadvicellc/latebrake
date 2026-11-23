import { GRID, sizeUnits } from './grid.js';
import { DEFAULT_TILES } from './home.js';
import {
  LAYOUT_FORMAT, MAX_LISTED, PAGE_IDS, checkLayout, fitsAmong, layoutOf, type GaugeInfo, type GaugeTable, type Layout, type LayoutTile, type TileInfo,
} from './layout.js';
import { sizesToTry } from './ops.js';

type Usable = GaugeInfo & { readonly tile: TileInfo };
const area = (size: LayoutTile['size']): number => sizeUnits(size).w * sizeUnits(size).h;
/** The sizes to try after a step: the ones that the Gauge allows and that are no bigger than the tile it had, so a step never makes a tile grow into its neighbours. */
const shrinkTo = (tile: LayoutTile, allowed: TileInfo['sizes']): LayoutTile['size'][] => sizesToTry(tile.size, allowed).filter(size => area(size) <= area(tile.size));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ReconcileOptions {
  /** A Gauge that a step just enabled. When it is on no tile, shelf, or hidden entry, it goes to the shelf, so it does not vanish. */
  readonly enabled?: string;
}

/**
 * Brings a layout back in line with the Gauges the core holds, after a lifecycle step changed them. The core does this inside the same approved plan, and saves the result as a normal revision.
 *
 * - A Gauge that is disabled, removed, or has lost its tile leaves its tile. The place goes back to its default Gauge when that Gauge is enabled, has a tile, is not hidden, is not on another
 *   tile, and has a size that fits (the size of the place first, then its manifest order). Otherwise the tile is dropped, and it stays gone: a restore of an earlier revision brings it back.
 *   A Gauge that is enabled and lost only its tile goes to the shelf.
 * - A tile whose Gauge no longer allows its size takes the first allowed size that is no bigger than the tile and that fits, in the same cell. When none does, the Gauge goes to the shelf.
 * - A place that is for a protected Gauge (its default became protected, or it is a place of the default home for one) and that another Gauge fills gives the place back to the protected
 *   Gauge. A protected Gauge on the shelf takes the place, and the Gauge that was there goes to the shelf. A protected Gauge on another tile exchanges places with it. When neither fits, the
 *   tile is dropped and the Gauge that was there goes to the shelf.
 * - A default Gauge that is gone becomes the Gauge that fills the place, and two places never share a default.
 * - A Gauge that is disabled or removed leaves the shelf and the hidden list. `settings` stays.
 * - A protected Gauge that is enabled and on no tile goes to the shelf, from the hidden list too. A protected Gauge is never dropped.
 * - A Gauge that was just enabled (`options.enabled`) and is on no tile, shelf, or hidden entry goes to the shelf.
 * - A hidden Gauge stays hidden, also when it is the default of a place whose tile was dropped.
 *
 * It never edits the layout it was given. The result is valid for the Gauges. A case that these rules do not foresee throws a plain `Error`, so a bug fails loudly and the core refuses the
 * step before it changes anything. It never gives back a different arrangement in silence.
 */
export function reconcileLayout(layout: Layout, table: GaugeTable, options: ReconcileOptions = {}): Layout {
  const usable = (id: string): Usable | undefined => {
    const info = table.get(id);
    return info !== undefined && info.enabled && info.tile !== null ? { ...info, tile: info.tile } : undefined;
  };
  const isProtected = (id: string): boolean => table.get(id)?.protected === true;
  const kept: LayoutTile[] = [], resize: LayoutTile[] = [], gone: LayoutTile[] = [];
  for (const tile of layout.tiles) {
    const info = usable(tile.gauge);
    if (!info) gone.push(tile);
    else if (info.tile.sizes.includes(tile.size)) kept.push(tile);
    else resize.push(tile);
  }
  let placed: LayoutTile[] = [...kept];
  const onTiles = new Set<string>([...kept, ...resize].map(tile => tile.gauge));
  const toShelf = new Set<string>();
  for (const tile of resize) {
    const info = usable(tile.gauge);
    // A size that is no bigger than the tile, in the cell of the tile, needs no check against the grid or the other tiles. The four sizes are rectangles that are nested and anchored at the top left
    // (small in medium in large in full, in cells), so a smaller one lies inside the old one, and the old one was inside the grid and apart from the other tiles, as `layoutOf` required. A test holds
    // the sizes to this, so a size of another shape fails loudly.
    const next = info ? shrinkTo(tile, info.tile.sizes).map(size => ({ ...tile, size }))[0] : undefined;
    if (next) placed.push(next);
    else { onTiles.delete(tile.gauge); toShelf.add(tile.gauge); }
  }
  for (const tile of gone) {
    // A Gauge that is enabled and only lost its tile stays reachable from the shelf.
    if (table.get(tile.gauge)?.enabled === true) toShelf.add(tile.gauge);
    const fallback = usable(tile.default);
    // A hidden Gauge stays hidden, so it does not come back on a tile as a side effect of another Gauge's step.
    if (!fallback || onTiles.has(tile.default) || layout.hidden.includes(tile.default)) continue;
    const next = sizesToTry(tile.size, fallback.tile.sizes).map(size => ({ ...tile, gauge: tile.default, size })).find(candidate => fitsAmong(candidate, placed));
    if (next) { placed.push(next); onTiles.add(tile.default); }
  }
  // A place that is for a protected Gauge and that another Gauge fills gives the place back.
  const claim = (tile: LayoutTile): string | undefined => {
    if (tile.default !== tile.gauge && isProtected(tile.default)) return tile.default;
    const home = DEFAULT_TILES.find(candidate => candidate.place === tile.place && candidate.gauge !== tile.gauge && isProtected(candidate.gauge));
    return home?.gauge;
  };
  // Why this ends. A claim is a place that is for a protected Gauge that it does not hold. Only a Gauge that became protected can be claimed. Such a Gauge is claimed by at most its own place of the
  // default home and by the places that name it as their default. A repair settles one claim: it puts the protected Gauge into the place, or drops the tile. In an exchange the other tile gets the
  // displaced Gauge, and when its old default was the protected Gauge it takes the displaced Gauge as its default, so it does not claim the Gauge again. It may still claim another protected Gauge
  // through its own place or its default, and that claim is settled in its turn. A claim is settled in at most three rounds: its own repair, the repair of the claim that its exchange hands to
  // another tile, and one more for the claim that this one hands on. So the loop ends within three rounds for each tile, and the bound is three rounds for each tile and one more. The bound is only a
  // guard: when it is reached there is a bug, and the check at the end throws.
  const bound = 3 * placed.length + 1;
  for (let round = 0; round <= bound; round += 1) {
    const holder = placed.find(tile => claim(tile) !== undefined);
    if (!holder) break;
    const wanted = claim(holder) ?? holder.gauge;
    const info = usable(wanted);
    const others = placed.filter(tile => tile !== holder);
    const onTile = others.find(tile => tile.gauge === wanted);
    let repaired = false;
    if (info && !onTile) {
      const next = sizesToTry(holder.size, info.tile.sizes).map(size => ({ ...holder, gauge: wanted, default: wanted, size })).find(candidate => fitsAmong(candidate, others));
      if (next) { placed = [...others, next]; toShelf.add(holder.gauge); repaired = true; }
    } else if (info && onTile) {
      const moving = usable(holder.gauge);
      const rest = others.filter(tile => tile !== onTile);
      for (const size of sizesToTry(holder.size, info.tile.sizes)) {
        for (const otherSize of moving ? sizesToTry(onTile.size, moving.tile.sizes) : []) {
          // The tile that gets the displaced Gauge keeps its own default, unless that default is a protected Gauge: then it takes the displaced Gauge as its default, or it would claim that Gauge again.
          const a = { ...holder, gauge: wanted, default: wanted, size }, b = { ...onTile, gauge: holder.gauge, default: isProtected(onTile.default) ? holder.gauge : onTile.default, size: otherSize };
          if (!repaired && fitsAmong(a, [...rest, b]) && fitsAmong(b, [...rest, a])) { placed = [...rest, a, b]; repaired = true; }
        }
      }
    }
    if (!repaired) { placed = others; toShelf.add(holder.gauge); }
  }
  onTiles.clear();
  for (const tile of placed) onTiles.add(tile.gauge);
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
  const justEnabled = options.enabled !== undefined && listed(options.enabled) && !layout.hidden.includes(options.enabled) ? [options.enabled] : [];
  const shelfAll = new Set([...layout.shelf, ...toShelf, ...justEnabled, ...protectedIds.filter(id => !onHome.has(id))].filter(id => listed(id) && !onHome.has(id)));
  const first = [...shelfAll].filter(id => PAGE_IDS.includes(id) || isProtected(id)).sort(compare), rest = [...shelfAll].filter(id => !first.includes(id)).sort(compare);
  const shelf = [...first, ...rest].slice(0, MAX_LISTED);
  const hidden = layout.hidden.filter(id => table.get(id)?.enabled === true && !isProtected(id) && !onHome.has(id) && !shelfAll.has(id));
  const result = layoutOf({ format: LAYOUT_FORMAT, grid: GRID, tiles, shelf, hidden }, { requireCanonical: false });
  const problem = result.ok ? checkLayout(result.layout, table) : result;
  if (result.ok && problem === undefined) return result.layout;
  throw new Error(`reconcile gave a layout that is not valid for the Gauges: ${problem?.code ?? 'unknown'} ${problem?.reason ?? ''}`);
}
