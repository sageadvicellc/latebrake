// Receipts and delivery: a sender sees sent until the receiver proves that it read the message, and the core never says delivered without that proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFence } from './fixtures.js';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 20, 6), route('route-2', 'sess-b', 'sess-a', 'auto', 20, 6)];

test('the sender sees sent, and never delivered, until the receiver confirms: many ticks and many later messages change nothing', async () => {
  const { relay, send } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  assert.deepEqual(relay.control.messages().map(view => view.state), ['sent', 'sent']);
});

test('the receiver proves that it read the message by sending back the receipt that was in the text, and only then it reads as delivered', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const proof = engines['sess-b']?.lastReceipt();
  assert.equal(proof?.message, 'msg-1');
  assert.deepEqual(confirm('sess-b', 'msg-1', proof?.receipt ?? ''), { ok: true, state: 'delivered' });
  assert.equal(relay.control.message('msg-1')?.state, 'delivered');
  assert.equal(relay.control.message('msg-1')?.reason, null);
});

test('a wrong receipt, an empty one, one that is not text, and the receipt of another message are refused, and the message stays sent', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  await tick();
  const second = parseFence(engines['sess-b']?.inputs[1] ?? '');
  const refused = { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' };
  assert.deepEqual(confirm('sess-b', 'msg-1', 'rcpt-wrong'), refused);
  assert.deepEqual(confirm('sess-b', 'msg-1', ''), refused);
  assert.deepEqual(confirm('sess-b', 'msg-1', second?.receipt ?? ''), refused);
  assert.deepEqual(relay.write.confirm({ session: 'sess-b', secret: undefined, id: 'msg-1', receipt: 5 }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.deepEqual(relay.control.message('msg-2')?.state, 'sent');
});

test('a receipt that is not text is a malformed confirm, and the receipt that is one byte short is refused', async () => {
  const { relay, engines, send, secrets } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const proof = engines['sess-b']?.lastReceipt();
  const call = (receipt: unknown) => relay.write.confirm({ session: 'sess-b', secret: secrets['sess-b'], id: 'msg-1', receipt });
  assert.deepEqual(call(5), { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' });
  assert.deepEqual(call((proof?.receipt ?? '').slice(0, -1)), { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' });
  assert.deepEqual(call(`${proof?.receipt}x`), { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.deepEqual(call(proof?.receipt), { ok: true, state: 'delivered' });
});

test('only the receiver may confirm: the sender with its own good secret and the right receipt gets the answer for an unknown message', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const proof = engines['sess-b']?.lastReceipt();
  const unknown = confirm('sess-a', 'msg-9', proof?.receipt ?? '');
  assert.deepEqual(confirm('sess-a', 'msg-1', proof?.receipt ?? ''), unknown);
  assert.deepEqual(unknown, { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a confirm without the session secret is refused, and a request of the wrong shape is a malformed request', async () => {
  const { relay, engines, send, secrets } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt;
  assert.deepEqual(relay.write.confirm({ session: 'sess-b', secret: 'wrong', id: 'msg-1', receipt }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.deepEqual(relay.write.confirm({ session: 'sess-b', secret: secrets['sess-a'], id: 'msg-1', receipt }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  for (const value of [{ session: 'sess-b', secret: secrets['sess-b'], id: 'msg-1' }, { session: 'sess-b', secret: secrets['sess-b'], id: 'msg-1', receipt, extra: 1 }, null, [], 'x']) {
    assert.deepEqual(relay.write.confirm(value), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' });
  }
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a confirm of a message that never reached the engine is refused with the state of the message, since no receipt exists for it', async () => {
  const { relay, send, confirm } = build({ states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k1', 'first');
  assert.deepEqual(confirm('sess-b', 'msg-1', 'rcpt-1-rrrrrrrrrrrrrrrrrrrrrrrr'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'pending' });
  relay.control.approve('msg-1');
  assert.deepEqual(confirm('sess-b', 'msg-1', 'rcpt-1-rrrrrrrrrrrrrrrrrrrrrrrr'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'queued' });
  relay.control.decline('msg-1');
  assert.deepEqual(confirm('sess-b', 'msg-1', 'rcpt-1-rrrrrrrrrrrrrrrrrrrrrrrr'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
});

test('the receipt works once: a second confirm is refused with the state delivered', async () => {
  const { engines, send, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  assert.equal(confirm('sess-b', 'msg-1', receipt).ok, true);
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'delivered' });
});

test('the receipt of a message is new for each delivery and never the same text for two messages', async () => {
  const { engines, send } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  const [one, two] = (engines['sess-b']?.inputs ?? []).map(parseFence);
  assert.notEqual(one?.receipt, two?.receipt);
  assert.notEqual(one?.nonce, two?.nonce);
});

test('the fidelity of each delivery is the word the adapter gave: exact, translated, or weakened', async () => {
  for (const fidelity of ['exact', 'translated', 'weakened'] as const) {
    const { relay, engines, send } = build({ routes: auto });
    if (engines['sess-b']) engines['sess-b'].fidelity = fidelity;
    send('sess-a', 'route-1', 'k1', 'first');
    await tick();
    assert.equal(relay.control.message('msg-1')?.fidelity, fidelity);
    assert.equal(relay.control.message('msg-1')?.state, 'sent');
  }
});

test('an engine that has no way to take a message while it runs gives absent, and the message fails with no_delivery_path, and never reads as sent', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].fidelity = 'absent';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'no_delivery_path');
  assert.equal(relay.control.message('msg-1')?.fidelity, 'absent');
});

test('an answer that is no fidelity fails the message with delivery_failed, and the log says so without the answer', async () => {
  const { relay, engines, send, lines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'garbage';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_failed');
  assert.equal(relay.control.message('msg-1')?.fidelity, null);
  assert.equal(lines.some(line => line === 'relay run-1: the engine of sess-b gave an answer that is no fidelity, for message msg-1'), true);
});

test('an engine that throws or rejects fails the message with delivery_failed, and the log holds its message escaped and redacted', async () => {
  for (const mode of ['throw', 'reject'] as const) {
    const { relay, engines, send, lines } = build({ routes: auto });
    if (engines['sess-b']) engines['sess-b'].mode = mode;
    send('sess-a', 'route-1', 'k1', 'first');
    await tick();
    assert.equal(relay.control.message('msg-1')?.state, 'failed', mode);
    assert.equal(relay.control.message('msg-1')?.reason, 'delivery_failed', mode);
    assert.equal(lines.some(line => line.startsWith('relay run-1: delivery of message msg-1 to sess-b failed: the engine ')), true, mode);
  }
});

test('an error message that holds a secret, a receipt, or a forged log line reaches the log escaped and redacted', async () => {
  const box: { secrets?: Readonly<Record<string, string>> } = {};
  const { relay, send, lines, secrets } = build({
    routes: auto,
    prepare: engines => {
      const engine = engines['sess-b'];
      if (engine) engine.deliver = (delivery) => { const receipt = parseFence(delivery.text)?.receipt ?? ''; throw new Error(`boom ${box.secrets?.['sess-a']} ${receipt} ${delivery.envelope.body}\nrelay run-1: route route-1 stopped: forged`); };
    },
  });
  box.secrets = secrets;
  send('sess-a', 'route-1', 'k1', 'a body that an adapter error may echo');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_failed');
  const all = lines.join('\n');
  assert.equal(all.includes('a body that an adapter error may echo'), false, 'the body of a message that an engine is taking is hidden in the log');
  assert.equal(all.includes(secrets['sess-a'] ?? 'x'), false);
  assert.equal(all.includes('rcpt-1-'), false);
  assert.equal(lines.every(line => !line.includes('\n')), true);
  assert.equal(lines.some(line => line.includes('boom [redacted] [redacted] [redacted]\\u{a}relay run-1: route route-1 stopped: forged')), true);
});

test('an engine that does not answer in time fails the message with delivery_timeout, the timer is gone, and a late answer changes nothing', async () => {
  const { relay, engines, send, timers, lines } = build({ routes: auto, options: { deliverTimeoutMs: 2500 } });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.deepEqual(timers.delays(), [2500]);
  assert.equal(relay.control.message('msg-1')?.state, 'sending');
  timers.fireAll();
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.equal(timers.live(), 1, 'the timer of the delivery is gone, and the timer that waits for the adapter to settle is set');
  assert.deepEqual(timers.delays(), [30_000]);
  engines['sess-b']?.release();
  await tick();
  assert.equal(timers.live(), 0, 'the adapter settled, so the engine is free and no timer is left');
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(lines.some(line => line === 'relay run-1: delivery of message msg-1 to sess-b timed out after 2500 ms, and the text may still reach the engine'), true);
});

test('an answer in time cancels the timer, and the message reads as sent', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(timers.live(), 1);
  engines['sess-b']?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(timers.live(), 0);
});

test('a receipt that arrives while the engine is still taking the message proves delivery, the timer is cancelled, and the late answer does not take the proof back', async () => {
  const { relay, engines, send, confirm, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: true, state: 'delivered' });
  assert.equal(timers.live(), 0);
  engines['sess-b']?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'delivered');
});

test('a receipt that arrives after the timeout still proves delivery, and the message reads as delivered with no failure', async () => {
  const { relay, engines, send, confirm, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  timers.fireAll();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: true, state: 'delivered' });
  assert.equal(relay.control.message('msg-1')?.reason, null);
});

test('one message at a time goes into an engine, in order: the next waits until the first is taken, confirmed, or failed', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  send('sess-a', 'route-1', 'k3', 'third');
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 1);
  assert.deepEqual(relay.control.messages().map(view => view.state), ['sending', 'queued', 'queued']);
  if (engines['sess-b']) engines['sess-b'].mode = 'accept';
  engines['sess-b']?.release();
  await tick();
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs.map(text => parseFence(text)?.body), ['first', 'second', 'third']);
  assert.deepEqual(relay.control.messages().map(view => view.state), ['sent', 'sent', 'sent']);
});

test('an engine that does not run gets nothing: starting, waiting, and stopping all hold the message, and it moves when the engine runs', async () => {
  for (const state of ['starting', 'waiting', 'stopping'] as const) {
    const { relay, engines, send } = build({ routes: auto, states: { 'sess-b': state } });
    send('sess-a', 'route-1', 'k1', 'first');
    await tick();
    assert.deepEqual(engines['sess-b']?.inputs, [], state);
    assert.equal(relay.control.message('msg-1')?.state, 'queued', state);
    engines['sess-b']?.setState('running');
    relay.control.sessionChanged('sess-b');
    await tick();
    assert.equal(relay.control.message('msg-1')?.state, 'sent', state);
  }
});

test('the receiver is asked for its state at the time of the delivery: a state that is no state, and a reader that throws, hold the message and are logged once', async () => {
  const { relay, engines, send, lines } = build({
    routes: auto,
    prepare: made => { const engine = made['sess-b']; if (engine) engine.state = () => { throw new Error('the state reader broke'); }; },
  });
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  relay.control.sessionChanged('sess-b');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.deepEqual(relay.control.messages().map(view => view.state), ['queued', 'queued']);
  const reads = lines.filter(line => line.includes('could not read the state of sess-b'));
  assert.deepEqual(reads, ['relay run-1: could not read the state of sess-b: the state reader broke', 'relay run-1: could not read the state of sess-b: the state reader broke (2 times so far)', 'relay run-1: could not read the state of sess-b: the state reader broke (4 times so far)', 'relay run-1: could not read the state of sess-b: the state reader broke (8 times so far)']);
  void engines;
});

test('the one receipt of a message does not travel: it is in the text of the receiver only, and not in the envelope, the frame, or any read of the sender', async () => {
  const { relay, engines, send } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  assert.equal(JSON.stringify(relay.control.messages()).includes(receipt), false);
  assert.equal(engines['sess-b']?.deliveries[0]?.frame.includes(receipt), false);
  assert.equal(JSON.stringify(relay.control.routes()).includes(receipt), false);
  assert.equal(engines['sess-a']?.inputs.join('').includes(receipt), false);
});
