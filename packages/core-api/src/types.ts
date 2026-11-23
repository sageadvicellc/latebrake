import type { GaugeCode } from '../../gauge-errors/src/index.js';
import type { AuditReason, GrantReason, ManifestReason, PermissionName } from '../../gauge-manifest/src/index.js';
import type { Layout, LayoutReason, LayoutRevision, ProtectedReason } from '../../gauge-layout/src/index.js';
import type { ModelChoice, RequestReason } from '../../engine-sessions/src/request.js';
import type { SessionFailure } from '../../engine-sessions/src/session.js';
import type { SessionState } from '../../engine-sessions/src/states.js';
import type { Billing, NotFoundReason, StartFailedReason } from '../../engine-sessions/src/vocab.js';
import type { JobReason, JobSession, NotInteractiveReason } from '../../jobs/src/definition.js';
import type { RunSessionPlan, RunSessionState } from '../../jobs/src/runs.js';

/** The wire names of the calls the core offers. Wire identifiers keep the `bowerloom` prefix until the rename. */
export type CoreMethod =
  | 'bowerloom.gauges.list' | 'bowerloom.gauges.get'
  | 'bowerloom.gauges.plan' | 'bowerloom.gauges.apply' | 'bowerloom.gauges.routes'
  | 'bowerloom.grants.plan' | 'bowerloom.grants.apply' | 'bowerloom.grants.revoke' | 'bowerloom.grants.list'
  | 'bowerloom.permissions.check' | 'bowerloom.audit.read'
  | 'bowerloom.layout.read' | 'bowerloom.layout.revisions' | 'bowerloom.layout.export' | 'bowerloom.layout.plan' | 'bowerloom.layout.apply'
  | 'bowerloom.sessions.list' | 'bowerloom.sessions.get' | 'bowerloom.sessions.plan' | 'bowerloom.sessions.apply'
  | 'bowerloom.jobs.list' | 'bowerloom.jobs.get' | 'bowerloom.jobs.plan' | 'bowerloom.jobs.apply'
  | 'bowerloom.runs.list' | 'bowerloom.runs.get' | 'bowerloom.runs.plan' | 'bowerloom.runs.apply';

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
  readonly permissions: readonly PermissionName[];
  readonly steps: readonly string[];
  readonly digest: string;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
  readonly nonce: string;
}

/** What an applied grant gives back: the Gauge and the permissions that are now granted, sorted. */
export interface GrantApplied {
  readonly id: string;
  readonly permissions: readonly PermissionName[];
}

/** What a revoke gives back: the Gauge and the permissions that it held and that were revoked now, sorted. A permission it did not hold is not in the list. The list may be empty. */
export interface GrantRevoked {
  readonly id: string;
  readonly revoked: readonly PermissionName[];
}

/** One grant a Gauge holds, with the two hashes it is bound to. */
export interface GrantEntry {
  readonly permission: PermissionName;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
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
 * approved grant plan. A revoke is `revoke` (a revoke call), `remove` (the removal of the Gauge), `disable` (the Gauge was disabled, which clears its traces grants), or `update`
 * (the Gauge was updated, which drops every grant of the old version). `version` is the installed version at the time of the record: for an update, the version that was replaced.
 * The hashes are those the grant is bound to.
 */
export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly action: 'grant' | 'revoke';
  readonly via: 'plan' | 'revoke' | 'remove' | 'disable' | 'update';
  readonly id: string;
  readonly version: string | null;
  readonly permission: PermissionName;
  readonly manifestHash: string | null;
  readonly folderHash: string | null;
}

/**
 * The most records that an audit read may hold. The file has a size cap of at most 1 MiB (`MAX_AUDIT_MAX_BYTES` in `grants.ts`) and a record is at least 64 bytes, so a file never holds more. A longer list is a protocol error.
 */
export const MAX_AUDIT_RECORDS = 16_384;

/**
 * What a read of the audit file gives. The file is not a complete history: when it is full, the oldest records are dropped. `firstSeq` is the `seq` of the oldest record
 * held, or `null` when the file is empty, and `droppedCount` is how many records were dropped, so a reader can tell that records were lost (`droppedCount` is `firstSeq - 1` when the file
 * is not empty). `auditFailed` is true once a record could not be written at all, because the clock gave no usable time or the file could not be written.
 * A revoke, a removal, a disable, and an update take effect first and are recorded after, on a best effort, so a failure here never leaves access in place.
 */
export interface AuditRead {
  readonly entries: readonly AuditEntry[];
  readonly firstSeq: number | null;
  readonly droppedCount: number;
  readonly auditFailed: boolean;
}

/** The kinds of change to the layout, in one list that the client and the fake core both use. Each goes through a plan and an approval. */
export const LAYOUT_KINDS = Object.freeze(['set', 'swap', 'default', 'restore', 'propose'] as const);
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

/** Why the core is in safe mode: the code and the reason of the refusal that the saved layout file got when the core started. */
export type LayoutSafe =
  | { readonly code: 'GAUGE_LAYOUT_INVALID'; readonly reason: LayoutReason }
  | { readonly code: 'GAUGE_PROTECTED'; readonly reason: ProtectedReason };

/**
 * What a read of the layout gives. `revision` is the number of the layout in use, from 1. In safe mode it is 0, `safe` says why, and `layout` is the default layout, which is not saved
 * until the person makes a change. When `safe` is `null`, the layout is the saved one.
 */
export interface LayoutState {
  readonly layout: Layout;
  readonly revision: number;
  readonly safe: LayoutSafe | null;
}

/** One earlier layout of the file, with the number it had. */
export type LayoutRevisionEntry = LayoutRevision;

/**
 * What a change to the layout would do, shown to the person before anything changes. The change is named by `kind` and the fields it needs, and the others are `null`:
 * `set` has `text` (the layout to use: a save and an import are both this), `swap` has `place` and `gauge`, `default` has `place`, `restore` has `revision`, and `propose` has `gauge`,
 * the Gauge that asks to add itself. `baseHash` is the SHA-256 of the canonical text of the layout the plan was made for, and `nextHash` is that of the layout it would give. Both are in the
 * `digest`, so an approval is for the change the person saw. `nonce` is issued by the core and is exactly 64 lowercase hexadecimal characters. Only the person approves a plan, so a Gauge never
 * changes the layout: it can only ask, and only to add itself.
 */
export interface LayoutPlan {
  readonly action: 'layout';
  readonly kind: LayoutKind;
  readonly place: string | null;
  readonly gauge: string | null;
  readonly revision: number | null;
  readonly text: string | null;
  readonly steps: readonly string[];
  readonly digest: string;
  readonly baseHash: string;
  readonly nextHash: string;
  readonly nonce: string;
}

/** What an applied layout plan gives back: the kind, the number of the layout now in use, and whether a revision was written. A change that gives the layout already in use writes none. */
export interface LayoutApplied {
  readonly kind: LayoutKind;
  readonly revision: number;
  readonly changed: boolean;
}

/** The two things a Gauge can ask the person to approve about a session. A stop is a plan too, because `sessions.stop` is an act permission: the Gauge asks, and never skips the plan. */
export const SESSION_ACTIONS = Object.freeze(['start', 'stop'] as const);
export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** A model choice, a provider and a model. */
export type SessionModel = ModelChoice;

/**
 * What a start or a stop of a session would do, shown to the person before anything changes. `gauge` is the Gauge that asked. `engine` and `folder` are the engine and the real folder of the session
 * (a link is followed, so two names for one folder are one folder). The fields of a start: `program` is the real path of the program, `model` is the choice (or `null` for the engine's own default),
 * `billing` is where the tokens are billed, `variables` are the names that pass to the program (those the engine declares and those the person allowed, sorted), and `sharedWith` are the engines
 * that already run in the folder (sorted): a start with some needs a second approval. The fields of a stop: `session` is the session to stop and `force` is true when it is stopping already,
 * and the stop sends the signal that cannot be ignored. A field that the action does not use is `null`, `[]`, or `false`. `digest` is the SHA-256 of the plan, and `nonce` is issued by the core and is
 * exactly 64 lowercase hexadecimal characters. A Gauge never makes an approval.
 */
export interface SessionPlan {
  readonly action: SessionAction;
  readonly gauge: string;
  readonly engine: string;
  readonly folder: string;
  readonly session: string | null;
  readonly program: string | null;
  readonly model: SessionModel | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly sharedWith: readonly string[];
  readonly force: boolean;
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

/** What an applied session plan gives back: the action, the session, its engine, and its state when the call returned. A stop that succeeded is `stopped`. A start is any state past `ready`, since the program may have moved on already. */
export interface SessionApplied {
  readonly action: SessionAction;
  readonly session: string;
  readonly engine: string;
  readonly state: SessionState;
}

/** What a read of a session gives. It holds no output of the engine: reading output is a stream, and needs the `sessions.stream` permission. */
export interface SessionSummary {
  readonly id: string;
  readonly engine: string;
  readonly folder: string;
  readonly state: SessionState;
  readonly billing: Billing;
  readonly model: SessionModel | null;
  readonly failure: SessionFailure | null;
}


/** The three changes to a job, in one list that the client and the fake core both use. Each goes through a plan and an approval. */
export const JOB_KINDS = Object.freeze(['create', 'update', 'delete'] as const);
export type JobKind = (typeof JOB_KINDS)[number];

/** A job as a read gives it: the id the core made, a title, and one to eight sessions. */
export interface JobRecord {
  readonly id: string;
  readonly title: string;
  readonly sessions: readonly JobSession[];
}

/** One job of the list: what a person needs to pick one, with no folder and no task. */
export interface JobListing {
  readonly id: string;
  readonly title: string;
  readonly sessions: number;
}

/**
 * What a change to a job would do, shown to the person before anything changes. `kind` names the change. `gauge` is the Gauge that asked. `job` is the id of the job (`null` for a create: the core makes the id
 * when the plan is applied). `definition` is the job the change gives (`null` for a delete). `baseHash` is the SHA-256 of the canonical text of the job as it is now (`null` for a create) and `nextHash` is that
 * of `definition` (`null` for a delete). Both are in the `digest`, so an approval is for the change the person saw, and a job that changed since holds it no longer. `digest` is the SHA-256 of the plan, and `nonce` is
 * issued by the core and is exactly 64 lowercase hexadecimal characters. A Gauge never makes an approval.
 */
export interface JobPlan {
  readonly action: 'job';
  readonly kind: JobKind;
  readonly gauge: string;
  readonly job: string | null;
  readonly definition: { readonly title: string; readonly sessions: readonly JobSession[] } | null;
  readonly baseHash: string | null;
  readonly nextHash: string | null;
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

/** What an applied job plan gives back: the change and the id of the job (for a create, the id the core made). */
export interface JobApplied {
  readonly kind: JobKind;
  readonly job: string;
}

/**
 * What a run would do, shown to the person before anything starts: every session of the run, in the order of the job, with its real program, its real folder, and what it shares. `shared` is true when any session
 * shares its folder with another engine, and then the run needs the second approval, once for the whole run. `digest` binds the plan to the job as it is now and to the state of the host. A run starts
 * through this one plan: an engine never starts another engine, and no call adds a session to a run.
 */
export interface RunPlan {
  readonly action: 'run';
  readonly gauge: string;
  readonly job: string;
  readonly title: string;
  readonly shared: boolean;
  readonly sessions: readonly RunSessionPlan[];
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

/**
 * A session of a run, as a Gauge may read it. `state` is the state the Engine Host holds, or `forgotten` when the host has dropped the session from its history, or `hidden` when the Gauge holds no `sessions.read`
 * grant for the engine: then `session` is `null`, so the answer is the same whatever the session is.
 */
export interface RunSessionSummary {
  readonly label: string;
  readonly engine: string;
  readonly session: string | null;
  readonly state: RunSessionState | 'hidden';
}

/** A run read as a group of its sessions, in the order of the plan. It holds no output of an engine and no state of its own. */
export interface RunSummary {
  readonly id: string;
  readonly job: string;
  readonly title: string;
  readonly sessions: readonly RunSessionSummary[];
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
export type CoreResult<T> = { readonly ok: true; readonly value: T } | CoreRefusal;

/**
 * A refusal, with its reason typed by its code. `GAUGE_GRANT_MISSING` has a grant reason or none. `GAUGE_AUDIT_FAILED` always has an audit reason. `GAUGE_LAYOUT_INVALID` always has a layout reason.
 * `GAUGE_PROTECTED` has a protected reason (`hidden`, `removed`, `replaced`) when the layout refused it, and none when the lifecycle did. `ENGINE_REQUEST_INVALID` always has a request reason (which field was wrong),
 * `ENGINE_NOT_FOUND` and `ENGINE_START_FAILED` always have a reason of their own closed set, and the other engine codes have none. Every other code has a manifest reason or none.
 */
/** The engine codes that never carry a reason. `ENGINE_REQUEST_INVALID`, `ENGINE_NOT_FOUND`, and `ENGINE_START_FAILED` always carry one. */
export const ENGINE_CODES = Object.freeze([
  'MODEL_NOT_FOR_ENGINE', 'ENGINE_LIMIT', 'ENGINE_PAIR_BUSY', 'ENGINE_FOLDER_SHARED', 'ENGINE_SESSION_UNKNOWN', 'ENGINE_SESSION_ENDED', 'ENGINE_STOP_TIMEOUT',
] as const);
export type EngineCode = (typeof ENGINE_CODES)[number];

/** `true` when the two types are the same set of literals, and `never` otherwise. */
export type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/**
 * A compile-time check that ties the engine codes of this package to the registry: it is `true` only when `ENGINE_CODES` and `ENGINE_REQUEST_INVALID` are exactly the registry codes that hold the word `ENGINE`.
 * A code added to the registry and not here, or here and not in the registry, makes this type `never`, and the declaration that uses it in `test/engine-codes-type.test.ts` stops compiling.
 * The pattern is the word ENGINE anywhere in the code, so a future registry code that holds the word and is not an engine session code will also fail this check, on purpose: it must be added here, or this pattern must be replaced by an explicit list.
 */
export type EngineCodesMatchRegistry = Exactly<EngineCode | EngineReasonCode, Extract<GaugeCode, `${string}ENGINE${string}`>>;
/** The engine codes that always carry a reason. */
export type EngineReasonCode = 'ENGINE_REQUEST_INVALID' | 'ENGINE_NOT_FOUND' | 'ENGINE_START_FAILED';

/** The job and run codes that never carry a reason. `GAUGE_JOB_INVALID` and `GAUGE_JOB_NOT_INTERACTIVE` always carry one. */
export const JOB_CODES = Object.freeze(['GAUGE_JOB_UNKNOWN', 'GAUGE_JOB_LIMIT', 'GAUGE_RUN_UNKNOWN', 'GAUGE_RUN_ROLLBACK_FAILED'] as const);
export type JobCode = (typeof JOB_CODES)[number];
/** The job codes that always carry a reason. */
export type JobReasonCode = 'GAUGE_JOB_INVALID' | 'GAUGE_JOB_NOT_INTERACTIVE';
/** A compile-time check that ties the job codes of this package to the registry: it is `true` only when `JOB_CODES` and `JobReasonCode` are exactly the registry codes that start with `GAUGE_JOB_` or `GAUGE_RUN_`. */
export type JobCodesMatchRegistry = Exactly<JobCode | JobReasonCode, Extract<GaugeCode, `GAUGE_JOB_${string}` | `GAUGE_RUN_${string}`>>;

export type CoreRefusal =
  | { readonly ok: false; readonly code: EngineCode; readonly reason?: never }
  | { readonly ok: false; readonly code: 'ENGINE_REQUEST_INVALID'; readonly reason: RequestReason }
  | { readonly ok: false; readonly code: 'ENGINE_NOT_FOUND'; readonly reason: NotFoundReason }
  | { readonly ok: false; readonly code: 'ENGINE_START_FAILED'; readonly reason: StartFailedReason }
  | { readonly ok: false; readonly code: 'GAUGE_GRANT_MISSING'; readonly reason?: GrantReason }
  | { readonly ok: false; readonly code: 'GAUGE_AUDIT_FAILED'; readonly reason: AuditReason }
  | { readonly ok: false; readonly code: 'GAUGE_LAYOUT_INVALID'; readonly reason: LayoutReason }
  | { readonly ok: false; readonly code: 'GAUGE_PROTECTED'; readonly reason?: ProtectedReason }
  | { readonly ok: false; readonly code: 'GAUGE_JOB_INVALID'; readonly reason: JobReason }
  | { readonly ok: false; readonly code: 'GAUGE_JOB_NOT_INTERACTIVE'; readonly reason: NotInteractiveReason }
  | { readonly ok: false; readonly code: JobCode; readonly reason?: never }
  | { readonly ok: false; readonly code: Exclude<GaugeCode, 'GAUGE_GRANT_MISSING' | 'GAUGE_AUDIT_FAILED' | 'GAUGE_LAYOUT_INVALID' | 'GAUGE_PROTECTED' | EngineCode | EngineReasonCode | JobCode | JobReasonCode>; readonly reason?: ManifestReason };
