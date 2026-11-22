import { createHash } from 'node:crypto';
import type { GaugeCode } from '../../gauge-errors/src/index.js';
import { unsafeNameReason, validateManifest } from '../../gauge-manifest/src/index.js';
import { FIXTURE_GAUGES } from './fixtures.js';
import type { Core, CoreReply, GaugeApplied, GaugePlan, GaugeSummary, PlanAction } from './types.js';

/** One Gauge folder that the fake core can find. `location` says where: `bundled` is stock and `user` is third-party. The core sets the origin from it. */
export interface GaugeFolder {
  readonly name: string;
  readonly location: 'bundled' | 'user';
  /** The text or bytes of the folder's `gauge.json`. */
  readonly manifest: string | Uint8Array;
  /** True when the folder is a link. A folder that is a link is refused. */
  readonly isLink?: boolean;
}

export interface FakeCoreOptions {
  /** The folders the core can find. None by default. */
  readonly folders?: readonly GaugeFolder[];
}

/** The fake core is a core, plus the person's approval. In the app a person approves with a click that no Gauge can make, so `approve` is not on the `Core` seam. */
export interface FakeCore extends Core {
  /** The person approves the plan with this digest. Gives back an approval that applies that plan once. */
  approve(digest: string): string;
}

interface Installed {
  summary: GaugeSummary;
  enabled: boolean;
}
type Planned = { readonly ok: true; readonly plan: GaugePlan; readonly summary: GaugeSummary | null } | { readonly ok: false; readonly code: GaugeCode };

const ACTIONS: readonly string[] = ['install', 'enable', 'disable', 'update', 'remove'];
const refuse = (code: GaugeCode): CoreReply => ({ ok: false, code });

const digestOf = (plan: Omit<GaugePlan, 'digest'>): string =>
  createHash('sha256').update(JSON.stringify([plan.action, plan.id, plan.folder, plan.from, plan.to, plan.origin, plan.steps])).digest('hex');
const sealed = (plan: Omit<GaugePlan, 'digest'>): GaugePlan => ({ ...plan, steps: [...plan.steps], digest: digestOf(plan) });

/**
 * A core that answers from fixture data and gives stable refusal codes. A design or a Gauge builds against it before the real core exists.
 * Each reply is a fresh copy, so a caller that changes it changes nothing for the next call.
 *
 * Its Gauges start installed and enabled. A Gauge installs disabled, and only an enabled Gauge has a route, `/gauges/<id>`. Each step goes through
 * a plan and an approval: a plan changes nothing; an approval is for the digest of one plan and works once; applying checks the approval, then that
 * the plan is the approved one, then that the plan would still be the same plan now.
 */
export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const folders = options.folders ?? [];
  const installed = new Map<string, Installed>(FIXTURE_GAUGES.map(gauge => [gauge.id, { summary: { ...gauge }, enabled: true }]));
  const approvals = new Map<string, string>();
  let issued = 0;

  function planInstallOrUpdate(action: 'install' | 'update', folderName: unknown): Planned {
    if (typeof folderName !== 'string') return { ok: false, code: 'UNKNOWN_GAUGE' };
    if (unsafeNameReason(folderName)) return { ok: false, code: 'GAUGE_PATH_UNSAFE' };
    const folder = folders.find(candidate => candidate.name === folderName);
    if (!folder) return { ok: false, code: 'UNKNOWN_GAUGE' };
    if (folder.isLink) return { ok: false, code: 'GAUGE_PATH_UNSAFE' };
    const loaded = validateManifest(folder.manifest);
    if (!loaded.ok) return { ok: false, code: loaded.code };
    const { manifest } = loaded;
    const origin = folder.location === 'bundled' ? 'stock' : 'third-party';
    // A manifest may ask to be protected, but only a stock Gauge may be, so a third-party Gauge can never be one the person cannot remove.
    const summary: GaugeSummary = { id: manifest.id, title: manifest.title, version: manifest.version, kind: manifest.kind, origin, protected: manifest.protected && origin === 'stock' };
    const current = installed.get(manifest.id);
    if (action === 'install') {
      if (current) return { ok: false, code: 'GAUGE_EXISTS' };
      return {
        ok: true, summary,
        plan: sealed({ action, id: summary.id, folder: folder.name, from: null, to: summary.version, origin, steps: [
          `check the manifest of ${summary.id}`, `copy folder ${folder.name} into the Gauge store`, `add ${summary.id} ${summary.version} as ${origin}, disabled`,
        ] }),
      };
    }
    if (!current) return { ok: false, code: 'UNKNOWN_GAUGE' };
    if (current.summary.origin === 'stock' && origin === 'third-party') return { ok: false, code: 'GAUGE_NAME_RESERVED' };
    return {
      ok: true, summary,
      plan: sealed({ action, id: summary.id, folder: folder.name, from: current.summary.version, to: summary.version, origin, steps: [
        `check the manifest of ${summary.id}`, `replace ${summary.id} ${current.summary.version} with ${summary.version} from folder ${folder.name}`, `keep ${summary.id} ${current.enabled ? 'enabled' : 'disabled'}`,
      ] }),
    };
  }

  function planOnInstalled(action: 'enable' | 'disable' | 'remove', id: unknown): Planned {
    const current = typeof id === 'string' ? installed.get(id) : undefined;
    if (!current) return { ok: false, code: 'UNKNOWN_GAUGE' };
    if (action !== 'enable' && current.summary.protected) return { ok: false, code: 'GAUGE_PROTECTED' };
    const { summary } = current, state = current.enabled ? 'enabled' : 'disabled';
    const steps = {
      enable: [`enable ${summary.id} ${summary.version} (now ${state})`, `add the route of ${summary.id}`],
      disable: [`disable ${summary.id} ${summary.version} (now ${state})`, `remove the route of ${summary.id}`],
      remove: [`remove ${summary.id} ${summary.version} (now ${state})`, `remove the route of ${summary.id}`, `delete the files of ${summary.id}`],
    }[action];
    return { ok: true, summary: null, plan: sealed({ action, id: summary.id, folder: null, from: summary.version, to: action === 'remove' ? null : summary.version, origin: summary.origin, steps }) };
  }

  function planFor(action: PlanAction, params: Readonly<Record<string, unknown>>): Planned {
    if (action === 'install' || action === 'update') return planInstallOrUpdate(action, params['folder']);
    return planOnInstalled(action, params['id']);
  }

  /** Reads the plan a caller sends back. Anything that is not a whole plan reads as `undefined`. */
  function readPlan(value: unknown): GaugePlan | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const { action, id, folder, from, to, origin, steps } = record;
    if (typeof action !== 'string' || !ACTIONS.includes(action) || typeof id !== 'string') return undefined;
    const nullable = (field: unknown): field is string | null => field === null || typeof field === 'string';
    if (!nullable(folder) || !nullable(from) || !nullable(to) || (origin !== 'stock' && origin !== 'third-party')) return undefined;
    if (!Array.isArray(steps) || !steps.every((step): step is string => typeof step === 'string')) return undefined;
    return sealed({ action: action as PlanAction, id, folder, from, to, origin, steps });
  }

  function apply(params: Readonly<Record<string, unknown>>): CoreReply {
    const approval = params['approval'];
    const approved = typeof approval === 'string' ? approvals.get(approval) : undefined;
    if (typeof approval !== 'string' || approved === undefined) return refuse('GAUGE_PLAN_NOT_APPROVED');
    const plan = readPlan(params['plan']);
    if (!plan || plan.digest !== approved) return refuse('GAUGE_PLAN_CHANGED');
    // The plan is the approved one. Plan again from the state now: a plan that the state has moved past is refused.
    const fresh = planFor(plan.action, plan.folder === null ? { id: plan.id } : { folder: plan.folder });
    if (!fresh.ok) return refuse(fresh.code);
    if (fresh.plan.digest !== plan.digest) return refuse('GAUGE_PLAN_CHANGED');
    approvals.delete(approval);
    const { id, action } = fresh.plan;
    let result: GaugeApplied;
    switch (action) {
      case 'install':
        installed.set(id, { summary: fresh.summary!, enabled: false });
        result = { action, id, version: fresh.summary!.version, enabled: false };
        break;
      case 'update': {
        const current = installed.get(id)!;
        installed.set(id, { summary: fresh.summary!, enabled: current.enabled });
        result = { action, id, version: fresh.summary!.version, enabled: current.enabled };
        break;
      }
      case 'enable':
      case 'disable': {
        const current = installed.get(id)!;
        current.enabled = action === 'enable';
        result = { action, id, version: current.summary.version, enabled: current.enabled };
        break;
      }
      case 'remove':
        installed.delete(id);
        result = { action, id, version: null, enabled: false };
        break;
    }
    return { ok: true, result };
  }

  return {
    approve(digest) {
      if (typeof digest !== 'string') throw new TypeError('an approval is for the digest of one plan');
      issued += 1;
      const approval = `approval-${issued}`;
      approvals.set(approval, digest);
      return approval;
    },
    async call(method, params): Promise<CoreReply> {
      switch (method) {
        case 'bowerloom.gauges.list':
          return { ok: true, result: [...installed.values()].map(({ summary }) => ({ ...summary })) };
        case 'bowerloom.gauges.get': {
          const found = installed.get(String(params['id']));
          return found ? { ok: true, result: { ...found.summary } } : { ok: false, code: 'UNKNOWN_GAUGE' };
        }
        case 'bowerloom.gauges.plan': {
          const action = params['action'];
          if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new Error(`unknown plan action: ${String(action)}`);
          const planned = planFor(action as PlanAction, params);
          return planned.ok ? { ok: true, result: { ...planned.plan, steps: [...planned.plan.steps] } } : refuse(planned.code);
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
