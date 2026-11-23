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
}

/**
 * The lines of a layout plan, which the person reads and approves. This is the contract, in this order:
 *
 * 1. The change: `replace the layout with the layout in the text given`, `swap place <place> from <gauge> to <gauge>`, `put the default Gauge <gauge> back in place <place>`,
 *    `restore revision <n> as the new layout`, or `add <gauge> to the layout, as the Gauge asked`.
 * 2. `after the change: <n> tile[s], <n> on the shelf, <n> hidden`.
 * 3. One line for each tile of the result, in the order of the file: `tile <place>: <gauge> <size> at column <col> row <row>`.
 * 4. `shelf: <ids joined by a comma and a space>`, or `shelf: none`, then `hidden: ...` in the same form.
 * 5. What happens to the file: `no change: the layout stays as it is`, or `leave safe mode and save the layout as revision 1` in safe mode, or
 *    `keep the layout now in use as revision <n>, and keep at most 10 earlier revisions`.
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
  return [
    header,
    `after the change: ${tiles.length} tile${tiles.length === 1 ? '' : 's'}, ${shelf.length} on the shelf, ${hidden.length} hidden`,
    ...tiles.map(tile => `tile ${e(tile.place)}: ${e(tile.gauge)} ${e(tile.size)} at column ${tile.col} row ${tile.row}`),
    `shelf: ${list(shelf)}`,
    `hidden: ${list(hidden)}`,
    input.safe ? 'leave safe mode and save the layout as revision 1'
      : unchanged ? 'no change: the layout stays as it is'
      : `keep the layout now in use as revision ${input.baseRevision}, and keep at most 10 earlier revisions`,
    `bind the change to layout ${e(input.baseHash)} and result ${e(input.nextHash)}`,
  ];
}
