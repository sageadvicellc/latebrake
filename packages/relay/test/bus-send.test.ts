// The bus, the write side: what an engine may send with its session secret, and every refusal, in the order that it is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/bus.js';
import { createFakeEngine } from '../src/fixtures.js';
import { build, route, tick } from './support.js';

const GOOD_BODY = 'Please check the draft in the shared folder.';

test('a message on a new accepted-output route waits for the person, and nothing reaches the receiver', async () => {
  const { relay, engines, send, clock } = build();
  const reply = send('sess-a', 'route-1', 'key-1', GOOD_BODY);
  assert.deepEqual(reply, { ok: true, id: 'msg-1', state: 'pending', duplicate: false });
  await tick();
  assert.deepEqual(engines['sess-b']?.inputs, []);
  assert.deepEqual(relay.control.message('msg-1'), {
    id: 'msg-1', state: 'pending', reason: null, fidelity: null,
    envelope: { run: 'run-1', route: 'route-1', sender: 'sess-a', receiver: 'sess-b', body: GOOD_BODY, time: clock.now, key: 'key-1' },
  });
});

test('the envelope takes the sender from the secret and the route and never from the request, and the time from the clock of the core', () => {
  const { relay, send, clock } = build();
  clock.now = 1_800_000_000_123;
  send('sess-a', 'route-1', 'k', 'body');
  const view = relay.control.message('msg-1');
  assert.equal(view?.envelope.sender, 'sess-a');
  assert.equal(view?.envelope.receiver, 'sess-b');
  assert.equal(view?.envelope.time, 1_800_000_000_123);
});

test('a message on an auto route flows at once: the receiver gets the fenced text, and the sender sees sent and not delivered', async () => {
  const { relay, engines, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  const reply = send('sess-a', 'route-1', 'key-1', GOOD_BODY);
  assert.equal(reply.ok, true);
  await tick();
  const engine = engines['sess-b'];
  assert.equal(engine?.inputs.length, 1);
  assert.match(engine?.inputs[0] ?? '', /^BEGIN PEER MESSAGE nonce-1-n+\n/);
  assert.equal(engine?.inputs[0]?.includes(GOOD_BODY), true);
  assert.equal(relay.control.message('msg-1')?.state, 'sent');
  assert.equal(relay.control.message('msg-1')?.fidelity, 'exact');
});

test('the receiver is given the envelope, its frame, and the text, and the frame is the one frame of the envelope', async () => {
  const { engines, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  send('sess-a', 'route-1', 'key-1', GOOD_BODY);
  await tick();
  const delivery = engines['sess-b']?.deliveries[0];
  assert.deepEqual(JSON.parse(delivery?.frame ?? 'null'), delivery?.envelope);
  assert.equal(Object.isFrozen(delivery), true);
  assert.equal(delivery?.frame.includes('\n'), false);
});

test('a write without the right secret is refused, and the reply is the same for a wrong secret, a missing one, a secret of another session, and an unknown session', () => {
  const { relay, secrets } = build();
  const same = { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' };
  const base = { route: 'route-1', key: 'k', body: 'hello' };
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: 'wrong', ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: '', ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: secrets['sess-b'], ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-zzz', secret: secrets['sess-a'], ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-zzz', secret: 'wrong', ...base }), same);
  assert.deepEqual(relay.write.send({ session: 5, secret: secrets['sess-a'], ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: 5, ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: 'q'.repeat(100_000), ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: `${secrets['sess-a']}x`, ...base }), same);
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: (secrets['sess-a'] ?? '').slice(0, -1), ...base }), same);
  assert.deepEqual(relay.control.messages(), []);
});

test('a session that was never given a secret cannot write, whatever it sends', () => {
  const { relay } = build({ noSecrets: true });
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: undefined, route: 'route-1', key: 'k', body: 'hello' }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: '', route: 'route-1', key: 'k', body: 'hello' }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
});

test('a refused write for a secret is logged once, with no value in it, and a flood makes one line', () => {
  const { relay, lines } = build();
  for (let i = 0; i < 20; i += 1) relay.write.send({ session: 'sess-a', secret: `guess-${i}`, route: 'route-1', key: 'k', body: 'hello' });
  assert.deepEqual(lines, ['relay run-1: a write came without the right session secret']);
});

test('a request that is not a plain record of exactly the five fields is a malformed request, also with a good secret', () => {
  const { relay, secrets } = build();
  const good = { session: 'sess-a', secret: secrets['sess-a'], route: 'route-1', key: 'k', body: 'hello' };
  const accessor = { ...good };
  Object.defineProperty(accessor, 'body', { get: () => 'hello', enumerable: true });
  class Request { session = 'sess-a'; secret = secrets['sess-a']; route = 'route-1'; key = 'k'; body = 'hello'; }
  const { body: _body, ...missing } = good;
  const expected = { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' };
  for (const value of [{ ...good, extra: 1 }, { ...good, sender: 'sess-b' }, { ...good, receiver: 'sess-b' }, missing, accessor, new Request(), [good], null, undefined, 'text', 5, { ...good, [Symbol('s')]: 1 }]) {
    assert.deepEqual(relay.write.send(value), expected);
  }
  assert.deepEqual(relay.control.messages(), []);
});

test('a route that does not exist, a route of another sender, and a route id that is not text give the same refusal, so a session learns nothing of the routes of others', () => {
  const { relay, secrets } = build({ sessions: ['sess-a', 'sess-b', 'sess-c'], routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-c', 'sess-b')] });
  const same = { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' };
  const call = (routeId: unknown) => relay.write.send({ session: 'sess-a', secret: secrets['sess-a'], route: routeId, key: 'k', body: 'hello' });
  assert.deepEqual(call('route-9'), same);
  assert.deepEqual(call('route-2'), same);
  assert.deepEqual(call(5), same);
  assert.deepEqual(call(''), same);
  assert.deepEqual(call('__proto__'), same);
  assert.deepEqual(call('constructor'), same);
  assert.equal(call('route-1').ok, true);
});

test('a route is used only by its sender: the receiver of a route cannot send on it', () => {
  const { relay, secrets } = build();
  assert.deepEqual(relay.write.send({ session: 'sess-b', secret: secrets['sess-b'], route: 'route-1', key: 'k', body: 'hello' }), { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' });
});

test('a bad key is a malformed key, and a key that looks like a secret is a secret', () => {
  const { send, relay } = build();
  assert.deepEqual(send('sess-a', 'route-1', '', 'hello'), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key' });
  assert.deepEqual(send('sess-a', 'route-1', 'a b', 'hello'), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key' });
  assert.deepEqual(send('sess-a', 'route-1', 'aB3'.repeat(12), 'hello'), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.deepEqual(relay.control.messages(), []);
});

test('a body of exactly 16,384 bytes is taken and one more byte is refused as too large', () => {
  const { send, relay } = build();
  assert.equal(send('sess-a', 'route-1', 'k1', 'a'.repeat(16_384)).ok, true);
  assert.deepEqual(send('sess-a', 'route-1', 'k2', 'a'.repeat(16_385)), { ok: false, code: 'GAUGE_MESSAGE_TOO_LARGE' });
  assert.equal(relay.control.messages().length, 1);
});

test('a body with a secret is refused, and a body that holds the secret of another session is refused as a secret, also when it is all lower case', () => {
  const { send, secrets, relay } = build();
  assert.deepEqual(send('sess-a', 'route-1', 'k1', `use ghp_${'a1B2'.repeat(6)} please`), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.deepEqual(send('sess-a', 'route-1', 'k2', `his secret is ${secrets['sess-b']}`), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.deepEqual(send('sess-a', 'route-1', 'k3', `my own secret is ${secrets['sess-a']}`), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.deepEqual(send('sess-a', 'route-1', 'k4', 'text\u001b[2J'), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'body' });
  assert.deepEqual(relay.control.messages(), []);
});

test('a body that holds the receipt or the nonce of a message that is in flight is refused as a secret', async () => {
  const { send, engines, relay } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4), route('route-2', 'sess-b', 'sess-a', 'auto', 10, 4)], options: { newReceipt: () => 'rcpt-fixed-0000000000000000', newNonce: () => 'nonce-fixed-000000000000000' } });
  engines['sess-b']?.setState('running');
  send('sess-a', 'route-1', 'k1', 'first');
  await tick();
  assert.deepEqual(send('sess-b', 'route-2', 'k2', 'my receipt is rcpt-fixed-0000000000000000'), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.deepEqual(send('sess-b', 'route-2', 'k3', 'the nonce is nonce-fixed-000000000000000'), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
  assert.equal(relay.control.messages().length, 1);
});

test('the checks run in order: closed, shape, secret, route, key, body size, body shape, body secret, then the state of the route', () => {
  const { relay, secrets } = build();
  const call = (over: Record<string, unknown>) => relay.write.send({ session: 'sess-a', secret: secrets['sess-a'], route: 'route-1', key: 'k', body: 'hello', ...over });
  assert.deepEqual(call({ secret: 'bad', route: 'nope', key: '', body: '' }), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
  assert.deepEqual(call({ route: 'nope', key: '', body: '' }), { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' });
  assert.deepEqual(call({ key: '', body: '' }), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key' });
  assert.deepEqual(call({ body: 'a'.repeat(20_000) }), { ok: false, code: 'GAUGE_MESSAGE_TOO_LARGE' });
  assert.deepEqual(call({ body: '' }), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'body' });
  assert.deepEqual(call({ body: `ghp_${'a1B2'.repeat(6)}` }), { ok: false, code: 'GAUGE_MESSAGE_SECRET_FOUND' });
});

test('a repeat of a message is dropped by its idempotency key: one record, one delivery, and the reply names the first message', async () => {
  const { relay, engines, send } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  const first = send('sess-a', 'route-1', 'same-key', GOOD_BODY);
  await tick();
  const again = send('sess-a', 'route-1', 'same-key', GOOD_BODY);
  assert.deepEqual(first, { ok: true, id: 'msg-1', state: 'sending', duplicate: false });
  assert.deepEqual(again, { ok: true, id: 'msg-1', state: 'sent', duplicate: true });
  await tick();
  assert.equal(relay.control.messages().length, 1);
  assert.equal(engines['sess-b']?.inputs.length, 1);
  assert.equal(relay.control.routes()[0]?.accepted, 1);
});

test('a repeat is dropped while the first message is still pending, and after the person declined it, so a retry never asks again', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'same-key', GOOD_BODY);
  assert.deepEqual(send('sess-a', 'route-1', 'same-key', GOOD_BODY), { ok: true, id: 'msg-1', state: 'pending', duplicate: true });
  relay.control.decline('msg-1');
  assert.deepEqual(send('sess-a', 'route-1', 'same-key', GOOD_BODY), { ok: true, id: 'msg-1', state: 'declined', duplicate: true });
  assert.equal(relay.control.messages().length, 1);
});

test('a key that is used again for another body is refused as key_reused, and it does not replace the first message', () => {
  const { relay, send } = build();
  send('sess-a', 'route-1', 'same-key', GOOD_BODY);
  assert.deepEqual(send('sess-a', 'route-1', 'same-key', `${GOOD_BODY} Also this.`), { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key_reused' });
  assert.equal(relay.control.message('msg-1')?.envelope.body, GOOD_BODY);
  assert.equal(relay.control.messages().length, 1);
});

test('a key belongs to its route: the same key on another route is another message', () => {
  const { relay, send } = build({ sessions: ['sess-a', 'sess-b', 'sess-c'], routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-a', 'sess-c')] });
  assert.equal(send('sess-a', 'route-1', 'k', 'one').ok, true);
  assert.deepEqual(send('sess-a', 'route-2', 'k', 'one'), { ok: true, id: 'msg-2', state: 'pending', duplicate: false });
  assert.equal(relay.control.messages().length, 2);
});

test('a route holds at most 16 waiting messages, and the 17th is refused until one moves', () => {
  const { send, relay } = build();
  for (let i = 0; i < 16; i += 1) assert.equal(send('sess-a', 'route-1', `k${i}`, `message ${i}`).ok, true);
  assert.deepEqual(send('sess-a', 'route-1', 'k16', 'one too many'), { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL' });
  assert.equal(relay.control.routes()[0]?.waiting, 16);
  relay.control.decline('msg-1');
  assert.equal(send('sess-a', 'route-1', 'k16', 'one too many').ok, true);
  assert.equal(relay.control.routes()[0]?.waiting, 16);
});

test('the full queue of one route does not stop another route', () => {
  const { send } = build();
  for (let i = 0; i < 16; i += 1) send('sess-a', 'route-1', `k${i}`, `message ${i}`);
  assert.equal(send('sess-b', 'route-2', 'k0', 'a reply').ok, true);
});

test('a refused send leaves nothing behind: no record, no key, no count, no timer, no waiting place', () => {
  const { send, relay, timers } = build({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)] });
  send('sess-a', 'route-1', 'bad key', 'x');
  send('sess-a', 'route-1', 'k', '');
  send('sess-a', 'route-1', 'k', 'a'.repeat(20_000));
  send('sess-a', 'nope', 'k', 'x');
  assert.deepEqual(relay.control.messages(), []);
  assert.equal(relay.control.routes()[0]?.accepted, 0);
  assert.equal(relay.control.routes()[0]?.waiting, 0);
  assert.equal(timers.live(), 0);
  // The key of a refused send is free for a good one.
  assert.equal(send('sess-a', 'route-1', 'k', 'x').ok, true);
});

test('a receiver that has ended is a refusal with its own code, and a sender that has ended can no longer write', () => {
  const { send, engines } = build();
  engines['sess-b']?.setState('stopped');
  assert.deepEqual(send('sess-a', 'route-1', 'k', 'hello'), { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' });
  engines['sess-a']?.setState('failed');
  assert.deepEqual(send('sess-a', 'route-1', 'k', 'hello'), { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' });
});

test('a closed relay refuses every write with its own code, with a good secret and with a bad one', () => {
  const { relay, send } = build();
  relay.control.close();
  assert.deepEqual(send('sess-a', 'route-1', 'k', 'hello'), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.deepEqual(relay.write.send({ session: 'sess-a', secret: 'bad', route: 'route-1', key: 'k', body: 'hello' }), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
  assert.deepEqual(relay.write.send(5), { ok: false, code: 'GAUGE_RELAY_CLOSED' });
});

test('a clock that gives no usable time throws before anything changes, and the next write works', () => {
  const { relay, send, clock } = build();
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    clock.now = bad;
    assert.throws(() => send('sess-a', 'route-1', 'k', 'hello'), RangeError);
  }
  assert.deepEqual(relay.control.messages(), []);
  clock.now = 1_700_000_000_000;
  assert.equal(send('sess-a', 'route-1', 'k', 'hello').ok, true);
});

test('an id maker that gives a bad or a repeated id throws before anything changes', () => {
  let n = 0;
  const { relay, send } = build({ options: { newId: () => (n += 1) <= 1 ? 'msg-1' : n === 2 ? 'msg-1' : n === 3 ? 'Bad Id' : 'msg-4' } });
  assert.equal(send('sess-a', 'route-1', 'k1', 'one').ok, true);
  assert.throws(() => send('sess-a', 'route-1', 'k2', 'two'), Error);
  assert.throws(() => send('sess-a', 'route-1', 'k2', 'two'), Error);
  assert.equal(relay.control.messages().length, 1);
  assert.equal(relay.control.routes()[0]?.waiting, 1);
  assert.equal(send('sess-a', 'route-1', 'k2', 'two').ok, true);
});

test('the secrets: one for each session, once, of a usable length, and never after the relay has closed', () => {
  const engines = ['sess-a', 'sess-b'].map(name => createFakeEngine(name));
  const make = (over: Record<string, unknown> = {}) => createRelay({
    run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b')], members: engines.map(engine => ({ session: engine.session, port: engine })), ...over,
  });
  const relay = make();
  const secret = relay.control.issueSecret('sess-a');
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notEqual(relay.control.issueSecret('sess-b'), secret);
  assert.throws(() => relay.control.issueSecret('sess-a'), TypeError);
  assert.throws(() => relay.control.issueSecret('sess-zzz'), TypeError);
  assert.throws(() => relay.control.issueSecret(5 as unknown as string), TypeError);
  assert.throws(() => make({ newSecret: () => 'short' }).control.issueSecret('sess-a'), TypeError);
  assert.throws(() => make({ newSecret: () => 5 }).control.issueSecret('sess-a'), TypeError);
  const closed = make();
  closed.control.close();
  assert.throws(() => closed.control.issueSecret('sess-a'), TypeError);
});

test('a relay is not made from options that are wrong: each is a bug of the caller and throws', () => {
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b');
  const members = [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }];
  const routes = [route('route-1', 'sess-a', 'sess-b')];
  const make = (over: Record<string, unknown>) => () => createRelay({ run: 'run-1', routes, members, ...over });
  assert.doesNotThrow(make({}));
  assert.throws(make({ run: 'Run 1' }), TypeError);
  assert.throws(make({ members: [] }), TypeError);
  assert.throws(make({ members: Array.from({ length: 9 }, (_v, i) => ({ session: `sess-${i}`, port: a })) }), TypeError);
  assert.throws(make({ members: [members[0], members[0]] }), TypeError);
  assert.throws(make({ members: [{ session: 'sess-a', port: {} }, members[1]] }), TypeError);
  assert.throws(make({ members: [{ session: 'Sess A', port: a }, members[1]] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-a', 'sess-zzz')] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-zzz', 'sess-b')] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-a', 'sess-a')] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-a', 'sess-b'), route('route-1', 'sess-b', 'sess-a')] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-a', 'sess-b'), route('route-2', 'sess-a', 'sess-b')] }), TypeError);
  assert.throws(make({ routes: [route('Route 1', 'sess-a', 'sess-b')] }), TypeError);
  assert.throws(make({ routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 0, 3)] }), TypeError);
  assert.throws(make({ routes: [{ ...route('route-1', 'sess-a', 'sess-b'), rule: 'manual' }] }), TypeError);
  assert.throws(make({ routes: Array.from({ length: 33 }, (_v, i) => route(`route-${i}`, 'sess-a', 'sess-b')) }), TypeError);
  assert.throws(make({ routes: 'x' }), TypeError);
  assert.throws(make({ keepSettled: 0 }), RangeError);
  assert.throws(make({ keepSettled: 1025 }), RangeError);
  assert.throws(make({ keepSettled: 1.5 }), RangeError);
  assert.throws(make({ deliverTimeoutMs: 0 }), RangeError);
  assert.throws(make({ deliverTimeoutMs: 600_001 }), RangeError);
  assert.doesNotThrow(make({ keepSettled: 1, deliverTimeoutMs: 1 }));
  assert.doesNotThrow(make({ keepSettled: 1024, deliverTimeoutMs: 600_000 }));
});

test('a timer that the relay sets for a delivery is unref-ed by default, so it never holds the process open, and the default timeout is 10 seconds', async () => {
  const a = createFakeEngine('sess-a'), b = createFakeEngine('sess-b', { mode: 'hang' });
  const made = createRelay({ run: 'run-1', routes: [route('route-1', 'sess-a', 'sess-b', 'auto', 10, 4)], members: [{ session: 'sess-a', port: a }, { session: 'sess-b', port: b }] });
  const secret = made.control.issueSecret('sess-a');
  const handles: unknown[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms: number) => { const handle = real(run, ms); handles.push({ ms, handle }); return handle; }) as typeof setTimeout;
  try {
    made.write.send({ session: 'sess-a', secret, route: 'route-1', key: 'k', body: 'hello' });
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(handles.length, 1);
  const { ms, handle } = handles[0] as { ms: number; handle: NodeJS.Timeout };
  assert.equal(ms, 10_000);
  assert.equal(handle.hasRef(), false);
  made.control.close();
  await tick();
});
