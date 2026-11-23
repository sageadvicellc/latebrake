// The caps: a cap on the messages of a route, a cap on a back-and-forth between two sessions, the stop that the core reports, and the count that is given back when a message never moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFence } from '../src/fixtures.js';
import { build, route, tick } from './support.js';

const autoPair = (messageCap: number, loopCap: number) => [route('route-1', 'sess-a', 'sess-b', 'auto', messageCap, loopCap), route('route-2', 'sess-b', 'sess-a', 'auto', messageCap, loopCap)];

test('an auto route stops at its message cap: the next send is refused, the route reads as stopped, and the core does not retry on its own', async () => {
  const { relay, send, engines, lines } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 3, 4)] });
  for (const n of [1, 2, 3]) assert.equal(send('sess-a', 'route-1', `k${n}`, `message ${n}`).ok, true);
  assert.deepEqual(send('sess-a', 'route-1', 'k4', 'message 4'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 3);
  assert.deepEqual(relay.control.routes()[0], {
    id: 'route-1', from: 'sess-a', to: 'sess-b', rule: 'auto', messageCap: 3, loopCap: 4, accepted: 3, waiting: 0, state: 'stopped', stoppedBy: 'message_cap', stoppedAt: 1_700_000_000_000, turns: 1,
  });
  assert.deepEqual(send('sess-a', 'route-1', 'k5', 'message 5'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.equal(relay.control.messages().length, 3);
  assert.equal(lines.filter(line => line.includes('stopped')).length, 1);
  assert.equal(lines.some(line => line === 'relay run-1: route route-1 stopped: the cap of 3 messages is reached'), true);
});

test('a message cap of one allows one message, and the cap counts at acceptance and never at the send of a message that waits for the person', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4)] });
  assert.equal(send('sess-a', 'route-1', 'k1', 'one').ok, true);
  assert.equal(send('sess-a', 'route-1', 'k2', 'two').ok, true);
  assert.equal(send('sess-a', 'route-1', 'k3', 'three').ok, true);
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  assert.equal(relay.control.approve('msg-1').ok, true);
  assert.equal(relay.control.routes()[0]?.accepted, 1);
});

test('a stop is about new acceptances: a message that waits for the person stays pending, cannot be approved while the route is stopped, and can be approved after the person resumes', async () => {
  const { relay, send, engines } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 1, 4)] });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  send('sess-a', 'route-1', 'k3', 'three');
  assert.equal(relay.control.approve('msg-1').ok, true);
  assert.deepEqual(relay.control.approve('msg-2'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.deepEqual(relay.control.approve('msg-3'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.equal(relay.control.message('msg-2')?.state, 'pending');
  assert.equal(relay.control.message('msg-3')?.state, 'pending');
  await tick();
  assert.equal(relay.control.routes()[0]?.waiting, 2);
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  relay.control.resume('route-1');
  assert.equal(relay.control.approve('msg-2').ok, true);
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs.map(text => parseFence(text)?.body), ['one', 'two']);
});

test('a person resumes a route that a cap stopped, and the count starts again from zero', async () => {
  const { relay, send, engines } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 2, 4)] });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  assert.equal(send('sess-a', 'route-1', 'k3', 'three').ok, false);
  assert.deepEqual(relay.control.resume('route-1'), { ok: true });
  assert.equal(relay.control.routes()[0]?.state, 'open');
  assert.equal(relay.control.routes()[0]?.stoppedBy, null);
  assert.equal(relay.control.routes()[0]?.stoppedAt, null);
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  assert.equal(send('sess-a', 'route-1', 'k3', 'three').ok, true);
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 3);
});

test('a resume of a route that is open changes nothing, and a resume of an unknown route is refused', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 5, 4)] });
  send('sess-a', 'route-1', 'k1', 'one');
  assert.deepEqual(relay.control.resume('route-1'), { ok: true });
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  for (const id of ['route-9', '', 5, null, {}, '__proto__']) assert.deepEqual(relay.control.resume(id), { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' });
});

test('a loop between two sessions stops at the loop cap: with a cap of 3 the exchange passes three messages, and the fourth is refused with the loop code', async () => {
  const { relay, send, engines, lines } = build({ routes: autoPair(100, 3) });
  assert.equal(send('sess-a', 'route-1', 'k1', 'ping 1').ok, true);
  assert.equal(send('sess-b', 'route-2', 'k2', 'pong 2').ok, true);
  assert.equal(send('sess-a', 'route-1', 'k3', 'ping 3').ok, true);
  assert.deepEqual(send('sess-b', 'route-2', 'k4', 'pong 4'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
  await tick();
  assert.equal(engines['sess-b']?.inputs.length, 2);
  assert.equal(engines['sess-a']?.inputs.length, 1);
  assert.equal(lines.filter(line => line === 'relay run-1: route route-2 stopped: the loop cap of 3 is reached between sess-a and sess-b').length, 1);
  const [one, two] = relay.control.routes();
  assert.equal(one?.state, 'stopped');
  assert.equal(one?.stoppedBy, 'loop_cap');
  assert.equal(two?.state, 'stopped');
  assert.equal(two?.stoppedBy, 'loop_cap');
});

test('a loop stop stops both directions: the route that did not hit the cap is stopped too, so neither engine can send', () => {
  const { send } = build({ routes: autoPair(100, 2) });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  assert.deepEqual(send('sess-a', 'route-1', 'k3', 'ping'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
  assert.deepEqual(send('sess-b', 'route-2', 'k4', 'pong'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
});

test('a loop cap of one lets a first message pass and refuses the answer', () => {
  const { send } = build({ routes: autoPair(100, 1) });
  assert.equal(send('sess-a', 'route-1', 'k1', 'ping').ok, true);
  assert.deepEqual(send('sess-b', 'route-2', 'k2', 'pong'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
});

test('two messages from one sender in a row are not a loop: the chain of back-and-forth starts again at one', () => {
  const { send, relay } = build({ routes: autoPair(100, 2) });
  for (let i = 0; i < 10; i += 1) assert.equal(send('sess-a', 'route-1', `k${i}`, `ping ${i}`).ok, true);
  assert.equal(relay.control.routes()[0]?.turns, 1);
  assert.equal(send('sess-b', 'route-2', 'r1', 'pong').ok, true);
  assert.equal(relay.control.routes()[0]?.turns, 2);
  assert.equal(send('sess-b', 'route-2', 'r2', 'pong again').ok, true);
  assert.equal(relay.control.routes()[0]?.turns, 1);
  assert.equal(relay.control.routes()[0]?.state, 'open');
});

test('a person resumes a loop: both routes open, the chain starts again, and the exchange can go on up to the cap again', () => {
  const { relay, send } = build({ routes: autoPair(100, 2) });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  assert.equal(send('sess-a', 'route-1', 'k3', 'ping').ok, false);
  assert.deepEqual(relay.control.resume('route-2'), { ok: true });
  assert.deepEqual(relay.control.routes().map(view => view.state), ['open', 'open']);
  assert.equal(relay.control.routes()[0]?.turns, 0);
  assert.equal(send('sess-a', 'route-1', 'k5', 'ping').ok, true);
  assert.equal(send('sess-b', 'route-2', 'k6', 'pong').ok, true);
  assert.equal(send('sess-a', 'route-1', 'k7', 'ping').ok, false);
});

test('the resume of a loop opens only the routes that the loop stopped: a route that its own message cap stopped stays stopped', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1, 1), route('route-2', 'sess-b', 'sess-a', 'auto', 100, 1)] });
  assert.equal(send('sess-a', 'route-1', 'k1', 'ping').ok, true);
  assert.equal(send('sess-a', 'route-1', 'k2', 'ping').ok, false, 'the message cap of route-1 is reached');
  assert.equal(relay.control.routes()[0]?.stoppedBy, 'message_cap');
  assert.equal(send('sess-b', 'route-2', 'k3', 'pong').ok, false, 'the loop cap of one is reached');
  assert.equal(relay.control.routes()[1]?.stoppedBy, 'loop_cap');
  assert.equal(relay.control.routes()[0]?.stoppedBy, 'message_cap', 'the loop does not take over a stop that has its own cause');
  relay.control.resume('route-2');
  assert.equal(relay.control.routes()[1]?.state, 'open');
  assert.equal(relay.control.routes()[0]?.state, 'stopped');
  relay.control.resume('route-1');
  assert.equal(relay.control.routes()[0]?.state, 'open');
});

test('a loop between two sessions does not stop a route of another pair', () => {
  const { send, relay } = build({
    sessions: ['sess-a', 'sess-b', 'sess-c'],
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 100, 1), route('route-2', 'sess-b', 'sess-a', 'auto', 100, 1), route('route-3', 'sess-a', 'sess-c', 'auto', 100, 1), route('route-4', 'sess-c', 'sess-a', 'auto', 100, 1)],
  });
  send('sess-a', 'route-1', 'k1', 'ping');
  assert.equal(send('sess-b', 'route-2', 'k2', 'pong').ok, false);
  assert.equal(send('sess-a', 'route-3', 'k3', 'ping').ok, true);
  assert.deepEqual(relay.control.routes().map(view => view.state), ['stopped', 'stopped', 'open', 'open']);
});

test('the chain of a pair is counted at acceptance, in the order the person approves, and not in the order the messages were sent', () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 100, 2), route('route-2', 'sess-b', 'sess-a', 'accepted-output', 100, 2)] });
  send('sess-a', 'route-1', 'k1', 'ping 1');
  send('sess-b', 'route-2', 'k2', 'pong 2');
  send('sess-a', 'route-1', 'k3', 'ping 3');
  assert.equal(relay.control.approve('msg-1').ok, true);
  assert.equal(relay.control.approve('msg-3').ok, true, 'same sender twice in a row, so the chain starts again');
  assert.equal(relay.control.approve('msg-2').ok, true);
  assert.equal(relay.control.routes()[0]?.turns, 2);
});

test('a loop stop leaves the messages that wait for the person pending, in both routes, and an approval is refused with the loop code until the person resumes', async () => {
  const { relay, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'accepted-output', 100, 1), route('route-2', 'sess-b', 'sess-a', 'accepted-output', 100, 1)] });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  send('sess-b', 'route-2', 'k3', 'pong again');
  send('sess-a', 'route-1', 'k4', 'ping again');
  assert.equal(relay.control.approve('msg-1').ok, true);
  assert.deepEqual(relay.control.approve('msg-2'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
  assert.deepEqual(relay.control.approve('msg-4'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
  assert.deepEqual(relay.control.messages().map(view => view.state === 'pending'), [false, true, true, true]);
  await tick();
  assert.deepEqual(relay.control.routes().map(view => view.waiting), [1, 2]);
  relay.control.resume('route-1');
  assert.equal(relay.control.approve('msg-4').ok, true);
});

test('a message that was accepted and waits for a receiver that does not run is not dropped by a stop: it was within the cap, and it goes when the receiver runs', async () => {
  const { relay, send, engines } = build({ states: { 'sess-a': 'starting', 'sess-b': 'starting' }, routes: autoPair(100, 2) });
  send('sess-a', 'route-1', 'k1', 'ping');
  assert.equal(relay.control.message('msg-1')?.state, 'queued');
  assert.equal(send('sess-b', 'route-2', 'k2', 'pong').ok, true);
  assert.deepEqual(send('sess-a', 'route-1', 'k3', 'ping'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
  assert.deepEqual(relay.control.messages().map(view => view.state), ['queued', 'queued']);
  assert.deepEqual(relay.control.routes().map(view => [view.waiting, view.accepted]), [[1, 1], [1, 1]]);
  engines['sess-b']?.setState('running');
  relay.control.sessionChanged('sess-b');
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
});

test('a message that was counted before a resume holds no place in the count after it: giving it back does not take a place from a newer message', () => {
  const { relay, send } = build({ states: { 'sess-b': 'waiting' }, routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 2, 4)] });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  assert.equal(send('sess-a', 'route-1', 'k3', 'three').ok, false);
  relay.control.resume('route-1');
  assert.equal(send('sess-a', 'route-1', 'k4', 'four').ok, true);
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  relay.control.decline('msg-1');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  relay.control.decline('msg-4');
  assert.equal(relay.control.routes()[0]?.accepted, 0);
});

test('the count is given back when a message fails before it reached the engine, and the chain goes back one step', () => {
  const { relay, send, engines } = build({ states: { 'sess-b': 'waiting' }, routes: autoPair(100, 5) });
  send('sess-a', 'route-1', 'k1', 'ping');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  assert.equal(relay.control.routes()[0]?.turns, 1);
  engines['sess-b']?.setState('stopped');
  relay.control.sessionChanged('sess-b');
  assert.equal(relay.control.message('msg-1')?.reason, 'receiver_gone');
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  assert.equal(relay.control.routes()[0]?.turns, 0);
});

test('the count is not given back for a message that the engine was asked to take, also when the engine refused it', async () => {
  const { relay, send, engines } = build({ routes: autoPair(100, 5) });
  if (engines['sess-b']) engines['sess-b'].mode = 'reject';
  send('sess-a', 'route-1', 'k1', 'ping');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_failed');
  assert.equal(relay.control.routes()[0]?.accepted, 1);
  assert.equal(relay.control.routes()[0]?.turns, 1);
});

test('a refund puts the chain back only when the message is the last of the chain, and never a later one', () => {
  const { relay, send } = build({ states: { 'sess-b': 'waiting', 'sess-a': 'waiting' }, routes: autoPair(100, 5) });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  assert.equal(relay.control.routes()[0]?.turns, 2);
  relay.control.decline('msg-1');
  assert.equal(relay.control.routes()[0]?.turns, 2, 'a later message holds the chain');
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  relay.control.decline('msg-2');
  assert.equal(relay.control.routes()[1]?.accepted, 0);
  assert.equal(relay.control.routes()[0]?.turns, 0, 'both are given back, so the chain is empty and does not hold the step of a message that never moved');
});

test('a refund in the other order, the later message first, leaves the chain at the earlier message, and then at nothing', () => {
  const { relay, send } = build({ states: { 'sess-b': 'waiting', 'sess-a': 'waiting' }, routes: autoPair(100, 5) });
  send('sess-a', 'route-1', 'k1', 'ping');
  send('sess-b', 'route-2', 'k2', 'pong');
  relay.control.decline('msg-2');
  assert.equal(relay.control.routes()[0]?.turns, 1);
  relay.control.decline('msg-1');
  assert.equal(relay.control.routes()[0]?.turns, 0);
});

test('the caps hold for a run of many messages: no count drifts, and each failure path ends with the counts that match the messages that were kept', async () => {
  const { relay, send, engines } = build({ routes: autoPair(1000, 100) });
  for (let i = 0; i < 40; i += 1) {
    if (engines['sess-b']) engines['sess-b'].mode = i % 3 === 0 ? 'reject' : 'accept';
    send('sess-a', 'route-1', `k${i}`, `message ${i}`);
    await tick();
  }
  const route1 = relay.control.routes()[0];
  assert.equal(route1?.accepted, 40);
  assert.equal(route1?.waiting, 0);
});
