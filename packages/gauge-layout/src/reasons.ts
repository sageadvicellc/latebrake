/**
 * Why a layout was refused, as closed sets. The code says what class of refusal it is, and the reason says which rule. A reason never holds a value that a caller sent.
 *
 * `LAYOUT_REASONS` go with `GAUGE_LAYOUT_INVALID`. `PROTECTED_REASONS` go with `GAUGE_PROTECTED`, the code that the lifecycle already uses to refuse the removal of a protected Gauge.
 */
export const LAYOUT_REASONS = Object.freeze([
  // The text.
  'not_utf8', 'too_large', 'syntax', 'duplicate_key', 'comment', 'trailing_comma',
  // The shape.
  'unknown_field', 'missing_field', 'invalid_field', 'unsupported_format', 'unsupported_grid', 'unknown_size', 'too_many_tiles', 'too_many_listed', 'not_canonical',
  // The grid and uniqueness.
  'duplicate_place', 'duplicate_gauge', 'out_of_grid', 'overlap',
  // The Gauges.
  'unknown_gauge', 'gauge_disabled', 'no_tile', 'size_not_allowed', 'not_resizable',
  // A change to the layout.
  'unknown_place', 'no_room', 'invalid_request', 'unknown_revision',
  // The file.
  'too_many_revisions', 'bad_revision',
  'internal',
] as const);
export type LayoutReason = (typeof LAYOUT_REASONS)[number];

/** `hidden`: a protected Gauge or Settings is on the hidden list. `removed`: it is nowhere in the layout. `replaced`: another Gauge fills the place of a protected one. */
export const PROTECTED_REASONS = Object.freeze(['hidden', 'removed', 'replaced'] as const);
export type ProtectedReason = (typeof PROTECTED_REASONS)[number];

const LAYOUT_SET: ReadonlySet<string> = new Set(LAYOUT_REASONS);
const PROTECTED_SET: ReadonlySet<string> = new Set(PROTECTED_REASONS);

/** True when the value is one of the layout reasons. */
export const isLayoutReason = (value: unknown): value is LayoutReason => typeof value === 'string' && LAYOUT_SET.has(value);
/** True when the value is one of the protected reasons. */
export const isProtectedReason = (value: unknown): value is ProtectedReason => typeof value === 'string' && PROTECTED_SET.has(value);

/** A refusal of a layout or of a change to it. */
export type LayoutRefusal =
  | { readonly ok: false; readonly code: 'GAUGE_LAYOUT_INVALID'; readonly reason: LayoutReason }
  | { readonly ok: false; readonly code: 'GAUGE_PROTECTED'; readonly reason: ProtectedReason };

/** A change named a Gauge that the core does not hold. */
export interface UnknownGaugeRefusal {
  readonly ok: false;
  readonly code: 'UNKNOWN_GAUGE';
  readonly reason?: undefined;
}

export const invalid = (reason: LayoutReason): LayoutRefusal => ({ ok: false, code: 'GAUGE_LAYOUT_INVALID', reason });
export const protectedRefusal = (reason: ProtectedReason): LayoutRefusal => ({ ok: false, code: 'GAUGE_PROTECTED', reason });
export const unknownGauge = (): UnknownGaugeRefusal => ({ ok: false, code: 'UNKNOWN_GAUGE' });
