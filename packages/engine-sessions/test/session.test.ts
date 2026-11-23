// The session machine: every legal and every illegal move, and what an illegal move does. The tables are written out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, type FaultEntry } from '../src/session.js';
import type { SessionState } from '../src/states.js';

const ALL: readonly SessionState[] = ['detected', 'ready', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'failed'];
const LEGAL: readonly (readonly [SessionState, SessionState])[] = [
  ['detected', 'ready'], ['detected', 'failed'], ['ready', 'starting'], ['ready', 'failed'],
  ['starting', 'running'], ['starting', 'waiting'], ['starting', 'stopping'], ['starting', 'failed'],
  ['running', 'waiting'], ['running', 'stopping'], ['running', 'stopped'], ['running', 'failed'],
  ['waiting', 'running'], ['waiting', 'stopping'], ['waiting', 'stopped'], ['waiting', 'failed'],
  ['stopping', 'stopped'], ['stopping', 'failed'],
];
/** The shortest path of legal moves from `detected` to each state, written out. */
const PATH: Readonly<Record<SessionState, readonly SessionState[]>> = {
  detected: [], ready: ['ready'], starting: ['ready', 'starting'], running: ['ready', 'starting', 'running'], waiting: ['ready', 'starting', 'waiting'],
  stopping: ['ready', 'starting', 'stopping'], stopped: ['ready', 'starting', 'running', 'stopped'], failed: ['failed'],
};
const at = (state: SessionState, log: (entry: FaultEntry) => void) => {
  const session = createSession('s-1', log);
  for (const step of PATH[state]) assert.equal(session.move(step).ok, true, `${state} via ${step}`);
  assert.equal(session.state, state);
  return session;
};

test('a new session is detected, has no failure, and keeps its id', () => {
  const session = createSession('s-1', () => undefined);
  assert.equal(session.id, 's-1');
  assert.equal(session.state, 'detected');
  assert.equal(session.failure, null);
});

test('every legal move changes the state, gives ok, and writes no log', () => {
  for (const [from, to] of LEGAL) {
    const entries: FaultEntry[] = [];
    const session = at(from, entry => entries.push(entry));
    assert.deepEqual(session.move(to), { ok: true, state: to }, `${from} -> ${to}`);
    assert.equal(session.state, to);
    assert.deepEqual(entries, [], `${from} -> ${to}`);
  }
});

test('every illegal move from a state that has not ended marks the session failed, with the failure illegal_move, and logs the id and both states', () => {
  let count = 0;
  for (const from of ALL.filter(state => state !== 'stopped' && state !== 'failed')) {
    for (const to of ALL) {
      if (LEGAL.some(([a, b]) => a === from && b === to)) continue;
      count += 1;
      const entries: FaultEntry[] = [];
      const session = at(from, entry => entries.push(entry));
      const result = session.move(to);
      assert.deepEqual(result, { ok: false, state: 'failed' }, `${from} -> ${to}`);
      assert.equal(session.state, 'failed', `${from} -> ${to}`);
      assert.equal(session.failure, 'illegal_move', `${from} -> ${to}`);
      assert.deepEqual(entries, [{ session: 's-1', from, to, message: `engine session s-1: illegal move ${from} -> ${to}` }], `${from} -> ${to}`);
    }
  }
  assert.equal(count, 30, 'six states that have not ended, 8 moves each, less their 18 legal moves');
});

test('an illegal move on a session that has ended is logged, and the state stays: it reaches stopped or failed once', () => {
  for (const from of ['stopped', 'failed'] as const) {
    for (const to of ALL) {
      const entries: FaultEntry[] = [];
      const session = at(from, entry => entries.push(entry));
      const failure = session.failure;
      assert.deepEqual(session.move(to), { ok: false, state: from }, `${from} -> ${to}`);
      assert.equal(session.state, from);
      assert.equal(session.failure, failure, 'the cause of an earlier failure is kept');
      assert.deepEqual(entries, [{ session: 's-1', from, to, message: `engine session s-1: illegal move ${from} -> ${to}` }]);
    }
  }
});

test('a value that is not a state is an illegal move: the session fails and the log names it', () => {
  for (const to of ['Running', '', '__proto__', 'toString']) {
    const entries: FaultEntry[] = [];
    const session = at('running', entry => entries.push(entry));
    assert.deepEqual(session.move(to as SessionState), { ok: false, state: 'failed' }, to);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.to, to);
    assert.equal(entries[0]?.message, `engine session s-1: illegal move running -> ${JSON.stringify(to).slice(1, -1)}`);
  }
});

test('the state is marked failed before the log runs, so a log that throws cannot leave the session in the wrong state, and the fault still reaches standard error', () => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const session = at('running', () => { throw new Error('log sink broke'); });
    assert.deepEqual(session.move('ready'), { ok: false, state: 'failed' });
    assert.equal(session.state, 'failed');
    assert.equal(session.failure, 'illegal_move');
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(lines, ['engine session s-1: illegal move running -> ready\n', 'engine session s-1: the log sink threw: log sink broke\n']);
});

test('fail gives a session a named failure once, and a session that ended keeps its first cause', () => {
  const session = at('running', () => undefined);
  assert.deepEqual(session.fail('crashed'), { ok: true, state: 'failed' });
  assert.equal(session.failure, 'crashed');
  assert.deepEqual(session.fail('start_failed').ok, false);
  assert.equal(session.failure, 'crashed');
  const stopped = at('stopped', () => undefined);
  assert.equal(stopped.fail('crashed').ok, false);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.failure, null);
});
