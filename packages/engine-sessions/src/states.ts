/**
 * The states of an engine session, and the moves between them. `waiting` is a state and not an error: the engine waits for the person.
 * A session reaches `stopped` or `failed` once, and a new start makes a new session, so no move leaves either of them.
 */
export const SESSION_STATES = Object.freeze(['detected', 'ready', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'failed'] as const);
export type SessionState = (typeof SESSION_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(SESSION_STATES);

/** True when the value is one of the eight states. */
export const isSessionState = (value: unknown): value is SessionState => typeof value === 'string' && STATE_SET.has(value);

/**
 * The legal moves, by state. A table, so a move is legal only because it is written here. A move that is not in the table is a fault.
 * A Map, so a state name such as `__proto__` or `constructor` can never read a property that an object inherits.
 */
const LEGAL: ReadonlyMap<SessionState, ReadonlySet<SessionState>> = new Map<SessionState, ReadonlySet<SessionState>>([
  ['detected', new Set<SessionState>(['ready', 'failed'])],
  ['ready', new Set<SessionState>(['starting', 'failed'])],
  ['starting', new Set<SessionState>(['running', 'waiting', 'stopping', 'failed'])],
  ['running', new Set<SessionState>(['waiting', 'stopping', 'stopped', 'failed'])],
  ['waiting', new Set<SessionState>(['running', 'stopping', 'stopped', 'failed'])],
  ['stopping', new Set<SessionState>(['stopped', 'failed'])],
  ['stopped', new Set<SessionState>()],
  ['failed', new Set<SessionState>()],
]);

/** True when a session may move from one state to the other. A value that is not a state is never legal. */
export function isLegalMove(from: SessionState, to: SessionState): boolean {
  return isSessionState(from) && isSessionState(to) && LEGAL.get(from)?.has(to) === true;
}

/** True for `stopped` and `failed`, the two states a session reaches once and never leaves. */
export const isTerminal = (state: SessionState): boolean => state === 'stopped' || state === 'failed';
