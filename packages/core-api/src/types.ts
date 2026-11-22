import type { GaugeCode } from '../../gauge-errors/src/index.js';

/** The wire names of the calls the core offers. Wire identifiers keep the `bowerloom` prefix until the rename. */
export type CoreMethod = 'bowerloom.gauges.list' | 'bowerloom.gauges.get';

/** What the core tells a caller about one Gauge. */
export interface GaugeSummary {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly kind: 'ui' | 'data';
  readonly origin: 'stock' | 'third-party';
  readonly protected: boolean;
}

/** The raw answer of a core: a result, or a refusal with a code. The client checks the code against the registry. */
export type CoreReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string };

/**
 * The seam. The fake core and the real core both have this shape, and a Gauge reaches either one only through a client built on it.
 */
export interface Core {
  call(method: CoreMethod, params: Readonly<Record<string, unknown>>): Promise<CoreReply>;
}

/** What a client call gives back: the value, or a stable code of the registry. */
export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: GaugeCode };
