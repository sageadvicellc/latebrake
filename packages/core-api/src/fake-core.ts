import { createHash, randomBytes } from 'node:crypto';
import type { GaugeCode } from '../../gauge-errors/src/index.js';
import {
  PERMISSION_NAMES, compareVersions, isPermission, isTracesPermission, isUnsafeFolderName, parseVersion, permissionOf, unsafeNameReason, validateManifest,
  type GaugeManifest, type GrantReason, type ManifestReason,
} from '../../gauge-manifest/src/index.js';
import { FIXTURE_GAUGES } from './fixtures.js';
import { DEFAULT_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES, appendAudit, auditLine, grantState, type GrantHashes } from './grants.js';
import { PLAN_ACTIONS, type AuditEntry, type Core, type CoreReply, type GaugeApplied, type GaugePlan, type GaugeSummary, type GrantPlan, type PlanAction } from './types.js';

/**
 * The default clock of the fake core, in milliseconds. It is monotonic: it reads the performance clock, which never steps back, and never the system
 * clock, which a person or a network time service can move. So a system clock that steps back cannot make an approval last longer.
 */
export const monotonicNow = (): number => performance.now();

const UNSAFE_IN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/gu;

/**
 * Makes a value safe to put in a line of a plan. A line break, a control, format, or separator character, and a backslash become a visible escape such as
 * `\u{a}`, so no value can end a line or start a new one, and a person reads what the value really holds.
 */
export const escapeForPlan = (value: string): string => value.replace(UNSAFE_IN_TEXT, char => (char === '\\' ? '\\\\' : `\\u{${char.codePointAt(0)?.toString(16) ?? ''}}`));

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
  /** The size cap of the audit file, in bytes: a whole number of at least 4,096. 64 KiB by default. A smaller or a non-integer cap is refused when the core is made. */
  readonly auditMaxBytes?: number;
  /** The wall clock for the time of an audit record, in milliseconds since 1970. The system clock by default. An audit record is a time, so it is not the monotonic clock. A test passes its own. */
  readonly wall?: () => number;
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
type Refusal = { readonly ok: false; readonly code: GaugeCode; readonly reason?: ManifestReason | GrantReason };
/** A plan of install or update comes with the Gauge to add. A plan on an installed Gauge comes with nothing more. */
type Planned = Refusal
  | { readonly ok: true; readonly kind: 'folder'; readonly plan: Sealed; readonly summary: GaugeSummary; readonly details: readonly string[]; readonly hashes: Hashes; readonly declared: Declared }
  | { readonly ok: true; readonly kind: 'installed'; readonly plan: Sealed };
/** What a manifest declares that a grant depends on. */
interface Declared {
  readonly permissions: readonly string[];
  readonly engines: readonly string[];
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
interface Approval {
  readonly nonce: string;
  readonly digest: string;
  readonly at: number;
  readonly epoch: number;
}

/** The last millisecond of the year 9999, so that a time is always written as four digits of year. */
const MAX_WALL_MS = 253_402_300_799_999;

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

const refuse = (code: GaugeCode, reason?: ManifestReason | GrantReason): Refusal => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
/** A refusal because of a grant: the code `GAUGE_GRANT_MISSING` with a reason of the closed set, or with none when the permission is plainly not granted. */
const deny = (reason?: GrantReason): Refusal => refuse('GAUGE_GRANT_MISSING', reason);
const reply = (refusal: Refusal): CoreReply => (refusal.reason === undefined ? { ok: false, code: refusal.code } : { ok: false, code: refusal.code, reason: refusal.reason });

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
 * is written to an audit file with a size cap before the change it describes.
 *
 * The fake does not check `dependencies` at install, and a removal is not blocked by a Gauge that depends on it. Both belong to a later ticket.
 */
export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const now = options.now ?? monotonicNow;
  const wall = options.wall ?? Date.now;
  const auditMaxBytes = options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  if (!Number.isSafeInteger(auditMaxBytes) || auditMaxBytes < MIN_AUDIT_MAX_BYTES) throw new RangeError(`the audit size cap is a whole number of at least ${MIN_AUDIT_MAX_BYTES} bytes`);
  const folders = new Map<string, GaugeFolder>((options.folders ?? []).map(folder => [folder.name, copyFolder(folder)]));
  const installed = new Map<string, Installed>(FIXTURE_GAUGES.map(gauge => [gauge.id, { summary: { ...gauge }, enabled: true, manifestHash: null, folderHash: null, details: [`permissions: none`, `kind: ${gauge.kind}`], permissions: [], engines: [] }]));
  /** Ids that a user Gauge may never use. A stock id stays reserved after its Gauge is removed. */
  const stockIds = new Set<string>(FIXTURE_GAUGES.filter(gauge => gauge.origin === 'stock').map(gauge => gauge.id));
  /** The nonce of each plan the core issued, with the digest of the plan and the count of applied steps at that time. A nonce is retired when the state changes. */
  const issued = new Map<string, { digest: string; epoch: number }>();
  const approvals = new Map<string, Approval>();
  /** Counts the steps applied. An approval from an earlier count is stale. */
  let epoch = 0;
  /** The grants of each Gauge, by permission. A grant holds the two hashes it is bound to. */
  const grants = new Map<string, Map<string, GrantHashes>>();
  /** The audit file, as its lines, oldest first, and the number of the last record ever written. */
  let auditLines: readonly string[] = [];
  let auditSeq = 0;

  /** The time of an audit record, in ISO form. A clock that gives no usable time stops the step before anything changes. */
  const stamp = (): string => {
    const time: unknown = wall();
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > MAX_WALL_MS) throw new TypeError('the wall clock gave no usable time');
    return new Date(time).toISOString();
  };
  /** Builds the records of one step, numbered after the last one. Nothing is written yet. */
  const auditEntries = (at: string, action: 'grant' | 'revoke', via: AuditEntry['via'], id: string, version: string, held: readonly (readonly [string, GrantHashes])[]): AuditEntry[] =>
    held.map(([permission, hashes], index) => ({ seq: auditSeq + 1 + index, at, action, via, id, version, permission, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash }));
  /** Writes the records of one step to the audit file, ahead of the change they describe, so a grant never takes effect without its record. */
  const writeAudit = (entries: readonly AuditEntry[]): void => {
    let next = auditLines;
    for (const entry of entries) next = appendAudit(next, auditLine(entry), auditMaxBytes);
    auditLines = next;
    auditSeq += entries.length;
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
    if (origin === 'third-party' && isReserved(summary.id)) return refuse('GAUGE_NAME_RESERVED');
    const current = installed.get(summary.id);
    const hashes = hashesOf(folder), details = describe(manifest);
    const declared: Declared = { permissions: [...manifest.permissions], engines: [...manifest.engines] };
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
    if (current.summary.protected && !summary.protected) return refuse('GAUGE_PROTECTED');
    if (compareVersions(parseVersion(summary.version) ?? [0, 0, 0], parseVersion(current.summary.version) ?? [0, 0, 0]) <= 0) return refuse('GAUGE_VERSION_NOT_NEWER');
    return {
      ok: true, kind: 'folder', summary, details, hashes, declared,
      plan: sealed({ ...content, action, from: current.summary.version, to: summary.version, steps: [
        `check the manifest of ${escapeForPlan(summary.id)}`, ...details, `replace ${escapeForPlan(summary.id)} ${escapeForPlan(current.summary.version)} with ${escapeForPlan(summary.version)} from folder ${escapeForPlan(folder.name)}`, `keep ${escapeForPlan(summary.id)} ${current.enabled ? 'enabled' : 'disabled'}`,
      ] }),
    };
  }

  function planOnInstalled(action: 'enable' | 'disable' | 'remove', id: unknown): Planned {
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (!current) return refuse('UNKNOWN_GAUGE');
    if (action !== 'enable' && current.summary.protected) return refuse('GAUGE_PROTECTED');
    const { summary } = current, state = current.enabled ? 'enabled' : 'disabled';
    const id0 = escapeForPlan(summary.id), version = escapeForPlan(summary.version);
    const steps = {
      enable: [...current.details, `enable ${id0} ${version} (now ${state})`, `add the route of ${id0}`],
      disable: [...current.details, `disable ${id0} ${version} (now ${state})`, `remove the route of ${id0}`],
      remove: [...current.details, `remove ${id0} ${version} (now ${state})`, `remove the route of ${id0}`, `delete the files of ${id0}`],
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
    if (!Array.isArray(steps) || !steps.every((step): step is string => typeof step === 'string')) return undefined;
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

  const sortedHeld = (id: string): (readonly [string, GrantHashes])[] =>
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
    if (fresh.kind === 'folder') {
      const entry: Installed = {
        summary: fresh.summary, enabled: false, manifestHash: fresh.hashes.manifestHash, folderHash: fresh.hashes.folderHash, details: fresh.details,
        permissions: fresh.declared.permissions, engines: fresh.declared.engines,
      };
      if (action === 'update') {
        if (!current) return reply(refuse('UNKNOWN_GAUGE'));
        entry.enabled = current.enabled;
      }
      installed.set(id, entry);
      if (fresh.summary.origin === 'stock') stockIds.add(id);
      result = { action, id, version: entry.summary.version, enabled: entry.enabled };
    } else {
      if (!current) return reply(refuse('UNKNOWN_GAUGE'));
      if (action === 'remove') {
        // A removed Gauge keeps no grant. The records are written first, and the clock is read first, so a clock that fails stops the removal before anything changes.
        const held = sortedHeld(id);
        if (held.length > 0) writeAudit(auditEntries(stamp(), 'revoke', 'remove', id, current.summary.version, held));
        grants.delete(id);
        installed.delete(id);
        result = { action, id, version: null, enabled: false };
      } else {
        current.enabled = action === 'enable';
        result = { action, id, version: current.summary.version, enabled: current.enabled };
      }
    }
    retire(plan.nonce, token);
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
    const lines = names.map(name => {
      const entry = permissionOf(name);
      return `permission ${escapeForPlan(name)} (${entry?.kind ?? 'read'}): ${escapeForPlan(entry?.meaning ?? '')}`;
    });
    const engines = current.engines.length > 0 ? current.engines.map(escapeForPlan).join(', ') : 'none';
    const steps = [
      `grant ${names.length} permission${names.length === 1 ? '' : 's'} to ${escapeForPlan(id)} ${escapeForPlan(current.summary.version)}`,
      ...lines,
      `engines: ${engines}`,
      ...(traces > 0 ? ['traces permissions start denied, are granted only here, and one revoke removes them all'] : []),
      `bind the grant to manifest ${escapeForPlan(current.manifestHash ?? 'none')} and folder ${escapeForPlan(current.folderHash ?? 'none')}`,
    ];
    return { ok: true, plan: sealedGrant({ id, version: current.summary.version, permissions: names, steps, manifestHash: current.manifestHash, folderHash: current.folderHash }) };
  }

  /** Reads the grant plan a caller sends back. Anything that is not a whole plan reads as `undefined`. The digest is computed here, and the one the caller sent is ignored. */
  function readGrantPlan(value: unknown): (SealedGrant & { readonly nonce: string }) | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { action, id, version, permissions, steps, manifestHash, folderHash, nonce } = value as Record<string, unknown>;
    if (action !== 'grant' || typeof id !== 'string' || typeof version !== 'string' || typeof nonce !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(manifestHash) || !nullable(folderHash)) return undefined;
    const isTexts = (field: unknown): field is string[] => Array.isArray(field) && field.every((item): item is string => typeof item === 'string');
    if (!isTexts(permissions) || !isTexts(steps)) return undefined;
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
    // The records are written first, and the clock is read first, so a clock that fails stops the grant before anything changes.
    writeAudit(auditEntries(stamp(), 'grant', 'plan', plan.id, fresh.plan.version, fresh.plan.permissions.map((name): readonly [string, GrantHashes] => [name, hashes])));
    const held = grants.get(plan.id) ?? new Map<string, GrantHashes>();
    for (const name of fresh.plan.permissions) held.set(name, hashes);
    grants.set(plan.id, held);
    retire(plan.nonce, token);
    return { ok: true, result: { id: plan.id, permissions: [...fresh.plan.permissions] } };
  }

  /** A revoke is one action with no plan: it only narrows what a Gauge may do, so the person never waits for it. It works on a stale grant and on a disabled Gauge. */
  function revoke(params: Readonly<Record<string, unknown>>): CoreReply {
    const id = params['id'];
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (typeof id !== 'string' || !current) return reply(refuse('UNKNOWN_GAUGE'));
    const held = grants.get(id);
    const group = params['group'], list = params['permissions'];
    let names: readonly string[];
    if (group !== undefined) {
      if (list !== undefined || group !== 'traces') return reply(deny('invalid_request'));
      names = [...(held?.keys() ?? [])].filter(isTracesPermission).sort();
      if (names.length === 0) return reply(deny('not_held'));
    } else {
      const read = readNames(list);
      if (!read) return reply(deny('invalid_request'));
      if (!read.every(isPermission)) return reply(deny('unknown_permission'));
      if (!read.every(name => held?.has(name) === true)) return reply(deny('not_held'));
      names = read;
    }
    const records = names.map((name): readonly [string, GrantHashes] => [name, held?.get(name) ?? { manifestHash: null, folderHash: null }]);
    writeAudit(auditEntries(stamp(), 'revoke', 'revoke', id, current.summary.version, records));
    for (const name of names) held?.delete(name);
    if (held?.size === 0) grants.delete(id);
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
    const held = grants.get(gaugeId)?.get(entry.name);
    if (!held) return refuse('GAUGE_GRANT_MISSING');
    if (grantState(held, current) === 'stale') return refuse('GAUGE_GRANT_STALE');
    return { ok: true, gauge: gaugeId, permission: entry.name, engine: engineName };
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
          issued.set(nonce, { digest: planned.plan.digest, epoch });
          return { ok: true, result: { ...planned.plan, steps: [...planned.plan.steps], nonce } };
        }
        case 'bowerloom.gauges.apply':
          return apply(params);
        case 'bowerloom.grants.plan': {
          const planned = planGrant(params);
          if (!planned.ok) return reply(planned);
          const nonce = randomBytes(32).toString('hex');
          issued.set(nonce, { digest: planned.plan.digest, epoch });
          const result: GrantPlan = { action: 'grant', ...planned.plan, permissions: [...planned.plan.permissions], steps: [...planned.plan.steps], nonce };
          return { ok: true, result };
        }
        case 'bowerloom.grants.apply':
          return applyGrant(params);
        case 'bowerloom.grants.revoke':
          return revoke(params);
        case 'bowerloom.grants.list': {
          const id = params['id'];
          const current = typeof id === 'string' ? installed.get(id) : undefined;
          if (typeof id !== 'string' || !current) return { ok: false, code: 'UNKNOWN_GAUGE' };
          return { ok: true, result: sortedHeld(id).map(([permission, hashes]) => ({ permission, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash, current: grantState(hashes, current) === 'current' })) };
        }
        case 'bowerloom.permissions.check': {
          const checked = enforce(params['gauge'], params['permission'], params['engine']);
          if (!checked.ok) return reply(checked);
          return { ok: true, result: { gauge: checked.gauge, permission: checked.permission, engine: checked.engine } };
        }
        case 'bowerloom.audit.read':
          return { ok: true, result: auditLines.map((line): unknown => JSON.parse(line)) };
        case 'bowerloom.gauges.routes':
          return { ok: true, result: [...installed.values()].filter(gauge => gauge.enabled).map(({ summary }) => `/gauges/${summary.id}`) };
        default:
          throw new Error(`unknown core method: ${String(method)}`);
      }
    },
  };
}
