import type { AuditEntry } from './types.js';

export type { AuditEntry };

/** The smallest size cap of the audit file that a core accepts, in bytes. One record is about 350 bytes, so this holds a dozen. */
export const MIN_AUDIT_MAX_BYTES = 4096;
/** The default size cap of the audit file: 64 KiB. */
export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024;

/** The two hashes a grant is bound to. They are the hashes of the install plan: the manifest, and the whole folder. */
export interface GrantHashes {
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}

/** A grant is current only when both hashes are the ones of the Gauge now installed. A grant of an earlier manifest or folder is stale: the person must grant again. */
export function grantState(grant: GrantHashes, installed: GrantHashes): 'current' | 'stale' {
  return grant.manifestHash === installed.manifestHash && grant.folderHash === installed.folderHash ? 'current' : 'stale';
}

/** One line of the audit file: the record as JSON, with the fields in a fixed order, and one line feed at the end. JSON writes every control character as an escape, so a line never holds a raw line break. */
export function auditLine(entry: AuditEntry): string {
  const { seq, at, action, via, id, version, permission, manifestHash, folderHash } = entry;
  return `${JSON.stringify({ seq, at, action, via, id, version, permission, manifestHash, folderHash })}\n`;
}

/**
 * Appends a line to the lines of the audit file and keeps the file under its cap in bytes: the oldest whole lines are dropped until the new one fits. A file of exactly the cap
 * fits. It gives a new list and changes nothing it was given. A line that is larger than the cap alone is a programming error, and nothing is dropped for it.
 */
export function appendAudit(lines: readonly string[], line: string, maxBytes: number): string[] {
  const size = Buffer.byteLength(line);
  if (size > maxBytes) throw new RangeError('an audit line is larger than the size cap');
  let total = size;
  for (const kept of lines) total += Buffer.byteLength(kept);
  let drop = 0;
  while (total > maxBytes && drop < lines.length) {
    total -= Buffer.byteLength(lines[drop] ?? '');
    drop += 1;
  }
  return [...lines.slice(drop), line];
}
