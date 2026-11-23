/** The engine sessions of the Engine Host: the states and their legal moves, the session machine, the host, and the process launcher. See `README.md`. The fake engine and its fixtures are for tests: import them from `./fixtures.js`. */
export { SESSION_STATES, isLegalMove, isSessionState, isTerminal } from './states.js';
export type { SessionState } from './states.js';
export { SESSION_FAILURES, createSession, report } from './session.js';
export type { FaultEntry, MoveResult, Session, SessionFailure } from './session.js';
export { MAX_CHOICE_LENGTH, MAX_FOLDER_LENGTH, MAX_LIST_LENGTH, MAX_NAME_LENGTH, MAX_VARIABLES, MAX_VARIABLE_LENGTH, REQUEST_REASONS, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, isLoaderVariable, isRefusedVariable, isRequestReason, readList } from './request.js';
export type { Checked, ModelChoice, RequestReason } from './request.js';
export { BILLING_SOURCES, KEEP_ENDED_SESSIONS, MAX_SESSIONS_LISTED, NOT_FOUND_REASONS, START_FAILED_REASONS, isBilling, isNotFoundReason, isStartFailedReason } from './vocab.js';
export { DEFAULT_KILL_WAIT_MS, DEFAULT_SESSION_CAP, DEFAULT_START_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, MAX_START_GROUP, StalePlanError, createEngineHost, isStalePlanError } from './host.js';
export type { Billing, NotFoundReason, StartFailedReason } from './vocab.js';
export type { BegunGroup, BegunStart, BegunStop, GroupRefusal, EngineHost, EngineSpec, HostOptions, HostRefusal, SessionInfo, StartPlanContent, StopPlanContent } from './host.js';
export type { Launched, LaunchSpec, Launcher, StopSignal } from './launcher.js';
export { CLOSE_GRACE_MS, MAX_LINE_CHARS, STDERR_TAIL_CHARS, createProcessLauncher, killLiveGroups, lineSplitter } from './process-launcher.js';
export type { ProcessLauncherOptions } from './process-launcher.js';
export { escapeText, hasPlanUnsafeChar, hasUnsafeChar } from './text.js';
