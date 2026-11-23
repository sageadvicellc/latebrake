// The words and the numbers of the relay, pinned by hand: a change to a set or a limit fails here on purpose, since a code and a reason are promises to Gauge authors.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as relay from '../src/index.js';
import {
  DEFAULT_DELIVER_TIMEOUT_MS, DEFAULT_KEEP_SETTLED, DEFAULT_LOOP_CAP, DEFAULT_MESSAGE_CAP, FAILURE_REASONS, FIDELITIES, MAX_BODY_BYTES, MAX_DELIVER_TIMEOUT_MS, MAX_KEEP_SETTLED, MAX_KEY_LENGTH, MAX_LOOP_CAP,
  MAX_MESSAGE_CAP, MAX_ROUTES, MAX_WAITING_PER_ROUTE, MESSAGE_INVALID_REASONS, MESSAGE_STATES, ROUTE_REASONS, ROUTE_RULES, STOP_CAUSES, isEnded, isFailureReason, isFidelity, isMessageInvalidReason,
  isMessageState, isRouteReason, isRouteRule,
} from '../src/vocab.js';
import { GAUGE_CODES } from '../../gauge-errors/src/index.js';

test('the limits are the numbers of the spec and of this ticket', () => {
  assert.equal(MAX_BODY_BYTES, 16_384);
  assert.equal(MAX_KEY_LENGTH, 64);
  assert.equal(MAX_ROUTES, 32);
  assert.equal(DEFAULT_MESSAGE_CAP, 50);
  assert.equal(MAX_MESSAGE_CAP, 1000);
  assert.equal(DEFAULT_LOOP_CAP, 6);
  assert.equal(MAX_LOOP_CAP, 100);
  assert.equal(MAX_WAITING_PER_ROUTE, 16);
  assert.equal(DEFAULT_KEEP_SETTLED, 256);
  assert.equal(MAX_KEEP_SETTLED, 1024);
  assert.equal(DEFAULT_DELIVER_TIMEOUT_MS, 10_000);
  assert.equal(MAX_DELIVER_TIMEOUT_MS, 600_000);
});

test('each closed set lists its words in a fixed order, and is frozen', () => {
  assert.deepEqual([...ROUTE_RULES], ['accepted-output', 'auto']);
  assert.deepEqual([...ROUTE_REASONS], ['request', 'session', 'self', 'repeat', 'rule', 'cap', 'limit']);
  assert.deepEqual([...MESSAGE_INVALID_REASONS], ['request', 'run', 'route', 'session', 'time', 'key', 'body', 'key_reused']);
  assert.deepEqual([...MESSAGE_STATES], ['pending', 'queued', 'sending', 'sent', 'delivered', 'declined', 'failed']);
  assert.deepEqual([...FAILURE_REASONS], ['receiver_gone', 'closed', 'delivery_failed', 'delivery_timeout', 'no_delivery_path', 'not_prepared']);
  assert.deepEqual([...FIDELITIES], ['exact', 'translated', 'weakened', 'absent']);
  assert.deepEqual([...STOP_CAUSES], ['loop_cap', 'message_cap']);
  for (const set of [ROUTE_RULES, ROUTE_REASONS, MESSAGE_INVALID_REASONS, MESSAGE_STATES, FAILURE_REASONS, FIDELITIES, STOP_CAUSES]) assert.equal(Object.isFrozen(set), true);
});

test('each guard takes the words of its set and nothing else, not a word of Object.prototype and not a value that is no text', () => {
  const guards: [(value: unknown) => boolean, readonly string[]][] = [
    [isRouteRule, ROUTE_RULES], [isRouteReason, ROUTE_REASONS], [isMessageInvalidReason, MESSAGE_INVALID_REASONS], [isMessageState, MESSAGE_STATES], [isFailureReason, FAILURE_REASONS], [isFidelity, FIDELITIES],
  ];
  for (const [guard, words] of guards) {
    for (const word of words) assert.equal(guard(word), true, word);
    for (const other of ['', 'Auto', ' auto', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 5, null, undefined, {}, ['auto']]) assert.equal(guard(other), false, String(other));
  }
});

test('a session has ended when it stopped or failed, and in no other state', () => {
  assert.deepEqual((['detected', 'ready', 'starting', 'running', 'waiting', 'stopping', 'stopped', 'failed'] as const).map(isEnded), [false, false, false, false, false, false, true, true]);
});

test('every refusal code of the relay is in the registry of Gauge codes, so a code that the relay gives is one that a Gauge author can look up', () => {
  const given = ['GAUGE_ROUTE_INVALID', 'GAUGE_ROUTE_UNKNOWN', 'GAUGE_MESSAGE_INVALID', 'GAUGE_MESSAGE_TOO_LARGE', 'GAUGE_MESSAGE_SECRET_FOUND', 'GAUGE_MESSAGE_UNKNOWN', 'GAUGE_MESSAGE_NOT_ACCEPTED',
    'GAUGE_RELAY_UNAUTHENTICATED', 'GAUGE_RELAY_RECEIPT_INVALID', 'GAUGE_RELAY_LOOP_CAP', 'GAUGE_RELAY_MESSAGE_CAP', 'GAUGE_RELAY_QUEUE_FULL', 'GAUGE_RELAY_RECEIVER_GONE', 'GAUGE_RELAY_CLOSED'];
  for (const code of given) assert.equal((GAUGE_CODES as readonly string[]).includes(code), true, code);
});

test('the package exports the relay, the envelope, the routes, the log, and the words, and the fake engines stay out', () => {
  assert.deepEqual(Object.keys(relay).sort(), [
    'DEFAULT_DELIVER_TIMEOUT_MS', 'DEFAULT_KEEP_SETTLED', 'DEFAULT_LOOP_CAP', 'DEFAULT_MESSAGE_CAP', 'FAILURE_REASONS', 'FIDELITIES', 'MAX_BODY_BYTES', 'MAX_KEEP_SETTLED', 'MAX_KEY_LENGTH', 'MAX_LOOP_CAP',
    'MAX_MESSAGE_CAP', 'MAX_ROUTES', 'MAX_WAITING_PER_ROUTE', 'MESSAGE_INVALID_REASONS', 'MESSAGE_STATES', 'ROUTE_REASONS', 'ROUTE_RULES', 'STOP_CAUSES', 'checkBody', 'checkEnvelope', 'checkKey',
    'checkRouteDefinitions', 'createLog', 'createRelay', 'fenceText', 'frameOf', 'isFailureReason', 'isFidelity', 'isMessageInvalidReason', 'isMessageState', 'isRouteId', 'isRouteReason', 'isRouteRule',
    'redactText', 'resolveRoutes',
  ].sort());
});
