import { isGaugeCode } from '../../gauge-errors/src/index.js';
import type { Core, CoreMethod, CoreResult, GaugeSummary } from './types.js';

/** The core broke the contract: it sent a code outside the registry, or a result of the wrong shape. This is a bug, not a refusal. */
export class CoreProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreProtocolError';
  }
}

/** The one door from a Gauge to the core. */
export interface CoreClient {
  /** Lists the Gauges the core holds. */
  listGauges(): Promise<CoreResult<readonly GaugeSummary[]>>;
  /** Reads one Gauge. Refuses with `UNKNOWN_GAUGE` when no Gauge has the id. */
  getGauge(id: string): Promise<CoreResult<GaugeSummary>>;
}

/** Builds the client on a core: the fake core now, the real core later. */
export function createCoreClient(core: Core): CoreClient {
  async function ask<T>(method: CoreMethod, params: Record<string, unknown>, shaped: (result: unknown) => result is T): Promise<CoreResult<T>> {
    const reply = await core.call(method, params);
    if (!reply.ok) {
      if (!isGaugeCode(reply.code)) throw new CoreProtocolError(`${method} refused with a code outside the registry: ${reply.code}`);
      return { ok: false, code: reply.code };
    }
    if (!shaped(reply.result)) throw new CoreProtocolError(`${method} gave a result of the wrong shape`);
    return { ok: true, value: reply.result };
  }
  const isList = (result: unknown): result is readonly GaugeSummary[] => Array.isArray(result);
  const isObject = (result: unknown): result is GaugeSummary => typeof result === 'object' && result !== null && !Array.isArray(result);
  return {
    listGauges: () => ask('bowerloom.gauges.list', {}, isList),
    getGauge: id => ask('bowerloom.gauges.get', { id }, isObject),
  };
}
