import { escapeText } from './text.js';
import { isLegalMove, isTerminal, type SessionState } from './states.js';

/**
 * Why a session failed, as a closed set. `start_failed`: the program did not start, did not say it runs in time, or ended before it ran. `crashed`: it ended on its own with an error or a signal.
 * `illegal_move`: a move that the table does not allow, or a claim of the engine that no line may make. `adapter_error`: the adapter of the engine threw on a line.
 */
export const SESSION_FAILURES = Object.freeze(['start_failed', 'crashed', 'illegal_move', 'adapter_error'] as const);
export type SessionFailure = (typeof SESSION_FAILURES)[number];

/**
 * What the log gets: the session id, the state before and the state after (or the state that was claimed), and the line to print. `to` holds escaped text, so a claim of the engine cannot forge a line of the log.
 * Every text that comes from an engine or from the operating system is escaped with `escapeText`.
 */
export interface FaultEntry {
  readonly session: string;
  readonly from: SessionState;
  readonly to: string;
  readonly message: string;
}

/** Writes an entry to standard error. This is the default log. */
const toStandardError = (entry: FaultEntry): void => { process.stderr.write(`${entry.message}\n`); };

/** Gives an entry to a log. A log that throws is reported on standard error, and the throw goes no further. */
export function report(log: ((entry: FaultEntry) => void) | undefined, entry: FaultEntry): void {
  try {
    (log ?? toStandardError)(entry);
  } catch (error) {
    process.stderr.write(`${entry.message}\n`);
    process.stderr.write(`engine session ${entry.session}: the log sink threw: ${escapeText(error instanceof Error ? error.message : String(error))}\n`);
  }
}

export interface MoveResult {
  readonly ok: boolean;
  /** The state of the session after the move was tried. */
  readonly state: SessionState;
}

/** One session and its state machine. Every change of state goes through `move` or `fail`, so the table is the one rule. */
export interface Session {
  readonly id: string;
  readonly state: SessionState;
  readonly failure: SessionFailure | null;
  /**
   * Moves the session to another state. A legal move changes the state. An illegal move is a fault: a session that has not ended is marked `failed` with the failure `illegal_move`,
   * and the fault is logged with the session id and both states, after the state changed, so a log that throws cannot leave the wrong state. A session that has ended keeps its state,
   * because it reaches `stopped` or `failed` once, and the fault is logged all the same. A move to `failed` has no cause, so it is a bug of the caller and throws: `fail(cause)` is the way to `failed`.
   */
  move(to: SessionState): MoveResult;
  /** A fault that the table does not decide: the host refuses a claim of the engine, whatever the table says. It fails the session with `illegal_move` and logs it, as an illegal move does. */
  fault(to: unknown): MoveResult;
  /** Marks the session failed with a named cause. It is the legal move to `failed`, so it works from a state that has not ended and does nothing, and logs nothing, for a session that has ended. */
  fail(cause: SessionFailure): MoveResult;
}

const printable = (value: unknown): string => (typeof value === 'string' ? escapeText(value) : String(typeof value));

/** Makes a session in the state `detected`. `log` receives each fault. A log that throws is reported on standard error, and never changes the state. */
export function createSession(id: string, log?: (entry: FaultEntry) => void): Session {
  let state: SessionState = 'detected';
  let failure: SessionFailure | null = null;
  const fault = (to: unknown): MoveResult => {
    const from = state;
    // The state changes first: a session that has not ended is failed, so the log can never be skipped by a throw.
    if (!isTerminal(from)) {
      state = 'failed';
      failure = 'illegal_move';
    }
    const shown = printable(to);
    report(log, { session: id, from, to: shown, message: `engine session ${id}: illegal move ${from} -> ${shown}` });
    return { ok: false, state };
  };
  return {
    get id() { return id; },
    get state() { return state; },
    get failure() { return failure; },
    move(to) {
      if (to === 'failed') throw new TypeError('a move to failed has no cause: use fail(cause)');
      if (isLegalMove(state, to)) {
        state = to;
        return { ok: true, state };
      }
      return fault(to);
    },
    fault,
    fail(cause) {
      if (isTerminal(state)) return { ok: false, state };
      state = 'failed';
      failure = cause;
      return { ok: true, state };
    },
  };
}
