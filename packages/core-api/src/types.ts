import type { GaugeCode } from '../../gauge-errors/src/index.js';
import type { GrantReason, ManifestReason } from '../../gauge-manifest/src/index.js';

/** The wire names of the calls the core offers. Wire identifiers keep the `bowerloom` prefix until the rename. */
export type CoreMethod =
  | 'bowerloom.gauges.list' | 'bowerloom.gauges.get'
  | 'bowerloom.gauges.plan' | 'bowerloom.gauges.apply' | 'bowerloom.gauges.routes'
  | 'bowerloom.grants.plan' | 'bowerloom.grants.apply' | 'bowerloom.grants.revoke' | 'bowerloom.grants.list'
  | 'bowerloom.permissions.check' | 'bowerloom.audit.read';

/** The five steps of a Gauge's life, in one list that the client and the fake core both use. Each goes through a plan and an approval. An update is an install plan of the new version. */
export const PLAN_ACTIONS = Object.freeze(['install', 'enable', 'disable', 'update', 'remove'] as const);
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/**
 * What a step would do, shown to the person before anything changes. `folder` is the folder an install or update reads, and `null` for the other steps.
 * `from` is the installed version and `to` the version after the step, each `null` when there is none. `origin` is set by the core. `digest` is the
 * SHA-256 of the plan, in lower-case hex. An approval is for one digest, so a changed plan needs a new approval.
 *
 * `manifestHash` is the SHA-256 of the bytes of `gauge.json`. `folderHash` is the SHA-256 over the files of the Gauge's folder: the file names sorted by their UTF-8
 * bytes, and for each file `<byte length of the name>:<name><size in bytes>:` and then its bytes, with the manifest as `gauge.json`. It covers files only. It does not
 * model empty folders, file modes, or links inside the folder. Both hashes are in the digest, so an approval is for the Gauge the person saw, and it holds no longer
 * when the manifest or any file changes. A step on a Gauge that is already installed carries the hashes from its install, and a Gauge the core started with has
 * none (`null`). The `steps` also show the permissions, the kind, and what the tile can do. A value in a step never holds a line break: the core escapes it.
 *
 * `nonce` is issued by the core for this one plan and is not in the digest. It is exactly 64 lowercase hexadecimal characters, and the client refuses any other
 * form. This is part of the seam contract, so a real core must issue nonces of that form. An approval is for a nonce, and a plan is retired when the state changes.
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

/**
 * What a grant would do, shown to the person before anything changes. `permissions` are the names to grant, once each, sorted. `version`, `manifestHash`, and
 * `folderHash` are those of the installed Gauge (the hashes come from the install plan, and are `null` for a Gauge that the core started with). A grant binds to
 * both hashes, so it holds no longer when the manifest or any file of the folder changes. `digest` is the SHA-256 of the plan, in lower-case hex, and `nonce` is
 * issued by the core for this one plan and is not in the digest. A nonce is exactly 64 lowercase hexadecimal characters. A Gauge never makes an approval.
 */
export interface GrantPlan {
  readonly action: 'grant';
  readonly id: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly steps: readonly string[];
  readonly digest: string;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
  readonly nonce: string;
}

/** What an applied grant gives back: the Gauge and the permissions that are now granted, sorted. */
export interface GrantApplied {
  readonly id: string;
  readonly permissions: readonly string[];
}

/** What a revoke gives back: the Gauge and the permissions that were revoked, sorted. */
export interface GrantRevoked {
  readonly id: string;
  readonly revoked: readonly string[];
}

/** One grant a Gauge holds. `current` is false when the grant belongs to an earlier manifest or folder, so the person must grant again. */
export interface GrantEntry {
  readonly permission: string;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
  readonly current: boolean;
}

/** What a permission check gives back when the call is allowed. `engine` is `null` for a permission that touches no engine. */
export interface PermissionCheck {
  readonly gauge: string;
  readonly permission: string;
  readonly engine: string | null;
}

/**
 * One record of the audit file: a grant or a revoke of one permission. `seq` starts at 1 and counts every record ever written, so it is never reused,
 * also after the oldest records were dropped to keep the file under its cap. `at` is an ISO 8601 time in UTC with milliseconds. `via` says how: `plan` is an
 * approved grant plan, `revoke` is a revoke call, and `remove` is the removal of the Gauge. The hashes are those the grant is bound to.
 */
export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly action: 'grant' | 'revoke';
  readonly via: 'plan' | 'revoke' | 'remove';
  readonly id: string;
  readonly version: string | null;
  readonly permission: string;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
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
 * What a client call gives back: the value, or a stable code of the registry. A refusal may also carry a `reason`, a word of a closed set of `packages/gauge-manifest`,
 * which says which rule it broke when several rules share one code. The manifest reasons go with the manifest and path codes. The grant reasons go with
 * `GAUGE_GRANT_MISSING` only. A reason is never a value that a caller or a manifest sent.
 */
export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: GaugeCode; readonly reason?: ManifestReason | GrantReason };
