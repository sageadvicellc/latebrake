// The closed sets of reasons that the host gives, and the limits of the history. Written out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_SOURCES, KEEP_ENDED_SESSIONS, MAX_SESSIONS_LISTED, NOT_FOUND_REASONS, START_FAILED_REASONS, isBilling, isNotFoundReason, isStartFailedReason } from '../src/vocab.js';

test('the reasons of ENGINE_NOT_FOUND are exactly these three, and each is recognised', () => {
  assert.deepEqual([...NOT_FOUND_REASONS], ['engine', 'program_missing', 'program_not_executable']);
  for (const reason of NOT_FOUND_REASONS) assert.equal(isNotFoundReason(reason), true, reason);
  for (const value of ['Engine', '', 'folder', 'toString', undefined, null, 5]) assert.equal(isNotFoundReason(value), false, String(value));
});

test('the reasons of ENGINE_START_FAILED are exactly these, and each is recognised', () => {
  assert.deepEqual([...START_FAILED_REASONS], ['program_missing', 'not_executable', 'folder_unusable', 'resource_limit', 'adapter_error', 'shutting_down', 'timed_out', 'exited', 'stopped', 'illegal_claim', 'other']);
  for (const reason of START_FAILED_REASONS) assert.equal(isStartFailedReason(reason), true, reason);
  for (const value of ['program_not_executable', 'Other', '', '__proto__', undefined, null]) assert.equal(isStartFailedReason(value), false, String(value));
});

test('the billing sources and the limits of the history are these, and the sets are frozen', () => {
  assert.deepEqual([...BILLING_SOURCES], ['engine-plan', 'local']);
  assert.equal(KEEP_ENDED_SESSIONS, 256);
  assert.equal(MAX_SESSIONS_LISTED, 320);
  for (const set of [NOT_FOUND_REASONS, START_FAILED_REASONS, BILLING_SOURCES]) assert.equal(Object.isFrozen(set), true);
});

test('isBilling accepts the two billing sources and nothing else', () => {
  for (const source of BILLING_SOURCES) assert.equal(isBilling(source), true, source);
  for (const value of ['provider-key', 'Local', '', 'toString', '__proto__', undefined, null, 5, {}, ['local']]) assert.equal(isBilling(value), false, String(value));
});
