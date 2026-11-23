import type { SessionState } from '../../engine-sessions/src/states.js';

/**
 * The words and the numbers of the relay. Every set here is closed: a refusal or a state is one of these words and never free text.
 */

/** The most bytes (UTF-8) in the body of one message. Larger content moves as a file path in a shared folder. */
export const MAX_BODY_BYTES = 16_384;
/** The longest idempotency key. */
export const MAX_KEY_LENGTH = 64;
/** The most routes in one job. A job holds at most 8 sessions, so 56 ordered pairs exist, and the cap keeps the relay far below that. */
export const MAX_ROUTES = 32;
/** The message cap of a route that does not name one, and the highest cap a person may set. */
export const DEFAULT_MESSAGE_CAP = 50;
export const MAX_MESSAGE_CAP = 1000;
/** The loop cap of a route that does not name one, and the highest cap a person may set. */
export const DEFAULT_LOOP_CAP = 6;
export const MAX_LOOP_CAP = 100;
/** The most messages of one route that wait for the person, for a receiver that is not ready, or for the engine. A message past it is refused. */
export const MAX_WAITING_PER_ROUTE = 16;
/** How many settled messages the relay keeps (those that ended, and those that were sent and wait for a receipt). The one that ended first is dropped first. */
export const DEFAULT_KEEP_SETTLED = 256;
export const MAX_KEEP_SETTLED = 1024;
/** How long the core waits for an engine to take a message, in milliseconds, and the range an option may take. */
export const DEFAULT_DELIVER_TIMEOUT_MS = 10_000;
export const MAX_DELIVER_TIMEOUT_MS = 600_000;

/** How a route moves messages. `accepted-output`: the person approves each message. `auto`: messages flow, and the core logs each one. */
export const ROUTE_RULES = Object.freeze(['accepted-output', 'auto'] as const);
export type RouteRule = (typeof ROUTE_RULES)[number];
const RULE_SET: ReadonlySet<string> = new Set(ROUTE_RULES);
/** True when the value is a route rule. */
export const isRouteRule = (value: unknown): value is RouteRule => typeof value === 'string' && RULE_SET.has(value);

/**
 * Why a route of a job was refused with `GAUGE_ROUTE_INVALID`. `request`: not a list, a record of another shape, or a field that a route does not have. `session`: the route names a session that the job does not have.
 * `self`: the sender and the receiver are one session. `repeat`: the job already has a route from that sender to that receiver. `rule`: the rule is not one of the two. `cap`: a cap is not a whole number in range,
 * or an `auto` route lacks a message cap or a loop cap. `limit`: more routes than a job may hold. A reason never holds a value that a caller sent.
 */
export const ROUTE_REASONS = Object.freeze(['request', 'session', 'self', 'repeat', 'rule', 'cap', 'limit'] as const);
export type RouteReason = (typeof ROUTE_REASONS)[number];
const ROUTE_REASON_SET: ReadonlySet<string> = new Set(ROUTE_REASONS);
export const isRouteReason = (value: unknown): value is RouteReason => typeof value === 'string' && ROUTE_REASON_SET.has(value);

/**
 * Why a message or an envelope was refused with `GAUGE_MESSAGE_INVALID`. `request`: not a record of exactly the fields of the call. `run`, `route`, `session`, `time`: that field of an envelope is wrong.
 * `key`: the idempotency key is not 1 to 64 plain characters. `body`: the body is not text, is empty, or holds a control, format, or separator character other than a line feed and a tab.
 * `key_reused`: the key was used before on the route for a body that is not this one. A reason never holds a value that a caller sent.
 */
export const MESSAGE_INVALID_REASONS = Object.freeze(['request', 'run', 'route', 'session', 'time', 'key', 'body', 'key_reused'] as const);
export type MessageInvalidReason = (typeof MESSAGE_INVALID_REASONS)[number];
const INVALID_SET: ReadonlySet<string> = new Set(MESSAGE_INVALID_REASONS);
export const isMessageInvalidReason = (value: unknown): value is MessageInvalidReason => typeof value === 'string' && INVALID_SET.has(value);

/**
 * Where a message is. `pending`: it waits for the person (an `accepted-output` route). `queued`: it is accepted and waits until the receiver runs. `sending`: the engine of the receiver is taking it now.
 * `sent`: the engine took it, and nothing proves that the engine read it. `delivered`: the receiver sent back the receipt, so the core has proof. `declined`: the person said no. `failed`: it did not arrive, and the reason says why.
 */
export const MESSAGE_STATES = Object.freeze(['pending', 'queued', 'sending', 'sent', 'delivered', 'declined', 'failed'] as const);
export type MessageState = (typeof MESSAGE_STATES)[number];
const STATE_SET: ReadonlySet<string> = new Set(MESSAGE_STATES);
export const isMessageState = (value: unknown): value is MessageState => typeof value === 'string' && STATE_SET.has(value);

/**
 * Why a message failed. `receiver_gone`: the session of the receiver ended. `route_stopped`: a cap stopped the route before the message moved. `closed`: the relay of the run closed before the message moved, or while the engine took it
 * (the text may have reached the engine). `delivery_failed`: the engine of the receiver said it could not take the message, or answered with something that is no answer. `delivery_timeout`: the engine did not answer in time (the text may
 * still reach it). `no_delivery_path`: the adapter has no way to give the engine a message while it runs, so nothing was given.
 */
export const FAILURE_REASONS = Object.freeze(['receiver_gone', 'route_stopped', 'closed', 'delivery_failed', 'delivery_timeout', 'no_delivery_path'] as const);
export type FailureReason = (typeof FAILURE_REASONS)[number];
const FAILURE_SET: ReadonlySet<string> = new Set(FAILURE_REASONS);
export const isFailureReason = (value: unknown): value is FailureReason => typeof value === 'string' && FAILURE_SET.has(value);

/** How faithfully an engine took a message: the fixed words of the spec. `absent` means that the engine has no way to take it. */
export const FIDELITIES = Object.freeze(['exact', 'translated', 'weakened', 'absent'] as const);
export type Fidelity = (typeof FIDELITIES)[number];
const FIDELITY_SET: ReadonlySet<string> = new Set(FIDELITIES);
export const isFidelity = (value: unknown): value is Fidelity => typeof value === 'string' && FIDELITY_SET.has(value);

/** What stopped a route. `loop_cap`: two sessions passed messages back and forth up to the loop cap. `message_cap`: the route reached its cap on messages. */
export const STOP_CAUSES = Object.freeze(['loop_cap', 'message_cap'] as const);
export type StopCause = (typeof STOP_CAUSES)[number];

/** The session states in which a session has ended. */
export const isEnded = (state: SessionState): boolean => state === 'stopped' || state === 'failed';
