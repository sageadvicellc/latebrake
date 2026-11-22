import type { GaugeCode } from '../../gauge-errors/src/index.js';
import type { ManifestReason } from '../../gauge-manifest/src/index.js';

/** The wire names of the calls the core offers. Wire identifiers keep the `bowerloom` prefix until the rename. */
export type CoreMethod =
  | 'bowerloom.gauges.list' | 'bowerloom.gauges.get'
  | 'bowerloom.gauges.plan' | 'bowerloom.gauges.apply' | 'bowerloom.gauges.routes';

/** The five steps of a Gauge's life, in one list that the client and the fake core both use. Each goes through a plan and an approval. An update is an install plan of the new version. */
export const PLAN_ACTIONS = Object.freeze(['install', 'enable', 'disable', 'update', 'remove'] as const);
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/**
 * What a step would do, shown to the person before anything changes. `folder` is the folder an install or update reads, and `null` for the other steps.
 * `from` is the installed version and `to` the version after the step, each `null` when there is none. `origin` is set by the core. `digest` is the
 * SHA-256 of the plan, in lower-case hex. An approval is for one digest, so a changed plan needs a new approval.
 *
 * `manifestHash` is the SHA-256 of the bytes of `gauge.json`. `folderHash` is the SHA-256 over every file of the Gauge's folder: the files in order
 * of name, and for each file `<byte length of the name>:<name><size in bytes>:` and then its bytes. Both are in the digest, so an approval is for
 * the Gauge the person saw, and it holds no longer when the manifest or any file changes. A step on a Gauge that is already installed carries the
 * hashes from its install, and a Gauge the core started with has none (`null`). The `steps` also show the permissions, the kind, and what the tile can do.
 * `nonce` is issued by the core for this one plan and is not in the digest. An approval is for a nonce.
 */
export interface GaugePlan {
  readonly action: PlanAction;
  readonly id: string;
  readonly folder: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly origin: 'stock' | 'third-party';
  readonly steps: readonly string[];
  readonly digest: string;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
  readonly nonce: string;
}

/** What an applied plan gives back. `version` is `null` after a removal. */
export interface GaugeApplied {
  readonly action: PlanAction;
  readonly id: string;
  readonly version: string | null;
  readonly enabled: boolean;
}

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
  | { readonly ok: false; readonly code: string; readonly reason?: string };

/**
 * The seam. The fake core and the real core both have this shape, and a Gauge reaches either one only through a client built on it.
 */
export interface Core {
  call(method: CoreMethod, params: Readonly<Record<string, unknown>>): Promise<CoreReply>;
}

/**
 * What a client call gives back: the value, or a stable code of the registry. A refusal of a manifest may also carry a `reason`, a word of the closed set
 * of `packages/gauge-manifest`, which says which rule it broke when several rules share one code. A reason is never a value from the manifest.
 */
export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: GaugeCode; readonly reason?: ManifestReason };
