// The ledger of keys, the memory of what the person declined, the pause after too many declines, and the answers that say why a message waits or is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRelay } from '../src/bus.js';
import { createFakeEngine, parseFence } from './fixtures.js';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 100)];

test('a key is held by the ledger and not by the message: after the history dropped a declined message, the same key and body are a repeat, and the person is not asked again', () => {
  const { relay, send } = build({ options: { keepSettled: 1 } });
  send('sess-a', 'route-1', 'ask', 'Please do the risky thing.');
  relay.control.decline('msg-1');
  for (let i = 0; i < 3; i += 1) {
    send('sess-a', 'route-1', `other-${i}`, `something else ${i}`);
    relay.control.decline(`msg-${i + 2}`);
  }
  assert.equal(relay.control.message('msg-1'), undefined, 'the history dropped it');
  assert.deepEqual(send('sess-a', 'route-1', 'ask', 'Please do the risky thing.'), { ok: true, id: 'msg-1', state: 'evicted', reason: null, duplicate: true });
  assert.equal(relay.control.messages().filter(view => view.state === 'pending').length, 0);
});

test('the same key for another body is refused after the message was dropped too', () => {
  const { relay, send } = build({ options: { keepSettled: 1 } });
  send('sess-a', 'route-1', 'ask', 'first body');
  relay.control.decline('msg-1');
  send('sess-a', 'route-1', 'x', 'second body');
  relay.control.decline('msg-2');
  assert.equal(relay.control.message('msg-1'), undefined);
  assert.deepEqual(send('sess-a', 'route-1', 'ask', 'a different body'), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key_reused' });
});

test('the ledger keeps the newest keys, oldest first out, up to the room that is set (16 here), and a key that left it is taken as new', () => {
  const { relay, send } = build({ routes: auto, options: { keepKeys: 16, keepSettled: 4, declineCap: 100 } });
  for (let i = 0; i < 20; i += 1) {
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    relay.control.decline(`msg-${i + 1}`);
  }
  assert.equal(relay.control.sizes().keys, 16);
  assert.equal((send('sess-a', 'route-1', 'k19', 'body 19') as { duplicate?: boolean }).duplicate, true);
  assert.equal((send('sess-a', 'route-1', 'k4', 'body 4') as { duplicate?: boolean }).duplicate, true);
  // k3 is the oldest that left the ledger. Its body was declined, so it is refused as a body that was declined, and not as a repeat.
  assert.deepEqual(send('sess-a', 'route-1', 'k3', 'body 3'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  assert.equal((send('sess-a', 'route-1', 'k0', 'a body that was not declined') as { duplicate?: boolean }).duplicate, false);
});

test('a body that the person declined is refused under another key on the same route, with the state declined, and no proposal is held', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'ask-1', 'Please do the risky thing.');
  relay.control.decline('msg-1');
  assert.deepEqual(send('sess-a', 'route-1', 'ask-2', 'Please do the risky thing.'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  assert.equal(relay.control.messages().length, 1);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
});

test('a declined body is refused on its own route only: another route may carry it', () => {
  const { relay, send } = build({ sessions: ['sess-a', 'sess-b', 'sess-c'], routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-a', 'sess-c')] });
  send('sess-a', 'route-1', 'k1', 'the same words');
  relay.control.decline('msg-1');
  assert.equal(send('sess-a', 'route-2', 'k2', 'the same words').ok, true);
});

test('a resume forgets the declined bodies of the route, also on a route that is open: the body is asked again, as a new message', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'ask-1', 'Please do the risky thing.');
  relay.control.decline('msg-1');
  relay.control.resume('route-1');
  assert.equal(relay.control.sizes().declined, 0);
  assert.deepEqual(send('sess-a', 'route-1', 'ask-2', 'Please do the risky thing.'), { ok: true, id: 'msg-2', state: 'pending', reason: null, duplicate: false });
});

test('a resume of one route keeps what was declined on another route', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'k1', 'words one');
  relay.control.decline('msg-1');
  send('sess-b', 'route-2', 'k2', 'words two');
  relay.control.decline('msg-2');
  relay.control.resume('route-2');
  assert.equal(relay.control.sizes().declined, 1);
  assert.equal(send('sess-a', 'route-1', 'k3', 'words one').ok, false);
});

test('a decline of a message that waited for a receiver counts and is remembered as a body too', () => {
  const { relay, send } = build({ routes: auto, states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k1', 'queued words');
  relay.control.decline('msg-1');
  assert.deepEqual(send('sess-a', 'route-1', 'k2', 'queued words'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  assert.equal(relay.control.routes()[0]?.declines, 1);
});

test('the person declines three proposals and the route is paused: with a decline cap of 3 the next proposal is refused with the paused code, and an approval too', () => {
  const { relay, send, lines } = build({ options: { declineCap: 3 } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(send('sess-a', 'route-1', `k${i}`, `proposal ${i}`).ok, true);
    relay.control.decline(`msg-${i + 1}`);
  }
  assert.deepEqual(relay.control.routes()[0], { ...relay.control.routes()[0], state: 'stopped', stoppedBy: 'declines', declines: 3, stoppedAt: 1_700_000_000_000 });
  assert.deepEqual(send('sess-a', 'route-1', 'k9', 'proposal 9'), { ok: false, code: 'GAUGE_RELAY_ROUTE_PAUSED' });
  assert.equal(lines.includes('relay run-1: route route-1 paused: the person declined 3 of its messages'), true);
  assert.equal(relay.control.routes()[1]?.state, 'open', 'the other direction is not paused');
});

test('a pause leaves what waits for the person pending, and the approval is refused with the paused code until the person resumes', () => {
  const { relay, send } = build({ options: { declineCap: 2 } });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  send('sess-a', 'route-1', 'k3', 'three');
  relay.control.decline('msg-1');
  relay.control.decline('msg-2');
  assert.deepEqual(relay.control.approve('msg-3'), { ok: false, code: 'GAUGE_RELAY_ROUTE_PAUSED' });
  assert.equal(relay.control.message('msg-3')?.state, 'pending');
  relay.control.resume('route-1');
  assert.equal(relay.control.approve('msg-3').ok, true);
  assert.equal(relay.control.routes()[0]?.declines, 0);
});

test('3,200 declined proposals do not leave the route open: the route is paused at the 8th with the default cap', () => {
  const { relay, send } = build();
  let refused = 0;
  for (let i = 0; i < 40; i += 1) {
    const reply = send('sess-a', 'route-1', `k${i}`, `proposal ${i}`);
    if (!reply.ok) { refused += 1; continue; }
    relay.control.decline(reply.id);
  }
  assert.equal(relay.control.routes()[0]?.state, 'stopped');
  assert.equal(relay.control.routes()[0]?.declines, 8);
  assert.equal(refused, 32);
});

test('a resume clears the pause: the route opens, the count of declines starts at zero, and the other routes are not touched', () => {
  const { relay, send } = build({ options: { declineCap: 1 } });
  send('sess-a', 'route-1', 'k1', 'one');
  relay.control.decline('msg-1');
  assert.equal(relay.control.routes()[0]?.state, 'stopped');
  assert.deepEqual(relay.control.resume('route-1'), { ok: true, reopened: ['route-1'] });
  assert.deepEqual([relay.control.routes()[0]?.state, relay.control.routes()[0]?.stoppedBy, relay.control.routes()[0]?.stoppedAt, relay.control.routes()[0]?.declines], ['open', null, null, 0]);
});

test('a message cap that stopped a route is not turned into a pause by a decline, and keeps its cause', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4), route('route-2', 'sess-b', 'sess-a')], options: { declineCap: 1 } });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  relay.control.approve('msg-1');
  relay.control.approve('msg-2');
  assert.equal(relay.control.routes()[0]?.stoppedBy, 'message_cap');
  relay.control.decline('msg-2');
  assert.equal(relay.control.routes()[0]?.stoppedBy, 'message_cap');
});

test('a decline on a route that a message cap stopped is no pause, and writes no line that says so', () => {
  const { relay, send, lines } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4), route('route-2', 'sess-b', 'sess-a')], options: { declineCap: 1 } });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  relay.control.approve('msg-1');
  relay.control.approve('msg-2');
  relay.control.decline('msg-2');
  assert.equal(relay.control.routes()[0]?.stoppedBy, 'message_cap');
  assert.equal(lines.some(line => line.includes('paused')), false);
});

test('a message that is dropped after it ended writes no line, since no receipt waits for it', async () => {
  const { send, lines, confirm, engines } = build({ routes: auto, options: { keepSettled: 1 } });
  send('sess-a', 'route-1', 'k1', 'one');
  await tick();
  confirm('sess-b', 'msg-1', engines['sess-b']?.lastReceipt()?.receipt ?? '');
  send('sess-a', 'route-1', 'k2', 'two');
  await tick();
  assert.equal(lines.some(line => line.includes('dropped from the history')), false);
});

test('the cause of a waiting route counts the message that an engine is taking: one pending and two that the receiver has accepted are waiting for the receiver', async () => {
  const { relay, engines, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-b', 'sess-a')] });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  send('sess-a', 'route-1', 'k3', 'three');
  relay.control.approve('msg-1');
  relay.control.approve('msg-2');
  await tick();
  assert.deepEqual(relay.control.messages().map(view => view.state), ['sending', 'queued', 'pending']);
  assert.equal(relay.control.routes()[0]?.waitingOn, 'receiver_busy');
});

test('a tie between the messages that wait for the person and those that wait for the receiver is told as waiting for the person', () => {
  const { relay, send } = build({ states: { 'sess-b': 'waiting' } });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  relay.control.approve('msg-1');
  assert.deepEqual(relay.control.messages().map(view => view.state), ['queued', 'pending']);
  assert.equal(relay.control.routes()[0]?.waitingOn, 'pending_approval');
});

test('a reply that quotes the body of a message that is in flight is taken: bodies are hidden in the log and not in the checks of a body', async () => {
  const { relay, engines, send } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'the plan is to rename the module');
  await tick();
  assert.equal(send('sess-b', 'route-2', 'k2', 'Re: the plan is to rename the module, and I agree').ok, true);
  assert.equal(relay.control.messages().length, 2);
});

test('a port is read once: the relay never reads state or deliver of a port again after it was made', async () => {
  const reads = { state: 0, deliver: 0 };
  const engine = createFakeEngine('sess-b');
  const port = {
    get state() { reads.state += 1; return () => engine.state(); },
    get deliver() { reads.deliver += 1; return (delivery: Parameters<typeof engine.deliver>[0]) => engine.deliver(delivery); },
  };
  const a = createFakeEngine('sess-a');
  const relay = createRelay({ run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 5)], members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port }] });
  const secret = relay.control.issueSecret('sess-a');
  assert.deepEqual(reads, { state: 1, deliver: 1 });
  for (let i = 0; i < 3; i += 1) relay.write.send({ session: 'sess-a', secret, route: 'route-1', key: `k${i}`, body: `body ${i}` });
  await tick();
  relay.control.sessionChanged('sess-b');
  assert.equal(engine.inputs.length, 3);
  assert.deepEqual(reads, { state: 1, deliver: 1 });
});

test('the ledger keeps 4,096 keys by default', async () => {
  const { relay, send } = build({ routes: auto, options: { runCap: 10_000 } });
  for (let i = 0; i < 4100; i += 1) {
    let reply = send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    // A cap that the run reaches is the person's to lift, and the person does it here.
    if (!reply.ok) { relay.control.resume('route-1'); reply = send('sess-a', 'route-1', `k${i}`, `body ${i}`); }
    assert.equal(reply.ok, true, String(i));
    await tick();
    if (i % 50 === 49) relay.control.resume('route-1');
  }
  assert.equal(relay.control.sizes().keys, 4096);
  assert.equal((send('sess-a', 'route-1', 'k4099', 'body 4099') as { duplicate?: boolean }).duplicate, true);
  assert.equal((send('sess-a', 'route-1', 'k3', 'body 3') as { duplicate?: boolean }).duplicate, false, 'the oldest keys left the ledger');
});

test('the decline cap and the keep of keys are set by options, and a bad value is a bug of the caller', () => {
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b');
  const make = (over: Record<string, unknown>) => () => createRelay({ run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b')], members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }], ...over });
  assert.throws(make({ declineCap: 0 }), RangeError);
  assert.throws(make({ keepKeys: 15 }), RangeError);
  assert.doesNotThrow(make({ declineCap: 100, keepKeys: 65_536 }));
});

test('a confirm for a message that the history dropped says evicted to its receiver only', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto, options: { keepSettled: 1 } });
  send('sess-a', 'route-1', 'k1', 'body 1');
  await tick();
  const receipt = engines['sess-b']?.lastReceipt()?.receipt ?? '';
  send('sess-a', 'route-1', 'k2', 'body 2');
  await tick();
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN', reason: 'evicted' });
  assert.deepEqual(confirm('sess-a', 'msg-1', receipt), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
  assert.equal(relay.control.message('msg-1'), undefined);
});

test('the ids of dropped messages are remembered up to the same room as the ledger, oldest first', async () => {
  const { send, engines, confirm } = build({ routes: auto, options: { keepSettled: 1, keepKeys: 16 } });
  const receipts: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    send('sess-a', 'route-1', `k${i}`, `body ${i}`);
    await tick();
    receipts.push(engines['sess-b']?.lastReceipt()?.receipt ?? '');
  }
  assert.deepEqual(confirm('sess-b', 'msg-19', receipts[18] ?? ''), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN', reason: 'evicted' });
  assert.deepEqual(confirm('sess-b', 'msg-1', receipts[0] ?? ''), { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' });
});

test('a message that was sent is dropped after the ones that ended: a delivered message goes first and the sent one waits for its receipt', async () => {
  const { relay, send, engines, confirm } = build({ routes: auto, options: { keepSettled: 2 } });
  send('sess-a', 'route-1', 'k1', 'one');
  await tick();
  send('sess-a', 'route-1', 'k2', 'two');
  await tick();
  assert.equal(confirm('sess-b', 'msg-2', engines['sess-b']?.lastReceipt()?.receipt ?? '').ok, true);
  send('sess-a', 'route-1', 'k3', 'three');
  await tick();
  assert.deepEqual(relay.control.messages().map(view => [view.id, view.state]), [['msg-1', 'sent'], ['msg-3', 'sent']]);
});

test('the waiting messages of a full route are told apart to the writer as the person, or the receiver that is busy; the person sees also that the receiver does not run', async () => {
  const person = build();
  for (let i = 0; i < 16; i += 1) person.send('sess-a', 'route-1', `k${i}`, `m${i}`);
  assert.deepEqual(person.send('sess-a', 'route-1', 'x', 'x'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'pending_approval' });
  assert.equal(person.relay.control.routes()[0]?.waitingOn, 'pending_approval');

  const waiting = build({ routes: auto, states: { 'sess-b': 'waiting' } });
  for (let i = 0; i < 16; i += 1) waiting.send('sess-a', 'route-1', `k${i}`, `m${i}`);
  assert.deepEqual(waiting.send('sess-a', 'route-1', 'x', 'x'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_busy' });
  assert.equal(waiting.relay.control.routes()[0]?.waitingOn, 'receiver_not_running');

  const unreadable = build({ routes: auto, prepare: made => { const engine = made['sess-b']; if (engine) engine.state = () => { throw new Error('no state'); }; } });
  for (let i = 0; i < 16; i += 1) unreadable.send('sess-a', 'route-1', `k${i}`, `m${i}`);
  assert.deepEqual(unreadable.send('sess-a', 'route-1', 'x', 'x'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_busy' });
  assert.equal(unreadable.relay.control.routes()[0]?.waitingOn, 'receiver_not_running');

  const busy = build({ routes: auto });
  if (busy.engines['sess-b']) busy.engines['sess-b'].mode = 'hang';
  for (let i = 0; i < 16; i += 1) busy.send('sess-a', 'route-1', `k${i}`, `m${i}`);
  await tick();
  assert.deepEqual(busy.send('sess-a', 'route-1', 'x', 'x'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_busy' });
  assert.equal(busy.relay.control.routes()[0]?.waitingOn, 'receiver_busy');
  assert.equal(busy.relay.control.routes()[1]?.waitingOn, null);
});

test('a route that has nothing waiting has no cause', () => {
  const { relay } = build();
  assert.deepEqual(relay.control.routes().map(view => view.waitingOn), [null, null]);
});

test('the order of delivery is the order of acceptance: messages that the person approves in another order than they were sent reach the engine in the order of the approval', async () => {
  const { relay, engines, send } = build({ states: { 'sess-b': 'starting' } });
  send('sess-a', 'route-1', 'k1', 'first sent');
  send('sess-a', 'route-1', 'k2', 'second sent');
  send('sess-a', 'route-1', 'k3', 'third sent');
  relay.control.approve('msg-3');
  relay.control.approve('msg-1');
  relay.control.approve('msg-2');
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  for (let i = 0; i < 4; i += 1) await tick();
  assert.deepEqual(engines['sess-b']?.inputs.map(text => parseFence(text)?.body), ['third sent', 'first sent', 'second sent']);
  assert.deepEqual(relay.control.messages().map(view => view.id), ['msg-1', 'msg-2', 'msg-3'], 'a read lists the messages in the order they were sent');
});

test('a repeat of a message that failed names its reason', async () => {
  const { send, engines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'reject';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.deepEqual(send('sess-a', 'route-1', 'k1', 'first'), { ok: true, id: 'msg-1', state: 'failed', reason: 'delivery_failed', duplicate: true });
});

test('a secret is made for a session that lives, once, and never the value that another session holds', () => {
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b');
  const make = (newSecret?: () => string) => createRelay({ run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b')], members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }], ...(newSecret === undefined ? {} : { newSecret }) });
  const same = make(() => 'the-same-secret-value-0000');
  same.control.issueSecret('sess-a');
  assert.throws(() => same.control.issueSecret('sess-b'), TypeError);
  const ended = make();
  a.setState('stopped');
  ended.control.sessionChanged('sess-a');
  assert.throws(() => ended.control.issueSecret('sess-a'), TypeError);
  a.setState('running');
});

test('a secret that equals the secret of a session that ended is refused too', () => {
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b');
  const relay = createRelay({ run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b')], members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }], newSecret: () => 'the-same-secret-value-0000' });
  relay.control.issueSecret('sess-a');
  a.setState('stopped');
  relay.control.sessionChanged('sess-a');
  assert.throws(() => relay.control.issueSecret('sess-b'), TypeError);
});

test('the fake engines are test code: they are not in the built source of the package', () => {
  assert.equal(fs.existsSync(new URL('../src/fixtures.js', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('./fixtures.js', import.meta.url)), true);
});
