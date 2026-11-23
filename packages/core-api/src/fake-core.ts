import { createHash, randomBytes } from 'node:crypto';
import type { GaugeCode } from '../../gauge-errors/src/index.js';
import {
  PERMISSION_NAMES, compareVersions, isPermission, isTracesPermission, isUnsafeFolderName, parseVersion, permissionOf, unsafeNameReason, validateManifest,
  type AuditReason, type GaugeManifest, type GrantReason, type ManifestReason, type PermissionName,
} from '../../gauge-manifest/src/index.js';
import {
  PAGE_IDS, canonicalText, checkLayout, defaultLayout, droppedRevision, layoutObject, newFile, parseLayout, parseLayoutFile, proposeTile, reconcileLayout, saveRevision, serializeLayoutFile, swapPlace, defaultPlace, tileInfoOf, invalid as layoutInvalid,
  type GaugeInfo, type Layout, type LayoutFile, type LayoutRefusal, type TileInfo, type UnknownGaugeRefusal,
} from '../../gauge-layout/src/index.js';
import { FIXTURE_GAUGES, HOME_STOCK } from './fixtures.js';
import { layoutChangeSteps, layoutSteps } from './layout-plan.js';
import { DEFAULT_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES, appendAuditStep, auditLine, grantSteps } from './grants.js';
import { escapeForPlan } from './plan-text.js';
import {
  LAYOUT_KINDS, PLAN_ACTIONS, type AuditEntry, type AuditRead, type Core, type CoreRefusal, type CoreReply, type GaugeApplied, type GaugePlan, type GaugeSummary, type LayoutKind, type LayoutSafe, type PlanAction,
} from './types.js';

export { escapeForPlan };

/**
 * The default clock of the fake core, in milliseconds. It is monotonic: it reads the performance clock, which never steps back, and never the system
 * clock, which a person or a network time service can move. So a system clock that steps back cannot make an approval last longer.
 */
export const monotonicNow = (): number => performance.now();

/** How long an approval lasts, in milliseconds. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

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
  /** The size cap of the audit file, in bytes: a whole number of at least `MIN_AUDIT_MAX_BYTES` (5,970). 64 KiB by default. A smaller or a non-integer cap is refused when the core is made. */
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
}

/**
 * The fake core is a core, plus two things that a test needs and no Gauge can reach: the person's approval, and a change of a folder on disk.
 *
 * A real core must not copy how the fake mints an approval. The fake is a test double. The person approves in the app with a click that a Gauge cannot make,
 * and a real core ties that approval to its own channel and its own store.
 */
export interface FakeCore extends Core {
  /** The person approves the plan that the core issued with this nonce. Gives back an approval: a random token that applies that plan once, within 15 minutes. */
  approve(nonce: string): string;
  /** Replaces, or adds, the folder with the same name, as if its files changed on disk. The core keeps a copy. */
  replaceFolder(folder: GaugeFolder): void;
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
}

/** The last millisecond of the year 9999, so that a time is always written as four digits of year. */
const MAX_WALL_MS = 253_402_300_799_999;
/** The time of a record when the clock gave none. */
const FALLBACK_AT = '1970-01-01T00:00:00.000Z';

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

type PlainCode = Exclude<GaugeCode, 'GAUGE_GRANT_MISSING' | 'GAUGE_AUDIT_FAILED' | 'GAUGE_LAYOUT_INVALID' | 'GAUGE_PROTECTED'>;
const refuse = (code: PlainCode, reason?: ManifestReason): Refusal => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
/** A refusal because a Gauge is protected: the lifecycle gives no reason. */
const protectedRefusal = (): Refusal => ({ ok: false, code: 'GAUGE_PROTECTED' });
/** A refusal of a layout, or of a change to it, or of a Gauge that a change names. */
const refusalOf = (result: LayoutRefusal | UnknownGaugeRefusal): Refusal => (result.code === 'UNKNOWN_GAUGE' ? refuse('UNKNOWN_GAUGE') : result);
/** A refusal because the audit file could not take the record of a grant. */
const auditRefusal = (reason: AuditReason): Refusal => ({ ok: false, code: 'GAUGE_AUDIT_FAILED', reason });
/** A refusal because of a grant: the code `GAUGE_GRANT_MISSING` with a reason of the closed set, or with none when the permission is plainly not granted. */
const deny = (reason?: GrantReason): Refusal => (reason === undefined ? { ok: false, code: 'GAUGE_GRANT_MISSING' } : { ok: false, code: 'GAUGE_GRANT_MISSING', reason });
const reply = (refusal: Refusal): CoreReply => (refusal.reason === undefined ? { ok: false, code: refusal.code } : { ok: false, code: refusal.code, reason: refusal.reason });
/** True when the value is a list of text with no hole. A hole is not a line of text. */
const isDenseTexts = (value: unknown): value is string[] => Array.isArray(value) && Array.from(value as unknown[]).every((item): item is string => typeof item === 'string');

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
  const now = options.now ?? monotonicNow;
  const wall = options.wall ?? Date.now;
  const auditMaxBytes = options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  if (!Number.isSafeInteger(auditMaxBytes) || auditMaxBytes < MIN_AUDIT_MAX_BYTES) throw new RangeError(`the audit size cap is a whole number of at least ${MIN_AUDIT_MAX_BYTES} bytes`);
  const folders = new Map<string, GaugeFolder>((options.folders ?? []).map(folder => [folder.name, copyFolder(folder)]));
  const started: readonly { readonly summary: GaugeSummary; readonly tile: TileInfo | null }[] = [
    ...FIXTURE_GAUGES.map(summary => ({ summary, tile: null })), ...(options.home === true ? HOME_STOCK : []),
  ];
  const installed = new Map<string, Installed>(started.map(({ summary, tile }) => [summary.id, {
    summary: { ...summary }, enabled: true, manifestHash: null, folderHash: null, details: [`permissions: none`, `kind: ${summary.kind}`], permissions: [], engines: [], tile,
  }]));
  /** Ids that a user Gauge may never use. A stock id stays reserved after its Gauge is removed. */
  const stockIds = new Set<string>(started.filter(({ summary }) => summary.origin === 'stock').map(({ summary }) => summary.id));
  /** The nonce of each plan the core issued, with the digest of the plan and the count of applied steps at that time. A nonce is retired when the state changes. */
  const issued = new Map<string, { digest: string; epoch: number; gauge: string | null }>();
  const approvals = new Map<string, Approval>();
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
  /** The bytes of the file found at the start, and the copy set aside when a change leaves safe mode. */
  let layoutFound: Uint8Array = new Uint8Array();
  let layoutKept: Uint8Array | null = null;
  const safeFrom = (refusal: LayoutRefusal): LayoutSafe => (refusal.code === 'GAUGE_PROTECTED' ? { code: 'GAUGE_PROTECTED', reason: refusal.reason } : { code: 'GAUGE_LAYOUT_INVALID', reason: refusal.reason });
  /** Reads a saved file against the Gauges as they are now: the file, or the cause that makes the core start in safe mode. A value that is not text or bytes is not a file. It never throws. */
  const readSaved = (found: unknown): { readonly file: LayoutFile } | { readonly safe: LayoutSafe } => {
    try {
      if (typeof found !== 'string' && !(found instanceof Uint8Array)) return { safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' } };
      const read = parseLayoutFile(found, gaugeTable());
      return read.ok ? { file: read.file } : { safe: safeFrom(read) };
    } catch {
      return { safe: { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' } };
    }
  };
  {
    const found = options.layoutFile;
    if (found === undefined) {
      layoutSaved = newFile(defaultLayout(gaugeTable()));
      layoutDisk = serializeLayoutFile(layoutSaved);
    } else {
      // The core keeps a copy of what it was given, as the bytes of the file, so a backup is never a lossy decode.
      const attempt = ((): { readonly file: LayoutFile } | { readonly safe: LayoutSafe } => {
        try {
          if (typeof found === 'string') {
            layoutFound = new TextEncoder().encode(found);
            layoutDisk = found;
            return readSaved(found);
          }
          if (found instanceof Uint8Array) {
            const copy = Uint8Array.from(found);
            layoutFound = copy;
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

  /**
   * What a lifecycle step does to the layout, for its plan: the layout brought in line with the Gauges as they will be (`after` is the Gauge then, or `null` when it is removed), and the lines
   * that say so. It is `undefined` when the layout does not change, and in safe mode, where the default layout follows the Gauges and nothing is saved.
   */
  function layoutEffect(id: string, after: GaugeInfo | null): { readonly steps: string[] } | undefined {
    if (layoutSaved === null) return undefined;
    const table = gaugeTable();
    if (after === null) table.delete(id);
    else table.set(id, after);
    const steps = layoutChangeSteps(layoutSaved.current, reconcileLayout(layoutSaved.current, table), layoutSaved.revision, droppedRevision(layoutSaved));
    return steps.length === 0 ? undefined : { steps };
  }
  /** Brings the saved layout in line with the Gauges after a lifecycle step, as a normal revision. When the counter is full the layout is replaced in place, since a step must never be refused for it. */
  function reconcileSaved(): void {
    if (layoutSaved === null) return;
    const next = reconcileLayout(layoutSaved.current, gaugeTable());
    if (canonicalText(next) === canonicalText(layoutSaved.current)) return;
    layoutSaved = saveRevision(layoutSaved, next) ?? Object.freeze({ revision: layoutSaved.revision, current: next, revisions: layoutSaved.revisions });
    layoutDisk = serializeLayoutFile(layoutSaved);
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
        ...(layoutEffect(summary.id, { enabled: current.enabled, protected: summary.protected, tile: declared.tile })?.steps ?? []),
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
      enable: [...current.details, `enable ${id0} ${version} (now ${state})`, `add the route of ${id0}`, ...(layoutEffect(summary.id, { enabled: true, protected: summary.protected, tile: current.tile })?.steps ?? [])],
      disable: [...current.details, `disable ${id0} ${version} (now ${state})`, `clear the traces grants of ${id0}, and keep its other grants`, `remove the route of ${id0}`, ...(layoutEffect(summary.id, { enabled: false, protected: summary.protected, tile: current.tile })?.steps ?? [])],
      remove: [...current.details, `remove ${id0} ${version} (now ${state})`, `drop every grant of ${id0}`, `remove the route of ${id0}`, `delete the files of ${id0}`, ...(layoutEffect(summary.id, null)?.steps ?? [])],
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
    const { action, id, folder, from, to, origin, steps, manifestHash, folderHash, nonce } = value as Record<string, unknown>;
    if (typeof action !== 'string' || !(PLAN_ACTIONS as readonly string[]).includes(action) || typeof id !== 'string' || typeof nonce !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(folder) || !nullable(from) || !nullable(to) || !nullable(manifestHash) || !nullable(folderHash) || (origin !== 'stock' && origin !== 'third-party')) return undefined;
    if (!isDenseTexts(steps)) return undefined;
    return { ...sealed({ action: action as PlanAction, id, folder, from, to, origin, steps, manifestHash, folderHash }), nonce };
  }

  /** Finds the approval a caller sent. An unknown, old, or expired approval reads as `undefined`, and an expired or stale one is forgotten. */
  function liveApproval(params: Readonly<Record<string, unknown>>): { readonly token: string; readonly approval: Approval } | undefined {
    const token = params['approval'];
    const approval = typeof token === 'string' ? approvals.get(token) : undefined;
    if (typeof token !== 'string' || !approval) return undefined;
    if (now() - approval.at >= APPROVAL_TTL_MS || approval.epoch !== epoch) {
      approvals.delete(token);
      return undefined;
    }
    return { token, approval };
  }

  /** A plan is applied: retire its nonce and its approvals, and end every approval and every plan of before. The state has changed. */
  function retire(nonce: string, token: string): void {
    for (const [other, record] of approvals) if (record.nonce === nonce) approvals.delete(other);
    issued.delete(nonce);
    approvals.delete(token);
    epoch += 1;
  }

  const sortedHeld = (id: string): (readonly [PermissionName, GrantHashes])[] =>
    [...(grants.get(id)?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  function apply(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { token, approval } = live;
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
    reconcileSaved();
    retire(plan.nonce, token);
    // The grants are gone. Their records come after, on a best effort, so a failure of the audit file never undoes the step.
    if (cleared) recordRevoked(cleared.via, id, cleared.version, cleared.held);
    return { ok: true, result };
  }

  // Grants

  /** Reads a list of permission names: a non-empty list of text with no repeat, sorted. Anything else reads as `undefined`. */
  function readNames(value: unknown): readonly string[] | undefined {
    try {
      if (!Array.isArray(value) || value.length === 0 || value.length > PERMISSION_NAMES.length) return undefined;
      const names: string[] = [];
      for (const item of value as unknown[]) {
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
    const { action, id, version, permissions, steps, manifestHash, folderHash, nonce } = value as Record<string, unknown>;
    if (action !== 'grant' || typeof id !== 'string' || typeof version !== 'string' || typeof nonce !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(manifestHash) || !nullable(folderHash)) return undefined;
    if (!isDenseTexts(permissions) || !isDenseTexts(steps)) return undefined;
    return { ...sealedGrant({ id, version, permissions, steps, manifestHash, folderHash }), nonce };
  }

  function applyGrant(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { token, approval } = live;
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
    retire(plan.nonce, token);
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
   * Plans a change to the layout. Nothing changes. Every check of the change runs here, so the plan the person sees is one that can be applied, with one exception: a counter that is full
   * (`bad_revision`) is found when the plan is applied. A start that broke inside the reader (`internal`) refuses every plan, so nothing overwrites a file that the core could not read.
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
    const baseHash = sha256(canonicalText(base)), nextHash = sha256(canonicalText(next));
    const place = (kind === 'swap' || kind === 'default') && typeof placeParam === 'string' ? placeParam : null;
    const gauge = (kind === 'swap' || kind === 'propose') && typeof gaugeParam === 'string' ? gaugeParam : null;
    const steps = layoutSteps({ kind, place, gauge, revision, base, next, baseHash, nextHash, baseRevision: layoutNumber(), safe: layoutSafe !== null, dropped: layoutSaved === null ? null : droppedRevision(layoutSaved) });
    const content: LayoutContent = { kind, place, gauge, revision, text, steps, baseHash, nextHash };
    return { ok: true, ...content, digest: layoutDigest(content), next, owner };
  }

  /** Reads the layout plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readLayoutPlan(value: unknown): (LayoutContent & { readonly digest: string; readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    // Own properties only: a field that the object inherits reads as missing.
    const field = (key: string): unknown => (Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined);
    const action = field('action'), kind = field('kind'), place = field('place'), gauge = field('gauge'), revision = field('revision'), text = field('text');
    const steps = field('steps'), baseHash = field('baseHash'), nextHash = field('nextHash'), nonce = field('nonce');
    if (action !== 'layout' || !isLayoutKind(kind) || typeof nonce !== 'string' || typeof baseHash !== 'string' || typeof nextHash !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(place) || !nullable(gauge) || !nullable(text) || !(revision === null || (typeof revision === 'number' && Number.isSafeInteger(revision))) || !isDenseTexts(steps)) return undefined;
    const content: LayoutContent = { kind, place, gauge, revision, text, steps: [...steps], baseHash, nextHash };
    return { ...content, digest: layoutDigest(content), nonce };
  }

  function applyLayout(params: Readonly<Record<string, unknown>>): CoreReply {
    const live = liveApproval(params);
    if (!live) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    const { token, approval } = live;
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
    if (layoutSafe !== null) layoutKept = Uint8Array.from(layoutFound);
    layoutSaved = saved;
    layoutSafe = null;
    layoutDisk = serializeLayoutFile(saved);
    retire(plan.nonce, token);
    return { ok: true, result: { kind: fresh.kind, revision: saved.revision, changed } };
  }

  return {
    approve(nonce) {
      const plan = typeof nonce === 'string' ? issued.get(nonce) : undefined;
      // A plan made before the state changed is retired, so a nonce of an old plan is no longer one that the core issued.
      if (plan === undefined || plan.epoch !== epoch) throw new TypeError('an approval is for a nonce that the core issued, for a plan that is still current');
      const token = randomBytes(32).toString('hex');
      approvals.set(token, { nonce, digest: plan.digest, at: now(), epoch });
      return token;
    },
    replaceFolder(folder) {
      folders.set(folder.name, copyFolder(folder));
    },
    auditFile: () => auditLines.join(''),
    layoutFile: () => layoutDisk,
    layoutBackup: () => (layoutKept === null ? null : Uint8Array.from(layoutKept)),
    layoutStartCheck() {
      const read = readSaved(layoutDisk);
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
          const nonce = randomBytes(32).toString('hex');
          issued.set(nonce, { digest: planned.plan.digest, epoch, gauge: null });
          return { ok: true, result: { ...planned.plan, steps: [...planned.plan.steps], nonce } };
        }
        case 'bowerloom.gauges.apply':
          return apply(params);
        case 'bowerloom.grants.plan': {
          const planned = planGrant(params);
          if (!planned.ok) return reply(planned);
          const nonce = randomBytes(32).toString('hex');
          issued.set(nonce, { digest: planned.plan.digest, epoch, gauge: planned.plan.id });
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
          const nonce = randomBytes(32).toString('hex');
          issued.set(nonce, { digest: planned.digest, epoch, gauge: planned.owner });
          const { kind, place, gauge, revision, text, steps, digest, baseHash, nextHash } = planned;
          return { ok: true, result: { action: 'layout', kind, place, gauge, revision, text, steps: [...steps], digest, baseHash, nextHash, nonce } };
        }
        case 'bowerloom.layout.apply':
          return applyLayout(params);
        case 'bowerloom.gauges.routes':
          return { ok: true, result: [...installed.values()].filter(gauge => gauge.enabled).map(({ summary }) => `/gauges/${summary.id}`) };
        default:
          throw new Error(`unknown core method: ${String(method)}`);
      }
    },
  };
}
