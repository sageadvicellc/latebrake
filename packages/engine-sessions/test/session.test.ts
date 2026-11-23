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
  for (const step of PATH[state]) assert.equal(step === 'failed' ? session.fail('crashed').ok : session.move(step).ok, true, `${state} via ${step}`);
  assert.equal(session.state, state);
  return session;
};

test('a new session is detected, has no failure, and keeps its id', () => {
  const session = createSession('s-1', () => undefined);
  assert.equal(session.id, 's-1');
  assert.equal(session.state, 'detected');
  assert.equal(session.failure, null);
});

test('every legal move changes the state, gives ok, and writes no log: a move to failed goes through fail with a cause', () => {
  for (const [from, to] of LEGAL.filter(([, target]) => target !== 'failed')) {
    const entries: FaultEntry[] = [];
    const session = at(from, entry => entries.push(entry));
    assert.deepEqual(session.move(to), { ok: true, state: to }, `${from} -> ${to}`);
    assert.equal(session.state, to);
    assert.deepEqual(entries, [], `${from} -> ${to}`);
  }
});

test('a bare move to failed is a bug, and it throws with no change: the cause is named by fail', () => {
  for (const from of ALL) {
    const entries: FaultEntry[] = [];
    const session = at(from, entry => entries.push(entry));
    assert.throws(() => session.move('failed'), /fail\(cause\)/, from);
    assert.equal(session.state, from);
    assert.equal(session.failure, from === 'failed' ? session.failure : null);
    assert.deepEqual(entries, []);
  }
});

test('every legal move to failed goes through fail, and gives the cause', () => {
  for (const [from] of LEGAL.filter(([, target]) => target === 'failed')) {
    for (const cause of ['start_failed', 'crashed', 'illegal_move', 'adapter_error'] as const) {
      const session = at(from, () => undefined);
      assert.deepEqual(session.fail(cause), { ok: true, state: 'failed' }, `${from} ${cause}`);
      assert.equal(session.failure, cause);
    }
  }
});

test('fault marks a session that has not ended failed with illegal_move, and logs the id and both states, for any claim, a legal move to another state included', () => {
  for (const from of ['starting', 'running', 'waiting', 'stopping'] as const) {
    for (const to of ['stopped', 'failed', 'stopping', 'detected', 'ready', 'starting']) {
      const entries: FaultEntry[] = [];
      const session = at(from, entry => entries.push(entry));
      assert.deepEqual(session.fault(to), { ok: false, state: 'failed' }, `${from} ${to}`);
      assert.equal(session.state, 'failed');
      assert.equal(session.failure, 'illegal_move');
      assert.deepEqual(entries, [{ session: 's-1', from, to, message: `engine session s-1: illegal move ${from} -> ${to}` }]);
    }
  }
  for (const from of ['stopped', 'failed'] as const) {
    const entries: FaultEntry[] = [];
    const session = at(from, entry => entries.push(entry));
    assert.deepEqual(session.fault('running'), { ok: false, state: from });
    assert.equal(session.state, from);
    assert.equal(entries.length, 1);
  }
});

test('the log escapes what the engine sent: a control, bidi, format, or separator character, and a look-alike space, shows as an escape in both the entry and the line', () => {
  const hostile = 'x\n\u2028\u202e\u200b\u00a0';
  const escaped = 'x\\u{a}\\u{2028}\\u{202e}\\u{200b}\\u{a0}';
  for (const act of [(s: ReturnType<typeof at>) => s.move(hostile as never), (s: ReturnType<typeof at>) => s.fault(hostile)]) {
    const entries: FaultEntry[] = [];
    const session = at('running', entry => entries.push(entry));
    act(session);
    assert.equal(entries[0]?.to, escaped);
    assert.equal(entries[0]?.message, `engine session s-1: illegal move running -> ${escaped}`);
    assert.equal(/[\n\u2028\u202e\u200b\u00a0]/.test(entries[0]?.message ?? ''), false);
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
      if (to === 'failed') continue;
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

test('the message of a log that threw is escaped before it is written to standard error', () => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const session = at('running', () => { throw new Error('broke\nforged line\u202e'); });
    session.move('ready');
  } finally {
    process.stderr.write = write;
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'engine session s-1: the log sink threw: broke\\u{a}forged line\\u{202e}\n');
});

// The change listener: the host learns of each change of state at once, and a listener that throws never changes the state.

test('a listener is called after every change of state, with the new state already set: a legal move, a fail, and a fault', () => {
  const seen: SessionState[] = [];
  let session: ReturnType<typeof createSession>;
  session = createSession('s-1', () => undefined, () => seen.push(session.state));
  session.move('ready');
  session.move('starting');
  session.move('running');
  assert.deepEqual(seen, ['ready', 'starting', 'running']);
  session.fault('nonsense');
  assert.deepEqual(seen, ['ready', 'starting', 'running', 'failed']);
  const other: SessionState[] = [];
  const failing = createSession('s-2', () => undefined, () => other.push(failing.state));
  failing.fail('crashed');
  assert.deepEqual(other, ['failed']);
  const illegal: SessionState[] = [];
  const jumper = createSession('s-3', () => undefined, () => illegal.push(jumper.state));
  jumper.move('running');
  assert.deepEqual(illegal, ['failed'], 'an illegal move is a change, to failed');
});

test('a listener is not called when nothing changed: a session that has ended, and a move to the same state', () => {
  let calls = 0;
  const session = createSession('s-1', () => undefined, () => { calls += 1; });
  session.fail('crashed');
  assert.equal(calls, 1);
  session.fail('crashed');
  session.move('ready');
  session.fault('x');
  assert.equal(calls, 1, 'an ended session never changes again');
});

test('a listener that throws is reported on standard error and never changes the state or the answer', () => {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const session = createSession('s-1', () => undefined, () => { throw new Error('the listener broke\nforged line'); });
    assert.deepEqual(session.move('ready'), { ok: true, state: 'ready' });
    assert.equal(session.state, 'ready');
    assert.deepEqual(session.fail('crashed'), { ok: true, state: 'failed' });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written.length, 2);
  assert.match(written[0] ?? '', /^engine session s-1: the change listener threw: the listener broke\\u\{a\}forged line\n$/);
});
