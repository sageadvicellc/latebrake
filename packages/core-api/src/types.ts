import type { GaugeCode } from '../../gauge-errors/src/index.js';
import type { AuditReason, GrantReason, ManifestReason, PermissionName } from '../../gauge-manifest/src/index.js';
import type { Layout, LayoutReason, LayoutRevision, ProtectedReason } from '../../gauge-layout/src/index.js';
import type { ModelChoice, RequestReason } from '../../engine-sessions/src/request.js';
import type { SessionFailure } from '../../engine-sessions/src/session.js';
import type { SessionState } from '../../engine-sessions/src/states.js';
import type { Billing, NotFoundReason, StartFailedReason } from '../../engine-sessions/src/vocab.js';
import type { JobReason, JobSession, NotInteractiveReason } from '../../jobs/src/definition.js';
import type { RunMember, RunSessionState } from '../../jobs/src/runs.js';

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
 * What a start or a stop of a session would do. The core makes two views of one plan, which differ in four fields only. The person who approves reads the full plan. A Gauge reads a plan whose `folder` is the folder
 * as it asked for it (so it learns no path behind a link), whose `program` is the program as the engine is configured (the same reason), whose `sharedWith` holds only the engines that the Gauge may read (`sessions.read`),
 * and whose `steps` are the text of those values. `digest` is the digest of the full plan, so it is the same in both views, and an approval of the full plan is an approval of what a Gauge applies.
 *
 * `gauge` is the Gauge that asked. `engine` is the engine of the session. The fields of a start: `folder` (the real folder in the full plan, with a link followed, so two names for one folder are one folder), `program` (the real
 * path of the program in the full plan), `model` is the choice (or `null` for the engine's own default), `billing` is where the tokens are billed, `variables` are the names that pass to the program (those the engine declares and
 * those the person allowed, sorted), and `sharedWith` are the engines that already run in the folder (sorted): a start with some needs a second approval. The fields of a stop: `session` is the session to stop and `force` is true when it
 * is stopping already, and the stop sends the signal that cannot be ignored. A field that the action does not use is `null`, `[]`, or `false`. `digest` is a keyed hash of the full plan and the nonce, which only the core can work out:
 * a Gauge cannot test a guess of a hidden path or a hidden engine against it. `nonce` is issued by the core and is exactly 64 lowercase hexadecimal characters. A Gauge never makes an approval.
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

/** What a read of a session gives. It holds no output of the engine: reading output is a stream, and needs the `sessions.stream` permission. `folder` is the folder as the session was asked for, and never the real folder behind a link. */
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

/** One session of a run plan, as a Gauge reads it: the program as configured, the folder as the job names it, and the engines that share the folder that the Gauge may read (see `SessionPlan`). */
export interface RunPlanSession {
  readonly label: string;
  readonly engine: string;
  readonly engineTitle: string;
  readonly harness: string;
  readonly program: string;
  readonly folder: string;
  readonly model: ModelChoice | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly sharedWith: readonly string[];
  readonly task: string;
}

/**
 * What a run would do, shown to the person before anything starts: every session of the run, in the order of the job, with its real program, its real folder, and what it shares (a Gauge reads the trimmed view of `RunPlanSession`). `shared` is true when any session
 * shares its folder with another engine, and then the run needs the second approval, once for the whole run (in a Gauge's view, only when it may read an engine that shares). `digest` is a keyed hash of the full plan and the nonce, and it binds the plan to the job as it is now and to the state of the host. A run starts
 * through this one plan: an engine never starts another engine, and no call adds a session to a run.
 */
export interface RunPlan {
  readonly action: 'run';
  readonly gauge: string;
  readonly job: string;
  readonly title: string;
  readonly shared: boolean;
  readonly sessions: readonly RunPlanSession[];
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

/**
 * The plan of a start or a stop as the person reads it, and the only thing that an approval screen may be built from. It is a type of its own, with its own names, so that no plan of the person can be given as a reply that a
 * Gauge reads, and no plan that a Gauge read can stand for it: the real folder is `realFolder` (not `folder`), the real path of the program is `realProgram`, and every engine in the folder is `allSharedWith`. `requestedFolder` and
 * `configuredProgram` are what a Gauge reads as `folder` and `program`. `digest` and `nonce` are those of the plan that the Gauge read.
 */
export interface PersonSessionPlan {
  readonly action: SessionAction;
  readonly gauge: string;
  readonly engine: string;
  readonly realFolder: string;
  readonly requestedFolder: string;
  readonly session: string | null;
  readonly realProgram: string | null;
  readonly configuredProgram: string | null;
  readonly model: SessionModel | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly allSharedWith: readonly string[];
  readonly force: boolean;
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

/** One session of a run plan as the person reads it (see `PersonSessionPlan`). */
export interface PersonRunPlanSession {
  readonly label: string;
  readonly engine: string;
  readonly engineTitle: string;
  readonly harness: string;
  readonly realProgram: string;
  readonly configuredProgram: string;
  readonly realFolder: string;
  readonly requestedFolder: string;
  readonly model: ModelChoice | null;
  readonly billing: Billing;
  readonly variables: readonly string[];
  readonly allSharedWith: readonly string[];
  readonly task: string;
}

/** A run plan as the person reads it (see `PersonSessionPlan`). `shared` is true when any session shares its folder with any engine. */
export interface PersonRunPlan {
  readonly action: 'run';
  readonly gauge: string;
  readonly job: string;
  readonly title: string;
  readonly shared: boolean;
  readonly sessions: readonly PersonRunPlanSession[];
  readonly steps: readonly string[];
  readonly digest: string;
  readonly nonce: string;
}

export type PersonPlan = PersonSessionPlan | PersonRunPlan;

/**
 * What a core must offer to the part that shows the person a plan before it approves it. It is not on the `Core` seam: no call reaches it, and so no Gauge can. An approval screen is built from `personView(nonce)`, and never from the
 * plan that a Gauge read, which lacks the real folder, the real program, and the engines that the Gauge may not read. A nonce that the core did not issue, or whose plan is retired, is a `TypeError`.
 */
export interface PersonView {
  personView(nonce: string): PersonPlan;
}

/** Why the person is told something that a Gauge is not: the second approval that a plan needs was not given. */
export type PersonNoticeCause = 'second_approval_missing';

/**
 * What the core tells the person when it gives a Gauge a refusal that holds back the cause. `shown` is the refusal that the Gauge got. `engines` are all the engines in the folder, those that the Gauge may read and those that it may not.
 * `member` is the true session of a run that shares its folder, and `null` for a start. A real core shows this to the person, and never to a Gauge.
 */
export interface PersonNotice {
  readonly action: 'start' | 'run';
  readonly gauge: string;
  readonly shown: 'ENGINE_FOLDER_SHARED' | 'GAUGE_PLAN_NOT_APPROVED';
  readonly cause: PersonNoticeCause;
  readonly engines: readonly string[];
  readonly member: RunMember | null;
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
  | { readonly ok: false; readonly code: string; readonly reason?: string; readonly member?: unknown; readonly run?: unknown; readonly cause?: unknown };

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
export const JOB_CODES = Object.freeze(['GAUGE_JOB_UNKNOWN', 'GAUGE_JOB_LIMIT', 'GAUGE_RUN_UNKNOWN'] as const);
export type JobCode = (typeof JOB_CODES)[number];
/** The job codes that always carry a reason. */
export type JobReasonCode = 'GAUGE_JOB_INVALID' | 'GAUGE_JOB_NOT_INTERACTIVE';
/** The run code that carries a run, a session, and a cause, and no reason. */
export type RunRollbackCode = 'GAUGE_RUN_ROLLBACK_FAILED';
/** A compile-time check that ties the job codes of this package to the registry: it is `true` only when `JOB_CODES`, `JobReasonCode`, and `RunRollbackCode` are exactly the registry codes that start with `GAUGE_JOB_` or `GAUGE_RUN_`. */
export type JobCodesMatchRegistry = Exactly<JobCode | JobReasonCode | RunRollbackCode, Extract<GaugeCode, `GAUGE_JOB_${string}` | `GAUGE_RUN_${string}`>>;

/**
 * What a refusal of a run call may carry besides its code and reason. `member` is the session that the refusal is about: its place in the plan and its label, for a refusal of a plan (the first session that cannot start) and of an apply.
 * `run` is the id of the run that a failed apply left behind: the run stays recorded and reads as a group that ended, so the id is how a Gauge finds it. Both are closed values.
 */
export interface RefusalExtras {
  readonly member?: RunMember;
  readonly run?: string;
}

export type CoreRefusal = (
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
  | { readonly ok: false; readonly code: Exclude<GaugeCode, 'GAUGE_GRANT_MISSING' | 'GAUGE_AUDIT_FAILED' | 'GAUGE_LAYOUT_INVALID' | 'GAUGE_PROTECTED' | EngineCode | EngineReasonCode | JobCode | JobReasonCode | RunRollbackCode>; readonly reason?: ManifestReason }
) & RefusalExtras
  | { readonly ok: false; readonly code: RunRollbackCode; readonly reason?: never; readonly run: string; readonly member: RunMember; readonly cause: StartFailedReason };
