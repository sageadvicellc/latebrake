// The last round: the scope of a reset, what a resume reopens, the causes in first replies, the logs of late failures, a stuck engine that is written to, and a receipt that keeps its engine busy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBody } from '../src/envelope.js';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 100)];
const four = ['sess-a', 'sess-b', 'sess-c', 'sess-d'];

test('an approval on an unrelated route does not start the count of another pair again: a bait approval on route C to D every few messages never lifts the cap of A and B', async () => {
  const { relay, send } = build({
    sessions: four,
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 6), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 6), route('route-3', 'sess-c', 'sess-d', 'accepted-output', 1000, 6)],
  });
  let passed = 0;
  for (let i = 0; i < 40; i += 1) {
    if (i % 3 === 0) {
      const proposal = send('sess-c', 'route-3', `bait-${i}`, `bait ${i}`);
      assert.ok(proposal.ok);
      assert.equal(relay.control.approve(proposal.id).ok, true);
    }
    if (send('sess-a', 'route-1', `k${i}`, `message ${i}`).ok) passed += 1;
    await tick();
  }
  assert.equal(passed, 6);
  assert.equal(relay.control.routes()[0]?.exchanged, 6);
  assert.equal(relay.control.routes()[2]?.exchanged, 1);
});

test('an approval that is refused at the message cap changes no count of any pair', () => {
  const { relay, send } = build({
    sessions: four,
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 6), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 6), route('route-3', 'sess-c', 'sess-d', 'accepted-output', 1, 6)],
  });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  send('sess-c', 'route-3', 'p1', 'proposal 1');
  send('sess-c', 'route-3', 'p2', 'proposal 2');
  assert.equal(relay.control.approve('msg-3').ok, true);
  assert.equal(relay.control.routes()[0]?.exchanged, 2);
  assert.deepEqual(relay.control.approve('msg-4'), { ok: false, code: 'GAUGE_RELAY_MESSAGE_CAP' });
  assert.equal(relay.control.routes()[0]?.exchanged, 2);
  assert.equal(relay.control.routes()[2]?.exchanged, 1, 'a refused approval does not touch its own pair either');
});

test('an approval starts again the count of its own pair only, and not the run count: with a run cap of 2 an approval does not give the run two more messages', () => {
  const { relay, send } = build({
    sessions: ['sess-a', 'sess-b', 'sess-c'],
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-c', 'accepted-output', 1000, 100), route('route-3', 'sess-c', 'sess-a', 'auto', 1000, 100)],
    options: { runCap: 2 },
  });
  assert.equal(send('sess-a', 'route-1', 'k1', 'one').ok, true);
  assert.equal(send('sess-c', 'route-3', 'k2', 'two').ok, true);
  send('sess-b', 'route-2', 'k3', 'proposal');
  assert.equal(relay.control.approve('msg-3').ok, true);
  assert.deepEqual(send('sess-a', 'route-1', 'k4', 'four'), { ok: false, code: 'GAUGE_RELAY_LOOP_CAP' });
});

test('a resume starts again the count of the pair it reopens, and no other pair', () => {
  const { relay, send } = build({
    sessions: four,
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 2), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 2), route('route-3', 'sess-c', 'sess-d', 'auto', 1000, 5), route('route-4', 'sess-d', 'sess-c', 'auto', 1000, 5)],
  });
  send('sess-a', 'route-1', 'k1', 'one');
  send('sess-a', 'route-1', 'k2', 'two');
  assert.equal(send('sess-a', 'route-1', 'k3', 'three').ok, false);
  send('sess-c', 'route-3', 'k4', 'four');
  send('sess-c', 'route-3', 'k5', 'five');
  assert.deepEqual(relay.control.resume('route-1'), { ok: true, reopened: ['route-1', 'route-2'] });
  assert.deepEqual(relay.control.routes().map(view => view.exchanged), [0, 0, 2, 2]);
});

test('a resume of one stopped pair leaves another stopped pair stopped, and the reply lists the routes that it reopened', () => {
  const { relay, send } = build({
    sessions: four,
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 1), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 1), route('route-3', 'sess-c', 'sess-d', 'auto', 1000, 1), route('route-4', 'sess-d', 'sess-c', 'auto', 1000, 1)],
  });
  send('sess-a', 'route-1', 'k1', 'one');
  assert.equal(send('sess-b', 'route-2', 'k2', 'two').ok, false);
  send('sess-c', 'route-3', 'k3', 'three');
  assert.equal(send('sess-d', 'route-4', 'k4', 'four').ok, false);
  assert.deepEqual(relay.control.routes().map(view => view.state), ['stopped', 'stopped', 'stopped', 'stopped']);
  assert.deepEqual(relay.control.resume('route-2'), { ok: true, reopened: ['route-1', 'route-2'] });
  assert.deepEqual(relay.control.routes().map(view => view.state), ['open', 'open', 'stopped', 'stopped']);
  assert.deepEqual(relay.control.resume('route-3'), { ok: true, reopened: ['route-3', 'route-4'] });
});

test('a run stop is reopened as a whole, and a pair that was stopped before it stays stopped: the reply names the routes of the run stop only', () => {
  const { relay, send } = build({
    sessions: four,
    routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 1), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 1), route('route-3', 'sess-c', 'sess-d', 'auto', 1000, 50), route('route-4', 'sess-d', 'sess-c', 'auto', 1000, 50)],
    options: { runCap: 3 },
  });
  send('sess-a', 'route-1', 'k1', 'one');
  assert.equal(send('sess-b', 'route-2', 'k2', 'two').ok, false, 'the pair of A and B is stopped by its loop cap of one');
  send('sess-c', 'route-3', 'k3', 'three');
  send('sess-c', 'route-3', 'k4', 'four');
  assert.equal(send('sess-c', 'route-3', 'k5', 'five').ok, false, 'the run cap of three is reached: one message of A and B and two of C and D');
  assert.deepEqual(relay.control.routes().map(view => view.state), ['stopped', 'stopped', 'stopped', 'stopped']);
  assert.deepEqual(relay.control.resume('route-4'), { ok: true, reopened: ['route-3', 'route-4'] });
  assert.deepEqual(relay.control.routes().map(view => view.state), ['stopped', 'stopped', 'open', 'open']);
  assert.equal(send('sess-c', 'route-3', 'k6', 'six').ok, true, 'the run count started again');
});

test('a resume of a route that its message cap or a pause stopped lists that route, and a resume of an open route lists none', () => {
  const capped = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 1, 5), route('route-2', 'sess-b', 'sess-a', 'auto', 1, 5)] });
  capped.send('sess-a', 'route-1', 'k1', 'one');
  assert.equal(capped.send('sess-a', 'route-1', 'k2', 'two').ok, false);
  assert.deepEqual(capped.relay.control.resume('route-1'), { ok: true, reopened: ['route-1'] });
  assert.deepEqual(capped.relay.control.resume('route-1'), { ok: true, reopened: [] });
  const paused = build({ options: { declineCap: 1 } });
  paused.send('sess-a', 'route-1', 'k1', 'one');
  paused.relay.control.decline('msg-1');
  assert.deepEqual(paused.relay.control.resume('route-1'), { ok: true, reopened: ['route-1'] });
});

test('a message that fails in the same call as its send says why in the first reply, and so does the approval', async () => {
  const stuck = build({ routes: auto, options: { newNonce: () => { throw new Error('the maker broke'); } } });
  assert.deepEqual(stuck.send('sess-a', 'route-1', 'k1', 'first'), { ok: true, id: 'msg-1', state: 'failed', reason: 'not_prepared', duplicate: false });
  assert.deepEqual(stuck.send('sess-a', 'route-1', 'k1', 'first'), { ok: true, id: 'msg-1', state: 'failed', reason: 'not_prepared', duplicate: true });
  const approving = build({ options: { newNonce: () => { throw new Error('the maker broke'); } } });
  approving.send('sess-a', 'route-1', 'k1', 'first');
  assert.deepEqual(approving.relay.control.approve('msg-1'), { ok: true, state: 'failed', reason: 'not_prepared' });
  const plain = build();
  plain.send('sess-a', 'route-1', 'k1', 'first');
  assert.deepEqual(plain.relay.control.approve('msg-1'), { ok: true, state: 'sending', reason: null });
  await tick();
});

test('a rejection or a bad answer that comes after the message was settled is logged with a fixed line that names the message and the receiver, and holds no text of the error', async () => {
  const rejected = build({ routes: auto });
  if (rejected.engines['sess-b']) rejected.engines['sess-b'].mode = 'hang';
  rejected.send('sess-a', 'route-1', 'k1', 'a body that is long enough');
  await tick();
  rejected.timers.fireAll();
  rejected.engines['sess-b']?.failHung('the engine said a secret reason');
  await tick();
  assert.equal(rejected.lines.includes('relay run-1: the adapter of sess-b rejected its delivery of message msg-1 after the message was settled'), true);
  assert.equal(rejected.lines.some(line => line.includes('secret reason')), false);

  const garbled = build({ routes: auto });
  const engine = garbled.engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'maybe' as never; }
  garbled.send('sess-a', 'route-1', 'k1', 'a body that is long enough');
  await tick();
  garbled.timers.fireAll();
  engine?.release();
  await tick();
  assert.equal(garbled.lines.includes('relay run-1: the engine of sess-b gave an answer that is no fidelity, for message msg-1, after the message was settled'), true);
});

test('a write to a stuck engine is refused with the reason receiver_stuck, makes no message and no key, and logs at counts 1, 2, 4, 8: 2,000 sends leave the ledger and the history as they were', async () => {
  const built = build({ routes: auto });
  const engine = built.engines['sess-b'];
  if (engine) engine.mode = 'hang';
  built.send('sess-a', 'route-1', 'honest', 'the honest message');
  await tick();
  built.timers.fireAll();
  built.timers.fireAll();
  const before = [built.relay.control.sizes(), built.relay.control.messages().length, built.lines.length];
  for (let i = 0; i < 2000; i += 1) {
    const reply = built.send('sess-a', 'route-1', `spin-${i}`, `spin ${i}`);
    assert.deepEqual(reply, { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_stuck' });
  }
  const stuckLines = built.lines.filter(line => line.includes('refused'));
  assert.deepEqual([built.relay.control.sizes(), built.relay.control.messages().length], [before[0], before[1]]);
  assert.equal(built.lines.length - (before[2] as number), 11, 'counts 1, 2, 4, and so on up to 1,024');
  assert.equal(stuckLines[0], 'relay run-1: a write to sess-b was refused, because its engine never settled an earlier delivery');
  assert.equal(built.relay.control.routes()[0]?.accepted, 1);
  assert.equal((built.send('sess-a', 'route-1', 'honest', 'the honest message') as { duplicate?: boolean }).duplicate, true, 'the retry of an honest sender is still a repeat');
  assert.equal(built.relay.control.routes()[0]?.waitingOn, null);
});

test('the writer of a full route is told pending_approval, receiver_busy, or receiver_stuck, and never that the receiver does not run: the person sees that in waitingOn', () => {
  const waiting = build({ routes: auto, states: { 'sess-b': 'waiting' } });
  for (let i = 0; i < 16; i += 1) waiting.send('sess-a', 'route-1', `k${i}`, `m${i}`);
  assert.deepEqual(waiting.send('sess-a', 'route-1', 'x', 'x'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_busy' });
  assert.equal(waiting.relay.control.routes()[0]?.waitingOn, 'receiver_not_running');
});

test('a receipt that comes while the engine is taking the message aborts its signal, keeps the engine busy until the adapter settles, and arms the wait for a stuck adapter', async () => {
  const { relay, engines, send, confirm, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  assert.deepEqual(confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? ''), { ok: true, state: 'delivered' });
  assert.equal(engine?.deliveries[0]?.signal.aborted, true);
  assert.equal(engine?.deliveries.length, 1, 'the second message waits');
  assert.equal(relay.control.message('msg-2')?.state, 'queued');
  assert.deepEqual(timers.delays(), [30_000]);
  if (engine) engine.mode = 'accept';
  engine?.releaseFirst();
  await tick();
  assert.equal(engine?.maxActive, 1);
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
  assert.equal(timers.live(), 0);
});

test('an adapter that never settles after a receipt leaves the engine stuck after the wait, and no signal is left that is not aborted', async () => {
  const { relay, engines, send, confirm, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? '');
  timers.fireAll();
  assert.equal(relay.control.message('msg-2')?.reason, 'receiver_stuck');
  assert.equal(engine?.deliveries.every(delivery => delivery.signal.aborted), true);
});

test('a late answer of absent after a receipt does not replace the fidelity unknown, and the contradiction is logged; another late answer replaces it', async () => {
  const absent = build({ routes: auto });
  const engine = absent.engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'absent'; }
  absent.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  absent.confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? '');
  engine?.release();
  await tick();
  assert.equal(absent.relay.control.message('msg-1')?.fidelity, 'unknown');
  assert.equal(absent.relay.control.message('msg-1')?.state, 'delivered');
  assert.equal(absent.lines.includes('relay run-1: the adapter of sess-b said absent for message msg-1, which a receipt had proved delivered'), true);
});

test('what the person declined on one route cannot be pushed out by another route: each route keeps its own set, and a resume clears the set of its route only', () => {
  const { relay, send } = build({
    sessions: ['sess-a', 'sess-b', 'sess-c'], routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-a', 'sess-c')], options: { declineCap: 2 },
  });
  send('sess-a', 'route-2', 'o1', 'other body');
  relay.control.decline('msg-1');
  for (let i = 0; i < 16; i += 1) send('sess-a', 'route-1', `k${i}`, `body ${i}`);
  for (let i = 0; i < 16; i += 1) relay.control.decline(`msg-${i + 2}`);
  assert.equal(relay.control.sizes().declined, 17);
  assert.deepEqual(send('sess-a', 'route-2', 'o2', 'other body'), { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' });
  relay.control.resume('route-1');
  assert.equal(relay.control.sizes().declined, 1);
});

test('a body that holds a word of a line of the log does not blank that word in the log of the operator, while the engine takes it', async () => {
  const { relay, engines, send, lines } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'session');
  await tick();
  relay.write.send({ session: 'sess-a', secret: 'wrong', route: 'route-1', key: 'k2', body: 'x' });
  assert.equal(lines.includes('relay run-1: a write for sess-a came without the right session secret'), true);
  assert.equal(lines.filter(line => line.includes('[redacted]')).length, 0);
});

test('the error text of an adapter has the body cut out of it', async () => {
  const { engines, send, lines } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'session');
  await tick();
  engine?.failHung('the engine said session twice');
  await tick();
  assert.equal(lines.includes('relay run-1: delivery of message msg-1 to sess-b failed: the engine said [redacted] twice'), true);
});

test('a body that hides text is refused: variation selectors, private use, unassigned code points, and the blank fillers', () => {
  const hidden = ['️', '\u{e0100}', '\u{e01ef}', '︀', '', '͸', '͏', 'ㅤ', '⠀', 'ᅟ', 'ᅠ', 'ﾠ'];
  for (const char of hidden) assert.deepEqual(checkBody(`a${char}b`), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'body' }, `U+${char.codePointAt(0)?.toString(16)}`);
  assert.equal(checkBody('café and é and \u{1F600} and 中文').ok, true);
});

test('the state of the receiver is read once for each look: a message that waits for a receiver is looked at twice by a send, and once by a state change', () => {
  let reads = 0;
  const { relay, send } = build({
    routes: auto, states: { 'sess-b': 'waiting' },
    prepare: made => { const engine = made['sess-b']; if (engine) { const real = engine.state.bind(engine); engine.state = () => { reads += 1; return real(); }; } },
  });
  send('sess-a', 'route-1', 'k1', 'first');
  assert.equal(reads, 2, 'one look to see that the receiver lives, and one by the pump');
  relay.control.sessionChanged('sess-b');
  assert.equal(reads, 3);
});
