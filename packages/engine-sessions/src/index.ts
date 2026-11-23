/** The engine sessions of the Engine Host: the states and their legal moves, the session machine, the host, and the process launcher. See `README.md`. The fake engine and its fixtures are for tests: import them from `./fixtures.js`. */
export { SESSION_STATES, isLegalMove, isSessionState, isTerminal } from './states.js';
export type { SessionState } from './states.js';
export { SESSION_FAILURES, createSession } from './session.js';
export type { FaultEntry, MoveResult, Session, SessionFailure } from './session.js';
export { MAX_CHOICE_LENGTH, MAX_FOLDER_LENGTH, MAX_NAME_LENGTH, MAX_VARIABLES, MAX_VARIABLE_LENGTH, REQUEST_REASONS, checkEngineId, checkFolder, checkModel, checkSessionId, checkVariables, isRequestReason } from './request.js';
export type { Checked, ModelChoice, RequestReason } from './request.js';
export { BILLING_SOURCES, DEFAULT_SESSION_CAP, DEFAULT_STOP_TIMEOUT_MS, createEngineHost } from './host.js';
export type { Billing, BegunStart, BegunStop, EngineHost, EngineSpec, HostOptions, HostRefusal, SessionInfo, StartPlanContent, StopPlanContent } from './host.js';
export type { Launched, LaunchSpec, Launcher, StopSignal } from './launcher.js';
export { CLOSE_GRACE_MS, MAX_LINE_CHARS, createProcessLauncher, lineSplitter } from './process-launcher.js';
