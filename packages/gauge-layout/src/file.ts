import { MAX_LAYOUT_BYTES, canonicalText, checkLayout, layoutObject, layoutOf, readJsonText, type GaugeTable, type Layout } from './layout.js';
import { invalid, type LayoutReason, type LayoutRefusal } from './reasons.js';

/** The format of the saved layout file. It holds the current layout and the earlier revisions. */
export const FILE_FORMAT = 'bowerloom/layout-file/1' as const;
/** The file keeps this many earlier revisions, besides the current layout. The 11th drops the oldest. */
export const MAX_REVISIONS = 10;
/** The last revision number. A file at this number takes no more saves. */
export const MAX_REVISION = 999_999_999;
/** The largest layout file, in bytes: the current layout and every revision at the largest size of a layout, and room for the rest. */
export const MAX_FILE_BYTES = (MAX_REVISIONS + 1) * MAX_LAYOUT_BYTES + 4096;

export interface LayoutRevision {
  readonly revision: number;
  readonly layout: Layout;
}

/** The saved layout: the current layout with its number, and the earlier revisions, newest first. The current layout is never in the list, so it is never lost when the oldest revision is dropped. */
export interface LayoutFile {
  readonly revision: number;
  readonly current: Layout;
  readonly revisions: readonly LayoutRevision[];
}

export type LayoutFileResult = { readonly ok: true; readonly file: LayoutFile } | LayoutRefusal;

/** A file that holds this layout as revision 1, with no earlier revision. */
export const newFile = (layout: Layout): LayoutFile => Object.freeze({ revision: 1, current: layout, revisions: Object.freeze([]) });

/**
 * Saves a layout as the new current one. The old current layout becomes the newest revision, the number goes up by one, and the oldest revision is dropped when there are more than 10.
 * A layout that is the same as the current one writes no revision, and the same file comes back. It gives `undefined` when the counter is full. It never changes the file it was given.
 */
export function saveRevision(file: LayoutFile, next: Layout): LayoutFile | undefined {
  if (canonicalText(next) === canonicalText(file.current)) return file;
  if (file.revision >= MAX_REVISION) return undefined;
  const revisions = [Object.freeze({ revision: file.revision, layout: file.current }), ...file.revisions].slice(0, MAX_REVISIONS);
  return Object.freeze({ revision: file.revision + 1, current: next, revisions: Object.freeze(revisions) });
}

/** The number of the revision that a save would drop now, which is the oldest, or `null` while the file holds fewer than 10 earlier revisions. */
export const droppedRevision = (file: LayoutFile): number | null => (file.revisions.length >= MAX_REVISIONS ? file.revisions[file.revisions.length - 1]?.revision ?? null : null);

/** The text of the file: one line of compact JSON with the fields in a fixed order, and one line feed. */
export const serializeLayoutFile = (file: LayoutFile): string => `${JSON.stringify({
  format: FILE_FORMAT,
  revision: file.revision,
  current: layoutObject(file.current),
  revisions: file.revisions.map(entry => ({ revision: entry.revision, layout: layoutObject(entry.layout) })),
})}\n`;

class Stop extends Error {
  constructor(readonly refusal: LayoutRefusal) { super('stop'); }
}
const stop = (reason: LayoutReason): never => { throw new Stop(invalid(reason)); };

function fieldsOf(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return stop('invalid_field');
  const found = new Map<string, unknown>();
  for (const key of Object.keys(value)) found.set(key, (value as Record<string, unknown>)[key]);
  if ([...found.keys()].some(key => !keys.includes(key))) return stop('unknown_field');
  if (keys.some(key => !found.has(key))) return stop('missing_field');
  return found;
}
function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) return stop('invalid_field');
  return value >= 1 && value <= MAX_REVISION ? value : stop('bad_revision');
}
function layoutIn(value: unknown): Layout {
  const result = layoutOf(value, { requireCanonical: false });
  if (!result.ok) throw new Stop(result);
  return result.layout;
}

/**
 * Reads the layout file from text or bytes, and checks the current layout against the Gauges. The revisions are checked for their shape and their grid only: a revision may name a Gauge
 * that is gone now, and is checked against the Gauges when it is restored. The size cap, UTF-8, and strict JSON come first. The revision numbers must fall from the newest to the
 * oldest, all below the current number. A file with more than 10 revisions is refused. It never throws.
 */
export function parseLayoutFile(input: string | Uint8Array, table: GaugeTable): LayoutFileResult {
  const json = readJsonText(input, MAX_FILE_BYTES);
  if (!json.ok) return json;
  try {
    const fields = fieldsOf(json.value, ['format', 'revision', 'current', 'revisions']);
    const format = fields.get('format');
    if (typeof format !== 'string') stop('invalid_field');
    if (format !== FILE_FORMAT) stop('unsupported_format');
    const revision = revisionOf(fields.get('revision'));
    const current = layoutIn(fields.get('current'));
    const list = fields.get('revisions');
    if (!Array.isArray(list)) stop('invalid_field');
    if ((list as unknown[]).length > MAX_REVISIONS) stop('too_many_revisions');
    const revisions: LayoutRevision[] = [];
    for (const item of Array.from(list as unknown[])) {
      const entry = fieldsOf(item, ['revision', 'layout']);
      const number = revisionOf(entry.get('revision'));
      if (number >= (revisions[revisions.length - 1]?.revision ?? revision)) stop('bad_revision');
      revisions.push(Object.freeze({ revision: number, layout: layoutIn(entry.get('layout')) }));
    }
    const refused = checkLayout(current, table);
    if (refused) return refused;
    return { ok: true, file: Object.freeze({ revision, current, revisions: Object.freeze(revisions) }) };
  } catch (error) {
    if (error instanceof Stop) return error.refusal;
    return invalid('internal');
  }
}
