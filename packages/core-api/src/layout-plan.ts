import { canonicalText, type Layout } from '../../gauge-layout/src/index.js';
import { escapeForPlan } from './plan-text.js';
import type { LayoutKind } from './types.js';

export interface LayoutStepsInput {
  readonly kind: LayoutKind;
  readonly place: string | null;
  readonly gauge: string | null;
  readonly revision: number | null;
  /** The layout in use, and the layout that the change would give. */
  readonly base: Layout;
  readonly next: Layout;
  readonly baseHash: string;
  readonly nextHash: string;
  /** The number of the layout in use. In safe mode the layout in use is not saved, and `safe` is true. */
  readonly baseRevision: number;
  readonly safe: boolean;
  /** The number of the revision that the save would drop because the file holds 10 earlier ones, or `null`. */
  readonly dropped: number | null;
}

const KEEP = (revision: number): string => `keep the layout now in use as revision ${revision}, and keep at most 10 earlier revisions`;
const DROP = (revision: number): string => `drop revision ${revision}, the oldest, because the file keeps at most 10 earlier revisions`;

/**
 * The lines of a layout plan, which the person reads and approves. This is the contract, in this order:
 *
 * 1. The change: `replace the layout with the layout in the text given`, `swap place <place> from <gauge> to <gauge>`, `put the default Gauge <gauge> back in place <place>`,
 *    `restore revision <n> as the new layout`, or `add <gauge> to the layout, as the Gauge asked`.
 * 2. `after the change: <n> tile[s], <n> on the shelf, <n> hidden`.
 * 3. One line for each tile of the result, in the order of the file: `tile <place>: <gauge> <size> at column <col> row <row>`.
 * 4. `shelf: <ids joined by a comma and a space>`, or `shelf: none`, then `hidden: ...` in the same form.
 * 5. What happens to the file: `no change: the layout stays as it is`, or in safe mode `leave safe mode, keep the saved file as a backup, and save the layout as revision 1`, or
 *    `keep the layout now in use as revision <n>, and keep at most 10 earlier revisions`, followed by `drop revision <n>, the oldest, because the file keeps at most 10 earlier revisions`
 *    when the file already holds 10 earlier revisions.
 *    A Gauge that was hidden and is not hidden after the change has a line before the tiles: `<gauge> was hidden and will show again`.
 * 6. `bind the change to layout <hash> and result <hash>`.
 *
 * Every value goes through `escapeForPlan`, so no value can add or forge a line.
 */
export function layoutSteps(input: LayoutStepsInput): string[] {
  const e = escapeForPlan;
  const header = {
    set: () => 'replace the layout with the layout in the text given',
    swap: () => `swap place ${e(input.place ?? 'none')} from ${e(input.base.tiles.find(tile => tile.place === input.place)?.gauge ?? 'none')} to ${e(input.gauge ?? 'none')}`,
    default: () => `put the default Gauge ${e(input.base.tiles.find(tile => tile.place === input.place)?.default ?? 'none')} back in place ${e(input.place ?? 'none')}`,
    restore: () => `restore revision ${e(String(input.revision ?? 'none'))} as the new layout`,
    propose: () => `add ${e(input.gauge ?? 'none')} to the layout, as the Gauge asked`,
  }[input.kind]();
  const { tiles, shelf, hidden } = input.next;
  const list = (ids: readonly string[]) => (ids.length > 0 ? ids.map(e).join(', ') : 'none');
  const unchanged = canonicalText(input.base) === canonicalText(input.next);
  const shown = input.base.hidden.filter(id => !input.next.hidden.includes(id));
  return [
    header,
    ...shown.map(id => `${e(id)} was hidden and will show again`),
    `after the change: ${tiles.length} tile${tiles.length === 1 ? '' : 's'}, ${shelf.length} on the shelf, ${hidden.length} hidden`,
    ...tiles.map(tile => `tile ${e(tile.place)}: ${e(tile.gauge)} ${e(tile.size)} at column ${tile.col} row ${tile.row}`),
    `shelf: ${list(shelf)}`,
    `hidden: ${list(hidden)}`,
    ...(input.safe ? ['leave safe mode, keep the saved file as a backup, and save the layout as revision 1']
      : unchanged ? ['no change: the layout stays as it is']
      : [KEEP(input.baseRevision), ...(input.dropped === null ? [] : [DROP(input.dropped)])]),
    `bind the change to layout ${e(input.baseHash)} and result ${e(input.nextHash)}`,
  ];
}

/**
 * The lines that a lifecycle plan adds when the step changes the layout too. The layout is brought in line with the Gauges inside the same approved plan and saved as a normal revision, so
 * the person reads the change before approving it. Each line starts with `layout: `, and every value goes through `escapeForPlan`. There are none when the layout does not change.
 */
export function layoutChangeSteps(before: Layout, after: Layout, baseRevision: number, dropped: number | null): string[] {
  const e = escapeForPlan;
  const lines: string[] = [];
  for (const tile of before.tiles) {
    const next = after.tiles.find(candidate => candidate.place === tile.place);
    if (!next) lines.push(`layout: drop tile ${e(tile.place)} (${e(tile.gauge)})`);
    else if (next.gauge !== tile.gauge) lines.push(`layout: tile ${e(tile.place)} holds ${e(next.gauge)} ${e(next.size)} instead of ${e(tile.gauge)}`);
    else if (next.size !== tile.size) lines.push(`layout: tile ${e(tile.place)} changes from ${e(tile.size)} to ${e(next.size)}`);
    if (next && next.default !== tile.default) lines.push(`layout: place ${e(tile.place)} has the default ${e(next.default)}`);
  }
  for (const id of before.shelf.filter(entry => !after.shelf.includes(entry))) lines.push(`layout: remove ${e(id)} from the shelf`);
  for (const id of after.shelf.filter(entry => !before.shelf.includes(entry))) lines.push(`layout: add ${e(id)} to the shelf`);
  for (const id of before.hidden.filter(entry => !after.hidden.includes(entry))) lines.push(`layout: remove ${e(id)} from the hidden list`);
  if (lines.length === 0) return [];
  return [...lines, `layout: ${KEEP(baseRevision)}`, ...(dropped === null ? [] : [`layout: ${DROP(dropped)}`])];
}
