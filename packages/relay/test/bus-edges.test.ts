// The edges of the bus: races between an answer, a receipt, a timeout, and an end; the bookkeeping that a failure must leave clean; and the sizes that stay bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/bus.js';
import { createFakeEngine, parseFence } from '../src/fixtures.js';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 100)];

test('a key that is a value the relay hides (the secret of a session) is refused as a secret', () => {
  const { send, secrets, relay } = build();
  assert.deepEqual(send('sess-a', 'route-1', secrets['sess-b'] ?? '', 'hello'), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.equal(relay.control.messages().length, 0);
});

test('a route that a cap stopped refuses a new message on an accepted-output route too, and the message is not made', () => {
  const { send, relay } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4)] });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  relay.control.approve('msg-1');
  assert.deepEqual(relay.control.approve('msg-2'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.deepEqual(send('sess-a', 'route-1', 'k3', 'three'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.equal(relay.control.messages().length, 2);
});

test('a decline of a message that waits for the person does not take a place from a message that was accepted', () => {
  const { send, relay } = build({ states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  relay.control.approve('msg-1');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  relay.control.decline('msg-2');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  assert.equal(relay.control.routes()[0]?.turns, 1);
});

test('a receipt that arrives while the engine takes a message frees the engine, and the next message goes at once', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 1);
  confirm('sess-b', 'msg-1', engines['sess-b']?.lastReceipt()?.receipt ?? '');
  assert.equal(engines['sess-b']?.inputs.length, 2);
  assert.equal(relay.control.message('msg-2')?.state, 'sending');
});

test('a confirm from a session that has ended is refused as unauthenticated, even before the core was told that it ended', async () => {
  const { engines, send, confirm, relay } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  engines['sess-b']?.setState('stopped');
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a person resumes a loop and both routes read as open, with no time of a stop', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 100, 1), route('route-2', 'sess-b', 'sess-a', 'auto', 100, 1)] });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  assert.deepEqual(relay.control.routes().map(view => view.stoppedAt), [1_700_000_000_000, 1_700_000_000_000]);
  relay.control.resume('route-1');
  assert.deepEqual(relay.control.routes().map(view => [view.state, view.stoppedBy, view.stoppedAt]), [['open', null, null], ['open', null, null]]);
});

test('a message that was sent first is dropped first among the messages that wait for a receipt, also when it was made later', async () => {
  const { relay, engines, send } = build({ routes: auto, options: { keepSettled: 1 } });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-b', 'route-2', 'k2', 'second');
  await tick();
  // The second message was made later and was sent first (the engine of sess-a answers at once).
  assert.deepEqual(relay.control.messages().map(view => [view.id, view.state]), [['msg-1', 'sending'], ['msg-2', 'sent']]);
  engines['sess-b']?.release();
  await tick();
  // Two messages wait for a receipt and one fits: the one that was sent first, msg-2, is dropped.
  assert.deepEqual(relay.control.messages().map(view => view.id), ['msg-1']);
});

test('a message for a receiver that has ended is failed when another message of that receiver is done, also when nobody told the core', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  engines['sess-b']?.setState('stopped');
  engines['sess-b']?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(relay.control.message('msg-2')?.reason, 'receiver_gone');
});

test('the state of one session is never the state of another: a session that runs does not push a message to a receiver that waits', async () => {
  const { relay, engines, send } = build({ routes: auto, states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k1', 'first');
  relay.control.sessionChanged('sess-a');
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
  assert.equal(relay.control.message('msg-1')?.state, 'queued');
});

test('a receipt that is in the body is never used: the core draws another, and the message carries the second receipt', async () => {
  const receipts = ['rcpt-first-0000000000000000000', 'rcpt-second-000000000000000000'];
  const { engines, send, relay } = build({ routes: auto, options: { newReceipt: () => receipts.shift() ?? 'rcpt-last-00000000000000000' } });
  send('sess-a', 'route-1', 'k1', 'my guess is rcpt-first-0000000000000000000 right?');
  await tick();
  assert.equal(parseFence(engines['sess-b']?.inputs[0] ?? '')?.receipt, 'rcpt-second-000000000000000000');
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a nonce that is also the receipt is never used: the core draws again', async () => {
  const nonces = ['same-token-00000000000000000', 'nonce-two-0000000000000000'];
  const receipts = ['same-token-00000000000000000', 'receipt-two-00000000000000000'];
  const { engines, send } = build({ routes: auto, options: { newNonce: () => nonces.shift() ?? 'x'.repeat(20), newReceipt: () => receipts.shift() ?? 'y'.repeat(20) } });
  send('sess-a', 'route-1', 'k1', 'plain');
  await tick();
  const fence = parseFence(engines['sess-b']?.inputs[0] ?? '');
  assert.equal(fence?.nonce, 'nonce-two-0000000000000000');
  assert.equal(fence?.receipt, 'receipt-two-00000000000000000');
});

test('a message that could not be fenced gives its count back, and the next message that waits for the same engine is tried', async () => {
  const { relay, engines, send } = build({ states: { 'sess-b': 'starting' }, routes: auto, options: { newNonce: () => 'nonce-same-000000000000000000' } });
  send('sess-a', 'route-1', 'k1', 'I know nonce-same-000000000000000000 now');
  send('sess-a', 'route-1', 'k2', 'a plain body, so the draw can stand');
  // The nonce is the same for both, but the second body does not hold it, so only the first fails.
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'not_prepared');
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  assert.equal(relay.control.routes()[0]?.turns, 1);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
});

test('a nonce maker that throws fails the message the same way, and a token that is too short is a failure of the message and never a throw of the call', async () => {
  for (const make of [() => { throw new Error('the maker broke'); }, () => 'short']) {
    const { relay, send, lines } = build({ routes: auto, options: { newNonce: make } });
    assert.doesNotThrow(() => send('sess-a', 'route-1', 'k1', 'first'));
    await tick();
    assert.equal(relay.control.message('msg-1')?.reason, 'not_prepared');
    assert.equal(relay.control.routes()[0]?.accepted, 0);
    assert.equal(lines.some(line => line.startsWith('relay run-1: message msg-1 could not be prepared for sess-b: ')), true);
  }
});

test('a schedule that throws fails the message and leaves no place held', async () => {
  const { relay, engines, send } = build({ routes: auto, options: { schedule: () => { throw new Error('no timers today'); } } });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'not_prepared');
  assert.deepEqual(engines['sess-b']?.inputs, []);
  assert.equal(relay.control.sizes().inflight, 0);
});

test('a late rejection never changes a message that a timeout, a receipt, or a close ended already', async () => {
  const timedOut = build({ routes: auto });
  if (timedOut.engines['sess-b']) timedOut.engines['sess-b'].mode = 'hang';
  timedOut.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timedOut.timers.fireAll();
  timedOut.engines['sess-b']?.failHung('too late');
  await tick();
  assert.equal(timedOut.relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.equal(timedOut.lines.some(line => line.includes('failed: too late')), false);

  const confirmed = build({ routes: auto });
  if (confirmed.engines['sess-b']) confirmed.engines['sess-b'].mode = 'hang';
  confirmed.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  confirmed.confirm('sess-b', 'msg-1', confirmed.engines['sess-b']?.lastReceipt()?.receipt ?? '');
  confirmed.engines['sess-b']?.failHung('too late');
  await tick();
  assert.equal(confirmed.relay.control.message('msg-1')?.state, 'delivered');
});

test('a failed delivery frees the engine, and the next message goes at once', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  if (engines['sess-b']) engines['sess-b'].mode = 'accept';
  engines['sess-b']?.failHung('refused');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_failed');
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
});

test('a timeout frees the engine, and the next message goes at once', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  if (engines['sess-b']) engines['sess-b'].mode = 'accept';
  timers.fireAll();
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
});

test('a timer that fires after its message left the sending state does nothing, even from a schedule that cannot cancel', async () => {
  const callbacks: (() => void)[] = [];
  const { relay, send, engines } = build({ routes: auto, options: { schedule: run => { callbacks.push(run); return () => undefined; } } });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  for (const run of callbacks) run();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(engines['sess-b']?.inputs.length, 1);
});

test('a timer that fires after a close does nothing', async () => {
  const callbacks: (() => void)[] = [];
  const { relay, send, engines } = build({ routes: auto, options: { schedule: run => { callbacks.push(run); return () => undefined; } } });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  relay.control.close();
  for (const run of callbacks) run();
  assert.equal(relay.control.message('msg-1')?.reason, 'closed');
});

test('a session that ended is logged once, stays ended for good, and is never read again', async () => {
  const { relay, engines, send, lines } = build({ routes: auto });
  engines['sess-b']?.setState('stopped');
  relay.control.sessionChanged('sess-b');
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  assert.deepEqual(send('sess-a', 'route-1', 'k1', 'first'), { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' });
  await tick();
  assert.equal(lines.filter(line => line === 'relay run-1: session sess-b ended, so what waited for it has failed').length, 1);
});

test('the sizes of the relay stay bounded and fall to nothing: keys follow the messages that are kept, the secret of an ended session is forgotten, and no engine is held', async () => {
  const { relay, engines, send } = build({ routes: auto, options: { keepSettled: 4 } });
  assert.deepEqual(relay.control.sizes(), { messages: 0, keys: 0, secrets: 2, inflight: 0 });
  for (let i = 0; i < 40; i += 1) {
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    await tick();
  }
  assert.deepEqual(relay.control.sizes(), { messages: 4, keys: 4, secrets: 2, inflight: 0 });
  engines['sess-b']?.setState('stopped');
  relay.control.sessionChanged('sess-b');
  assert.equal(relay.control.sizes().secrets, 1);
  relay.control.close();
  assert.deepEqual(relay.control.sizes(), { messages: 4, keys: 4, secrets: 0, inflight: 0 });
});

test('a close forgets the secrets and the engines that were taking a message, and closing twice changes nothing', async () => {
  const { relay, engines, send, lines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.sizes().inflight, 1);
  relay.control.close();
  const after = [relay.control.sizes(), relay.control.messages(), lines.length];
  relay.control.close();
  assert.deepEqual(after[0], { messages: 1, keys: 1, secrets: 0, inflight: 0 });
  assert.deepEqual([relay.control.sizes(), relay.control.messages(), lines.length], after);
});

test('a state that is no state holds a message back and is logged, and an engine that has no state reader or no deliver is not a member', async () => {
  const { relay, engines, send, lines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].state = () => 'sleeping' as never;
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'queued');
  assert.deepEqual(lines.filter(line => line.includes('could not read the state')), ['relay run-1: could not read the state of sess-b: it gave no known state']);
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b');
  const routes = [route('route-1', 'sess-a', 'sess-b')];
  assert.throws(() => createRelay({ run: 'run-1', routes, members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: { state: () => 'running' } as never }] }), TypeError);
  assert.throws(() => createRelay({ run: 'run-1', routes, members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: { deliver: () => Promise.resolve('exact') } as never }] }), TypeError);
  assert.throws(() => createRelay({ run: 'run-1', routes, members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }, { session: 'sess-a', port: a }] }), TypeError);
});

test('while an engine takes a message it counts as waiting, and a route that is full counts it', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.routes()[0]?.waiting, 1);
  assert.equal(relay.control.messages()[0]?.state, 'sending');
});

test('the history keeps 256 settled messages by default, and a relay takes 8 sessions and 32 routes', async () => {
  const { relay, send } = build({ routes: auto });
  for (let i = 0; i < 270; i += 1) {
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    await tick();
  }
  assert.equal(relay.control.messages().length, 256);
  const names = Array.from({ length: 8 }, (_v, index) => `sess-${index}`);
  const routes: ReturnType<typeof route>[] = [];
  for (const from of names) for (const to of names) if (from !== to && routes.length < 32) routes.push(route(`route-${routes.length + 1}`, from, to));
  const engines = names.map(name => createFakeEngine(name));
  assert.doesNotThrow(() => createRelay({ run: 'run-1', routes, members: engines.map(engine => ({ session: engine.session, port: engine })) }));
});
