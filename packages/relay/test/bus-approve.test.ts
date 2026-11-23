// The bus, the person's side: each message on an accepted-output route needs the person's approval, a decline is final, and an approval never applies to a message that is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, route, tick } from './support.js';

test('an approval moves the message that it names, and no other: of two pending messages, only the approved one reaches the receiver', async () => {
  const { relay, engines, send } = build();
  send('sess-a', 'route-1', 'k1', 'first body');
  send('sess-a', 'route-1', 'k2', 'second body');
  assert.deepEqual(relay.control.approve('msg-2'), { ok: true, state: 'sending', reason: null });
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 1);
  assert.equal(engines['sess-b']?.inputs[0]?.includes('second body'), true);
  assert.equal(engines['sess-b']?.inputs[0]?.includes('first body'), false);
  assert.equal(relay.control.message('msg-1')?.state, 'pending');
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
});

test('the person may approve messages in any order, and each moves once', async () => {
  const { relay, engines, send } = build();
  for (const n of [1, 2, 3]) send('sess-a', 'route-1', `k${n}`, `body ${n}`);
  for (const id of ['msg-3', 'msg-1', 'msg-2']) {
    assert.equal(relay.control.approve(id).ok, true);
    await tick();
  }
  assert.deepEqual(engines['sess-b']?.inputs.map(text => /body (\d)/.exec(text)?.[1]), ['3', '1', '2']);
});

test('an approval of a message that was approved already is refused with the state of the message, and delivers nothing twice', async () => {
  const { relay, engines, send } = build();
  send('sess-a', 'route-1', 'k', 'hello');
  relay.control.approve('msg-1');
  await tick();
  assert.deepEqual(relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'sent' });
  assert.equal(engines['sess-b']?.inputs.length, 1);
});

test('an approval of an id that no message has, or of a value that is not an id, is a refusal that names no message', () => {
  const { relay } = build();
  for (const id of ['msg-9', '', 5, null, undefined, {}, '__proto__']) assert.deepEqual(relay.control.approve(id), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
});

test('a decline is final: the message is never delivered, an approval after it is refused, and a repeat of the message is dropped', async () => {
  const { relay, engines, send } = build();
  send('sess-a', 'route-1', 'k', 'hello');
  assert.deepEqual(relay.control.decline('msg-1'), { ok: true, state: 'declined', reason: null });
  assert.deepEqual(relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  assert.deepEqual(relay.control.decline('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
});

test('a decline of an unknown id is a refusal, and a decline of a message that was sent already is refused with its state', async () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4), route('route-2', 'sess-b', 'sess-a')] });
  assert.deepEqual(relay.control.decline('msg-9'), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
  send('sess-a', 'route-1', 'k', 'hello');
  await tick();
  assert.deepEqual(relay.control.decline('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'sent' });
});

test('the person may withdraw a message that is accepted and waits for a receiver that does not run yet', async () => {
  const { relay, engines, send } = build({ states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k', 'hello');
  assert.deepEqual(relay.control.approve('msg-1'), { ok: true, state: 'queued', reason: null });
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  assert.deepEqual(relay.control.decline('msg-1'), { ok: true, state: 'declined', reason: null });
  assert.equal(relay.control.routes()[0]?.accepted, 0, 'the count of the message is given back');
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
});

test('an approval of a message whose receiver has ended fails the message with receiver_gone, and the refusal has its own code', () => {
  const { relay, engines, send } = build();
  send('sess-a', 'route-1', 'k', 'hello');
  engines['sess-b']?.setState('stopped');
  assert.deepEqual(relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' });
  assert.deepEqual(relay.control.message('msg-1')?.state, 'failed');
  assert.deepEqual(relay.control.message('msg-1')?.reason, 'receiver_gone');
  assert.deepEqual(relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'failed' });
});

test('an approval never applies to a message that a close or the end of the receiver dropped, and a stopped route refuses it without dropping the message', async () => {
  // A stop of the route: the approval is refused, the message stays pending, and nothing reaches the engine.
  const stopped = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4)] });
  stopped.send('sess-a', 'route-1', 'k1', 'one');
  stopped.send('sess-a', 'route-1', 'k2', 'two');
  assert.equal(stopped.relay.control.approve('msg-1').ok, true);
  assert.deepEqual(stopped.relay.control.approve('msg-2'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.equal(stopped.relay.control.message('msg-2')?.state, 'pending');
  await tick();
  assert.equal(stopped.engines['sess-b']?.inputs.length, 1);
  // A close.
  const closed = build();
  closed.send('sess-a', 'route-1', 'k1', 'one');
  closed.relay.control.close();
  assert.deepEqual(closed.relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.equal(closed.relay.control.message('msg-1')?.reason, 'closed');
  // The receiver ends before the person decides.
  const gone = build();
  gone.send('sess-a', 'route-1', 'k1', 'one');
  gone.engines['sess-b']?.setState('failed');
  gone.relay.control.sessionChanged('sess-b');
  assert.equal(gone.relay.control.message('msg-1')?.reason, 'receiver_gone');
  assert.deepEqual(gone.relay.control.approve('msg-1'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'failed' });
  await tick();
  assert.deepEqual(gone.engines['sess-b']?.inputs, []);
});

test('an approved message waits while the receiver is not running, and moves when it runs', async () => {
  const { relay, engines, send } = build({ states: { 'sess-b': 'starting' } });
  send('sess-a', 'route-1', 'k', 'hello');
  assert.deepEqual(relay.control.approve('msg-1'), { ok: true, state: 'queued', reason: null });
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 1);
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a message on an auto route is never pending: it is accepted when it is sent, and each one is logged without its body', async () => {
  const { relay, send, lines } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  send('sess-a', 'route-1', 'k', 'a body that must not be logged');
  await tick();
  assert.notEqual(relay.control.message('msg-1')?.state, 'pending');
  assert.deepEqual(lines, ['relay run-1: message msg-1 accepted on the auto route route-1, from sess-a to sess-b']);
});

test('an accepted-output route logs nothing when a message is accepted by the person, since the person saw it', async () => {
  const { relay, send, lines } = build();
  send('sess-a', 'route-1', 'k', 'hello');
  relay.control.approve('msg-1');
  await tick();
  assert.deepEqual(lines, []);
});

test('a control call that is made after the relay closed is refused as closed, and the reads still work', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'k', 'hello');
  relay.control.close();
  assert.deepEqual(relay.control.decline('msg-1'), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.deepEqual(relay.control.resume('route-1'), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.equal(relay.control.messages().length, 1);
  assert.equal(relay.control.routes().length, 2);
  assert.equal(relay.control.closed, true);
});
