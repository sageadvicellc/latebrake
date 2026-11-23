/** The Core API client and its types. The fake core and its fixtures are for tests: import them from `./fake-core.js` and `./fixtures.js`. See `README.md`. */
export { CoreProtocolError, createCoreClient } from './client.js';
export type { CoreClient } from './client.js';
export { PLAN_ACTIONS } from './types.js';
export type {
  AuditEntry, AuditRead, CoreRefusal, Core, CoreMethod, CoreReply, CoreResult, GaugeApplied, GaugePlan, GaugeSummary, GrantApplied, GrantEntry, GrantPlan, GrantRevoked, PermissionCheck, PlanAction,
} from './types.js';
export { DEFAULT_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES } from './grants.js';
