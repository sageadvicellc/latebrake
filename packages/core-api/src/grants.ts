import { PERMISSION_NAMES, isTracesPermission, permissionOf, type PermissionName } from '../../gauge-manifest/src/index.js';
import { escapeForPlan } from './plan-text.js';
import type { AuditEntry } from './types.js';

export type { AuditEntry };

/** The ways a record can come about, in one list. `plan` is an approved grant plan. The others each end grants: a `revoke` call, the `remove` of a Gauge, its `disable`, or its `update`. */
export const AUDIT_VIAS = Object.freeze(['plan', 'revoke', 'remove', 'disable', 'update'] as const);

/** One line of the audit file: the record as JSON, with the fields in a fixed order, and one line feed at the end. JSON writes every control character as an escape, so a line never holds a raw line break. */
export function auditLine(entry: AuditEntry): string {
  const { seq, at, action, via, id, version, permission, manifestHash, folderHash } = entry;
  return `${JSON.stringify({ seq, at, action, via, id, version, permission, manifestHash, folderHash })}\n`;
}

const LONGEST_VIA = AUDIT_VIAS.reduce((longest, via) => (via.length > longest.length ? via : longest));
const LONGEST_PERMISSION = PERMISSION_NAMES.reduce((longest, name) => (name.length > longest.length ? name : longest));

/**
 * The longest line a record can have, in bytes. It is built from the largest value of every field: the largest safe integer for `seq`, the last time of year 9999,
 * the longest way and the longest permission name, an id of 64 characters (the manifest limit), a version of three numbers of nine digits (the version rule), and two hashes.
 */
export const MAX_AUDIT_LINE_BYTES = Buffer.byteLength(auditLine({
  seq: Number.MAX_SAFE_INTEGER, at: '9999-12-31T23:59:59.999Z', action: 'revoke', via: LONGEST_VIA, id: 'a'.repeat(64), version: '999999999.999999999.999999999',
  permission: LONGEST_PERMISSION, manifestHash: 'f'.repeat(64), folderHash: 'f'.repeat(64),
}));

/**
 * The smallest size cap of the audit file that a core accepts, in bytes: room for the longest records of the largest single step. The largest step grants,
 * or ends, every permission of the list at once, one record each. So a step never has to drop a record of its own.
 */
export const MIN_AUDIT_MAX_BYTES = PERMISSION_NAMES.length * MAX_AUDIT_LINE_BYTES;
/** The default size cap of the audit file: 64 KiB. */
export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024;

/**
 * Appends the lines of one step to the lines of the audit file and keeps the file under its cap in bytes: the oldest whole lines are dropped until the step fits.
 * A step never drops a line of its own. A file of exactly the cap fits. It gives the new lines and how many old lines were dropped, and changes nothing it was given.
 * A step that is larger than the cap alone gives `undefined`, and nothing is dropped for it.
 */
export function appendAuditStep(lines: readonly string[], step: readonly string[], maxBytes: number): { readonly lines: string[]; readonly dropped: number } | undefined {
  let total = 0;
  for (const line of step) total += Buffer.byteLength(line);
  if (total > maxBytes) return undefined;
  for (const kept of lines) total += Buffer.byteLength(kept);
  let drop = 0;
  while (total > maxBytes && drop < lines.length) {
    total -= Buffer.byteLength(lines[drop] ?? '');
    drop += 1;
  }
  return { lines: [...lines.slice(drop), ...step], dropped: drop };
}

/** What the text of a grant plan is built from. */
export interface GrantStepsInput {
  readonly id: string;
  readonly version: string;
  readonly permissions: readonly PermissionName[];
  readonly engines: readonly string[];
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}

/**
 * The lines of a grant plan, which the person reads and approves. This is the contract:
 *
 * 1. `grant <n> permission[s] to <id> <version>`
 * 2. one line for each permission: `permission <name> (<kind>): <meaning>`
 * 3. `engines: <ids joined by comma and space>`, or `engines: none`
 * 4. for a traces plan only: `traces permissions start denied, are granted only here, and one revoke removes them all`
 * 5. `bind the grant to manifest <hash or none> and folder <hash or none>`
 *
 * Every value goes through `escapeForPlan`, so no value can add or forge a line.
 */
export function grantSteps(input: GrantStepsInput): string[] {
  const lines = input.permissions.map(name => {
    const entry = permissionOf(name);
    if (!entry) throw new Error(`${escapeForPlan(String(name))} is not in the permission list`);
    return `permission ${escapeForPlan(entry.name)} (${entry.kind}): ${escapeForPlan(entry.meaning)}`;
  });
  const engines = input.engines.length > 0 ? input.engines.map(escapeForPlan).join(', ') : 'none';
  const count = input.permissions.length;
  return [
    `grant ${count} permission${count === 1 ? '' : 's'} to ${escapeForPlan(input.id)} ${escapeForPlan(input.version)}`,
    ...lines,
    `engines: ${engines}`,
    ...(input.permissions.some(isTracesPermission) ? ['traces permissions start denied, are granted only here, and one revoke removes them all'] : []),
    `bind the grant to manifest ${escapeForPlan(input.manifestHash ?? 'none')} and folder ${escapeForPlan(input.folderHash ?? 'none')}`,
  ];
}
