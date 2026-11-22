import { FIXTURE_GAUGES } from './fixtures.js';
import type { Core, CoreReply } from './types.js';

/**
 * A core that answers from fixture data and gives stable refusal codes. A design or a Gauge builds against it before the real core exists.
 * Each reply is a fresh copy, so a caller that changes it changes nothing for the next call.
 */
export function createFakeCore(): Core {
  return {
    async call(method, params): Promise<CoreReply> {
      switch (method) {
        case 'bowerloom.gauges.list':
          return { ok: true, result: FIXTURE_GAUGES.map(gauge => ({ ...gauge })) };
        case 'bowerloom.gauges.get': {
          const found = FIXTURE_GAUGES.find(gauge => gauge.id === params['id']);
          return found ? { ok: true, result: { ...found } } : { ok: false, code: 'UNKNOWN_GAUGE' };
        }
        default:
          throw new Error(`unknown core method: ${String(method)}`);
      }
    },
  };
}
