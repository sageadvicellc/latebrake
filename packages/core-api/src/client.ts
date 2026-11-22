import { isGaugeCode, type GaugeCode } from '../../gauge-errors/src/index.js';
import type { Core, CoreMethod, CoreResult, GaugeApplied, GaugePlan, GaugeSummary, PlanAction } from './types.js';

/** The core broke the contract: a reply of the wrong shape, or a code outside the registry. This is a bug, not a refusal. It names the method that failed. */
export class CoreProtocolError extends Error {
  readonly method: CoreMethod;
  constructor(method: CoreMethod, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CoreProtocolError';
    this.method = method;
  }
}

/** The one door from a Gauge to the core. */
export interface CoreClient {
  /** Lists the Gauges the core holds. */
  listGauges(): Promise<CoreResult<readonly GaugeSummary[]>>;
  /** Reads one Gauge. Refuses with `UNKNOWN_GAUGE` when no Gauge has the id. */
  getGauge(id: string): Promise<CoreResult<GaugeSummary>>;
  /** Plans the install of the Gauge in a folder the core found. Nothing changes until the plan is applied with an approval. */
  planInstall(folder: string): Promise<CoreResult<GaugePlan>>;
  /** Plans the update of an installed Gauge from a folder that holds a new version of it. */
  planUpdate(folder: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to enable an installed Gauge. */
  planEnable(id: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to disable an installed Gauge. */
  planDisable(id: string): Promise<CoreResult<GaugePlan>>;
  /** Plans to remove an installed Gauge. */
  planRemove(id: string): Promise<CoreResult<GaugePlan>>;
  /**
   * Applies a plan. The core applies it only when `approval` is the person's approval of this exact plan. A Gauge never makes an approval: the person
   * does, in the app. Without one the core refuses with `GAUGE_PLAN_NOT_APPROVED`, and with a changed plan with `GAUGE_PLAN_CHANGED`.
   */
  applyPlan(plan: GaugePlan, approval?: string): Promise<CoreResult<GaugeApplied>>;
  /** Lists the routes of the enabled Gauges. A disabled or removed Gauge has none. */
  listRoutes(): Promise<CoreResult<readonly string[]>>;
}

const SHOWN_LENGTH = 64;
/** One piece of JSON text that a cut must not split: a unicode escape, any other escape, or one character (a surrogate pair counts as one). */
const PIECE = /\\u[0-9a-fA-F]{4}|\\[\s\S]|[\s\S]/gu;

/** Prints any value on one line and never throws. It stringifies first, then cuts once to 64 characters between two pieces, so an escape is never cut in half. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? `<${typeof value}>`;
  } catch {
    return `<unprintable ${typeof value}>`;
  }
  if (text.length <= SHOWN_LENGTH) return text;
  let kept = '';
  for (const [piece] of text.matchAll(PIECE)) {
    if (kept.length + piece.length > SHOWN_LENGTH) break;
    kept += piece;
  }
  return `${kept}...`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads one own property, once. A property that is only inherited reads as missing. */
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * Builds a Gauge summary from a value, or gives back `undefined` when it is not one. Each of the six fields is read once, from the value's own
 * properties, and checked. The result is a new frozen object made from those six values, so a field beyond them is dropped.
 */
function summaryOf(value: unknown): GaugeSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = own(value, 'id'), title = own(value, 'title'), version = own(value, 'version');
  const kind = own(value, 'kind'), origin = own(value, 'origin'), isProtected = own(value, 'protected');
  if (typeof id !== 'string' || typeof title !== 'string' || typeof version !== 'string') return undefined;
  if (kind !== 'ui' && kind !== 'data') return undefined;
  if (origin !== 'stock' && origin !== 'third-party') return undefined;
  if (typeof isProtected !== 'boolean') return undefined;
  return Object.freeze({ id, title, version, kind, origin, protected: isProtected });
}

const ACTIONS: readonly string[] = ['install', 'enable', 'disable', 'update', 'remove'];
const DIGEST = /^[0-9a-f]{64}$/;
const nullableText = (value: unknown): string | null | undefined => (value === null || typeof value === 'string' ? value : undefined);

/** Builds a plan from a value, or gives back `undefined` when it is not one. Each of the eight fields is read once, from own properties. */
function planOf(value: unknown): GaugePlan | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), id = own(value, 'id'), folder = nullableText(own(value, 'folder')), from = nullableText(own(value, 'from')), to = nullableText(own(value, 'to'));
  const origin = own(value, 'origin'), steps = own(value, 'steps'), digest = own(value, 'digest');
  if (typeof action !== 'string' || !ACTIONS.includes(action) || typeof id !== 'string' || id === '') return undefined;
  if (folder === undefined || from === undefined || to === undefined) return undefined;
  if (origin !== 'stock' && origin !== 'third-party') return undefined;
  if (!Array.isArray(steps) || !steps.every((step): step is string => typeof step === 'string')) return undefined;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return undefined;
  return Object.freeze({ action: action as PlanAction, id, folder, from, to, origin, steps: Object.freeze([...steps]), digest });
}

/** Builds the result of an applied plan from a value, or gives back `undefined` when it is not one. */
function appliedOf(value: unknown): GaugeApplied | undefined {
  if (!isRecord(value)) return undefined;
  const action = own(value, 'action'), id = own(value, 'id'), version = nullableText(own(value, 'version')), enabled = own(value, 'enabled');
  if (typeof action !== 'string' || !ACTIONS.includes(action) || typeof id !== 'string' || version === undefined || typeof enabled !== 'boolean') return undefined;
  return Object.freeze({ action: action as PlanAction, id, version, enabled });
}

/** Builds the client on a core: the fake core now, the real core later. */
export function createCoreClient(core: Core): CoreClient {
  /** Calls the core, then reads the reply. A throw from the call itself reaches the caller unchanged. A throw while reading the reply is a protocol error. */
  async function ask<T>(method: CoreMethod, params: Record<string, unknown>, read: (method: CoreMethod, result: unknown) => T): Promise<CoreResult<T>> {
    const reply: unknown = await core.call(method, params);
    try {
      if (!isRecord(reply)) throw new CoreProtocolError(method, `reply is not an object: ${shown(reply)}`);
      const ok = own(reply, 'ok');
      if (ok === false) return { ok: false, code: refusal(method, own(reply, 'code')) };
      if (ok !== true) throw new CoreProtocolError(method, 'reply has no boolean ok');
      return { ok: true, value: read(method, own(reply, 'result')) };
    } catch (error) {
      if (error instanceof CoreProtocolError) throw error;
      throw new CoreProtocolError(method, `reply could not be read: ${shown(error instanceof Error ? error.message : error)}`);
    }
  }
  function refusal(method: CoreMethod, code: unknown): GaugeCode {
    if (typeof code !== 'string') throw new CoreProtocolError(method, `refusal code is not a string: ${shown(code)}`);
    if (!isGaugeCode(code)) throw new CoreProtocolError(method, `refusal code is outside the registry: ${shown(code)}`);
    return code;
  }
  function gaugeList(method: CoreMethod, result: unknown): readonly GaugeSummary[] {
    if (!Array.isArray(result)) throw new CoreProtocolError(method, 'result is not a list');
    const gauges: GaugeSummary[] = [];
    for (let index = 0; index < result.length; index += 1) {
      const gauge = summaryOf(result[index]);
      if (!gauge) throw new CoreProtocolError(method, `result element ${index} is not a Gauge summary`);
      gauges.push(gauge);
    }
    return Object.freeze(gauges);
  }
  const planning = (action: PlanAction, target: { id: string } | { folder: string }) => ask('bowerloom.gauges.plan', { action, ...target }, (method, result) => {
    const plan = planOf(result);
    if (!plan) throw new CoreProtocolError(method, 'result is not a Gauge plan');
    if (plan.action !== action) throw new CoreProtocolError(method, `result is a plan for another step: ${shown(plan.action)}`);
    if ('folder' in target ? plan.folder !== target.folder : plan.folder !== null || plan.id !== target.id) throw new CoreProtocolError(method, 'result is a plan for another target');
    return plan;
  });
  return {
    listGauges: () => ask('bowerloom.gauges.list', {}, gaugeList),
    getGauge: id => ask('bowerloom.gauges.get', { id }, (method, result) => {
      const gauge = summaryOf(result);
      if (!gauge) throw new CoreProtocolError(method, 'result is not a Gauge summary');
      if (gauge.id !== id) throw new CoreProtocolError(method, `result is for another Gauge: ${shown(gauge.id)}`);
      return gauge;
    }),
    planInstall: folder => planning('install', { folder }),
    planUpdate: folder => planning('update', { folder }),
    planEnable: id => planning('enable', { id }),
    planDisable: id => planning('disable', { id }),
    planRemove: id => planning('remove', { id }),
    applyPlan: (plan, approval) => ask('bowerloom.gauges.apply', { plan: { ...plan, steps: [...plan.steps] }, ...(approval === undefined ? {} : { approval }) }, (method, result) => {
      const applied = appliedOf(result);
      if (!applied) throw new CoreProtocolError(method, 'result is not an applied plan');
      if (applied.action !== plan.action || applied.id !== plan.id) throw new CoreProtocolError(method, 'result is for another plan');
      return applied;
    }),
    listRoutes: () => ask('bowerloom.gauges.routes', {}, (method, result) => {
      if (!Array.isArray(result) || !result.every((route): route is string => typeof route === 'string')) throw new CoreProtocolError(method, 'result is not a list of routes');
      return Object.freeze([...result]);
    }),
  };
}
