// The session states and the table of legal moves. The table below is written out by hand. It is not read from the source, so a wrong move in the source fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STATES, isLegalMove, isSessionState, isTerminal, type SessionState } from '../src/states.js';

const ALL: readonly SessionState[] = ['detected', 'ready', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'failed'];

/** Every legal move, written out. Every other pair of the 8 x 8 table is illegal, and so is a move to the same state. */
const LEGAL: readonly (readonly [SessionState, SessionState])[] = [
  ['detected', 'ready'], ['detected', 'failed'],
  ['ready', 'starting'], ['ready', 'failed'],
  ['starting', 'running'], ['starting', 'waiting'], ['starting', 'stopping'], ['starting', 'failed'],
  ['running', 'waiting'], ['running', 'stopping'], ['running', 'stopped'], ['running', 'failed'],
  ['waiting', 'running'], ['waiting', 'stopping'], ['waiting', 'stopped'], ['waiting', 'failed'],
  ['stopping', 'stopped'], ['stopping', 'failed'],
];

test('the eight states are exactly these, in this order, and frozen', () => {
  assert.deepEqual([...SESSION_STATES], ALL);
  assert.equal(Object.isFrozen(SESSION_STATES), true);
});

test('there are 18 legal moves, and each one is legal', () => {
  assert.equal(LEGAL.length, 18);
  for (const [from, to] of LEGAL) assert.equal(isLegalMove(from, to), true, `${from} -> ${to}`);
});

test('each of the other 46 moves of the 8 x 8 table is illegal, a move to the same state included', () => {
  let illegal = 0;
  for (const from of ALL) {
    for (const to of ALL) {
      if (LEGAL.some(([a, b]) => a === from && b === to)) continue;
      illegal += 1;
      assert.equal(isLegalMove(from, to), false, `${from} -> ${to}`);
    }
  }
  assert.equal(illegal, 46);
});

test('a session reaches stopped or failed once: no move leaves either of them', () => {
  for (const from of ['stopped', 'failed'] as const) for (const to of ALL) assert.equal(isLegalMove(from, to), false, `${from} -> ${to}`);
  assert.equal(isTerminal('stopped'), true);
  assert.equal(isTerminal('failed'), true);
  for (const state of ALL.filter(state => state !== 'stopped' && state !== 'failed')) assert.equal(isTerminal(state), false, state);
});

test('waiting is a state, not an error: a session goes from running to waiting and back', () => {
  assert.equal(isLegalMove('running', 'waiting'), true);
  assert.equal(isLegalMove('waiting', 'running'), true);
});

test('a value that is not a state is not a state, and every move with it is illegal', () => {
  for (const value of ['Running', 'RUNNING', '', 'toString', '__proto__', 'constructor', 'hasOwnProperty', undefined, null, 5, {}, []]) {
    assert.equal(isSessionState(value), false, String(value));
    assert.equal(isLegalMove(value as SessionState, 'failed'), false, String(value));
    assert.equal(isLegalMove('running', value as SessionState), false, String(value));
  }
  for (const state of ALL) assert.equal(isSessionState(state), true, state);
});
