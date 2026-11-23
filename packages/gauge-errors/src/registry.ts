import { createHash } from 'node:crypto';

/**
 * The Gauge error registry: every refusal the Core API gives a Gauge has one stable code, and every code is in this one list.
 *
 * A code is a promise to Gauge authors, so it never changes its name. The tests pin the list, refuse two equal codes, refuse a code whose digest is among the digests of the code
 * literals that exist in the product at the pinned commit of the fixture, and hold each code to the naming rules of `codeNameProblems`.
 *
 * The naming rules (`codeNameProblems`): capitals, digits and single underscores, every word starting with a capital letter, at most 40 characters, the word
 * `GAUGE` or the word `ENGINE` as one of the words (it may lead, follow or sit between others, as in `UNKNOWN_GAUGE` and `MODEL_NOT_FOR_ENGINE`), and neither `EXTENSION`
 * nor `MODULE` anywhere in the code, because those two names are retired. The Engine Host spec names its codes `ENGINE_LIMIT` and `ENGINE_STOP_TIMEOUT`, so `ENGINE` is the second scope word. Wire identifiers keep the `bowerloom` prefix until the rename, but a code is a bare word, so it carries no prefix.
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
  { code: 'GAUGE_NAME_RESERVED', meaning: 'The Gauge id is reserved by the app, and no user Gauge may use it.' },
  { code: 'GAUGE_VERSION_NOT_NEWER', meaning: 'An update must be a newer version than the one installed.' },
  // Grants
  { code: 'GAUGE_GRANT_MISSING', meaning: 'The call needs a permission that the person has not granted to this Gauge.' },
  { code: 'GAUGE_GRANT_STALE', meaning: 'The grant belongs to an earlier manifest or folder, so the person must grant again.' },
  { code: 'GAUGE_TRACES_OWN_STEP', meaning: 'Traces permissions are granted in their own step, apart from every other permission.' },
  { code: 'GAUGE_AUDIT_FAILED', meaning: 'A grant was refused because its audit record could not be made: the file failed, or the clock gave no usable time.' },
  // Layout
  { code: 'GAUGE_LAYOUT_INVALID', meaning: 'The layout file does not match the layout rules.' },
  // Plans
  { code: 'GAUGE_PLAN_NOT_APPROVED', meaning: 'The write needs an approval that is missing: the plan has no approval, or it needs a second approval that the person has not given.' },
  { code: 'GAUGE_PLAN_CHANGED', meaning: 'The plan to run is not the plan the person approved.' },
  // Engine sessions
  { code: 'ENGINE_NOT_FOUND', meaning: 'No engine has that id, or its program is missing or cannot run. The reason says which.' },
  { code: 'ENGINE_REQUEST_INVALID', meaning: 'The request for a session is malformed, so no plan was made. The reason says which field.' },
  { code: 'MODEL_NOT_FOR_ENGINE', meaning: 'The engine cannot take a main-model choice, and the core never picks another model on its own.' },
  { code: 'ENGINE_LIMIT', meaning: 'The cap on sessions is reached, so no session can start until one ends.' },
  { code: 'ENGINE_PAIR_BUSY', meaning: 'This engine already has a session in this folder.' },
  { code: 'ENGINE_FOLDER_SHARED', meaning: 'Another engine runs in this folder, so the start needs a second approval from the person.' },
  { code: 'ENGINE_START_FAILED', meaning: 'The program of the engine could not be started, so the session failed. The reason says why.' },
  { code: 'ENGINE_SESSION_UNKNOWN', meaning: 'No session has that id, or none that this Gauge may use.' },
  { code: 'ENGINE_SESSION_ENDED', meaning: 'The session has stopped or failed already, so there is nothing to stop.' },
  { code: 'ENGINE_STOP_TIMEOUT', meaning: 'The engine did not stop in time, so the session stays stopping.' },
  // Jobs and runs
  { code: 'GAUGE_JOB_INVALID', meaning: 'The job definition is malformed, so no plan was made. The reason says which field.' },
  { code: 'GAUGE_JOB_UNKNOWN', meaning: 'No job has that id.' },
  { code: 'GAUGE_JOB_LIMIT', meaning: 'The core holds as many jobs as it may, so no job can be created until one is deleted.' },
  { code: 'GAUGE_JOB_NOT_INTERACTIVE', meaning: 'A schedule or an unattended run is refused, because runs are interactive in this version. The reason says which.' },
  { code: 'GAUGE_RUN_UNKNOWN', meaning: 'No run has that id.' },
  { code: 'GAUGE_RUN_ROLLBACK_FAILED', meaning: 'A session of the run failed to start, and a session that had started could not be stopped.' },
  // Relay
  { code: 'GAUGE_ROUTE_INVALID', meaning: 'A relay route of a job is malformed, so no route was made. The reason says which part.' },
  { code: 'GAUGE_ROUTE_UNKNOWN', meaning: 'No route has that id, or none that this session may send on.' },
  { code: 'GAUGE_MESSAGE_INVALID', meaning: 'A relay message is malformed, so it was not sent. The reason says which part.' },
  { code: 'GAUGE_MESSAGE_TOO_LARGE', meaning: 'The body of a relay message is over 16,384 bytes. Larger content moves as a file path.' },
  { code: 'GAUGE_MESSAGE_SECRET_FOUND', meaning: 'The body of a relay message holds what looks like a secret value, so it was not sent.' },
  { code: 'GAUGE_MESSAGE_UNKNOWN', meaning: 'No relay message has that id, or none that this session may use.' },
  { code: 'GAUGE_MESSAGE_NOT_ACCEPTED', meaning: 'The relay message is not in a state that allows this move. The reason says its state.' },
  { code: 'GAUGE_RELAY_UNAUTHENTICATED', meaning: 'A write to the relay bus came without the right session secret, so it was refused.' },
  { code: 'GAUGE_RELAY_RECEIPT_INVALID', meaning: 'The receipt does not match the message, so the core does not report it delivered.' },
  { code: 'GAUGE_RELAY_LOOP_CAP', meaning: 'Two sessions passed messages back and forth up to the loop cap, so the core stopped their routes.' },
  { code: 'GAUGE_RELAY_MESSAGE_CAP', meaning: 'A route reached its cap on messages, so the core stopped it until the person resumes it.' },
  { code: 'GAUGE_RELAY_QUEUE_FULL', meaning: 'The route holds as many waiting messages as it may, so none can be added until some move.' },
  { code: 'GAUGE_RELAY_RECEIVER_GONE', meaning: 'The session that should receive the message has ended, so the message cannot be delivered.' },
  { code: 'GAUGE_RELAY_CLOSED', meaning: 'The relay of the run has closed, so it takes no more messages.' },
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
  const words = code.split('_');
  if (!words.includes('GAUGE') && !words.includes('ENGINE')) problems.push('a code holds the word GAUGE or the word ENGINE');
  for (const retired of RETIRED_WORDS) if (code.includes(retired)) problems.push(`a code does not hold ${retired} anywhere, because that word is retired`);
  return problems;
}
