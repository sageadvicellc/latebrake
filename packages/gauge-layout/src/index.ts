/** The layout of the bento home: the grid, the layout file, its revisions, and the changes a person can make. See `README.md`. */
export { COLUMNS, FULL_WIDTH_PX, GAP_PX, GRID, MAX_ROWS, UNIT_PX, columnsFor, sizeUnits, spanOn } from './grid.js';
export { DEFAULT_TILES, HOME_GAUGES } from './home.js';
export type { HomeGauge } from './home.js';
export {
  LAYOUT_FORMAT, MAX_LAYOUT_BYTES, MAX_LISTED, MAX_TILES, PAGE_IDS, canonicalText, checkLayout, defaultLayout, isProtectedId, layoutObject, layoutOf, parseLayout, parseLayoutText, readJsonText, tileInfoOf,
} from './layout.js';
export type { GaugeInfo, GaugeTable, Layout, LayoutResult, LayoutTile, ReadOptions, TileInfo } from './layout.js';
export { defaultPlace, proposeTile, swapPlace } from './ops.js';
export type { OpResult } from './ops.js';
export { FILE_FORMAT, MAX_FILE_BYTES, MAX_REVISION, MAX_REVISIONS, newFile, parseLayoutFile, saveRevision, serializeLayoutFile } from './file.js';
export type { LayoutFile, LayoutFileResult, LayoutRevision } from './file.js';
export { LAYOUT_REASONS, PROTECTED_REASONS, invalid, isLayoutReason, isProtectedReason, protectedRefusal, unknownGauge } from './reasons.js';
export type { LayoutReason, LayoutRefusal, ProtectedReason, UnknownGaugeRefusal } from './reasons.js';
