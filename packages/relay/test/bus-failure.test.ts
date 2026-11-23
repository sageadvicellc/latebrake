// What is left after a failure: no message stuck, no count, place, timer, or secret left behind, and every history bounded by the order in which things ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 100)];

test('a close fails every message that has not reached the engine, with the reason closed, and gives the counts back', async () => {
  const { relay, send, engines } = build({ states: { 'sess-b': 'waiting' }, routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4), route('route-2', 'sess-b', 'sess-a')] });
  send('sess-a', 'route-1', 'k1', 'queued one');
  send('sess-b', 'route-2', 'k2', 'pending one');
  relay.control.close();
  assert.deepEqual(relay.control.messages().map(view => [view.state, view.reason]), [['failed', 'closed'], ['failed', 'closed']]);
  assert.deepEqual(relay.control.routes().map(view => [view.accepted, view.waiting]), [[0, 0], [0, 0]]);
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
});

test('a close while an engine takes a message fails it with closed, cancels the timer, and a late answer changes nothing', async () => {
  const { relay, send, engines, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  relay.control.close();
  assert.equal(timers.live(), 0);
  assert.equal(relay.control.message('msg-1')?.reason, 'closed');
  engines['sess-b']?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'closed');
});

test('a close is final: the secrets are forgotten, a confirm is refused as closed, a second close does nothing, and the reads still answer', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  relay.control.close();
  relay.control.close();
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(relay.control.closed, true);
});

test('a receiver that ends fails what waits for it with receiver_gone, in every state before the engine took it, and gives the counts back', async () => {
  const { relay, send, engines } = build({ states: { 'sess-b': 'waiting' }, routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  send('sess-a', 'route-1', 'k1', 'queued');
  engines['sess-b']?.setState('failed');
  relay.control.sessionChanged('sess-b');
  assert.deepEqual(relay.control.messages().map(view => [view.state, view.reason]), [['failed', 'receiver_gone']]);
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
  await tick();
});

test('a receiver that ends while the engine takes a message fails it with receiver_gone, and the timer is cancelled', async () => {
  const { relay, send, engines, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  engines['sess-b']?.setState('stopped');
  relay.control.sessionChanged('sess-b');
  assert.equal(relay.control.message('msg-1')?.reason, 'receiver_gone');
  assert.equal(timers.live(), 0);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
});

test('a session that has ended can no longer write or confirm, and its secret is forgotten', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  engines['sess-b']?.setState('stopped');
  relay.control.sessionChanged('sess-b');
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.deepEqual(send('sess-b', 'route-2', 'k2', 'late'), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a message that waits for the person from a sender that has ended may still be approved, and it still reaches a receiver that runs', async () => {
  const { relay, send, engines } = build();
  send('sess-a', 'route-1', 'k1', 'last words');
  engines['sess-a']?.setState('stopped');
  relay.control.sessionChanged('sess-a');
  assert.equal(relay.control.message('msg-1')?.state, 'pending');
  assert.equal(relay.control.approve('msg-1').ok, true);
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a call about a session that is not a member, or is no id, does nothing and throws nothing', () => {
  const { relay } = build();
  for (const value of ['sess-zzz', 5, null, {}, '']) assert.doesNotThrow(() => relay.control.sessionChanged(value));
});

test('the history is bounded: with room for 3 settled messages, the one that ended first goes first, in the order of the end and not the order of the send', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto, options: { keepSettled: 3 } });
  const ids: string[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const reply = send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    assert.ok(reply.ok);
    ids.push(reply.id);
    await tick();
  }
  // Message 1 ends last: its receipt comes after the later ones are confirmed.
  const receipts = (engines['sess-b']?.inputs ?? []).map(text => text.match(/send the receipt (\S+) to/)?.[1] ?? '');
  assert.equal(confirm('sess-b', 'msg-2', receipts[1] ?? '').ok, true);
  assert.equal(confirm('sess-b', 'msg-3', receipts[2] ?? '').ok, true);
  assert.equal(confirm('sess-b', 'msg-1', receipts[0] ?? '').ok, true);
  send('sess-a', 'route-1', 'k4', 'body 4');
  await tick();
  // 4 messages are settled and 3 fit: the one that ended first, message 2, is dropped. Message 1 ended last, so it stays.
  assert.deepEqual(relay.control.messages().map(view => view.id), ['msg-1', 'msg-3', 'msg-4']);
  assert.equal(relay.control.message('msg-2'), undefined);
});

test('a message that is dropped from the history takes its key and its receipt with it: a confirm for it is a refusal of an unknown message, and the key is free', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto, options: { keepSettled: 1 } });
  send('sess-a', 'route-1', 'k1', 'body 1');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  send('sess-a', 'route-1', 'k2', 'body 2');
  await tick();
  assert.equal(relay.control.message('msg-1'), undefined);
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
  assert.deepEqual(send('sess-a', 'route-1', 'k1', 'body 1'), { ok: true, id: 'msg-3', state: 'sending', duplicate: false });
});

test('a message that is sent and waits for a receipt is dropped after the ones that ended, and a message that is live is never dropped', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto, options: { keepSettled: 2 } });
  send('sess-a', 'route-1', 'k1', 'one');
  await tick();
  send('sess-a', 'route-1', 'k2', 'two');
  await tick();
  const receipts = (engines['sess-b']?.inputs ?? []).map(text => text.match(/send the receipt (\S+) to/)?.[1] ?? '');
  confirm('sess-b', 'msg-2', receipts[1] ?? '');
  // msg-1 is sent, msg-2 delivered. A third message that is declined pushes out a settled one: the delivered one ended, so it goes first.
  if (engines['sess-b']) engines['sess-b'].setState('waiting');
  send('sess-a', 'route-1', 'k3', 'three');
  send('sess-a', 'route-1', 'k4', 'four');
  assert.equal(relay.control.message('msg-3')?.state, 'queued');
  relay.control.decline('msg-3');
  assert.deepEqual(relay.control.messages().map(view => view.id), ['msg-1', 'msg-3', 'msg-4']);
  assert.equal(relay.control.message('msg-4')?.state, 'queued');
});

test('a long run keeps the history, the keys, and the counts inside their bounds, and ends with no timer', async () => {
  const { relay, send, engines, timers } = build({ routes: auto, options: { keepSettled: 8 } });
  for (let i = 0; i < 300; i += 1) {
    if (engines['sess-b']) engines['sess-b'].mode = i % 4 === 0 ? 'reject' : 'accept';
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    await tick();
  }
  assert.equal(relay.control.messages().length, 8);
  assert.equal(relay.control.routes()[0]?.accepted, 300);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
  assert.equal(timers.live(), 0);
  // The newest key is still held, and the oldest is free again.
  assert.equal((send('sess-a', 'route-1', 'k299', 'body 299') as { duplicate?: boolean }).duplicate, true);
  assert.equal((send('sess-a', 'route-1', 'k0', 'body 0') as { duplicate?: boolean }).duplicate, false);
});

test('every message that goes in leaves in one of the states that name an end: after a mix of failures, none is stuck pending, queued, or sending, with no person and no timer to act', async () => {
  const { relay, send, engines, timers } = build({ routes: auto });
  const modes = ['accept', 'reject', 'throw', 'garbage', 'accept'] as const;
  for (const [i, mode] of modes.entries()) {
    if (engines['sess-b']) engines['sess-b'].mode = mode;
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    await tick();
  }
  assert.deepEqual(relay.control.messages().map(view => view.state), ['sent', 'failed', 'failed', 'failed', 'sent']);
  assert.equal(timers.live(), 0);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
});

test('the log never holds a body, a session secret, a receipt, or a nonce, over a whole exchange with failures', async () => {
  const { relay, send, engines, lines, secrets, timers } = build({ routes: auto });
  send('sess-a', 'route-1', 'k1', 'SECRET-LOOKING-BODY-1 plain words');
  await tick();
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k2', 'SECRET-LOOKING-BODY-2 plain words');
  await tick();
  timers.fireAll();
  relay.write.send({ session: 'sess-a', secret: 'wrong', route: 'route-1', key: 'k3', body: 'SECRET-LOOKING-BODY-3' });
  relay.control.close();
  const all = lines.join('\n');
  for (const needle of ['SECRET-LOOKING-BODY', 'plain words', secrets['sess-a'] ?? '?', secrets['sess-b'] ?? '?', 'rcpt-', 'nonce-']) assert.equal(all.includes(needle), false, needle);
  assert.ok(lines.length > 0);
});

test('a log that throws never changes what the relay does or answers', async () => {
  const { relay, send } = build({ routes: auto, options: { log: () => { throw new Error('the log broke'); } } });
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(send('sess-a', 'route-1', 'k1', 'first').ok, true);
    await tick();
  } finally {
    process.stderr.write = original;
  }
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(written.some(line => line.includes('the log sink threw: the log broke')), true);
});

test('a port that throws from its state reader or its deliver never leaves a message sending, and the place for the next one is free', async () => {
  const { relay, send, engines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'throw';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  if (engines['sess-b']) engines['sess-b'].mode = 'accept';
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  assert.deepEqual(relay.control.messages().map(view => view.state), ['failed', 'sent']);
});

test('the relay holds no listener on the process and no timer after a whole run is closed', async () => {
  const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'beforeExit'] as const;
  const before = events.map(name => process.listenerCount(name));
  const { relay, send, engines, timers } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  for (let i = 0; i < 4; i += 1) send('sess-a', 'route-1', `k${i}`, `body ${i}`);
  await tick();
  assert.deepEqual(events.map(name => process.listenerCount(name)), before);
  relay.control.close();
  assert.equal(timers.live(), 0);
  assert.deepEqual(events.map(name => process.listenerCount(name)), before);
});
