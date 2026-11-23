import { isLegalMove, isTerminal, type SessionState } from './states.js';

/** Why a session failed, as a closed set. `start_failed`: the program did not start, or ended before it ran. `crashed`: it ended on its own with an error or a signal. `illegal_move`: a move that the table does not allow. */
export const SESSION_FAILURES = Object.freeze(['start_failed', 'crashed', 'illegal_move'] as const);
export type SessionFailure = (typeof SESSION_FAILURES)[number];

/** What the log gets for an illegal move: the session id and both states, and the line to print. */
export interface FaultEntry {
  readonly session: string;
  readonly from: SessionState;
  readonly to: SessionState;
  readonly message: string;
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
   * because it reaches `stopped` or `failed` once, and the fault is logged all the same.
   */
  move(to: SessionState): MoveResult;
  /** Marks the session failed with a named cause. It is the legal move to `failed`, so it works from a state that has not ended and does nothing, and logs nothing, for a session that has ended. */
  fail(cause: SessionFailure): MoveResult;
}

const printable = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : String(typeof value));

/** Writes a fault to standard error. This is the default log. */
const toStandardError = (entry: FaultEntry): void => { process.stderr.write(`${entry.message}\n`); };

/** Makes a session in the state `detected`. `log` receives each fault. A log that throws is reported on standard error, and never changes the state. */
export function createSession(id: string, log: (entry: FaultEntry) => void = toStandardError): Session {
  let state: SessionState = 'detected';
  let failure: SessionFailure | null = null;
  const report = (entry: FaultEntry): void => {
    try {
      log(entry);
    } catch (error) {
      process.stderr.write(`${entry.message}\n`);
      process.stderr.write(`engine session ${entry.session}: the log sink threw: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  return {
    get id() { return id; },
    get state() { return state; },
    get failure() { return failure; },
    move(to) {
      if (isLegalMove(state, to)) {
        state = to;
        return { ok: true, state };
      }
      const from = state;
      // The state changes first: a session that has not ended is failed, so the log can never be skipped by a throw.
      if (!isTerminal(from)) {
        state = 'failed';
        failure = 'illegal_move';
      }
      report({ session: id, from, to, message: `engine session ${id}: illegal move ${from} -> ${printable(to)}` });
      return { ok: false, state };
    },
    fail(cause) {
      if (isTerminal(state)) return { ok: false, state };
      state = 'failed';
      failure = cause;
      return { ok: true, state };
    },
  };
}
