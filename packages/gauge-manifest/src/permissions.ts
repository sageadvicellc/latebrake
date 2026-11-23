/**
 * The permission list: the one place that says which permissions exist and what each one means.
 *
 * A permission names one thing a Gauge can read or do. The person grants permissions per Gauge version, and a manifest may declare only names from this list.
 * A `write` or `act` permission lets a Gauge ask for a plan. It never lets the Gauge skip the plan: the person approves every plan.
 *
 * `scope` says whether the permission is scoped by the engines a Gauge lists. A permission with scope `engine` works only for an engine in the manifest's `engines` list,
 * so a Gauge that lists one engine reads that engine only. A permission with scope `none` does not touch an engine.
 *
 * `traces` marks a permission that reads traces. Traces permissions are denied by default, granted in their own step, and revoked in one action.
 * A Gauge that reads the text of a trace needs the facts permission too. The Traces API enforces that pairing, not this list.
 *
 * Reactions have no permission: a reaction is recorded only from the person's click on the core's reaction menu, so a Gauge has no call that reacts for the person.
 */

export const PERMISSION_KINDS = Object.freeze(['read', 'write', 'act'] as const);
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

const NAMES = [
  'engines.read', 'usage.read', 'models.read', 'sessions.read', 'sessions.stream', 'sessions.start', 'sessions.stop', 'sessions.attach', 'sessions.send',
  'layout.propose', 'jobs.read', 'jobs.write', 'jobs.run', 'traces.facts', 'traces.text',
] as const;

/** A name in the permission list, as a literal type. */
export type PermissionName = (typeof NAMES)[number];

export interface PermissionEntry {
  readonly name: PermissionName;
  readonly kind: PermissionKind;
  readonly scope: 'engine' | 'none';
  readonly traces: boolean;
  /** One line, ending in a full stop. */
  readonly meaning: string;
}

type Definition = Omit<PermissionEntry, 'name'>;
const define = (kind: PermissionKind, scope: 'engine' | 'none', meaning: string, traces = false): Definition => ({ kind, scope, traces, meaning });
const NEVER_SKIPS = ' The Gauge never skips the plan.';

/** The definition of each name. The type is a record over every name, so a name without a definition does not compile. */
const DEFINITIONS: Readonly<Record<PermissionName, Definition>> = {
  'engines.read': define('read', 'engine', 'Read the state of the engines the Gauge lists.'),
  'usage.read': define('read', 'engine', 'Read the usage figures of the engines the Gauge lists.'),
  'models.read': define('read', 'engine', 'Read the models of the engines the Gauge lists.'),
  'sessions.read': define('read', 'engine', 'Read the sessions of the engines the Gauge lists.'),
  'sessions.stream': define('read', 'engine', 'Read the live message stream of a session on an engine the Gauge lists.'),
  'sessions.start': define('act', 'engine', `Ask for a plan to start a session on an engine the Gauge lists.${NEVER_SKIPS}`),
  'sessions.stop': define('act', 'engine', `Ask for a plan to stop a session on an engine the Gauge lists.${NEVER_SKIPS}`),
  'sessions.attach': define('act', 'engine', `Ask for a plan to attach to a running session on an engine the Gauge lists.${NEVER_SKIPS}`),
  'sessions.send': define('act', 'engine', `Ask for a plan to send text to a session on an engine the Gauge lists.${NEVER_SKIPS}`),
  'layout.propose': define('write', 'none', `Ask for a plan to add the Gauge to the layout.${NEVER_SKIPS}`),
  'jobs.read': define('read', 'none', 'Read every saved job, with the folder and the task text of each session, and the runs of the jobs.'),
  'jobs.write': define('write', 'none', `Ask for a plan to create, change, or delete a job, and see the title of that job in the plan.${NEVER_SKIPS}`),
  'jobs.run': define('act', 'none', `Ask for a plan to run a job, which also needs the start-session grant for the engine of each session.${NEVER_SKIPS}`),
  'traces.facts': define('read', 'engine', 'Read the recorded facts of traces from the engines the Gauge lists. Denied until the person grants it.', true),
  'traces.text': define('read', 'engine', 'Read the prompt and reply text of traces, together with traces.facts. Denied until the person grants it.', true),
};

/** Every permission, with its one-line meaning, in a fixed order. Frozen. */
export const PERMISSIONS: readonly PermissionEntry[] = Object.freeze(NAMES.map((name): PermissionEntry => Object.freeze({ name, ...DEFINITIONS[name] })));

/** Every permission name, in the order of the list. Frozen. */
export const PERMISSION_NAMES: readonly PermissionName[] = Object.freeze(PERMISSIONS.map(permission => permission.name));

const BY_NAME: ReadonlyMap<string, PermissionEntry> = new Map(PERMISSIONS.map(permission => [permission.name, permission]));

/** The entry of a permission, or `undefined` when the value is not a name in the list. */
export function permissionOf(value: unknown): PermissionEntry | undefined {
  return typeof value === 'string' ? BY_NAME.get(value) : undefined;
}

/** True when the value is a name in the list. */
export function isPermission(value: unknown): value is PermissionName {
  return permissionOf(value) !== undefined;
}

/** True when the value is the name of a traces permission. */
export function isTracesPermission(value: unknown): boolean {
  return permissionOf(value)?.traces === true;
}

/**
 * Why a call about grants was refused, as a closed set. The code `GAUGE_GRANT_MISSING` says what class of refusal it is, and the reason says which rule.
 * A reason never holds a value that a caller sent.
 *
 * - `unknown_permission`: a name that is not in the list.
 * - `not_declared`: a listed name that the Gauge's manifest does not declare.
 * - `engine_not_listed`: an engine that the Gauge's manifest does not list, or no engine for a permission that needs one.
 * - `gauge_disabled`: the Gauge is disabled, so it holds no active grant.
 * - `invalid_request`: a request of the wrong shape: not a list of names, an empty list, a repeat, a value that is not text, a revoke that names both or neither of a list and a group,
 *   a group that is not `traces`, or an engine given for a permission that touches no engine.
 * - `facts_required`: `traces.text` is held, but `traces.facts` is not, and the text is readable only together with the facts.
 */
export const GRANT_REASONS = Object.freeze(['unknown_permission', 'not_declared', 'engine_not_listed', 'gauge_disabled', 'invalid_request', 'facts_required'] as const);
export type GrantReason = (typeof GRANT_REASONS)[number];

const GRANT_REASON_SET: ReadonlySet<string> = new Set(GRANT_REASONS);

/** True when the value is one of the grant reasons. */
export function isGrantReason(value: unknown): value is GrantReason {
  return typeof value === 'string' && GRANT_REASON_SET.has(value);
}

/**
 * Why a grant was refused with the code `GAUGE_AUDIT_FAILED`, as a closed set. A grant is recorded in the audit file before it takes effect, so a grant whose record cannot
 * be written is refused. `clock_unusable`: the wall clock gave no usable time. `write_failed`: the audit file could not be written.
 */
export const AUDIT_REASONS = Object.freeze(['clock_unusable', 'write_failed'] as const);
export type AuditReason = (typeof AUDIT_REASONS)[number];

const AUDIT_REASON_SET: ReadonlySet<string> = new Set(AUDIT_REASONS);

/** True when the value is one of the audit reasons. */
export function isAuditReason(value: unknown): value is AuditReason {
  return typeof value === 'string' && AUDIT_REASON_SET.has(value);
}
