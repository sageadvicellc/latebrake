import { isGaugeCode, type GaugeCode } from '../../gauge-errors/src/index.js';
import type { Core, CoreMethod, CoreResult, GaugeSummary } from './types.js';

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
}

const KINDS: readonly unknown[] = ['ui', 'data'];
const ORIGINS: readonly unknown[] = ['stock', 'third-party'];
const SHOWN_LENGTH = 64;

/** Prints any value on one line, at most 64 characters of it, and never throws. A string is quoted, so line breaks show escaped. */
function shown(value: unknown): string {
  try {
    const text = typeof value === 'string' ? JSON.stringify(value.slice(0, SHOWN_LENGTH)) : JSON.stringify(value);
    return (text ?? `<${typeof value}>`).slice(0, SHOWN_LENGTH + 2);
  } catch {
    return `<unprintable ${typeof value}>`;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when the value is a Gauge summary: every field present, each of the right type. A field beyond these is allowed and passes through. */
function isGaugeSummary(value: unknown): value is GaugeSummary {
  return isRecord(value)
    && typeof value['id'] === 'string' && typeof value['title'] === 'string' && typeof value['version'] === 'string'
    && KINDS.includes(value['kind']) && ORIGINS.includes(value['origin']) && typeof value['protected'] === 'boolean';
}

/** Builds the client on a core: the fake core now, the real core later. */
export function createCoreClient(core: Core): CoreClient {
  async function ask(method: CoreMethod, params: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; code: GaugeCode }> {
    const reply: unknown = await core.call(method, params);
    if (!isRecord(reply)) throw new CoreProtocolError(method, `reply is not an object: ${shown(reply)}`);
    if (reply['ok'] === false) return { ok: false, code: refusal(method, reply['code']) };
    if (reply['ok'] !== true) throw new CoreProtocolError(method, 'reply has no boolean ok');
    return { ok: true, result: reply['result'] };
  }
  function refusal(method: CoreMethod, code: unknown): GaugeCode {
    if (typeof code !== 'string') throw new CoreProtocolError(method, `refusal code is not a string: ${shown(code)}`);
    if (!isGaugeCode(code)) throw new CoreProtocolError(method, `refusal code is outside the registry: ${shown(code)}`);
    return code;
  }
  return {
    async listGauges() {
      const method = 'bowerloom.gauges.list';
      const answer = await ask(method, {});
      if (!answer.ok) return answer;
      if (!Array.isArray(answer.result)) throw new CoreProtocolError(method, 'result is not a list');
      const bad = answer.result.findIndex(element => !isGaugeSummary(element));
      if (bad !== -1) throw new CoreProtocolError(method, `result element ${bad} is not a Gauge summary`);
      return { ok: true, value: answer.result as GaugeSummary[] };
    },
    async getGauge(id) {
      const method = 'bowerloom.gauges.get';
      const answer = await ask(method, { id });
      if (!answer.ok) return answer;
      if (!isGaugeSummary(answer.result)) throw new CoreProtocolError(method, 'result is not a Gauge summary');
      if (answer.result.id !== id) throw new CoreProtocolError(method, `result is for another Gauge: ${shown(answer.result.id)}`);
      return { ok: true, value: answer.result };
    },
  };
}
