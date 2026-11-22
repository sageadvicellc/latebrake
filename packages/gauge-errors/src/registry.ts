import { createHash } from 'node:crypto';

/**
 * The Gauge error registry: every refusal the Core API gives a Gauge has one stable code, and every code is in this one list.
 *
 * A code is a promise to Gauge authors, so it never changes its name. The tests pin the list, refuse two equal codes, refuse a code whose digest is among the digests of the code
 * literals that exist in the product at the pinned commit of the fixture, and hold each code to the naming rules of `codeNameProblems`.
 *
 * The naming rules (`codeNameProblems`): capitals, digits and single underscores, every word starting with a capital letter, at most 40 characters, the word
 * `GAUGE` as one of the words (it may lead, follow or sit between others, as in `UNKNOWN_GAUGE`), and neither `EXTENSION` nor `MODULE` anywhere in the code,
 * because those two names are retired. Wire identifiers keep the `bowerloom` prefix until the rename, but a code is a bare word, so it carries no prefix.
 *
 * A refusal to hide, remove or replace a protected Gauge, such as the Gauge manager, uses `GAUGE_PROTECTED`, in the layout as well as in the lifecycle.
 */

/** The starter set. Each later ticket of the Core API work adds its own codes here, in the group of its area. */
const ENTRIES = [
  // Manifest
  { code: 'GAUGE_MANIFEST_INVALID', meaning: 'The Gauge manifest is not strict JSON or does not match the manifest rules.' },
  { code: 'GAUGE_MANIFEST_TOO_LARGE', meaning: 'The Gauge manifest is larger than the size cap.' },
  { code: 'GAUGE_PATH_UNSAFE', meaning: 'The Gauge folder holds a link, a hidden name, or a name with two dots.' },
  { code: 'GAUGE_SECRET_FOUND', meaning: 'The Gauge manifest holds what looks like a secret value.' },
  { code: 'GAUGE_API_UNSUPPORTED', meaning: 'The Gauge needs a Core API version that this app does not offer.' },
  // Lifecycle
  { code: 'UNKNOWN_GAUGE', meaning: 'No Gauge has that id.' },
  { code: 'GAUGE_EXISTS', meaning: 'A Gauge with that id is already installed.' },
  { code: 'GAUGE_PROTECTED', meaning: 'A protected Gauge cannot be hidden, removed, or replaced.' },
  { code: 'GAUGE_REMOVE_INCOMPLETE', meaning: 'A removal stopped part way, so some files or grants of the Gauge remain.' },
  { code: 'GAUGE_NAME_RESERVED', meaning: 'The Gauge id is reserved by the app and no Gauge may use it.' },
  // Grants
  { code: 'GAUGE_GRANT_MISSING', meaning: 'The call needs a permission that the person has not granted to this Gauge.' },
  { code: 'GAUGE_GRANT_STALE', meaning: 'The grant belongs to an earlier manifest or folder, so the person must grant again.' },
  // Layout
  { code: 'GAUGE_LAYOUT_INVALID', meaning: 'The layout file does not match the layout rules.' },
  // Plans
  { code: 'GAUGE_PLAN_NOT_APPROVED', meaning: 'The write needs a plan that the person has approved, and none was approved.' },
  { code: 'GAUGE_PLAN_CHANGED', meaning: 'The plan to run is not the plan the person approved.' },
] as const;

/** A Gauge refusal code. */
export type GaugeCode = (typeof ENTRIES)[number]['code'];

/** One code and what it means, in one line. */
export interface GaugeErrorEntry {
  readonly code: GaugeCode;
  readonly meaning: string;
}

/** Every code with its meaning, in the order of the list. Frozen. */
export const GAUGE_ERRORS: readonly GaugeErrorEntry[] = Object.freeze(ENTRIES.map((entry): GaugeErrorEntry => Object.freeze({ ...entry })));

/** Every code, in the order of the list. Frozen. */
export const GAUGE_CODES: readonly GaugeCode[] = Object.freeze(ENTRIES.map(entry => entry.code));

/** The meaning of each code. Frozen. */
export const GAUGE_MEANINGS: Readonly<Record<GaugeCode, string>> = Object.freeze(
  Object.fromEntries(ENTRIES.map(entry => [entry.code, entry.meaning])) as Record<GaugeCode, string>,
);

const CODES = new Set<string>(GAUGE_CODES);

/** True when the value is a code of the registry. */
export function isGaugeCode(value: unknown): value is GaugeCode {
  return typeof value === 'string' && CODES.has(value);
}

/** Returns each code that appears more than once, once each, in the order of its first repeat. */
export function duplicateCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const code of codes) (seen.has(code) ? repeated : seen).add(code);
  return [...repeated];
}

/** The SHA-256 digest of a code, in lower-case hex. The fixture of existing literals stores these digests and not the literals. */
export const codeDigest = (code: string): string => createHash('sha256').update(code).digest('hex');

/** Returns each code whose digest is in `existingDigests` (the digests of the code literals that exist in the product), once each, sorted. */
export function collidingCodes(codes: readonly string[], existingDigests: ReadonlySet<string>): string[] {
  return [...new Set(codes.filter(code => existingDigests.has(codeDigest(code))))].sort();
}

/** The longest a code may be. */
export const MAX_CODE_LENGTH = 40;

const SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*$/;
const RETIRED_WORDS = ['EXTENSION', 'MODULE'] as const;

/** Returns what is wrong with a code name, in plain words. An empty list means the name follows the rules. */
export function codeNameProblems(code: unknown): string[] {
  if (typeof code !== 'string') return ['a code is a string'];
  const problems: string[] = [];
  if (!SHAPE.test(code)) problems.push('a code uses capitals, digits, and underscores only, every word starts with a capital letter, and single underscores join the words');
  if (code.length > MAX_CODE_LENGTH) problems.push(`a code has at most ${MAX_CODE_LENGTH} characters`);
  if (!code.split('_').includes('GAUGE')) problems.push('a code holds the word GAUGE');
  for (const retired of RETIRED_WORDS) if (code.includes(retired)) problems.push(`a code does not hold ${retired} anywhere, because that word is retired`);
  return problems;
}
