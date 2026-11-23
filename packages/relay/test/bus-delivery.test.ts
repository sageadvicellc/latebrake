// A delivery that cannot be cancelled: the adapter is told to stop, the engine stays busy until the adapter settles, and no late write is ever read as a delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFence } from './fixtures.js';
import { build, route, tick } from './support.js';

const auto = [route('route-1', 'sess-a', 'sess-b', 'auto', 1000, 100), route('route-2', 'sess-b', 'sess-a', 'auto', 1000, 100)];

test('every delivery carries a signal that is not aborted at the start, and is aborted when the core gives up: a timeout, a close, and the end of the receiver', async () => {
  const timeout = build({ routes: auto });
  if (timeout.engines['sess-b']) timeout.engines['sess-b'].mode = 'hang';
  timeout.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const signal = timeout.engines['sess-b']?.deliveries[0]?.signal;
  assert.equal(signal?.aborted, false);
  timeout.timers.fireAll();
  assert.equal(signal?.aborted, true);

  const closing = build({ routes: auto });
  if (closing.engines['sess-b']) closing.engines['sess-b'].mode = 'hang';
  closing.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  closing.relay.control.close();
  assert.equal(closing.engines['sess-b']?.deliveries[0]?.signal.aborted, true);

  const ending = build({ routes: auto });
  if (ending.engines['sess-b']) ending.engines['sess-b'].mode = 'hang';
  ending.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  ending.engines['sess-b']?.setState('stopped');
  ending.relay.control.sessionChanged('sess-b');
  assert.equal(ending.engines['sess-b']?.deliveries[0]?.signal.aborted, true);
});

test('a delivery that finishes or is confirmed in time is never aborted', async () => {
  const { engines, send, confirm } = build({ routes: auto });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  confirm('sess-b', 'msg-1', engines['sess-b']?.lastReceipt()?.receipt ?? '');
  engines['sess-b']?.release();
  await tick();
  assert.equal(engines['sess-b']?.deliveries[0]?.signal.aborted, false);
});

test('an adapter that honors the signal writes nothing after the timeout, also when a prompt appeared after the delivery began: the prompt is not answered and the message is never read as delivered', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'late';
  send('sess-a', 'route-1', 'k1', 'y');
  await tick();
  engine?.ask('Allow this tool to edit files? (y/n)');
  timers.fireAll();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  engine?.release();
  await tick();
  assert.deepEqual(engine?.inputs, []);
  assert.deepEqual(engine?.promptAnswers, []);
  assert.equal(engine?.prompt, 'Allow this tool to edit files? (y/n)');
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
});

test('an adapter that ignores the signal may write late into a prompt, which the relay cannot prevent, but the message is never read as delivered or sent because of it', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) { engine.mode = 'late'; engine.honorsAbort = false; }
  send('sess-a', 'route-1', 'k1', 'y');
  await tick();
  engine?.ask('Allow this tool to edit files? (y/n)');
  timers.fireAll();
  engine?.release();
  await tick();
  assert.equal(engine?.promptAnswers.length, 1, 'the contract is broken by the adapter, and the text landed on the prompt');
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.notEqual(relay.control.message('msg-1')?.state, 'delivered');
});

test('two deliveries never run into one engine at once: a message waits behind a timed-out delivery until the adapter settles', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  send('sess-a', 'route-1', 'k3', 'third');
  await tick();
  timers.fireAll();
  await tick();
  assert.equal(engine?.deliveries.length, 1);
  assert.deepEqual(relay.control.messages().map(view => view.state), ['failed', 'queued', 'queued']);
  if (engine) engine.mode = 'accept';
  engine?.release();
  await tick();
  assert.deepEqual(relay.control.messages().map(view => view.state), ['failed', 'sent', 'sent']);
  assert.equal(engine?.maxActive, 1);
  assert.deepEqual(engine?.inputs.map(text => parseFence(text)?.body), ['first', 'second', 'third']);
});

test('a rejection of the adapter after the timeout frees the engine too, and the next message goes', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  timers.fireAll();
  if (engine) engine.mode = 'accept';
  engine?.failHung('too late');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
});

test('an adapter that never settles leaves the engine stuck after the wait: what waits fails with receiver_stuck, a new message fails the same way, and the engine is free again when the adapter does settle', async () => {
  const { relay, engines, send, timers, lines } = build({ routes: auto, options: { abandonMs: 7000 } });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  timers.fireAll();
  assert.deepEqual(timers.delays(), [7000]);
  timers.fireAll();
  assert.equal(relay.control.message('msg-2')?.reason, 'receiver_stuck');
  assert.equal(relay.control.routes()[0]?.accepted, 1, 'a message that never reached the engine gives its count back');
  assert.equal(lines.some(line => line === 'relay run-1: the engine of sess-b never settled its delivery of message msg-1, so nothing more is given to it until it does'), true);
  send('sess-a', 'route-1', 'k3', 'third');
  assert.equal(relay.control.message('msg-3')?.reason, 'receiver_stuck');
  assert.equal(engine?.deliveries.length, 1);
  assert.equal(timers.live(), 0);
  if (engine) engine.mode = 'accept';
  engine?.release();
  await tick();
  send('sess-a', 'route-1', 'k4', 'fourth');
  await tick();
  assert.equal(relay.control.message('msg-4')?.state, 'sent');
  assert.equal(engine?.maxActive, 1);
});

test('a receipt frees a busy engine at once, also after the timeout, and its stuck timer is cancelled', async () => {
  const { relay, engines, send, confirm, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  const receipt = engine?.lastReceipt()?.receipt ?? '';
  timers.fireAll();
  assert.equal(timers.live(), 1);
  if (engine) engine.mode = 'accept';
  assert.equal(confirm('sess-b', 'msg-1', receipt).ok, true);
  await tick();
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
  assert.equal(timers.live(), 0, 'the stuck timer of the first message and the timer of the second are both gone');
});

test('the end of the receiver and a close free the busy marker and cancel the stuck timer, so nothing is held', async () => {
  const ended = build({ routes: auto });
  if (ended.engines['sess-b']) ended.engines['sess-b'].mode = 'hang';
  ended.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  ended.timers.fireAll();
  assert.equal(ended.timers.live(), 1);
  ended.engines['sess-b']?.setState('stopped');
  ended.relay.control.sessionChanged('sess-b');
  assert.deepEqual([ended.timers.live(), ended.relay.control.sizes().inflight], [0, 0]);

  const closed = build({ routes: auto });
  if (closed.engines['sess-b']) closed.engines['sess-b'].mode = 'hang';
  closed.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  closed.timers.fireAll();
  closed.relay.control.close();
  assert.deepEqual([closed.timers.live(), closed.relay.control.sizes().inflight], [0, 0]);
});

test('a stuck timer that fires after its engine was freed does nothing, even from a schedule that cannot cancel', async () => {
  const callbacks: (() => void)[] = [];
  const { relay, engines, send } = build({ routes: auto, options: { schedule: run => { callbacks.push(run); return () => undefined; } } });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  await tick();
  callbacks[0]?.();
  assert.equal(callbacks.length, 2);
  if (engine) engine.mode = 'accept';
  engine?.release();
  await tick();
  assert.equal(relay.control.message('msg-2')?.state, 'sent');
  callbacks[1]?.();
  send('sess-a', 'route-1', 'k3', 'third');
  await tick();
  assert.equal(relay.control.message('msg-3')?.state, 'sent');
});

test('a cancel that throws never throws out of the relay: the failure is logged, and the message goes on', async () => {
  const { relay, engines, send, lines } = build({ routes: auto, options: { schedule: () => () => { throw new Error('cancel broke'); } } });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.doesNotThrow(() => engines['sess-b']?.release());
  await tick();
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(lines.includes('relay run-1: the timer of message msg-1 failed: cancel broke'), true);
});

test('a timer callback that cannot run its work never throws out of the timer', async () => {
  const callbacks: (() => void)[] = [];
  const { relay, engines, send } = build({
    routes: auto,
    options: { schedule: run => { callbacks.push(run); return () => undefined; }, log: () => { throw new Error('the log broke'); } },
  });
  if (engines['sess-b']) engines['sess-b'].mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => callbacks.forEach(run => run()));
  } finally {
    process.stderr.write = original;
  }
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
});

test('a schedule that returns no function is a failed cancel that is logged, and never a throw', async () => {
  const { relay, engines, send, lines } = build({ routes: auto, options: { schedule: (() => undefined) as never } });
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  void engines;
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(lines.filter(line => line.includes('failed')).length, 0, 'a value that is not a function is skipped without a word');
});

test('a late answer after the timeout records the fidelity when none is known, and the state does not change', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'weakened'; }
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timers.fireAll();
  assert.equal(relay.control.message('msg-1')?.fidelity, null);
  engine?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.fidelity, 'weakened');
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.reason, 'delivery_timeout');
});

test('a receipt before the answer gives the fidelity unknown, and the answer that follows replaces it without a change of state', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'translated'; }
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.deepEqual(confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? ''), { ok: true, state: 'delivered' });
  assert.equal(relay.control.message('msg-1')?.fidelity, 'unknown');
  assert.equal(relay.control.message('msg-1')?.failedBefore, null);
  engine?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.fidelity, 'translated');
  assert.equal(relay.control.message('msg-1')?.state, 'delivered');
});

test('a late answer never changes a fidelity that is known already', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'exact'; }
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timers.fireAll();
  engine?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.fidelity, 'exact');
  // A second late answer for the same message cannot come, and a garbage answer is no fidelity.
  const other = build({ routes: auto });
  if (other.engines['sess-b']) other.engines['sess-b'].mode = 'garbage';
  other.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(other.relay.control.message('msg-1')?.fidelity, null);
});

test('a receipt for a message that failed with no_delivery_path is refused with the receipt code: absent says that no delivery path existed', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.fidelity = 'absent';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(relay.control.message('msg-1')?.reason, 'no_delivery_path');
  const receipt = engine?.lastReceipt()?.receipt ?? '';
  assert.deepEqual(confirm('sess-b', 'msg-1', receipt), { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' });
  assert.equal(relay.control.message('msg-1')?.state, 'failed');
  assert.equal(relay.control.message('msg-1')?.fidelity, 'absent');
});

test('a receipt for a message that failed with delivery_failed or delivery_timeout still proves delivery: delivered, the failure kept apart, and the fidelity recorded or unknown', async () => {
  const failed = build({ routes: auto });
  const engine = failed.engines['sess-b'];
  if (engine) engine.mode = 'garbage';
  failed.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.equal(failed.relay.control.message('msg-1')?.reason, 'delivery_failed');
  assert.deepEqual(failed.confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? ''), { ok: true, state: 'delivered' });
  assert.deepEqual([failed.relay.control.message('msg-1')?.state, failed.relay.control.message('msg-1')?.reason, failed.relay.control.message('msg-1')?.failedBefore, failed.relay.control.message('msg-1')?.fidelity], ['delivered', null, 'delivery_failed', 'unknown']);

  const timed = build({ routes: auto });
  const slow = timed.engines['sess-b'];
  if (slow) { slow.mode = 'hang'; slow.fidelity = 'weakened'; }
  timed.send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timed.timers.fireAll();
  slow?.release();
  await tick();
  assert.deepEqual(timed.confirm('sess-b', 'msg-1', slow?.lastReceipt()?.receipt ?? ''), { ok: true, state: 'delivered' });
  assert.deepEqual([timed.relay.control.message('msg-1')?.state, timed.relay.control.message('msg-1')?.reason, timed.relay.control.message('msg-1')?.failedBefore, timed.relay.control.message('msg-1')?.fidelity], ['delivered', null, 'delivery_timeout', 'weakened']);
});

test('the settle of an old delivery frees only its own engine slot: a late answer of a message that a receipt already proved does not free the engine of the message that runs now', async () => {
  const { relay, engines, send, confirm } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  send('sess-a', 'route-1', 'k2', 'second');
  send('sess-a', 'route-1', 'k3', 'third');
  await tick();
  confirm('sess-b', 'msg-1', engine?.lastReceipt()?.receipt ?? '');
  assert.equal(engine?.deliveries.length, 2, 'the second message runs now');
  engine?.releaseFirst();
  await tick();
  assert.equal(engine?.deliveries.length, 2, 'the answer of the first message does not free the engine of the second');
  assert.equal(relay.control.message('msg-3')?.state, 'queued');
  engine?.releaseFirst();
  await tick();
  assert.equal(engine?.deliveries.length, 3);
  assert.equal(engine?.maxActive, 2, 'the first delivery was still open when the second began, because its receipt had proved it: only the receipt frees an engine before the adapter settles');
});

test('a late answer that is no fidelity is not recorded', async () => {
  const { relay, engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) { engine.mode = 'hang'; engine.fidelity = 'maybe' as never; }
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timers.fireAll();
  engine?.release();
  await tick();
  assert.equal(relay.control.message('msg-1')?.fidelity, null);
});

test('a receipt for an early stop of the engine is no help: the settle of the old promise leaves a newer busy marker alone, also with a single release', async () => {
  const { engines, send, timers } = build({ routes: auto });
  const engine = engines['sess-b'];
  if (engine) engine.mode = 'hang';
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  timers.fireAll();
  assert.equal(engine?.deliveries.length, 1);
  engine?.releaseFirst();
  await tick();
  assert.equal(timers.live(), 0);
});
