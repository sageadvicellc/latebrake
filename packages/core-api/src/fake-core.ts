import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { GaugeCode } from '../../gauge-errors/src/index.js';
import {
  PERMISSION_NAMES, compareVersions, isPermission, isTracesPermission, isUnsafeFolderName, parseVersion, permissionOf, unsafeNameReason, validateManifest,
  type AuditReason, type GaugeManifest, type GrantReason, type ManifestReason, type PermissionName,
} from '../../gauge-manifest/src/index.js';
import {
  MAX_REVISION, PAGE_IDS, canonicalText, checkLayout, defaultLayout, droppedRevision, layoutObject, newFile, parseLayout, parseLayoutFile, proposeTile, reconcileLayout, saveRevision, serializeLayoutFile, swapPlace, defaultPlace, tileInfoOf, invalid as layoutInvalid,
  type GaugeInfo, type Layout, type LayoutFile, type LayoutRefusal, type TileInfo, type UnknownGaugeRefusal,
} from '../../gauge-layout/src/index.js';
import { checkModel, checkSessionId, createEngineHost, isBilling, isStalePlanError, readList, type Billing, type EngineHost, type HostRefusal, type SessionInfo, type StartPlanContent } from '../../engine-sessions/src/index.js';
import { MAX_JOB_SESSIONS, checkDefinition, hashDefinition, type DefinitionRefusal, type JobDefinition } from '../../jobs/src/definition.js';
import { checkJobId, createJobStore, type Job } from '../../jobs/src/store.js';
import { createRunBook, type PlannedRun, type RunMember, type RunOutcome, type RunRefusal, type RunView } from '../../jobs/src/runs.js';
import { isRunId } from '../../jobs/src/ids.js';
import { FIXTURE_GAUGES, HOME_STOCK } from './fixtures.js';
import { jobSteps, runSteps } from './job-plan.js';
import { denseTexts as readTexts } from './reading.js';
import { layoutChangeSteps, layoutSteps } from './layout-plan.js';
import { DEFAULT_AUDIT_MAX_BYTES, MAX_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES, appendAuditStep, auditLine, grantSteps } from './grants.js';
import { escapeForPlan } from './plan-text.js';
import { startSteps, stopSteps } from './session-plan.js';
import {
  JOB_KINDS, LAYOUT_KINDS, PLAN_ACTIONS, SESSION_ACTIONS, type AuditEntry, type AuditRead, type Core, type CoreRefusal, type CoreReply, type EngineCode, type EngineReasonCode, type JobCode, type JobReasonCode, type RunRollbackCode, type GaugeApplied, type GaugePlan, type GaugeSummary, type LayoutKind, type LayoutSafe, type PlanAction,
  type JobKind, type PersonNotice, type PersonPlan, type PersonRunPlan, type PersonRunPlanSession, type PersonSessionPlan, type PersonView, type RunPlan, type RunPlanSession, type RunSessionSummary, type RunSummary, type SessionAction, type SessionModel, type SessionPlan,
} from './types.js';

export { escapeForPlan };

/**
 * The default clock of the fake core, in milliseconds. It is monotonic: it reads the performance clock, which never steps back, and never the system
 * clock, which a person or a network time service can move. So a system clock that steps back cannot make an approval last longer.
 */
export const monotonicNow = (): number => performance.now();

/** How long an approval lasts, in milliseconds. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The most plans that one Gauge holds at one time. A plan past it makes the core drop the oldest plan of that Gauge, and an approval of the dropped plan is for a plan that is gone. */
export const MAX_LIVE_PLANS_PER_GAUGE = 64;
/** The most notices for the person that the core keeps in all, and for each Gauge. The oldest go first. */
const MAX_NOTICES = 64;
const MAX_NOTICES_PER_GAUGE = 16;

type Content = string | Uint8Array;

/** One Gauge folder that the fake core can find. `location` says where: `bundled` is stock and `user` is third-party. The core sets the origin from it. */
export interface GaugeFolder {
  readonly name: string;
  readonly location: 'bundled' | 'user';
  /** The text or bytes of the folder's `gauge.json`. */
  readonly manifest: Content;
  /** The other files of the folder, by path. They count in the folder hash. */
  readonly files?: Readonly<Record<string, Content>>;
  /** True when the folder is a link. A folder that is a link is refused. */
  readonly isLink?: boolean;
}

export interface FakeCoreOptions {
  /** The folders the core can find. None by default. The core keeps a copy, so a caller that changes its own folders changes nothing here. */
  readonly folders?: readonly GaugeFolder[];
  /** The clock, in milliseconds. A monotonic clock by default (`monotonicNow`). A test passes its own, to move time. */
  readonly now?: () => number;
  /** The size cap of the audit file, in bytes: a whole number from `MIN_AUDIT_MAX_BYTES` (5,970) to `MAX_AUDIT_MAX_BYTES` (1 MiB). 64 KiB by default. Any other cap is refused when the core is made. */
  readonly auditMaxBytes?: number;
  /** The wall clock for the time of an audit record, in milliseconds since 1970. The system clock by default. An audit record is a time, so it is not the monotonic clock. A test passes its own. */
  readonly wall?: () => number;
  /**
   * Called with the whole text of the audit file each time the core writes a record, before the core keeps the new text. A test makes it throw, to stand for a file that cannot be written.
   * A real core writes the file here.
   */
  readonly onAuditWrite?: (text: string) => void;
  /** When true, the core also holds the nine stock Gauges of the bento home, after the fixture Gauges. False by default, so the fixture list stays as the older suites expect it. */
  readonly home?: boolean;
  /**
   * The saved layout file that the core finds when it starts, as text or UTF-8 bytes. The core keeps a copy. None means a first start, with the default layout. A file that is broken, or
   * that no longer fits the Gauges the core holds, makes the core start in safe mode with the default layout, and so does a value that is not text or bytes (the reason `syntax`).
   * The core never refuses to start because of it. The raw bytes are kept, and a change that leaves safe mode sets them aside as a backup (`layoutBackup()`).
   */
  readonly layoutFile?: string | Uint8Array;
  /** Only for a test: the function that brings the layout in line with the Gauges after a lifecycle step. `reconcileLayout` by default. A test passes one that throws, to prove that a step is all or nothing. */
  readonly reconcile?: typeof reconcileLayout;
  /**
   * Where the core gets its random bytes, for a nonce, an approval, and the key of the digest. The random bytes of the system by default. The first draw is the key of the digest. A test passes its own, to make
   * two cores issue the same nonce and prove that their digests differ. For tests only: a draw that is not the size asked for, or that repeats a nonce that is held, throws a `RangeError`.
   */
  readonly entropy?: (size: number) => Uint8Array;
  /** The Engine Host that starts, watches, and stops sessions (`packages/engine-sessions`). A host with no engine by default, so every engine is `ENGINE_NOT_FOUND`. A test passes one over scripted fake engines. */
  readonly engineHost?: EngineHost;
  /** Makes the id of a job. `job-` and sixteen hexadecimal characters by default. A test passes a counter. */
  readonly jobIds?: () => string;
  /** Makes the id of a run. `run-` and sixteen hexadecimal characters by default. A test passes a counter. */
  readonly runIds?: () => string;
  /** The most jobs the core holds: a whole number from 1 to 64. 64 by default. A test lowers it. */
  readonly jobCap?: number;
}

/**
 * The fake core is a core, plus two things that a test needs and no Gauge can reach: the person's approval, and a change of a folder on disk.
 *
 * A real core must not copy how the fake mints an approval. The fake is a test double. The person approves in the app with a click that a Gauge cannot make,
 * and a real core ties that approval to its own channel and its own store.
 */
export interface FakeCore extends Core, PersonView {
  /** The person approves the plan that the core issued with this nonce. Gives back an approval: a random token that applies that plan once, within 15 minutes. */
  approve(nonce: string): string;
  /**
   * The person gives the second approval that a start in a shared folder needs. It is for the plan that the core issued with this nonce, and the plan must name another engine in its folder.
   * It is a token of another kind: it never applies a plan as the first approval, and the first approval never stands for it.
   */
  approveShared(nonce: string): string;
  /** Replaces, or adds, the folder with the same name, as if its files changed on disk. The core keeps a copy. */
  replaceFolder(folder: GaugeFolder): void;
  /**
   * What the person reads before approving a start, a stop, or a run: the full plan that the core issued with this nonce, as a new copy each time (see `PersonView`). The plan that a Gauge reads has the same digest and the same nonce.
   * `personSessionPlan` and `personRunPlan` are the same read with the type of the kind of plan, and a nonce of the other kind is a `TypeError`.
   */
  personView(nonce: string): PersonPlan;
  personSessionPlan(nonce: string): PersonSessionPlan;
  personRunPlan(nonce: string): PersonRunPlan;
  /**
   * What the person is told, and a Gauge is not, when a Gauge gets a refusal that holds back its cause: the true cause, the engines in the folder, and the true session of a run. The newest 64, oldest first, as new copies. A real
   * core shows these to the person.
   */
  personNotices(): readonly PersonNotice[];
  /** How many plans the core holds now. A Gauge may hold at most `MAX_LIVE_PLANS_PER_GAUGE`, and a step that is applied drops every plan of before. For tests. */
  livePlans(): number;
  /** The text of the audit file: one JSON line for each record, oldest first. A real core keeps this in a file on this computer. */
  auditFile(): string;
  /** The text of the saved layout file. In safe mode it is the broken text that was found, until the first change replaces it. A real core keeps this in a file on this computer. */
  layoutFile(): string;
  /** The raw bytes of the saved layout file that a change set aside when it left safe mode, or `null` when none was set aside. A copy each time. A real core keeps the file itself. */
  layoutBackup(): Uint8Array | null;
  /** What the next start would find in the saved layout file against the Gauges as they are now: `null` when the core would start normally, or the cause of safe mode. Changes nothing. */
  layoutStartCheck(): LayoutSafe | null;
}

interface Installed {
  summary: GaugeSummary;
  enabled: boolean;
  manifestHash: string | null;
  folderHash: string | null;
  /** The lines of the plan that say what the Gauge may do: permissions, kind, tile, page. */
  details: readonly string[];
  /** The permissions and the engines its manifest declares. A Gauge the core starts with declares none. */
  permissions: readonly string[];
  engines: readonly string[];
  /** What its tile allows. `null` for a Gauge with no tile. */
  tile: TileInfo | null;
}
interface Hashes {
  readonly manifestHash: string;
  readonly folderHash: string;
}
/** What a plan says before the core seals it. */
interface Content0 {
  readonly action: PlanAction;
  readonly id: string;
  readonly folder: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly origin: 'stock' | 'third-party';
  readonly steps: readonly string[];
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}
type Sealed = Content0 & { readonly digest: string };
type Refusal = CoreRefusal;
/** A plan of install or update comes with the Gauge to add. A plan on an installed Gauge comes with nothing more. */
type Planned = Refusal
  | { readonly ok: true; readonly kind: 'folder'; readonly plan: Sealed; readonly summary: GaugeSummary; readonly details: readonly string[]; readonly hashes: Hashes; readonly declared: Declared }
  | { readonly ok: true; readonly kind: 'installed'; readonly plan: Sealed };
/** What a manifest declares that a grant depends on. */
interface Declared {
  readonly permissions: readonly string[];
  readonly engines: readonly string[];
  readonly tile: TileInfo | null;
}
/** What a grant plan says before the core seals it. */
interface GrantContent {
  readonly id: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly steps: readonly string[];
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}
type SealedGrant = GrantContent & { readonly digest: string };
/** The two hashes a grant is bound to: those of the install plan, the manifest and the whole folder. */
interface GrantHashes {
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}
interface Approval {
  readonly nonce: string;
  readonly digest: string;
  readonly at: number;
  readonly epoch: number;
  /** `plan` is the approval of a plan. `shared` is the second approval of a start in a folder that another engine uses. A token of one kind never stands for the other. */
  readonly purpose: 'plan' | 'shared';
}

/** The last millisecond of the year 9999, so that a time is always written as four digits of year. */
const MAX_WALL_MS = 253_402_300_799_999;
/** The time of a record when the clock gave none. */
const FALLBACK_AT = '1970-01-01T00:00:00.000Z';

/** Reads one own property. A field that an object inherits reads as missing. */
const ownField = (value: object, key: string): unknown => (Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined);

/** A keyed hash (HMAC-SHA-256) of a value, in lower-case hex, with the key of the core that made it. */
type Json = string | number | boolean | null | readonly Json[];
const keyedHash = (key: Uint8Array, value: readonly Json[]): string => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
const sha256 = (...parts: Content[]): string => { const hash = createHash('sha256'); for (const part of parts) hash.update(part); return hash.digest('hex'); };
const bytesOf = (content: Content): Uint8Array => (typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
const copyContent = (content: Content): Content => (typeof content === 'string' ? content : Uint8Array.from(content));

function copyFolder(folder: GaugeFolder): GaugeFolder {
  const files: Record<string, Content> = {};
  for (const [path, content] of Object.entries(folder.files ?? {})) files[path] = copyContent(content);
  return { name: folder.name, location: folder.location, manifest: copyContent(folder.manifest), files, isLink: folder.isLink === true };
}

/** The hash of the manifest, and the hash of the whole folder: the files in order of the UTF-8 bytes of the name (the manifest is `gauge.json`), each as `<name byte length>:<name><size>:` and its bytes. */
function hashesOf(folder: GaugeFolder): Hashes {
  const all = new Map<string, Content>(Object.entries(folder.files ?? {}));
  all.set('gauge.json', folder.manifest);
  const parts: Content[] = [];
  const entries = [...all.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const [name, content] of entries) {
    const bytes = bytesOf(content);
    parts.push(`${Buffer.byteLength(name)}:${name}${bytes.byteLength}:`, bytes);
  }
  return { manifestHash: sha256(folder.manifest instanceof Uint8Array ? folder.manifest : Buffer.from(folder.manifest, 'utf8')), folderHash: sha256(...parts) };
}

const digestOf = (plan: Content0): string => sha256(JSON.stringify([plan.action, plan.id, plan.folder, plan.from, plan.to, plan.origin, plan.steps, plan.manifestHash, plan.folderHash]));
const sealed = (plan: Content0): Sealed => ({ ...plan, steps: [...plan.steps], digest: digestOf(plan) });

/** The lines that say what a Gauge may do, for the person to read in a plan. */
function describe(manifest: GaugeManifest): readonly string[] {
  const tile = manifest.tile === null ? 'none' : manifest.tile.expandable && manifest.tile.resizable ? 'expandable and resizable' : manifest.tile.expandable ? 'expandable' : manifest.tile.resizable ? 'resizable' : 'neither';
  return [`permissions: ${manifest.permissions.length > 0 ? manifest.permissions.join(', ') : 'none'}`, `kind: ${manifest.kind}`, `tile: ${tile}`, `page: ${manifest.page === null ? 'no' : 'yes'}`];
}

const digestOfGrant = (plan: GrantContent): string => sha256(JSON.stringify(['grant', plan.id, plan.version, plan.permissions, plan.steps, plan.manifestHash, plan.folderHash]));
const sealedGrant = (plan: GrantContent): SealedGrant => ({ ...plan, permissions: [...plan.permissions], steps: [...plan.steps], digest: digestOfGrant(plan) });

type PlainCode = Exclude<GaugeCode, 'GAUGE_GRANT_MISSING' | 'GAUGE_AUDIT_FAILED' | 'GAUGE_LAYOUT_INVALID' | 'GAUGE_PROTECTED' | EngineCode | EngineReasonCode | JobCode | JobReasonCode | RunRollbackCode>;
const refuse = (code: PlainCode, reason?: ManifestReason): Refusal => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
/** A refusal because a Gauge is protected: the lifecycle gives no reason. */
const protectedRefusal = (): Refusal => ({ ok: false, code: 'GAUGE_PROTECTED' });
/** A refusal of a layout, or of a change to it, or of a Gauge that a change names. */
const refusalOf = (result: LayoutRefusal | UnknownGaugeRefusal): Refusal => (result.code === 'UNKNOWN_GAUGE' ? refuse('UNKNOWN_GAUGE') : result);
/** A refusal because the audit file could not take the record of a grant. */
const auditRefusal = (reason: AuditReason): Refusal => ({ ok: false, code: 'GAUGE_AUDIT_FAILED', reason });
/** A refusal because of a grant: the code `GAUGE_GRANT_MISSING` with a reason of the closed set, or with none when the permission is plainly not granted. */
const deny = (reason?: GrantReason): Refusal => (reason === undefined ? { ok: false, code: 'GAUGE_GRANT_MISSING' } : { ok: false, code: 'GAUGE_GRANT_MISSING', reason });
/** A refusal of the Engine Host, as the core gives it. `ENGINE_REQUEST_INVALID`, `ENGINE_NOT_FOUND`, and `ENGINE_START_FAILED` keep their reason, and every other engine code has none. */
const engineRefusal = (refusal: HostRefusal): Refusal => {
  if (refusal.code === 'ENGINE_REQUEST_INVALID') return { ok: false, code: refusal.code, reason: refusal.reason };
  if (refusal.code === 'ENGINE_NOT_FOUND') return { ok: false, code: refusal.code, reason: refusal.reason };
  if (refusal.code === 'ENGINE_START_FAILED') return { ok: false, code: refusal.code, reason: refusal.reason };
  return { ok: false, code: refusal.code };
};
const reply = (refusal: Refusal): CoreReply => ({ ...refusal });
/** True when the value is a list of text with no hole. A hole is not a line of text. */
/** Reads a list of text by index, once (see `readList`). A list with a hole, an accessor, or an item that is not text reads as `undefined`. */
const denseTexts = (value: unknown): string[] | undefined => {
  const items = readList(value);
  return items !== undefined && items.every((item): item is string => typeof item === 'string') ? items : undefined;
};

/**
 * A core that answers from fixture data and gives stable refusal codes. A design or a Gauge builds against it before the real core exists.
 * Each reply is a fresh copy, so a caller that changes it changes nothing for the next call.
 *
 * Its Gauges start installed and enabled. A Gauge installs disabled, and only an enabled Gauge has a route, `/gauges/<id>`. Each step goes through
 * a plan and an approval:
 *
 * - A plan changes nothing. It carries a nonce that the core issued, the hashes of the manifest and of the folder, and a digest of all of it.
 * - An approval is a random token for one nonce. It works once, for 15 minutes, and only while the state of the core has not changed since: any applied step ends every approval given before it.
 * - Applying checks the approval, then that the plan is the approved one, then that the folder still has the approved hashes, and then that the plan would still be the same plan now.
 *
 * Grants follow the same plan and approval rules (see `README.md`): `bowerloom.grants.plan` and `bowerloom.grants.apply`. A grant binds to the manifest hash and the folder hash
 * of the installed Gauge, so an update makes it stale. A revoke is one call with no plan. `bowerloom.permissions.check` is the one enforcement point, and every grant and revoke
 * is written to an audit file with a size cap. A grant is written before it takes effect, and it is refused when its record cannot be written. A revoke, a removal, a disable, and an update take
 * effect first, and their records are written after, on a best effort.
 *
 * The layout (`bowerloom.layout.*`, see `packages/gauge-layout`) follows the same plan and approval rules: no call changes it without a plan the person approves. The core starts from the saved layout
 * file (`layoutFile`), or in safe mode with the default layout when that file is broken or invalid, and a refused change leaves the layout, the revisions, and the file as they were.
 *
 * The fake does not check `dependencies` at install, and a removal is not blocked by a Gauge that depends on it. Both belong to a later ticket.
 */
export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  /** The key of the digest of a session plan and of a run plan. It is the first draw of the core, and no reply holds it. */
  /** Draws random bytes, and checks that a source of a test gave exactly the bytes that were asked for. */
  const draw = (size: number): Buffer => {
    const bytes = Buffer.from((options.entropy ?? randomBytes)(size));
    if (bytes.length !== size) throw new RangeError(`the entropy gave ${bytes.length} bytes, and ${size} were asked for`);
    return bytes;
  };
  const digestKey = draw(32);
  const keyed = (value: readonly Json[]): string => keyedHash(digestKey, value);
  /** A new nonce, or token. A source of a test that gives one that is held now is a mistake of the test, and throws: no plan or approval is replaced by another. */
  const newNonce = (): string => {
    const nonce = draw(32).toString('hex');
    if (issued.has(nonce) || approvals.has(nonce)) throw new RangeError('the entropy gave a nonce that the core holds now');
    return nonce;
  };
  const now = options.now ?? monotonicNow;
  const wall = options.wall ?? Date.now;
  const auditMaxBytes = options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  if (!Number.isSafeInteger(auditMaxBytes) || auditMaxBytes < MIN_AUDIT_MAX_BYTES || auditMaxBytes > MAX_AUDIT_MAX_BYTES) throw new RangeError(`the audit size cap is a whole number of bytes from ${MIN_AUDIT_MAX_BYTES} to ${MAX_AUDIT_MAX_BYTES}`);
  const folders = new Map<string, GaugeFolder>((options.folders ?? []).map(folder => [folder.name, copyFolder(folder)]));
  const started: readonly { readonly summary: GaugeSummary; readonly tile: TileInfo | null }[] = [
    ...FIXTURE_GAUGES.map(summary => ({ summary, tile: null })), ...(options.home === true ? HOME_STOCK : []),
  ];
  const installed = new Map<string, Installed>(started.map(({ summary, tile }) => [summary.id, {
    summary: { ...summary }, enabled: true, manifestHash: null, folderHash: null, details: [`permissions: none`, `kind: ${summary.kind}`], permissions: [], engines: [], tile,
  }]));
  /** Ids that a user Gauge may never use. A stock id stays reserved after its Gauge is removed. */
  const stockIds = new Set<string>(started.filter(({ summary }) => summary.origin === 'stock').map(({ summary }) => summary.id));
  /**
   * The nonce of each plan the core issued, with the digest of the plan, the count of applied steps at that time, and the bucket it fills. A plan of a start, a stop, or a run also holds `view` (the SHA-256 of the plan that the
   * Gauge read) and `person` (the plan that the person reads). A bucket holds at most `MAX_LIVE_PLANS_PER_GAUGE` plans, and a step that is applied drops every plan (see `retire`), so the map holds at most that many for each bucket,
   * and only the plans of the epoch now.
   */
  const issued = new Map<string, { digest: string; epoch: number; bucket: string; gauge: string | null; shared: boolean; view?: string; person?: PersonPlan }>();
  /**
   * Keeps a plan that was issued. The plans that a caller can fill are kept in a bucket for that caller: a Gauge fills `gauge:<id>` (the Gauge that the call names, which the one enforcement point checked), and a call that names
   * no Gauge fills the bucket of its kind (`person:lifecycle`, `person:grants`, `person:layout`). So a Gauge cannot drop a plan of another Gauge, or a plan of a kind that it does not make. A bucket that holds
   * `MAX_LIVE_PLANS_PER_GAUGE` plans loses its oldest plan first, and the approvals of that plan go with it. The calls that name no Gauge cannot tell who made them until the call identity work is done, so a caller can still
   * drop the plans of its own kind in the bucket of the person: a real core must key the buckets on the authenticated caller.
   */
  const issue = (nonce: string, bucket: string, record: { digest: string; gauge: string | null; shared: boolean; view?: string; person?: PersonPlan }): void => {
    const mine = [...issued].filter(([, held]) => held.bucket === bucket).map(([held]) => held);
    for (const oldest of mine.slice(0, Math.max(0, mine.length - MAX_LIVE_PLANS_PER_GAUGE + 1))) {
      issued.delete(oldest);
      for (const [token, approval] of approvals) if (approval.nonce === oldest) approvals.delete(token);
    }
    issued.set(nonce, { ...record, bucket, epoch });
  };
  const approvals = new Map<string, Approval>();
  /** What the person is told that a Gauge is not. */
  const notices: PersonNotice[] = [];
  /**
   * Tells the person. A repeat of the same notice (the same Gauge, call, plan, and cause) is one notice, so a Gauge that asks again and again fills nothing. A Gauge keeps its newest `MAX_NOTICES_PER_GAUGE`, and the core keeps
   * the newest `MAX_NOTICES`, so one Gauge cannot push the notices of another out.
   */
  const notify = (notice: PersonNotice): void => {
    if (notices.some(held => held.gauge === notice.gauge && held.action === notice.action && held.nonce === notice.nonce && held.cause === notice.cause)) return;
    notices.push(notice);
    const mine = notices.filter(held => held.gauge === notice.gauge);
    for (const oldest of mine.slice(0, Math.max(0, mine.length - MAX_NOTICES_PER_GAUGE))) notices.splice(notices.indexOf(oldest), 1);
    if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES);
  };
  /** Counts the steps applied. An approval from an earlier count is stale. */
  let epoch = 0;
  /** The grants of each Gauge, by permission. A grant holds the two hashes it is bound to. */
  const grants = new Map<string, Map<PermissionName, GrantHashes>>();
  /** The audit file, as its lines, oldest first, and the number of the last record ever written. */
  let auditLines: readonly string[] = [];
  let auditSeq = 0;
  /** How many records were dropped to keep the file under its cap, and whether a record was ever lost for another reason. The reader sees both. */
  let auditDropped = 0;
  let auditFailed = false;

  // The layout. The file on disk is `layoutDisk`. In safe mode `layoutSaved` is `null` and `layoutSafe` says why: the layout in use is then the default layout, which is not saved until the person makes a change.
  /** The Gauges as the layout sees them: whether each is enabled and protected, and what its tile allows. */
  const gaugeTable = (): Map<string, GaugeInfo> => new Map([...installed].map(([id, entry]) => [id, { enabled: entry.enabled, protected: entry.summary.protected, tile: entry.tile }]));
  let layoutSaved: LayoutFile | null = null;
  let layoutSafe: LayoutSafe | null = null;
  let layoutDisk = '';
  /** The bytes of the saved file as they are on disk now: the file found at the start until a change replaces it, and then the file the core wrote. */
  let layoutRaw: Uint8Array = new Uint8Array();
  /** The copy of the file that a change set aside when it left safe mode. One slot: a real core must never overwrite an earlier backup. */
  let layoutKept: Uint8Array | null = null;
  const reconcile = options.reconcile ?? reconcileLayout;
  const safeFrom = (refusal: LayoutRefusal): LayoutSafe => (refusal.code === 'GAUGE_PROTECTED' ? { code: 'GAUGE_PROTECTED', reason: refusal.reason } : { code: 'GAUGE_LAYOUT_INVALID', reason: refusal.reason });
  /** Reads a saved file against the Gauges (as they are now, or as a step will leave them): the file, or the cause that makes the core start in safe mode. A value that is not text or bytes is not a file. It never throws. */
  const readSaved = (found: unknown, table: ReadonlyMap<string, GaugeInfo> = gaugeTable()): { readonly file: LayoutFile } | { readonly safe: LayoutSafe } => {
    try {
      if (typeof found !== 'string' && !(found instanceof Uint8Array)) return { safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' } };
      const read = parseLayoutFile(found, table);
      return read.ok ? { file: read.file } : { safe: safeFrom(read) };
    } catch {
      return { safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' } };
    }
  };
  /** Writes the saved layout file: the file and its text and bytes on disk. */
  const writeLayout = (file: LayoutFile): void => {
    layoutSaved = file;
    layoutDisk = serializeLayoutFile(file);
    layoutRaw = new TextEncoder().encode(layoutDisk);
  };
  {
    const found = options.layoutFile;
    if (found === undefined) {
      writeLayout(newFile(defaultLayout(gaugeTable())));
    } else {
      // The core keeps a copy of what it was given, as the bytes of the file, so a backup is never a lossy decode.
      const attempt = ((): { readonly file: LayoutFile } | { readonly safe: LayoutSafe } => {
        try {
          if (typeof found === 'string') {
            layoutRaw = new TextEncoder().encode(found);
            layoutDisk = found;
            return readSaved(found);
          }
          if (found instanceof Uint8Array) {
            const copy = Uint8Array.from(found);
            layoutRaw = copy;
            layoutDisk = new TextDecoder().decode(copy);
            return readSaved(copy);
          }
          return readSaved(found);
        } catch {
          return { safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' } };
        }
      })();
      if ('file' in attempt) layoutSaved = attempt.file;
      else layoutSafe = attempt.safe;
    }
  }
  const layoutInUse = (): Layout => layoutSaved?.current ?? defaultLayout(gaugeTable());
  const layoutNumber = (): number => layoutSaved?.revision ?? 0;

  /** The time of an audit record, in ISO form, or `undefined` when the clock gave no usable time (or threw). */
  const readClock = (): string | undefined => {
    try {
      const time: unknown = wall();
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > MAX_WALL_MS) return undefined;
      return new Date(time).toISOString();
    } catch {
      return undefined;
    }
  };
  /** Builds the records of one step, numbered after the last one. Nothing is written yet. */
  const auditEntries = (at: string, action: 'grant' | 'revoke', via: AuditEntry['via'], id: string, version: string, held: readonly (readonly [PermissionName, GrantHashes])[]): AuditEntry[] =>
    held.map(([permission, hashes], index) => ({ seq: auditSeq + 1 + index, at, action, via, id, version, permission, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash }));
  /**
   * Writes the records of one step to the audit file as one unit: the oldest records are dropped to make room, and a record of the step is never dropped. The sink sees the new file
   * text first, and the core keeps it only when the sink did not throw. Gives `false` when the step could not be written, and then nothing changed.
   */
  const writeAudit = (entries: readonly AuditEntry[]): boolean => {
    const next = appendAuditStep(auditLines, entries.map(auditLine), auditMaxBytes);
    if (!next) return false;
    try {
      options.onAuditWrite?.(next.lines.join(''));
    } catch {
      return false;
    }
    auditLines = next.lines;
    auditSeq += entries.length;
    auditDropped += next.dropped;
    return true;
  };
  /**
   * Records a revoke that has already taken effect. This is a best effort and it never throws: access ended first, so a clock that gives no usable time (the record takes the time 0 and the
   * file is marked) or a file that cannot be written (no record, and the file is marked) can never leave access in place or stop a revoke, a disable, an update, or a removal.
   */
  const recordRevoked = (via: AuditEntry['via'], id: string, version: string, held: readonly (readonly [PermissionName, GrantHashes])[]): void => {
    if (held.length === 0) return;
    const at = readClock();
    if (at === undefined) auditFailed = true;
    if (!writeAudit(auditEntries(at ?? FALLBACK_AT, 'revoke', via, id, version, held))) auditFailed = true;
  };

  const isReserved = (id: string): boolean => {
    if (stockIds.has(id)) return true;
    for (const folder of folders.values()) {
      if (folder.location !== 'bundled' || folder.isLink === true) continue;
      const loaded = validateManifest(folder.manifest);
      if (loaded.ok && loaded.manifest.id === id) return true;
    }
    return false;
  };

  /** What a lifecycle step leaves of the layout: the saved file and the safe cause after it, the plan lines that say so, and whether the saved file is written. */
  interface LayoutOutcome {
    readonly saved: LayoutFile | null;
    readonly safe: LayoutSafe | null;
    readonly steps: string[];
    readonly write: boolean;
  }
  /**
   * What a lifecycle step does to the layout, worked out before anything changes (`after` is the Gauge as it will be, or `null` when it is removed). With a saved layout, the layout is brought in
   * line with the Gauges as they will be, saved as a normal revision, and the plan says so. When the counter is full the layout is replaced in place, since a step must never be refused for it, and
   * the plan says that. In safe mode nothing is saved, but when the step makes the saved file readable again the core loads it and the plan says so. A step that breaks inside the reconcile throws here,
   * before any state changes.
   */
  function layoutAfter(action: PlanAction, id: string, after: GaugeInfo | null): LayoutOutcome {
    const unchanged: LayoutOutcome = { saved: layoutSaved, safe: layoutSafe, steps: [], write: false };
    // An install adds a Gauge that is disabled, so a saved layout that holds it does not change. It can only change what a file in safe mode gets.
    if (action === 'install' && layoutSaved !== null) return unchanged;
    const table = gaugeTable();
    if (after === null) table.delete(id);
    else table.set(id, after);
    if (layoutSaved === null) {
      if (layoutSafe === null || layoutSafe.reason === 'internal') return unchanged;
      const read = readSaved(layoutRaw, table);
      // A file that is still broken keeps the core in safe mode, and the cause is what the file gets now.
      return 'file' in read ? { saved: read.file, safe: null, steps: ['layout: the saved layout can be read again'], write: false } : { ...unchanged, safe: read.safe };
    }
    const before = layoutSaved.current;
    const next = reconcile(before, table, action === 'enable' ? { enabled: id } : {});
    if (canonicalText(next) === canonicalText(before)) return unchanged;
    const counterFull = layoutSaved.revision >= MAX_REVISION;
    const saved = (counterFull ? undefined : saveRevision(layoutSaved, next)) ?? Object.freeze({ revision: layoutSaved.revision, current: next, revisions: layoutSaved.revisions });
    return { saved, safe: null, steps: layoutChangeSteps(before, next, layoutSaved.revision, droppedRevision(layoutSaved), counterFull), write: true };
  }
  /** The Gauge as a lifecycle step will leave it, for the layout: `null` when it is removed, and `undefined` when the step does not touch the Gauges the layout sees (an install). */
  function gaugeAfter(action: PlanAction, current: Installed | undefined, update?: { readonly summary: GaugeSummary; readonly tile: TileInfo | null }): GaugeInfo | null | undefined {
    if (action === 'remove') return null;
    if (action === 'install') return update ? { enabled: false, protected: update.summary.protected, tile: update.tile } : undefined;
    if (!current) return undefined;
    if (action === 'update') return update ? { enabled: current.enabled, protected: update.summary.protected, tile: update.tile } : undefined;
    if (action === 'enable' || action === 'disable') return { enabled: action === 'enable', protected: current.summary.protected, tile: current.tile };
    return undefined;
  }

  function planInstallOrUpdate(action: 'install' | 'update', folderName: unknown): Planned {
    if (typeof folderName !== 'string') return refuse('UNKNOWN_GAUGE');
    const unsafe = unsafeNameReason(folderName);
    if (unsafe) return refuse('GAUGE_PATH_UNSAFE', unsafe);
    // The folder name is shown to the person in the plan, so it is one plain name: no line break, no invisible character, no slash.
    if (isUnsafeFolderName(folderName)) return refuse('GAUGE_PATH_UNSAFE', 'unsafe_folder_name');
    const folder = folders.get(folderName);
    if (!folder) return refuse('UNKNOWN_GAUGE');
    if (folder.isLink === true) return refuse('GAUGE_PATH_UNSAFE', 'link');
    const loaded = validateManifest(folder.manifest);
    if (!loaded.ok) return refuse(loaded.code, loaded.reason);
    const { manifest } = loaded;
    const origin: 'stock' | 'third-party' = folder.location === 'bundled' ? 'stock' : 'third-party';
    // A manifest may ask to be protected, but only a stock Gauge may be, so a third-party Gauge can never be one the person cannot remove.
    const summary: GaugeSummary = { id: manifest.id, title: manifest.title, version: manifest.version, kind: manifest.kind, origin, protected: manifest.protected && origin === 'stock' };
    // The id of a core page is reserved for ever, for every origin: a Gauge with the id `settings` could stand in for the Settings page in the layout.
    if (PAGE_IDS.includes(summary.id)) return refuse('GAUGE_NAME_RESERVED');
    if (origin === 'third-party' && isReserved(summary.id)) return refuse('GAUGE_NAME_RESERVED');
    const current = installed.get(summary.id);
    const hashes = hashesOf(folder), details = describe(manifest);
    const declared: Declared = { permissions: [...manifest.permissions], engines: [...manifest.engines], tile: manifest.tile === null ? null : tileInfoOf(manifest.tile) };
    const content = { id: summary.id, folder: folder.name, origin, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash };
    if (action === 'install') {
      if (current) return refuse('GAUGE_EXISTS');
      return {
        ok: true, kind: 'folder', summary, details, hashes, declared,
        plan: sealed({ ...content, action, from: null, to: summary.version, steps: [
          `check the manifest of ${escapeForPlan(summary.id)}`, ...details, `copy folder ${escapeForPlan(folder.name)} into the Gauge store`, `add ${escapeForPlan(summary.id)} ${escapeForPlan(summary.version)} as ${origin}, disabled`,
          ...layoutAfter('install', summary.id, { enabled: false, protected: summary.protected, tile: declared.tile }).steps,
        ] }),
      };
    }
    if (!current) return refuse('UNKNOWN_GAUGE');
    if (current.summary.origin !== origin) return refuse('GAUGE_NAME_RESERVED');
    if (current.summary.protected && !summary.protected) return protectedRefusal();
    if (compareVersions(parseVersion(summary.version) ?? [0, 0, 0], parseVersion(current.summary.version) ?? [0, 0, 0]) <= 0) return refuse('GAUGE_VERSION_NOT_NEWER');
    return {
      ok: true, kind: 'folder', summary, details, hashes, declared,
      plan: sealed({ ...content, action, from: current.summary.version, to: summary.version, steps: [
        `check the manifest of ${escapeForPlan(summary.id)}`, ...details, `replace ${escapeForPlan(summary.id)} ${escapeForPlan(current.summary.version)} with ${escapeForPlan(summary.version)} from folder ${escapeForPlan(folder.name)}`, `drop every grant of ${escapeForPlan(summary.id)}, so each permission is granted again`, `keep ${escapeForPlan(summary.id)} ${current.enabled ? 'enabled' : 'disabled'}`,
        ...layoutAfter('update', summary.id, { enabled: current.enabled, protected: summary.protected, tile: declared.tile }).steps,
      ] }),
    };
  }

  function planOnInstalled(action: 'enable' | 'disable' | 'remove', id: unknown): Planned {
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (!current) return refuse('UNKNOWN_GAUGE');
    if (action !== 'enable' && current.summary.protected) return protectedRefusal();
    const { summary } = current, state = current.enabled ? 'enabled' : 'disabled';
    const id0 = escapeForPlan(summary.id), version = escapeForPlan(summary.version);
    const steps = {
      enable: [...current.details, `enable ${id0} ${version} (now ${state})`, `add the route of ${id0}`, ...layoutAfter('enable', summary.id, { enabled: true, protected: summary.protected, tile: current.tile }).steps],
      disable: [...current.details, `disable ${id0} ${version} (now ${state})`, `clear the traces grants of ${id0}, and keep its other grants`, `remove the route of ${id0}`, ...layoutAfter('disable', summary.id, { enabled: false, protected: summary.protected, tile: current.tile }).steps],
      remove: [...current.details, `remove ${id0} ${version} (now ${state})`, `drop every grant of ${id0}`, `remove the route of ${id0}`, `delete the files of ${id0}`, ...layoutAfter('remove', summary.id, null).steps],
    }[action];
    return {
      ok: true, kind: 'installed',
      plan: sealed({ action, id: summary.id, folder: null, from: summary.version, to: action === 'remove' ? null : summary.version, origin: summary.origin, steps, manifestHash: current.manifestHash, folderHash: current.folderHash }),
    };
  }

  function planFor(action: PlanAction, params: Readonly<Record<string, unknown>>): Planned {
    if (action === 'install' || action === 'update') return planInstallOrUpdate(action, params['folder']);
    return planOnInstalled(action, params['id']);
  }

  /** Reads the plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readPlan(value: unknown): (Sealed & { readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const action = ownField(value, 'action'), id = ownField(value, 'id'), folder = ownField(value, 'folder'), from = ownField(value, 'from'), to = ownField(value, 'to'), origin = ownField(value, 'origin');
    const steps = ownField(value, 'steps'), manifestHash = ownField(value, 'manifestHash'), folderHash = ownField(value, 'folderHash'), nonce = ownField(value, 'nonce');
    if (typeof action !== 'string' || !(PLAN_ACTIONS as readonly string[]).includes(action) || typeof id !== 'string' || typeof nonce !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(folder) || !nullable(from) || !nullable(to) || !nullable(manifestHash) || !nullable(folderHash) || (origin !== 'stock' && origin !== 'third-party')) return undefined;
    const stepList = denseTexts(steps);
    if (stepList === undefined) return undefined;
    return { ...sealed({ action: action as PlanAction, id, folder, from, to, origin, steps: stepList, manifestHash, folderHash }), nonce };
  }

  /** Finds the approval a caller sent. An unknown, old, or expired approval reads as `undefined`, and an expired or stale one is forgotten. */
  function liveApproval(params: Readonly<Record<string, unknown>>, key = 'approval', purpose: Approval['purpose'] = 'plan'): { readonly token: string; readonly approval: Approval } | undefined {
    const token = params[key];
    const approval = typeof token === 'string' ? approvals.get(token) : undefined;
    // A token of the other kind is not an approval of this kind, and it is kept, since it may be good for its own use.
    if (typeof token !== 'string' || !approval || approval.purpose !== purpose) return undefined;
    // An approval is for a plan that the core holds: one that the cap dropped, or that a revoke ended, is gone, and its approval is no approval. This holds for every kind of plan.
    if (now() - approval.at >= APPROVAL_TTL_MS || approval.epoch !== epoch || !issued.has(approval.nonce)) {
      approvals.delete(token);
      return undefined;
    }
    return { token, approval };
  }

  /** A plan is applied: the state has changed, so every plan and every approval of before is for a state that is gone. None is kept, so nothing of a past state is held and no approval of it can ever be used. */
  function retire(): void {
    issued.clear();
    approvals.clear();
    epoch += 1;
  }

  const sortedHeld = (id: string): (readonly [PermissionName, GrantHashes])[] =>
    [...(grants.get(id)?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  function apply(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readPlan(params['plan']);
    if (!plan || plan.nonce !== approval.nonce || plan.digest !== approval.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    // The plan is the approved one. Read the folder again: it must still have the approved hashes.
    if (plan.folder !== null) {
      const folder = folders.get(plan.folder);
      const hashes = folder ? hashesOf(folder) : undefined;
      if (!hashes || hashes.manifestHash !== plan.manifestHash || hashes.folderHash !== plan.folderHash) return reply(refuse('GAUGE_PLAN_CHANGED'));
    }
    // Then plan again from the state now: a plan that would no longer be the same plan is refused.
    const fresh = planFor(plan.action, plan.folder === null ? { id: plan.id } : { folder: plan.folder });
    if (!fresh.ok) return reply(fresh);
    if (fresh.plan.digest !== plan.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    const { id, action } = fresh.plan;
    const current = installed.get(id);
    // The layout after the step is worked out first, so a failure in it leaves nothing half applied. Everything below changes state and cannot fail.
    const afterGauge = gaugeAfter(action, current, fresh.kind === 'folder' ? { summary: fresh.summary, tile: fresh.declared.tile } : undefined);
    const layoutNow = afterGauge === undefined ? undefined : layoutAfter(action, id, afterGauge);
    let result: GaugeApplied;
    let cleared: { readonly via: 'remove' | 'disable' | 'update'; readonly version: string; readonly held: readonly (readonly [PermissionName, GrantHashes])[] } | undefined;
    if (fresh.kind === 'folder') {
      const entry: Installed = {
        summary: fresh.summary, enabled: false, manifestHash: fresh.hashes.manifestHash, folderHash: fresh.hashes.folderHash, details: fresh.details,
        permissions: fresh.declared.permissions, engines: fresh.declared.engines, tile: fresh.declared.tile,
      };
      if (action === 'update') {
        if (!current) return reply(refuse('UNKNOWN_GAUGE'));
        entry.enabled = current.enabled;
        // An update drops every grant of the old version, so a changed manifest asks again and no grant of an earlier version lingers. The record names the version that was replaced.
        cleared = { via: 'update', version: current.summary.version, held: sortedHeld(id) };
        grants.delete(id);
      }
      installed.set(id, entry);
      if (fresh.summary.origin === 'stock') stockIds.add(id);
      result = { action, id, version: entry.summary.version, enabled: entry.enabled };
    } else {
      if (!current) return reply(refuse('UNKNOWN_GAUGE'));
      if (action === 'remove') {
        // A removed Gauge keeps no grant.
        cleared = { via: 'remove', version: current.summary.version, held: sortedHeld(id) };
        grants.delete(id);
        installed.delete(id);
        result = { action, id, version: null, enabled: false };
      } else {
        current.enabled = action === 'enable';
        // A disabled Gauge loses its traces grants and keeps the others. The traces grants must be made again, in their own step.
        if (action === 'disable') {
          const traces = sortedHeld(id).filter(([permission]) => isTracesPermission(permission));
          for (const [permission] of traces) grants.get(id)?.delete(permission);
          if (grants.get(id)?.size === 0) grants.delete(id);
          cleared = { via: 'disable', version: current.summary.version, held: traces };
        }
        result = { action, id, version: current.summary.version, enabled: current.enabled };
      }
    }
    // The layout follows the Gauges inside the same approved plan, as a normal revision.
    if (layoutNow) {
      layoutSafe = layoutNow.safe;
      if (layoutNow.write && layoutNow.saved) writeLayout(layoutNow.saved);
      else layoutSaved = layoutNow.saved;
    }
    retire();
    // The grants are gone. Their records come after, on a best effort, so a failure of the audit file never undoes the step.
    if (cleared) recordRevoked(cleared.via, id, cleared.version, cleared.held);
    return { ok: true, result };
  }

  // Grants

  /** Reads a list of permission names: a non-empty list of text with no repeat, sorted. Anything else reads as `undefined`. */
  function readNames(value: unknown): readonly string[] | undefined {
    try {
      const items = readList(value, PERMISSION_NAMES.length);
      if (items === undefined || items.length === 0) return undefined;
      const names: string[] = [];
      for (const item of items) {
        if (typeof item !== 'string') return undefined;
        names.push(item);
      }
      if (new Set(names).size !== names.length) return undefined;
      return names.sort();
    } catch {
      return undefined;
    }
  }

  /** Plans a grant. Nothing changes. Every check runs here, so the plan the person sees is one that can be applied. */
  function planGrant(params: Readonly<Record<string, unknown>>): { readonly ok: true; readonly plan: SealedGrant } | Refusal {
    const id = params['id'];
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (typeof id !== 'string' || !current) return refuse('UNKNOWN_GAUGE');
    const names = readNames(params['permissions']);
    if (!names) return deny('invalid_request');
    if (!names.every(isPermission)) return deny('unknown_permission');
    // Traces permissions are granted in their own step: a plan holds only traces permissions, or none.
    const traces = names.filter(isTracesPermission).length;
    if (traces > 0 && traces < names.length) return refuse('GAUGE_TRACES_OWN_STEP');
    if (!names.every(name => current.permissions.includes(name))) return deny('not_declared');
    const steps = grantSteps({ id, version: current.summary.version, permissions: names, engines: current.engines, manifestHash: current.manifestHash, folderHash: current.folderHash });
    return { ok: true, plan: sealedGrant({ id, version: current.summary.version, permissions: names, steps, manifestHash: current.manifestHash, folderHash: current.folderHash }) };
  }

  /** Reads the grant plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readGrantPlan(value: unknown): (SealedGrant & { readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const action = ownField(value, 'action'), id = ownField(value, 'id'), version = ownField(value, 'version'), permissions = ownField(value, 'permissions');
    const steps = ownField(value, 'steps'), manifestHash = ownField(value, 'manifestHash'), folderHash = ownField(value, 'folderHash'), nonce = ownField(value, 'nonce');
    if (action !== 'grant' || typeof id !== 'string' || typeof version !== 'string' || typeof nonce !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(manifestHash) || !nullable(folderHash)) return undefined;
    const permissionList = denseTexts(permissions), stepList = denseTexts(steps);
    if (permissionList === undefined || stepList === undefined) return undefined;
    return { ...sealedGrant({ id, version, permissions: permissionList, steps: stepList, manifestHash, folderHash }), nonce };
  }

  function applyGrant(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readGrantPlan(params['plan']);
    if (!plan || plan.nonce !== approval.nonce || plan.digest !== approval.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    // Plan again from the state now: a grant for a Gauge that has changed, or that is gone, is not the grant the person approved.
    const fresh = planGrant({ id: plan.id, permissions: plan.permissions });
    if (!fresh.ok) return reply(fresh);
    if (fresh.plan.digest !== plan.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    const hashes: GrantHashes = { manifestHash: fresh.plan.manifestHash, folderHash: fresh.plan.folderHash };
    const names = fresh.plan.permissions.filter(isPermission);
    // A grant stays closed when it cannot be recorded: the record is written first, and a clock with no usable time or a file that cannot be written refuses the grant, with nothing changed.
    const at = readClock();
    if (at === undefined) return reply(auditRefusal('clock_unusable'));
    if (!writeAudit(auditEntries(at, 'grant', 'plan', plan.id, fresh.plan.version, names.map((name): readonly [PermissionName, GrantHashes] => [name, hashes])))) return reply(auditRefusal('write_failed'));
    const held = grants.get(plan.id) ?? new Map<PermissionName, GrantHashes>();
    for (const name of names) held.set(name, hashes);
    grants.set(plan.id, held);
    retire();
    return { ok: true, result: { id: plan.id, permissions: [...names] } };
  }

  /** Ends the pending grant plans and the approvals of grant plans for one Gauge, so an approved regrant cannot apply after the person revoked. */
  function retireGrantPlans(id: string): void {
    for (const [nonce, record] of issued) {
      if (record.gauge !== id) continue;
      issued.delete(nonce);
      for (const [token, approval] of approvals) if (approval.nonce === nonce) approvals.delete(token);
    }
  }

  /**
   * A revoke is one action with no plan: it only narrows what a Gauge may do, so the person never waits for it. Access ends first, and the record is written after, on a best effort,
   * so a bad clock or a file that cannot be written never stops a revoke. It works on a disabled Gauge. A permission that the Gauge does not hold is a no-op: the end state is reached.
   * Only an unknown Gauge, an unknown name, and a request of the wrong shape are refused.
   */
  function revoke(params: Readonly<Record<string, unknown>>): CoreReply {
    const id = params['id'];
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (typeof id !== 'string' || !current) return reply(refuse('UNKNOWN_GAUGE'));
    const held = grants.get(id);
    const group = params['group'], list = params['permissions'];
    let names: readonly PermissionName[];
    if (group !== undefined) {
      if (list !== undefined || group !== 'traces') return reply(deny('invalid_request'));
      names = [...(held?.keys() ?? [])].filter(isTracesPermission).sort();
    } else {
      const read = readNames(list);
      if (!read) return reply(deny('invalid_request'));
      if (!read.every(isPermission)) return reply(deny('unknown_permission'));
      names = read.filter(name => held?.has(name) === true);
    }
    const records = names.map((name): readonly [PermissionName, GrantHashes] => [name, held?.get(name) ?? { manifestHash: null, folderHash: null }]);
    for (const name of names) held?.delete(name);
    if (held?.size === 0) grants.delete(id);
    if (names.length > 0) retireGrantPlans(id);
    recordRevoked('revoke', id, current.summary.version, records);
    return { ok: true, result: { id, revoked: [...names] } };
  }

  /** The one place that decides whether a Gauge may use a permission now, for an engine. Every call that a permission guards goes through it. */
  function enforce(gaugeId: unknown, permission: unknown, engine: unknown): { readonly ok: true; readonly gauge: string; readonly permission: string; readonly engine: string | null } | Refusal {
    const current = typeof gaugeId === 'string' ? installed.get(gaugeId) : undefined;
    if (typeof gaugeId !== 'string' || !current) return refuse('UNKNOWN_GAUGE');
    const entry = permissionOf(permission);
    if (!entry) return deny('unknown_permission');
    if (!current.permissions.includes(entry.name)) return deny('not_declared');
    if (!current.enabled) return deny('gauge_disabled');
    let engineName: string | null = null;
    if (entry.scope === 'engine') {
      // A permission is scoped by the Gauge's own list of engines: a Gauge reads an engine it lists, and no other.
      if (typeof engine !== 'string' || !current.engines.includes(engine)) return deny('engine_not_listed');
      engineName = engine;
    } else if (engine !== undefined) {
      return deny('invalid_request');
    }
    const held = grants.get(gaugeId);
    if (held?.has(entry.name) !== true) return deny();
    // The text of a trace is readable only together with the facts. The Traces API (ticket 714) enforces the pairing at the reader. This one enforcement point
    // must not allow a state that the spec forbids either, so the text is refused while the facts are not held.
    if (entry.name === 'traces.text' && !held.has('traces.facts')) return deny('facts_required');
    return { ok: true, gauge: gaugeId, permission: entry.name, engine: engineName };
  }

  // Layout plans

  /** What a layout plan says before the core seals it. */
  interface LayoutContent {
    readonly kind: LayoutKind;
    readonly place: string | null;
    readonly gauge: string | null;
    readonly revision: number | null;
    readonly text: string | null;
    readonly steps: readonly string[];
    readonly baseHash: string;
    readonly nextHash: string;
  }
  type LayoutPlanned = (LayoutContent & { readonly ok: true; readonly digest: string; readonly next: Layout; readonly owner: string | null }) | Refusal;
  const layoutDigest = (plan: LayoutContent): string => sha256(JSON.stringify(['layout', plan.kind, plan.place, plan.gauge, plan.revision, plan.text, plan.steps, plan.baseHash, plan.nextHash]));
  const isLayoutKind = (value: unknown): value is LayoutKind => typeof value === 'string' && (LAYOUT_KINDS as readonly string[]).includes(value);
  const layoutRefusal = (reason: Parameters<typeof layoutInvalid>[0]): Refusal => layoutInvalid(reason);

  /**
   * Plans a change to the layout. Nothing changes. Every check of the change runs here, so the plan the person sees is one that can be applied: a change that would write a revision is
   * refused with `bad_revision` when the revision counter is full, as applying it would. A start that broke inside the reader (`internal`) refuses every plan, so nothing overwrites a file that the core could not read.
   */
  function planLayout(params: Readonly<Record<string, unknown>>): LayoutPlanned {
    const kind = params['kind'];
    if (layoutSafe?.reason === 'internal') return layoutRefusal('internal');
    if (!isLayoutKind(kind)) return layoutRefusal('invalid_request');
    const table = gaugeTable();
    const base = layoutInUse();
    const placeParam = params['place'], gaugeParam = params['gauge'];
    let next: Layout;
    let owner: string | null = null;
    let text: string | null = null, revision: number | null = null;
    switch (kind) {
      case 'set': {
        const given = params['text'];
        if (typeof given !== 'string') return layoutRefusal('invalid_request');
        const parsed = parseLayout(given, table);
        if (!parsed.ok) return refusalOf(parsed);
        next = parsed.layout;
        text = given;
        break;
      }
      case 'swap': {
        const changed = swapPlace(base, table, placeParam, gaugeParam);
        if (!changed.ok) return refusalOf(changed);
        next = changed.layout;
        break;
      }
      case 'default': {
        const changed = defaultPlace(base, table, placeParam);
        if (!changed.ok) return refusalOf(changed);
        next = changed.layout;
        break;
      }
      case 'restore': {
        const wanted = params['revision'];
        if (typeof wanted !== 'number' || !Number.isSafeInteger(wanted)) return layoutRefusal('invalid_request');
        const entry = layoutSaved?.revisions.find(candidate => candidate.revision === wanted);
        if (!entry) return layoutRefusal('unknown_revision');
        // A revision is checked against the Gauges the core holds now: a Gauge may be gone since.
        const refused = checkLayout(entry.layout, table);
        if (refused) return refusalOf(refused);
        next = entry.layout;
        revision = wanted;
        break;
      }
      case 'propose': {
        // A Gauge may only ask to add itself, and only with the grant. The grant check is the one enforcement point.
        const allowed = enforce(gaugeParam, 'layout.propose', undefined);
        if (!allowed.ok) return allowed;
        const changed = proposeTile(base, table, gaugeParam);
        if (!changed.ok) return refusalOf(changed);
        next = changed.layout;
        owner = allowed.gauge;
        break;
      }
    }
    // A change that would write a revision cannot be applied at a full counter, so the plan is refused now. A lifecycle step is never refused for it: its plan says that it replaces in place.
    if (layoutSaved !== null && layoutSaved.revision >= MAX_REVISION && canonicalText(next) !== canonicalText(base)) return layoutRefusal('bad_revision');
    const baseHash = sha256(canonicalText(base)), nextHash = sha256(canonicalText(next));
    const place = (kind === 'swap' || kind === 'default') && typeof placeParam === 'string' ? placeParam : null;
    const gauge = (kind === 'swap' || kind === 'propose') && typeof gaugeParam === 'string' ? gaugeParam : null;
    const steps = layoutSteps({ kind, place, gauge, revision, base, next, baseHash, nextHash, baseRevision: layoutNumber(), safe: layoutSafe !== null, backup: layoutRaw.byteLength > 0, dropped: layoutSaved === null ? null : droppedRevision(layoutSaved) });
    const content: LayoutContent = { kind, place, gauge, revision, text, steps, baseHash, nextHash };
    return { ok: true, ...content, digest: layoutDigest(content), next, owner };
  }

  /** Reads the layout plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readLayoutPlan(value: unknown): (LayoutContent & { readonly digest: string; readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    // Own properties only: a field that the object inherits reads as missing.
    const field = (key: string): unknown => ownField(value, key);
    const action = field('action'), kind = field('kind'), place = field('place'), gauge = field('gauge'), revision = field('revision'), text = field('text');
    const steps = field('steps'), baseHash = field('baseHash'), nextHash = field('nextHash'), nonce = field('nonce');
    if (action !== 'layout' || !isLayoutKind(kind) || typeof nonce !== 'string' || typeof baseHash !== 'string' || typeof nextHash !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(place) || !nullable(gauge) || !nullable(text) || !(revision === null || (typeof revision === 'number' && Number.isSafeInteger(revision)))) return undefined;
    const stepList = denseTexts(steps);
    if (stepList === undefined) return undefined;
    const content: LayoutContent = { kind, place, gauge, revision, text, steps: stepList, baseHash, nextHash };
    return { ...content, digest: layoutDigest(content), nonce };
  }

  function applyLayout(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readLayoutPlan(params['plan']);
    if (!plan || plan.nonce !== approval.nonce || plan.digest !== approval.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    // Plan again from the state now: a change that is no longer the one the person approved, or that no longer applies, is refused. Nothing is kept until every check has passed.
    const fresh = planLayout({ kind: plan.kind, place: plan.place, gauge: plan.gauge, revision: plan.revision, text: plan.text });
    if (!fresh.ok) return reply(fresh);
    // A second line: every applied step already retires every plan and approval of before (the epoch), so no test can reach this refusal.
    if (fresh.digest !== plan.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    // In safe mode the layout in use was never saved, so the first change starts a new file. Otherwise the layout in use becomes the newest revision.
    const saved = layoutSaved === null ? newFile(fresh.next) : saveRevision(layoutSaved, fresh.next);
    if (!saved) return reply(layoutRefusal('bad_revision'));
    const changed = layoutSaved === null || saved !== layoutSaved;
    // The saved file is replaced, so when it was never read as a layout its bytes are kept as a backup. Revisions are not salvaged from it.
    if (layoutSafe !== null) layoutKept = layoutRaw.byteLength > 0 ? Uint8Array.from(layoutRaw) : null;
    layoutSafe = null;
    writeLayout(saved);
    retire();
    return { ok: true, result: { kind: fresh.kind, revision: saved.revision, changed } };
  }

  // Sessions

  /** The Engine Host. It holds the sessions and the rules of the cap, the pairs, and the shared folder. The core holds the plans and the approvals, and asks the host to do what was approved. */
  const host = options.engineHost ?? createEngineHost({ engines: [], launcher: { launch: () => { throw new Error('this fake core holds no engine'); } } });

  /** What a start or a stop says to a Gauge: the fields of `SessionPlan`, but the digest and the nonce. */
  type SessionContent = Omit<SessionPlan, 'digest' | 'nonce'>;
  /** What the same start or stop says to the person: the fields of `PersonSessionPlan`, but the digest and the nonce. The two have no field name in common that holds a real value, so one cannot be given as the other. */
  type PersonSessionContent = Omit<PersonSessionPlan, 'digest' | 'nonce'>;
  /**
   * A planned start or stop, with its two views. `person` is the full plan that the person approves. `seen` is the plan that a Gauge reads: the folder and the program as they were asked for or configured, and the engines that the
   * Gauge may read. `start` is the plan of the host, for a start. The plan of the person holds the folder as the Gauge asked for it, in its text, when it is not the real folder, so the digest of the person's plan covers it.
   */
  type SessionPlanned = {
    readonly ok: true;
    readonly person: PersonSessionContent;
    readonly seen: SessionContent;
    readonly start: StartPlanContent | null;
  } | Refusal;
  /**
   * The digest of a session plan: a keyed hash (HMAC-SHA-256) of the nonce and the full plan, with a key that only this core holds. A Gauge reads the digest and cannot work it out, so it cannot test a guess of a real folder or of an
   * engine against it, and the nonce makes the digest of two plans differ, so it cannot tell from digests that two plans agree. The hash covers the full plan, and so the approval of a Gauge's view is the approval of the full plan.
   */
  const sessionDigest = (person: PersonSessionContent, nonce: string): string => keyed([
    'session', nonce, person.action, person.gauge, person.engine, person.realFolder, person.session, person.realProgram, person.model === null ? null : [person.model.provider, person.model.model], person.billing, person.variables,
    person.allSharedWith, person.force, person.steps,
  ]);
  const isSessionAction = (value: unknown): value is SessionAction => typeof value === 'string' && (SESSION_ACTIONS as readonly string[]).includes(value);
  /** A session plan as a Gauge reads it, as it goes over the seam: a new object each time, in a fixed order. */
  const sessionPlanObject = (content: SessionContent, digest: string, nonce: string): SessionPlan => ({
    action: content.action, gauge: content.gauge, engine: content.engine, folder: content.folder, session: content.session, program: content.program,
    model: content.model === null ? null : { provider: content.model.provider, model: content.model.model }, billing: content.billing, variables: [...content.variables], sharedWith: [...content.sharedWith], force: content.force,
    steps: [...content.steps], digest, nonce,
  });
  /** A session plan as the person reads it: a new object each time. */
  const personSessionObject = (content: PersonSessionContent, digest: string, nonce: string): PersonSessionPlan => ({
    action: content.action, gauge: content.gauge, engine: content.engine, realFolder: content.realFolder, requestedFolder: content.requestedFolder, session: content.session, realProgram: content.realProgram,
    configuredProgram: content.configuredProgram, model: content.model === null ? null : { provider: content.model.provider, model: content.model.model }, billing: content.billing, variables: [...content.variables],
    allSharedWith: [...content.allSharedWith], force: content.force, steps: [...content.steps], digest, nonce,
  });
  /** What stands for the plan a Gauge read: the SHA-256 of its text. A plan that a Gauge sends back must give the same hash as the one the core issued. */
  const sessionViewHash = (plan: SessionPlan): string => sha256(JSON.stringify(['session', plan]));
  /** A session as it goes over the seam: a new object each time, with no output of the engine. The folder is the folder as the session was asked for: the real folder is for the person. */
  const sessionObject = (info: SessionInfo) => ({
    id: info.id, engine: info.engine, folder: info.requestedFolder, state: info.state, billing: info.billing, model: info.model === null ? null : { provider: info.model.provider, model: info.model.model }, failure: info.failure,
  });

  /** The engines that a Gauge may read: the engines of its manifest for which it holds `sessions.read` now, by the one enforcement point. Only these are named to it in a plan. */
  const readableEngines = (gaugeId: string): ReadonlySet<string> => new Set((installed.get(gaugeId)?.engines ?? []).filter(engine => enforce(gaugeId, 'sessions.read', engine).ok));

  /**
   * The plan of a start as a Gauge reads it, made from the plan of the person by an allow-list: the folder as it was asked for, the program as configured, and the engines of the folder that the Gauge may read. The real folder,
   * the real program, and the engines that the Gauge may not read are not read here at all, so no change to this function can let one through by a spread or a copy.
   */
  const trimmedStart = (person: PersonSessionContent, title: string, readable: ReadonlySet<string>): SessionContent => {
    const program = person.configuredProgram;
    if (program === null) throw new Error('a start plan holds the program as it is configured');
    const sharedWith = person.allSharedWith.filter(engine => readable.has(engine));
    return {
      action: person.action, gauge: person.gauge, engine: person.engine, folder: person.requestedFolder, session: person.session, program, model: person.model, billing: person.billing, variables: person.variables, sharedWith,
      force: person.force,
      steps: startSteps({ gauge: person.gauge, engine: person.engine, title, program, folder: person.requestedFolder, requestedFolder: null, model: person.model, billing: person.billing, variables: person.variables, sharedWith }),
    };
  };
  /** The plan of a stop as a Gauge reads it, by an allow-list (see `trimmedStart`). */
  const trimmedStop = (person: PersonSessionContent, text: { readonly ended: boolean }): SessionContent => {
    if (person.session === null) throw new Error('a stop plan holds a session');
    return {
      action: person.action, gauge: person.gauge, engine: person.engine, folder: person.requestedFolder, session: person.session, program: null, model: null, billing: person.billing, variables: [], sharedWith: [], force: person.force,
      steps: stopSteps({ gauge: person.gauge, session: person.session, engine: person.engine, folder: person.requestedFolder, requestedFolder: null, force: person.force, ended: text.ended, timeoutMs: host.stopTimeoutMs }),
    };
  };

  /**
   * The engines for which a Gauge holds a permission now: the engines of its manifest that pass the one enforcement point. When there are none, the refusal of the check, so a Gauge with no grant at all gets the
   * grant refusal whatever id it names. A stop and a get look at this before they look at a session, so the refusal never says whether an id exists.
   */
  function grantedEngines(gaugeId: unknown, permission: 'sessions.read' | 'sessions.stop'): { readonly ok: true; readonly engines: ReadonlySet<string> } | Refusal {
    const current = typeof gaugeId === 'string' ? installed.get(gaugeId) : undefined;
    if (typeof gaugeId !== 'string' || !current) return refuse('UNKNOWN_GAUGE');
    const engines = new Set<string>();
    let first: Refusal | undefined;
    for (const engine of current.engines) {
      const checked = enforce(gaugeId, permission, engine);
      if (checked.ok) engines.add(engine);
      else first ??= checked;
    }
    if (engines.size > 0) return { ok: true, engines };
    // No engine is granted: the refusal of the first engine, or, for a Gauge that lists none, the check without an engine.
    if (first) return first;
    const bare = enforce(gaugeId, permission, undefined);
    // A permission that is scoped by engine never passes without one, so reaching here with an allow is a bug, and it throws.
    if (bare.ok) throw new Error('a permission scoped by engine was allowed with no engine');
    return bare;
  }

  /**
   * Plans a start or a stop of a session. Nothing changes. Every check runs here, so the plan the person sees is one that can be applied: the permission (the one enforcement point), the shape of the request,
   * the engine and its program, the model choice, the pair, the cap, and the folder that another engine uses. A stop for a session that is not there names the session as unknown, so a Gauge that holds no
   * grant for it learns only what the id already says. The plan has two views: the full one for the person, and the one that a Gauge reads (see `SessionPlanned`).
   */
  function planSession(params: Readonly<Record<string, unknown>>): SessionPlanned {
    const action = params['action'], gauge = params['gauge'];
    if (action === 'start') {
      const allowed = enforce(gauge, 'sessions.start', params['engine']);
      if (!allowed.ok) return allowed;
      const planned = host.planStart({ engine: params['engine'], folder: params['folder'], model: params['model'], variables: params['variables'] });
      if (!planned.ok) return engineRefusal(planned);
      const c = planned.plan;
      const person: PersonSessionContent = {
        action: 'start', gauge: allowed.gauge, engine: c.engine, realFolder: c.folder, requestedFolder: c.requestedFolder, session: null, realProgram: c.program, configuredProgram: c.configuredProgram, model: c.model, billing: c.billing,
        variables: [...c.variables], allSharedWith: [...c.sharedWith], force: false,
        steps: startSteps({ gauge: allowed.gauge, engine: c.engine, title: c.title, program: c.program, folder: c.folder, requestedFolder: c.requestedFolder, model: c.model, billing: c.billing, variables: c.variables, sharedWith: c.sharedWith }),
      };
      return { ok: true, person, seen: trimmedStart(person, c.title, readableEngines(allowed.gauge)), start: c };
    }
    const granted = grantedEngines(gauge, 'sessions.stop');
    if (!granted.ok) return granted;
    const id = checkSessionId(params['session']);
    if (!id.ok) return engineRefusal({ ok: false, code: 'ENGINE_REQUEST_INVALID', reason: id.reason });
    const found = host.get(id.value);
    // A session of an engine that the Gauge has no grant for reads exactly as a session that is not there.
    if (!found || !granted.engines.has(found.engine)) return engineRefusal({ ok: false, code: 'ENGINE_SESSION_UNKNOWN' });
    const allowed = enforce(gauge, 'sessions.stop', found.engine);
    if (!allowed.ok) return allowed;
    const planned = host.planStop(id.value);
    if (!planned.ok) return engineRefusal(planned);
    const c = planned.plan;
    const ended = found.state === 'stopped' || found.state === 'failed';
    const person: PersonSessionContent = {
      action: 'stop', gauge: allowed.gauge, engine: c.engine, realFolder: c.folder, requestedFolder: c.requestedFolder, session: c.session, realProgram: null, configuredProgram: null, model: null, billing: found.billing,
      variables: [], allSharedWith: [], force: c.force,
      steps: stopSteps({ gauge: allowed.gauge, session: c.session, engine: c.engine, folder: c.folder, requestedFolder: c.requestedFolder, force: c.force, ended, timeoutMs: host.stopTimeoutMs }),
    };
    return { ok: true, person, seen: trimmedStop(person, { ended }), start: null };
  }

  /** Reads the session plan a caller sends back, which is the plan a Gauge read. Anything that is not a whole plan reads as `undefined`. */
  function readSessionPlan(value: unknown): SessionPlan | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    // Own data properties only, each read once: an accessor reads as missing, and no getter runs.
    const field = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined; };
    const texts = (item: unknown): string[] | undefined => { const items = readList(item); return items !== undefined && items.every((entry): entry is string => typeof entry === 'string') ? items : undefined; };
    const action = field('action'), gauge = field('gauge'), engine = field('engine'), folder = field('folder'), session = field('session'), program = field('program');
    const rawModel = field('model'), billing = field('billing'), variables = texts(field('variables')), sharedWith = texts(field('sharedWith')), force = field('force'), steps = texts(field('steps')), digest = field('digest'), nonce = field('nonce');
    if (!isSessionAction(action) || typeof gauge !== 'string' || typeof engine !== 'string' || typeof folder !== 'string' || typeof digest !== 'string' || typeof nonce !== 'string' || typeof force !== 'boolean' || !isBilling(billing)) return undefined;
    const nullable = (item: unknown): item is string | null => item === null || typeof item === 'string';
    if (!nullable(session) || !nullable(program) || rawModel === undefined || variables === undefined || sharedWith === undefined || steps === undefined) return undefined;
    const model = checkModel(rawModel);
    if (!model.ok) return undefined;
    return sessionPlanObject({ action, gauge, engine, folder, session, program, model: model.value, billing, variables, sharedWith, force, steps }, digest, nonce);
  }

  /**
   * The host plans again when it begins. A plan that went stale in that moment (a link that was swapped between the two reads of a folder) is a changed plan, and `undefined` here. Any other throw is a bug, and goes on.
   * No session was made when the host throws it.
   */
  function beginOrStale<T>(begin: () => T): T | undefined {
    try {
      return begin();
    } catch (error) {
      if (isStalePlanError(error)) return undefined;
      throw error;
    }
  }

  /**
   * Applies a session plan. The first approval, the plan, and a plan made again from the state now are checked as for every plan, and then a start in a shared folder needs the second approval.
   * The plan a caller sends is the plan that a Gauge read: it must be that plan, as the core issued it. The core plans again from the folder as the Gauge asked for it, and its digest must be the digest that the person approved,
   * so a link that moved, or an engine that began or ended in the folder, is a changed plan. Everything is checked before the host is asked, and the host is asked before the approval is used up. The wait for the program
   * (to spawn, or to go) comes after the approval is used up and every older plan is retired, so a second call in the same tick finds the approval gone.
   *
   * The checks of the plan overlap, and are kept so that each holds without the others (defence in depth): the plan that a Gauge sends is the plan that the core issued (the hash of its text), it is for the nonce of the approval,
   * the plan made again has the digest that was approved, and the second approval is for this nonce and this digest. The test `the digest holds a key of the core` catches a digest that loses its key, and the tests `the digest is the same in both views`
   * and `the digest of a run plan is a keyed hash` catch a digest that loses its nonce. The check that the nonce of the plan is the nonce of the approval is covered by the digest check (a plan of another nonce has another digest), so no test pins it alone.
   */
  async function applySession(params: Readonly<Record<string, unknown>>): Promise<CoreReply> {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readSessionPlan(params['plan']);
    // A nonce that is not the nonce of a session plan has no view, so it reads as a changed plan, as a plan that is not the one issued does.
    if (!plan || plan.nonce !== approval.nonce || issued.get(plan.nonce)?.view !== sessionViewHash(plan)) return reply(refuse('GAUGE_PLAN_CHANGED'));
    // Plan again from the state now: a session plan that is no longer the one the person approved, or that no longer applies, is refused.
    const fresh = planSession(plan.action === 'start'
      ? { action: 'start', gauge: plan.gauge, engine: plan.engine, folder: plan.folder, model: plan.model, variables: plan.variables }
      : { action: 'stop', gauge: plan.gauge, session: plan.session });
    if (!fresh.ok) return reply(fresh);
    if (sessionDigest(fresh.person, plan.nonce) !== approval.digest) {
      // The plan changed. If the plan that a Gauge would read now is the plan that it read, the cause is one that it cannot read (an engine that began or ended in the folder, or a link that moved): the person is told.
      if (issued.get(plan.nonce)?.view === sessionViewHash(sessionPlanObject(fresh.seen, plan.digest, plan.nonce))) {
        notify({ action: 'start', gauge: plan.gauge, nonce: plan.nonce, shown: 'GAUGE_PLAN_CHANGED', cause: 'plan_changed_hidden', engines: [...fresh.person.allSharedWith], member: null });
      }
      return reply(refuse('GAUGE_PLAN_CHANGED'));
    }
    if (fresh.person.action === 'start') {
      if (fresh.start === null) throw new Error('a start plan holds the plan of the host');
      let second: { readonly token: string; readonly approval: Approval } | undefined;
      if (fresh.person.allSharedWith.length > 0) {
        second = liveApproval(params, 'sharedApproval', 'shared');
        if (!second || second.approval.nonce !== plan.nonce || second.approval.digest !== approval.digest) {
          // A Gauge is told that the folder is shared only when it may read an engine that shares it. Otherwise the refusal is the one of a missing approval, so it learns nothing of an engine that it may not read.
          // The person is told the true cause.
          const shown = fresh.seen.sharedWith.length > 0 ? 'ENGINE_FOLDER_SHARED' : 'GAUGE_PLAN_NOT_APPROVED';
          notify({ action: 'start', gauge: plan.gauge, nonce: plan.nonce, shown, cause: 'second_approval_missing', engines: [...fresh.person.allSharedWith], member: null });
          return reply(shown === 'ENGINE_FOLDER_SHARED' ? engineRefusal({ ok: false, code: 'ENGINE_FOLDER_SHARED' }) : refuse('GAUGE_PLAN_NOT_APPROVED'));
        }
      }
      const started = fresh.start;
      const begun = beginOrStale(() => host.beginStart(started, { sharedApproved: second !== undefined }));
      if (begun === undefined) return reply(refuse('GAUGE_PLAN_CHANGED'));
      if (!begun.ok) return reply(engineRefusal(begun));
      retire();
      const settled = await begun.settled;
      if (!settled.ok) return reply(engineRefusal(settled));
      return { ok: true, result: { action: 'start', session: begun.session, engine: plan.engine, state: settled.info.state } };
    }
    if (fresh.person.session === null) throw new Error('a stop plan holds a session');
    const begun = host.beginStop(fresh.person.session);
    if (!begun.ok) return reply(engineRefusal(begun));
    retire();
    const settled = await begun.settled;
    if (!settled.ok) return reply(engineRefusal(settled));
    return { ok: true, result: { action: 'stop', session: fresh.person.session, engine: plan.engine, state: settled.info.state } };
  }


  // Jobs and runs

  /** The jobs the core holds, and the runs that have begun. Jobs are the person's saved work: a Gauge asks for a change through a plan, and no Gauge owns a job. */
  const jobStore = createJobStore({ ...(options.jobCap === undefined ? {} : { cap: options.jobCap }), ...(options.jobIds === undefined ? {} : { newId: options.jobIds }) });
  const runBook = createRunBook({ host, ...(options.runIds === undefined ? {} : { newId: options.runIds }) });

  const isJobKind = (value: unknown): value is JobKind => typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
  const jobInvalid = (reason: 'job' | 'request'): Refusal => ({ ok: false, code: 'GAUGE_JOB_INVALID', reason });
  /** The refusal of the host for a session of a run, with the place and the label of that session. */
  const memberRefusal = (refusal: RunRefusal): Refusal => ({ ...engineRefusal(refusal), member: { index: refusal.index, label: refusal.label } });
  /**
   * Looks at the top-level keys of a raw call that plans or applies a job or a run. A `schedule` key, or an `unattended` key, with any value, is refused as not interactive (a schedule before an unattended flag), and any key that the call does
   * not know is refused as a request that is malformed. The client never sends such a key, so only a raw caller meets this.
   */
  function unknownKeys(params: Readonly<Record<string, unknown>>, known: readonly PropertyKey[]): Refusal | undefined {
    const keys = Reflect.ownKeys(params);
    if (keys.includes('schedule')) return { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'schedule' };
    if (keys.includes('unattended')) return { ok: false, code: 'GAUGE_JOB_NOT_INTERACTIVE', reason: 'unattended' };
    return keys.some(key => !known.includes(key)) ? jobInvalid('request') : undefined;
  }
  /** The refusal of the definition check as the core gives it. */
  const definitionRefusal = (refused: DefinitionRefusal): Refusal => refused;
  const hashOf = (definition: JobDefinition | null): string | null => (definition === null ? null : hashDefinition(definition));
  /** A definition as it goes over the seam: new objects each time. */
  const definitionObject = (definition: JobDefinition) => ({
    title: definition.title,
    sessions: definition.sessions.map(session => ({ ...session, model: session.model === null ? null : { provider: session.model.provider, model: session.model.model } })),
  });

  /** What a job plan says before the core seals it. */
  interface JobContent {
    readonly kind: JobKind;
    readonly gauge: string;
    readonly job: string | null;
    readonly definition: JobDefinition | null;
    readonly baseHash: string | null;
    readonly nextHash: string | null;
    readonly steps: readonly string[];
  }
  type JobPlanned = (JobContent & { readonly ok: true; readonly digest: string }) | Refusal;
  const jobDigest = (plan: JobContent): string => sha256(JSON.stringify(['job', plan.kind, plan.gauge, plan.job, plan.baseHash, plan.nextHash, plan.steps]));

  /**
   * Plans a change to a job. Nothing changes. Every check runs here, so the plan the person sees is one that can be applied: the grant first (so a Gauge with no grant learns nothing about any job), then the shape of
   * the job id and of the definition (a schedule is refused here as not interactive), then whether the job is there, and for a create whether the store has room.
   */
  function planJob(params: Readonly<Record<string, unknown>>): JobPlanned {
    const kind = params['kind'];
    if (!isJobKind(kind)) throw new Error(`unknown job change: ${String(kind)}`);
    const allowed = enforce(params['gauge'], 'jobs.write', undefined);
    if (!allowed.ok) return allowed;
    const stray = unknownKeys(params, ['kind', 'gauge', 'job', 'definition']);
    if (stray) return stray;
    let id: string | null = null;
    if (kind !== 'create') {
      const checked = checkJobId(params['job']);
      if (!checked.ok) return jobInvalid('job');
      id = checked.value;
    }
    let definition: JobDefinition | null = null;
    if (kind !== 'delete') {
      const checked = checkDefinition(params['definition']);
      if (!checked.ok) return definitionRefusal(checked);
      definition = checked.value;
    }
    let before: Job | undefined;
    if (id === null) {
      if (jobStore.full) return { ok: false, code: 'GAUGE_JOB_LIMIT' };
    } else {
      before = jobStore.get(id);
      if (before === undefined) return { ok: false, code: 'GAUGE_JOB_UNKNOWN' };
    }
    const content: JobContent = {
      kind, gauge: allowed.gauge, job: id, definition, baseHash: hashOf(before?.definition ?? null), nextHash: hashOf(definition),
      steps: jobSteps({ kind, gauge: allowed.gauge, job: id, before: before?.definition ?? null, definition, baseHash: hashOf(before?.definition ?? null), nextHash: hashOf(definition) }),
    };
    return { ok: true, ...content, digest: jobDigest(content) };
  }

  /** Reads the job plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readJobPlan(value: unknown): (JobContent & { readonly digest: string; readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const field = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined; };
    const action = field('action'), kind = field('kind'), gauge = field('gauge'), job = field('job'), baseHash = field('baseHash'), nextHash = field('nextHash'), steps = readTexts(field('steps')), nonce = field('nonce');
    if (action !== 'job' || !isJobKind(kind) || typeof gauge !== 'string' || typeof nonce !== 'string' || steps === undefined) return undefined;
    const nullable = (item: unknown): item is string | null => item === null || typeof item === 'string';
    if (!nullable(job) || !nullable(baseHash) || !nullable(nextHash)) return undefined;
    const rawDefinition = field('definition');
    let definition: JobDefinition | null = null;
    if (rawDefinition !== null) {
      const checked = checkDefinition(rawDefinition);
      if (!checked.ok) return undefined;
      definition = checked.value;
    }
    const content: JobContent = { kind, gauge, job, definition, baseHash, nextHash, steps };
    return { ...content, digest: jobDigest(content), nonce };
  }

  /** Applies a job plan: the approval, the plan, and a plan made again from the state now are checked as for every plan. A job that changed since, or a grant that was revoked since, is refused. */
  function applyJob(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readJobPlan(params['plan']);
    if (!plan || plan.nonce !== approval.nonce || plan.digest !== approval.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    const fresh = planJob({ kind: plan.kind, gauge: plan.gauge, job: plan.job, definition: plan.definition === null ? undefined : definitionObject(plan.definition) });
    if (!fresh.ok) return reply(fresh);
    if (fresh.digest !== plan.digest) return reply(refuse('GAUGE_PLAN_CHANGED'));
    let job: string;
    if (fresh.kind === 'create') {
      if (fresh.definition === null) throw new Error('a create plan holds a definition');
      const made = jobStore.create(fresh.definition);
      if (!made.ok) return reply({ ok: false, code: made.code });
      job = made.id;
    } else {
      if (fresh.job === null) throw new Error('an update or a delete plan holds a job');
      job = fresh.job;
      if (fresh.kind === 'update') {
        if (fresh.definition === null) throw new Error('an update plan holds a definition');
        if (!jobStore.replace(job, fresh.definition)) throw new Error('a job that was planned is gone');
      } else if (!jobStore.remove(job)) throw new Error('a job that was planned is gone');
    }
    retire();
    return { ok: true, result: { kind: fresh.kind, job } };
  }

  /** What a run plan says, for a kind of session: `RunPlanSession` for a Gauge and `PersonRunPlanSession` for the person. */
  interface RunContent<Session> {
    readonly gauge: string;
    readonly job: string;
    readonly title: string;
    readonly shared: boolean;
    readonly sessions: readonly Session[];
    readonly steps: readonly string[];
  }
  type RunPlanned = {
    readonly ok: true;
    readonly person: RunContent<PersonRunPlanSession>;
    readonly seen: RunContent<RunPlanSession>;
    readonly planned: PlannedRun;
  } | Refusal;
  /** The digest of a run plan: a keyed hash of the nonce and the full plan, for the reasons of `sessionDigest`. */
  const runDigest = (plan: RunContent<PersonRunPlanSession>, nonce: string): string => keyed([
    'run', nonce, plan.gauge, plan.job, plan.title, plan.shared,
    plan.sessions.map(session => [session.label, session.engine, session.engineTitle, session.harness, session.realProgram, session.realFolder, session.model === null ? null : [session.model.provider, session.model.model], session.billing, session.variables, session.allSharedWith, session.task]),
    plan.steps,
  ]);
  const modelObject = (model: SessionModel | null): SessionModel | null => (model === null ? null : { provider: model.provider, model: model.model });
  /** A session of a run plan as a Gauge reads it, as it goes over the seam: a new object each time. */
  const runSessionObject = (session: RunPlanSession): RunPlanSession => ({
    label: session.label, engine: session.engine, engineTitle: session.engineTitle, harness: session.harness, program: session.program, folder: session.folder,
    model: modelObject(session.model), billing: session.billing, variables: [...session.variables], sharedWith: [...session.sharedWith], task: session.task,
  });
  const runPlanObject = (content: RunContent<RunPlanSession>, digest: string, nonce: string): RunPlan => (
    { action: 'run', gauge: content.gauge, job: content.job, title: content.title, shared: content.shared, sessions: content.sessions.map(runSessionObject), steps: [...content.steps], digest, nonce }
  );
  /** A run plan as the person reads it: a new object each time. */
  const personRunObject = (content: RunContent<PersonRunPlanSession>, digest: string, nonce: string): PersonRunPlan => ({
    action: 'run', gauge: content.gauge, job: content.job, title: content.title, shared: content.shared,
    sessions: content.sessions.map((session): PersonRunPlanSession => ({
      label: session.label, engine: session.engine, engineTitle: session.engineTitle, harness: session.harness, realProgram: session.realProgram, configuredProgram: session.configuredProgram, realFolder: session.realFolder,
      requestedFolder: session.requestedFolder, model: modelObject(session.model), billing: session.billing, variables: [...session.variables], allSharedWith: [...session.allSharedWith], task: session.task,
    })),
    steps: [...content.steps], digest, nonce,
  });
  const runViewHash = (plan: RunPlan): string => sha256(JSON.stringify(['run', plan]));
  /**
   * The plan of a run as a Gauge reads it, made from the plan of the person by an allow-list: the folder as the job names it, the program as configured, and the engines of each folder that the Gauge may read. The real folder,
   * the real program, and the engines that the Gauge may not read are not read here at all (see `trimmedStart`). `shared` is true when a folder is shared with an engine that the Gauge may read.
   */
  const trimmedRun = (person: RunContent<PersonRunPlanSession>, readable: ReadonlySet<string>): RunContent<RunPlanSession> => {
    const sessions = person.sessions.map((session): RunPlanSession => ({
      label: session.label, engine: session.engine, engineTitle: session.engineTitle, harness: session.harness, program: session.configuredProgram, folder: session.requestedFolder, model: session.model, billing: session.billing,
      variables: session.variables, sharedWith: session.allSharedWith.filter(engine => readable.has(engine)), task: session.task,
    }));
    const shared = sessions.some(session => session.sharedWith.length > 0);
    return {
      gauge: person.gauge, job: person.job, title: person.title, shared, sessions,
      steps: runSteps({ gauge: person.gauge, job: person.job, title: person.title, shared, sessions: sessions.map(session => ({ ...session, requestedFolder: null })) }),
    };
  };

  /**
   * Plans a run of a job. Nothing changes. The grant `jobs.run` first, so a Gauge with none learns nothing about any job. A key that asks for a schedule or an unattended run is refused: v0.9.1 runs are interactive, and any other key that the call does not know is refused too. Then the job, and the
   * `sessions.start` grant for the engine of every session of it, by the one enforcement point: a Gauge that lists one engine never starts another engine through a job. Last, the Engine Host plans the whole group.
   * The plan has two views, as a plan of a session has: the person reads the real folders, the real programs, and every engine that shares a folder, and a Gauge reads the folders as the job names them, the programs as they are
   * configured, and the engines that it may read.
   */
  function planRun(params: Readonly<Record<string, unknown>>): RunPlanned {
    const allowed = enforce(params['gauge'], 'jobs.run', undefined);
    if (!allowed.ok) return allowed;
    const stray = unknownKeys(params, ['gauge', 'job']);
    if (stray) return stray;
    const id = checkJobId(params['job']);
    if (!id.ok) return jobInvalid('job');
    const job = jobStore.get(id.value);
    if (job === undefined) return { ok: false, code: 'GAUGE_JOB_UNKNOWN' };
    for (const session of job.definition.sessions) {
      const startable = enforce(allowed.gauge, 'sessions.start', session.engine);
      if (!startable.ok) return startable;
    }
    const planned = runBook.plan(job);
    if (!planned.ok) return memberRefusal(planned);
    const whole = planned.plan;
    const sessions = whole.sessions.map((session): PersonRunPlanSession => ({
      label: session.label, engine: session.engine, engineTitle: session.engineTitle, harness: session.harness, realProgram: session.program, configuredProgram: session.configuredProgram, realFolder: session.folder,
      requestedFolder: session.requestedFolder, model: session.model, billing: session.billing, variables: session.variables, allSharedWith: session.sharedWith, task: session.task,
    }));
    const person: RunContent<PersonRunPlanSession> = {
      gauge: allowed.gauge, job: whole.job, title: whole.title, shared: whole.shared, sessions,
      steps: runSteps({
        gauge: allowed.gauge, job: whole.job, title: whole.title, shared: whole.shared,
        sessions: sessions.map(session => ({
          label: session.label, engine: session.engine, engineTitle: session.engineTitle, harness: session.harness, program: session.realProgram, folder: session.realFolder, requestedFolder: session.requestedFolder,
          model: session.model, billing: session.billing, variables: session.variables, sharedWith: session.allSharedWith, task: session.task,
        })),
      }),
    };
    return { ok: true, person, seen: trimmedRun(person, readableEngines(allowed.gauge)), planned: { plan: whole, start: planned.start } };
  }

  /** Reads the run plan a caller sends back, which is the plan a Gauge read, from own data properties. Anything that is not a whole plan reads as `undefined`. */
  function readRunPlan(value: unknown): RunPlan | undefined {
    const record = (item: unknown): Record<string, unknown> | undefined => (typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : undefined);
    const own = (item: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(item, key); return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined; };
    const top = record(value);
    if (top === undefined) return undefined;
    const action = own(top, 'action'), gauge = own(top, 'gauge'), job = own(top, 'job'), title = own(top, 'title'), shared = own(top, 'shared'), digest = own(top, 'digest'), nonce = own(top, 'nonce');
    const items = readList(own(top, 'sessions'), MAX_JOB_SESSIONS), steps = readTexts(own(top, 'steps'));
    if (action !== 'run' || typeof gauge !== 'string' || typeof job !== 'string' || typeof title !== 'string' || typeof shared !== 'boolean' || typeof digest !== 'string' || typeof nonce !== 'string' || items === undefined || steps === undefined) return undefined;
    const sessions: RunPlanSession[] = [];
    for (const item of items) {
      const entry = record(item);
      if (entry === undefined) return undefined;
      const text = (key: string): string | undefined => { const field = own(entry, key); return typeof field === 'string' ? field : undefined; };
      const model = checkModel(own(entry, 'model') ?? undefined);
      const variables = readTexts(own(entry, 'variables')), sharedWith = readTexts(own(entry, 'sharedWith')), billing = own(entry, 'billing');
      const label = text('label'), engine = text('engine'), engineTitle = text('engineTitle'), harness = text('harness'), program = text('program'), folder = text('folder'), task = text('task');
      if (label === undefined || engine === undefined || engineTitle === undefined || harness === undefined || program === undefined || folder === undefined || task === undefined) return undefined;
      if (!model.ok || variables === undefined || sharedWith === undefined || !isBilling(billing)) return undefined;
      sessions.push({ label, engine, engineTitle, harness, program, folder, model: model.value, billing, variables, sharedWith, task });
    }
    return runPlanObject({ gauge, job, title, shared, sessions, steps }, digest, nonce);
  }

  /** A run as a Gauge may read it: a session of an engine that the Gauge holds no `sessions.read` grant for is `hidden`, with no id, so the answer is the same whatever that session is. */
  function runSummary(gauge: string, view: RunView): RunSummary {
    const sessions = view.sessions.map((session): RunSessionSummary => (enforce(gauge, 'sessions.read', session.engine).ok
      ? { label: session.label, engine: session.engine, session: session.session, state: session.state }
      : { label: session.label, engine: session.engine, session: null, state: 'hidden' }));
    return { id: view.id, job: view.job, title: view.title, sessions };
  }

  /** The failure of a run that did not start: the first failure and its session, with the run that it left, or the failure of the undo with the cause. */
  const outcomeRefusal = (outcome: Exclude<RunOutcome, { readonly ok: true }>): Refusal => (outcome.code === 'GAUGE_RUN_ROLLBACK_FAILED'
    ? { ok: false, code: 'GAUGE_RUN_ROLLBACK_FAILED', run: outcome.run, member: outcome.member, cause: outcome.cause }
    : { ok: false, code: 'ENGINE_START_FAILED', reason: outcome.reason, member: outcome.member, run: outcome.run });

  /**
   * Applies a run plan. The first approval, the plan, and a plan made again from the state now are checked as for every plan, and a plan with `shared` needs the second approval, once. Everything is checked before the
   * book is asked, and the book is asked before the approval is used up. The wait for the programs comes after the approval is used up and every older plan is retired.
   */
  async function applyRun(params: Readonly<Record<string, unknown>>): Promise<CoreReply> {
    const stray = unknownKeys(params, ['plan', 'approval', 'sharedApproval']);
    if (stray) return reply(stray);
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { approval } = live;
    const plan = readRunPlan(params['plan']);
    // As for a session plan (see `applySession`, which says why these checks overlap): the plan must be the one a Gauge read, as issued, and a plan of another kind has no view.
    if (!plan || plan.nonce !== approval.nonce || issued.get(plan.nonce)?.view !== runViewHash(plan)) return reply(refuse('GAUGE_PLAN_CHANGED'));
    const fresh = planRun({ gauge: plan.gauge, job: plan.job });
    if (!fresh.ok) return reply(fresh);
    if (runDigest(fresh.person, plan.nonce) !== approval.digest) {
      if (issued.get(plan.nonce)?.view === runViewHash(runPlanObject(fresh.seen, plan.digest, plan.nonce))) {
        notify({ action: 'run', gauge: plan.gauge, nonce: plan.nonce, shown: 'GAUGE_PLAN_CHANGED', cause: 'plan_changed_hidden', engines: [...new Set(fresh.person.sessions.flatMap(session => session.allSharedWith))].sort(), member: null });
      }
      return reply(refuse('GAUGE_PLAN_CHANGED'));
    }
    let second: { readonly token: string; readonly approval: Approval } | undefined;
    if (fresh.person.shared) {
      second = liveApproval(params, 'sharedApproval', 'shared');
      if (!second || second.approval.nonce !== plan.nonce || second.approval.digest !== approval.digest) {
        // A Gauge is told which session shares its folder only when it may read an engine that shares it. Otherwise the refusal is the one of a missing approval, and it names no session.
        // The person is told the true session and every engine.
        const index = fresh.seen.sessions.findIndex(session => session.sharedWith.length > 0);
        const label = fresh.seen.sessions[index]?.label;
        const trueIndex = fresh.person.sessions.findIndex(session => session.allSharedWith.length > 0);
        const trueLabel = fresh.person.sessions[trueIndex]?.label;
        const member: RunMember | null = trueLabel === undefined ? null : { index: trueIndex, label: trueLabel };
        notify({
          action: 'run', gauge: plan.gauge, nonce: plan.nonce, shown: label === undefined ? 'GAUGE_PLAN_NOT_APPROVED' : 'ENGINE_FOLDER_SHARED', cause: 'second_approval_missing',
          engines: [...new Set(fresh.person.sessions.flatMap(session => session.allSharedWith))].sort(), member,
        });
        return reply(label === undefined ? refuse('GAUGE_PLAN_NOT_APPROVED') : memberRefusal({ ok: false, code: 'ENGINE_FOLDER_SHARED', index, label }));
      }
    }
    const planned = fresh.planned;
    const begun = beginOrStale(() => runBook.begin(planned, { sharedApproved: second !== undefined }));
    if (begun === undefined) return reply(refuse('GAUGE_PLAN_CHANGED'));
    if (!begun.ok) return reply(memberRefusal(begun));
    retire();
    const outcome = await begun.settled;
    if (!outcome.ok) return reply(outcomeRefusal(outcome));
    const view = runBook.get(begun.run);
    if (view === undefined) throw new Error('a run that began is gone');
    return { ok: true, result: runSummary(plan.gauge, view) };
  }

  /** What the person reads: see `PersonView`. A plan that is retired, or that was dropped for a newer plan of its Gauge, is not held, and a plan of another kind has no plan of the person. */
  function personView(nonce: string): PersonPlan {
    const record = typeof nonce === 'string' ? issued.get(nonce) : undefined;
    if (record === undefined || record.epoch !== epoch || record.person === undefined) throw new TypeError('the plan of the person is for a nonce that the core issued for a start, a stop, or a run, and that is still current');
    return structuredClone(record.person);
  }

  return {
    approve(nonce) {
      const plan = typeof nonce === 'string' ? issued.get(nonce) : undefined;
      // A plan made before the state changed is retired, so a nonce of an old plan is no longer one that the core issued.
      if (plan === undefined || plan.epoch !== epoch) throw new TypeError('an approval is for a nonce that the core issued, for a plan that is still current');
      const token = newNonce();
      approvals.set(token, { nonce, digest: plan.digest, at: now(), epoch, purpose: 'plan' });
      return token;
    },
    approveShared(nonce) {
      const plan = typeof nonce === 'string' ? issued.get(nonce) : undefined;
      if (plan === undefined || plan.epoch !== epoch) throw new TypeError('an approval is for a nonce that the core issued, for a plan that is still current');
      if (!plan.shared) throw new TypeError('a second approval is for a start in a folder that another engine uses');
      const token = newNonce();
      approvals.set(token, { nonce, digest: plan.digest, at: now(), epoch, purpose: 'shared' });
      return token;
    },
    personView,
    personSessionPlan(nonce) {
      const plan = personView(nonce);
      if (plan.action === 'run') throw new TypeError('the plan for this nonce is a run plan: read it with personRunPlan');
      return plan;
    },
    personRunPlan(nonce) {
      const plan = personView(nonce);
      if (plan.action !== 'run') throw new TypeError('the plan for this nonce is a plan of a start or a stop: read it with personSessionPlan');
      return plan;
    },
    personNotices: () => structuredClone(notices),
    livePlans: () => issued.size,
    replaceFolder(folder) {
      folders.set(folder.name, copyFolder(folder));
    },
    auditFile: () => auditLines.join(''),
    layoutFile: () => layoutDisk,
    layoutBackup: () => (layoutKept === null ? null : Uint8Array.from(layoutKept)),
    layoutStartCheck() {
      // The raw bytes are read, and not the text that was decoded from them: a decode drops a byte order mark that a start would refuse.
      if (layoutSafe?.reason === 'internal') return layoutSafe;
      const read = readSaved(layoutRaw);
      return 'safe' in read ? read.safe : null;
    },
    async call(method, params): Promise<CoreReply> {
      switch (method) {
        case 'bowerloom.gauges.list':
          return { ok: true, result: [...installed.values()].map(({ summary }) => ({ ...summary })) };
        case 'bowerloom.gauges.get': {
          const id = params['id'];
          const found = typeof id === 'string' ? installed.get(id) : undefined;
          return found ? { ok: true, result: { ...found.summary } } : { ok: false, code: 'UNKNOWN_GAUGE' };
        }
        case 'bowerloom.gauges.plan': {
          const action = params['action'];
          if (typeof action !== 'string' || !(PLAN_ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown plan action: ${String(action)}`);
          const planned = planFor(action as PlanAction, params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          issue(nonce, 'person:lifecycle', { digest: planned.plan.digest, gauge: null, shared: false });
          return { ok: true, result: { ...planned.plan, steps: [...planned.plan.steps], nonce } };
        }
        case 'bowerloom.gauges.apply':
          return apply(params);
        case 'bowerloom.grants.plan': {
          const planned = planGrant(params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          issue(nonce, 'person:grants', { digest: planned.plan.digest, gauge: planned.plan.id, shared: false });
          return { ok: true, result: { action: 'grant', ...planned.plan, permissions: [...planned.plan.permissions], steps: [...planned.plan.steps], nonce } };
        }
        case 'bowerloom.grants.apply':
          return applyGrant(params);
        case 'bowerloom.grants.revoke':
          return revoke(params);
        case 'bowerloom.grants.list': {
          const id = params['id'];
          const current = typeof id === 'string' ? installed.get(id) : undefined;
          if (typeof id !== 'string' || !current) return { ok: false, code: 'UNKNOWN_GAUGE' };
          return { ok: true, result: sortedHeld(id).map(([permission, hashes]) => ({ permission, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash })) };
        }
        case 'bowerloom.permissions.check': {
          const checked = enforce(params['gauge'], params['permission'], params['engine']);
          if (!checked.ok) return reply(checked);
          return { ok: true, result: { gauge: checked.gauge, permission: checked.permission, engine: checked.engine } };
        }
        case 'bowerloom.audit.read':
        {
          const entries = auditLines.map((line): AuditEntry => JSON.parse(line) as AuditEntry);
          const result: AuditRead = { entries, firstSeq: entries[0]?.seq ?? null, droppedCount: auditDropped, auditFailed };
          return { ok: true, result };
        }
        case 'bowerloom.layout.read':
          return { ok: true, result: { layout: layoutObject(layoutInUse()), revision: layoutNumber(), safe: layoutSafe === null ? null : { ...layoutSafe } } };
        case 'bowerloom.layout.revisions':
          return { ok: true, result: (layoutSaved?.revisions ?? []).map(entry => ({ revision: entry.revision, layout: layoutObject(entry.layout) })) };
        case 'bowerloom.layout.export':
          return { ok: true, result: canonicalText(layoutInUse()) };
        case 'bowerloom.layout.plan': {
          const planned = planLayout(params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          issue(nonce, planned.owner === null ? 'person:layout' : `gauge:${planned.owner}`, { digest: planned.digest, gauge: planned.owner, shared: false });
          const { kind, place, gauge, revision, text, steps, digest, baseHash, nextHash } = planned;
          return { ok: true, result: { action: 'layout', kind, place, gauge, revision, text, steps: [...steps], digest, baseHash, nextHash, nonce } };
        }
        case 'bowerloom.layout.apply':
          return applyLayout(params);
        case 'bowerloom.sessions.plan': {
          if (!isSessionAction(params['action'])) throw new Error(`unknown session action: ${String(params['action'])}`);
          const planned = planSession(params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          const digest = sessionDigest(planned.person, nonce);
          const result = sessionPlanObject(planned.seen, digest, nonce);
          issue(nonce, `gauge:${planned.person.gauge}`, { digest, gauge: planned.person.gauge, shared: planned.person.allSharedWith.length > 0, view: sessionViewHash(result), person: personSessionObject(planned.person, digest, nonce) });
          return { ok: true, result };
        }
        case 'bowerloom.sessions.apply':
          return applySession(params);
        case 'bowerloom.sessions.list': {
          const allowed = enforce(params['gauge'], 'sessions.read', params['engine']);
          if (!allowed.ok) return reply(allowed);
          return { ok: true, result: host.list(allowed.engine ?? undefined).map(sessionObject) };
        }
        case 'bowerloom.sessions.get': {
          const gauge = params['gauge'];
          const granted = grantedEngines(gauge, 'sessions.read');
          if (!granted.ok) return reply(granted);
          const id = checkSessionId(params['session']);
          if (!id.ok) return reply(engineRefusal({ ok: false, code: 'ENGINE_REQUEST_INVALID', reason: id.reason }));
          const found = host.get(id.value);
          if (!found || !granted.engines.has(found.engine)) return reply(engineRefusal({ ok: false, code: 'ENGINE_SESSION_UNKNOWN' }));
          return { ok: true, result: sessionObject(found) };
        }
        case 'bowerloom.jobs.list': {
          const allowed = enforce(params['gauge'], 'jobs.read', undefined);
          if (!allowed.ok) return reply(allowed);
          return { ok: true, result: jobStore.list().map(job => ({ ...job })) };
        }
        case 'bowerloom.jobs.get': {
          const allowed = enforce(params['gauge'], 'jobs.read', undefined);
          if (!allowed.ok) return reply(allowed);
          const id = checkJobId(params['job']);
          if (!id.ok) return reply(jobInvalid('job'));
          const job = jobStore.get(id.value);
          if (job === undefined) return { ok: false, code: 'GAUGE_JOB_UNKNOWN' };
          return { ok: true, result: { id: job.id, ...definitionObject(job.definition) } };
        }
        case 'bowerloom.jobs.plan': {
          const planned = planJob(params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          issue(nonce, `gauge:${planned.gauge}`, { digest: planned.digest, gauge: planned.gauge, shared: false });
          const { kind, gauge, job, definition, baseHash, nextHash, steps, digest } = planned;
          return { ok: true, result: { action: 'job', kind, gauge, job, definition: definition === null ? null : definitionObject(definition), baseHash, nextHash, steps: [...steps], digest, nonce } };
        }
        case 'bowerloom.jobs.apply':
          return applyJob(params);
        case 'bowerloom.runs.plan': {
          const planned = planRun(params);
          if (!planned.ok) return reply(planned);
          const nonce = newNonce();
          const digest = runDigest(planned.person, nonce);
          const result = runPlanObject(planned.seen, digest, nonce);
          issue(nonce, `gauge:${planned.person.gauge}`, { digest, gauge: planned.person.gauge, shared: planned.person.shared, view: runViewHash(result), person: personRunObject(planned.person, digest, nonce) });
          return { ok: true, result };
        }
        case 'bowerloom.runs.apply':
          return applyRun(params);
        case 'bowerloom.runs.list': {
          const allowed = enforce(params['gauge'], 'jobs.read', undefined);
          if (!allowed.ok) return reply(allowed);
          return { ok: true, result: runBook.list().map(view => runSummary(allowed.gauge, view)) };
        }
        case 'bowerloom.runs.get': {
          const allowed = enforce(params['gauge'], 'jobs.read', undefined);
          if (!allowed.ok) return reply(allowed);
          const id = params['run'];
          const view = isRunId(id) ? runBook.get(id) : undefined;
          if (view === undefined) return { ok: false, code: 'GAUGE_RUN_UNKNOWN' };
          return { ok: true, result: runSummary(allowed.gauge, view) };
        }
        case 'bowerloom.gauges.routes':
          return { ok: true, result: [...installed.values()].filter(gauge => gauge.enabled).map(({ summary }) => `/gauges/${summary.id}`) };
        default:
          throw new Error(`unknown core method: ${String(method)}`);
      }
    },
  };
}
