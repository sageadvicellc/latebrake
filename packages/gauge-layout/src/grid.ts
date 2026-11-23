import type { TileSize } from '../../gauge-manifest/src/index.js';

/** The grid of the bento home: 6 columns, a unit of 200 px, and a gap of 12 px. */
export const COLUMNS = 6;
export const UNIT_PX = 200;
export const GAP_PX = 12;
export const GRID = Object.freeze({ columns: COLUMNS, unit: UNIT_PX, gap: GAP_PX });

/** The width of the full home: 6 units and 5 gaps, 1,260 px. */
export const FULL_WIDTH_PX = COLUMNS * UNIT_PX + (COLUMNS - 1) * GAP_PX;

/** The home has a fixed number of rows, so a tile cannot sit at any depth. A tile must end within this many rows. */
export const MAX_ROWS = 32;

const UNITS: Readonly<Record<TileSize, { readonly w: number; readonly h: number }>> = Object.freeze({
  small: Object.freeze({ w: 1, h: 1 }),
  medium: Object.freeze({ w: 2, h: 1 }),
  large: Object.freeze({ w: 2, h: 2 }),
  full: Object.freeze({ w: COLUMNS, h: 2 }),
});

/** The size of a tile in grid units: small 1x1, medium 2x1, large 2x2, and full (every column) x 2. */
export const sizeUnits = (size: TileSize): { readonly w: number; readonly h: number } => UNITS[size];

/**
 * How many columns a window of this width in px has. A window too narrow for 6 columns drops columns: n columns need `212 n - 12` px. Never less than 1, never more than 6.
 * A width that is not a number gives 1.
 */
export function columnsFor(width: number): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return 1;
  return Math.min(COLUMNS, Math.max(1, Math.floor((width + GAP_PX) / (UNIT_PX + GAP_PX))));
}

/** How many of the available columns a tile of this size covers: its own width, and no more than the columns that the window has. The file does not change. */
export const spanOn = (size: TileSize, columns: number): number => Math.min(UNITS[size].w, columns);
