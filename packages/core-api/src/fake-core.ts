import { createHash, randomBytes } from 'node:crypto';
import type { GaugeCode } from '../../gauge-errors/src/index.js';
import { compareVersions, isUnsafeFolderName, parseVersion, unsafeNameReason, validateManifest, type GaugeManifest, type ManifestReason } from '../../gauge-manifest/src/index.js';
import { FIXTURE_GAUGES } from './fixtures.js';
import { PLAN_ACTIONS, type Core, type CoreReply, type GaugeApplied, type GaugePlan, type GaugeSummary, type PlanAction } from './types.js';

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
}

interface Installed {
  summary: GaugeSummary;
  enabled: boolean;
  manifestHash: string | null;
  folderHash: string | null;
  /** The lines of the plan that say what the Gauge may do: permissions, kind, tile, page. */
  details: readonly string[];
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
type Refusal = { readonly ok: false; readonly code: GaugeCode; readonly reason?: ManifestReason };
/** A plan of install or update comes with the Gauge to add. A plan on an installed Gauge comes with nothing more. */
type Planned = Refusal
  | { readonly ok: true; readonly kind: 'folder'; readonly plan: Sealed; readonly summary: GaugeSummary; readonly details: readonly string[]; readonly hashes: Hashes }
  | { readonly ok: true; readonly kind: 'installed'; readonly plan: Sealed };
interface Approval {
  readonly nonce: string;
  readonly digest: string;
  readonly at: number;
  readonly epoch: number;
}

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

const refuse = (code: GaugeCode, reason?: ManifestReason): Refusal => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
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
 * The fake does not check `dependencies` at install, and a removal is not blocked by a Gauge that depends on it. Both belong to a later ticket.
 */
export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const now = options.now ?? monotonicNow;
  const folders = new Map<string, GaugeFolder>((options.folders ?? []).map(folder => [folder.name, copyFolder(folder)]));
  const installed = new Map<string, Installed>(FIXTURE_GAUGES.map(gauge => [gauge.id, { summary: { ...gauge }, enabled: true, manifestHash: null, folderHash: null, details: [`permissions: none`, `kind: ${gauge.kind}`] }]));
  /** Ids that a user Gauge may never use. A stock id stays reserved after its Gauge is removed. */
  const stockIds = new Set<string>(FIXTURE_GAUGES.filter(gauge => gauge.origin === 'stock').map(gauge => gauge.id));
  /** The nonce of each plan the core issued, with the digest of the plan and the count of applied steps at that time. A nonce is retired when the state changes. */
  const issued = new Map<string, { digest: string; epoch: number }>();
  const approvals = new Map<string, Approval>();
  /** Counts the steps applied. An approval from an earlier count is stale. */
  let epoch = 0;

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
    const content = { id: summary.id, folder: folder.name, origin, manifestHash: hashes.manifestHash, folderHash: hashes.folderHash };
    if (action === 'install') {
      if (current) return refuse('GAUGE_EXISTS');
      return {
        ok: true, kind: 'folder', summary, details, hashes,
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
      ok: true, kind: 'folder', summary, details, hashes,
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

  function apply(params: Readonly<Record<string, unknown>>): CoreReply {
    const token = params['approval'];
    const approval = typeof token === 'string' ? approvals.get(token) : undefined;
    if (typeof token !== 'string' || !approval) return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    if (now() - approval.at >= APPROVAL_TTL_MS || approval.epoch !== epoch) {
      approvals.delete(token);
      return reply(refuse('GAUGE_PLAN_NOT_APPROVED'));
    }
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
      const entry: Installed = { summary: fresh.summary, enabled: false, manifestHash: fresh.hashes.manifestHash, folderHash: fresh.hashes.folderHash, details: fresh.details };
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
        installed.delete(id);
        result = { action, id, version: null, enabled: false };
      } else {
        current.enabled = action === 'enable';
        result = { action, id, version: current.summary.version, enabled: current.enabled };
      }
    }
    // The plan is applied: retire its nonce and its approvals, and end every approval and every plan of before. The state has changed.
    for (const [other, record] of approvals) if (record.nonce === plan.nonce) approvals.delete(other);
    issued.delete(plan.nonce);
    approvals.delete(token);
    epoch += 1;
    return { ok: true, result };
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
        case 'bowerloom.gauges.routes':
          return { ok: true, result: [...installed.values()].filter(gauge => gauge.enabled).map(({ summary }) => `/gauges/${summary.id}`) };
        default:
          throw new Error(`unknown core method: ${String(method)}`);
      }
    },
  };
}
