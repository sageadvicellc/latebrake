/** Where a session's tokens are billed. A provider key joins when the keys and spend work is built: a spec that names it is refused when the host is made. */
export const BILLING_SOURCES = Object.freeze(['engine-plan', 'local'] as const);
export type Billing = (typeof BILLING_SOURCES)[number];
const BILLING_SET: ReadonlySet<string> = new Set(BILLING_SOURCES);
/** True when the value is one of the billing sources. */
export const isBilling = (value: unknown): value is Billing => typeof value === 'string' && BILLING_SET.has(value);

/**
 * Why an engine was not found, as a closed set, with `ENGINE_NOT_FOUND`. `engine`: no engine of the host has the id. `program_missing`: the program of the engine is not on this computer (or its path is not one that a person
 * could read in a plan). `program_not_executable`: the program is there and cannot run, or a folder on the way to it cannot be searched.
 */
export const NOT_FOUND_REASONS = Object.freeze(['engine', 'program_missing', 'program_not_executable'] as const);
export type NotFoundReason = (typeof NOT_FOUND_REASONS)[number];
const NOT_FOUND_SET: ReadonlySet<string> = new Set(NOT_FOUND_REASONS);
/** True when the value is one of the reasons of `ENGINE_NOT_FOUND`. */
export const isNotFoundReason = (value: unknown): value is NotFoundReason => typeof value === 'string' && NOT_FOUND_SET.has(value);

/**
 * Why a start failed, as a closed set, with `ENGINE_START_FAILED`. The free text of the error stays in the log of the host, since it can name a path. `program_missing`, `not_executable`, `folder_unusable`: the operating system said
 * so. `resource_limit`: the system is out of a resource (arguments too long, too many open files, no memory, or a process limit). `adapter_error`: the adapter of the engine threw while it built the arguments.
 * `shutting_down`: the host has been told to kill everything, so no start is made. `timed_out`: the program did not say it runs in time. `exited`: the program ended before it said it runs. `stopped`: the person's own stop, or the end of the host, cut the start short. `illegal_claim`: the engine claimed a state that no line may claim, or moved the session by a move that the table forbids. `other`: any other cause, and the log of the host says which.
 */
export const START_FAILED_REASONS = Object.freeze(['program_missing', 'not_executable', 'folder_unusable', 'resource_limit', 'adapter_error', 'shutting_down', 'timed_out', 'exited', 'stopped', 'illegal_claim', 'other'] as const);
export type StartFailedReason = (typeof START_FAILED_REASONS)[number];
const START_FAILED_SET: ReadonlySet<string> = new Set(START_FAILED_REASONS);
/** True when the value is one of the reasons of `ENGINE_START_FAILED`. */
export const isStartFailedReason = (value: unknown): value is StartFailedReason => typeof value === 'string' && START_FAILED_SET.has(value);

/** How many sessions that have ended the host keeps, besides every session that is live. The oldest ended session is dropped first. */
export const KEEP_ENDED_SESSIONS = 256;
/** The most sessions that a read can give: the largest cap (64) and the ended sessions that are kept. */
export const MAX_SESSIONS_LISTED = 64 + KEEP_ENDED_SESSIONS;

/** The most sessions that one group start may hold. A run of a job starts its sessions as one group, and a job holds at most this many sessions. */
export const MAX_START_GROUP = 8;
