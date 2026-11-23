import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkSessionId, readList } from '../../engine-sessions/src/request.js';
import { isSessionState, type SessionState } from '../../engine-sessions/src/states.js';
import { MAX_START_GROUP } from '../../engine-sessions/src/vocab.js';
import { isRunId } from '../../jobs/src/ids.js';
import { checkBody, checkKey, fenceText, frameOf, isRouteId, type Envelope } from './envelope.js';
import { createLog } from './log.js';
import { hasExactly, plainRecord } from './read.js';
import type { Route } from './routes.js';
import {
  DEFAULT_DELIVER_TIMEOUT_MS, DEFAULT_KEEP_SETTLED, MAX_DELIVER_TIMEOUT_MS, MAX_KEEP_SETTLED, MAX_LOOP_CAP, MAX_MESSAGE_CAP, MAX_ROUTES, MAX_WAITING_PER_ROUTE,
  isEnded, isFidelity, isRouteRule, type Fidelity, type FailureReason, type MessageInvalidReason, type MessageState, type RouteRule, type StopCause,
} from './vocab.js';

/**
 * The relay bus of one run (v0.9.1). The sessions of a run pass messages through it, under the routes that the person set. It is a core service: it runs in the process of the core, with no socket and no remote transport.
 *
 * The rules that never bend, and where each is kept:
 * - A route is a cable between two sessions, fixed when the relay is made. No call adds a route or a session, and no call reads the output of an engine, so what an engine prints can start, add, or route nothing.
 * - A message is data. The receiver gets it inside a fence that the sender cannot close, and the bus delivers only into a session that runs, so the text never lands on the prompt of an engine that waits for the person.
 * - Delivery is at least once. A repeat of a message, by its key, is dropped.
 * - Receipts are honest. A sender sees `sent` until the receiver sends back the receipt that was inside the text it was given. Only then the message reads as `delivered`.
 * - A write needs the secret of the session that sends. The secrets are made by the core, held in its memory, and given once.
 */

/** What a session offers to the relay. The core builds one from the Engine Host session and the adapter of the engine. */
export interface SessionPort {
  /** The state of the session now. A state that is no state, or a reader that throws, holds a message back and is logged. */
  state(): SessionState;
  /**
   * Gives the text to the engine as its next input, and says how faithfully the engine took it. A rejection or a throw is a failed delivery. `absent` says that the engine has no way to take a message while it runs.
   * The receipt is inside `delivery.text` only. It never travels in the envelope or the frame.
   */
  deliver(delivery: Delivery): Promise<Fidelity>;
}

/** What an engine adapter is given for one message: the envelope, its frame (one JSON line), and the text for the engine, which holds the body inside the fence. Frozen. */
export interface Delivery {
  readonly envelope: Envelope;
  readonly frame: string;
  readonly text: string;
}

export interface RelayMember {
  readonly session: string;
  readonly port: SessionPort;
}

export interface RelayOptions {
  /** The run that the relay serves. */
  readonly run: string;
  /** The routes of the run: at most 32, each between two members, with at most one for each sender and receiver. */
  readonly routes: readonly Route[];
  /** The sessions of the run: 1 to 8. */
  readonly members: readonly RelayMember[];
  /** How many settled messages the relay keeps, from 1 to 1,024. 256 by default. */
  readonly keepSettled?: number;
  /** How long the core waits for an engine to take a message, from 1 to 600,000 milliseconds. 10,000 by default. */
  readonly deliverTimeoutMs?: number;
  /** Runs a callback after a delay and gives the function that cancels it. An unref-ed timer by default. A test passes a schedule that it moves by hand. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /** The time, in milliseconds since the epoch. A time that is not a whole number of at least 0 is a bug of the clock and throws before anything changes. */
  readonly now?: () => number;
  /** Makes a message id. `msg-` and sixteen hexadecimal characters by default. A bad or repeated id throws before anything changes. */
  readonly newId?: () => string;
  /** Makes a session secret: 16 to 256 characters. 64 hexadecimal characters by default. */
  readonly newSecret?: () => string;
  /** Makes the nonce of a fence and the receipt of a message: 16 to 256 characters each. 32 hexadecimal characters by default. */
  readonly newNonce?: () => string;
  readonly newReceipt?: () => string;
  /** The one log. Standard error by default. */
  readonly log?: (line: string) => void;
}

/** One message as a read gives it. Frozen. The receipt of the message is not in it. */
export interface MessageView {
  readonly id: string;
  readonly state: MessageState;
  /** Why the message failed, or `null`. */
  readonly reason: FailureReason | null;
  /** How faithfully the engine took the message, or `null` while it did not. */
  readonly fidelity: Fidelity | null;
  readonly envelope: Envelope;
}

/** One route as a read gives it. `turns` is the length of the back-and-forth that the pair is in now. Frozen. */
export interface RouteView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly rule: RouteRule;
  readonly messageCap: number;
  readonly loopCap: number;
  /** The messages that the route accepted, less those that were given back. */
  readonly accepted: number;
  /** The messages of the route that wait for the person, for a receiver that does not run, or for the engine. */
  readonly waiting: number;
  readonly state: 'open' | 'stopped';
  readonly stoppedBy: StopCause | null;
  readonly stoppedAt: number | null;
  readonly turns: number;
}

type Fail<C extends string> = { readonly ok: false; readonly code: C };
type Invalid = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_INVALID'; readonly reason: MessageInvalidReason };
type NotAccepted = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_NOT_ACCEPTED'; readonly reason: MessageState };
export type SendRefusal = Invalid | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_RELAY_UNAUTHENTICATED' | 'GAUGE_ROUTE_UNKNOWN' | 'GAUGE_MESSAGE_TOO_LARGE' | 'GAUGE_MESSAGE_SECRET_FOUND' | 'GAUGE_RELAY_LOOP_CAP' | 'GAUGE_RELAY_MESSAGE_CAP' | 'GAUGE_RELAY_QUEUE_FULL' | 'GAUGE_RELAY_RECEIVER_GONE'>;
export type SendReply = { readonly ok: true; readonly id: string; readonly state: MessageState; readonly duplicate: boolean } | SendRefusal;
export type ConfirmReply = { readonly ok: true; readonly state: 'delivered' } | Invalid | NotAccepted | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_RELAY_UNAUTHENTICATED' | 'GAUGE_MESSAGE_UNKNOWN' | 'GAUGE_RELAY_RECEIPT_INVALID'>;
export type ControlReply = { readonly ok: true; readonly state: MessageState } | NotAccepted | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_MESSAGE_UNKNOWN' | 'GAUGE_RELAY_RECEIVER_GONE' | 'GAUGE_RELAY_LOOP_CAP' | 'GAUGE_RELAY_MESSAGE_CAP'>;
export type ResumeReply = { readonly ok: true } | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_ROUTE_UNKNOWN'>;

/** What an engine reaches: two writes, each with the secret of its own session. Nothing here approves, declines, resumes, reads, or closes. */
export interface RelayWrites {
  /** `{ session, secret, route, key, body }`. A request of any other shape is refused. */
  send(request: unknown): SendReply;
  /** `{ session, secret, id, receipt }`. The receiver proves that it read the message. */
  confirm(request: unknown): ConfirmReply;
}

/** What the core and the person reach. The Core API carries these calls behind its own plans and grants. */
export interface RelayControl {
  /** Makes the secret of a session and gives it, once. Throws for a session that is not a member, one that has its secret already, and a closed relay. */
  issueSecret(session: string): string;
  /** The person approves a message that waits on an `accepted-output` route. It is accepted now, and moves when the receiver runs. */
  approve(id: unknown): ControlReply;
  /** The person declines a message that waits, or that is accepted and has not reached the engine. A decline is final. */
  decline(id: unknown): ControlReply;
  /** The person resumes a route that a cap stopped. A message cap starts again from zero. A loop cap opens both routes of the pair that the loop stopped, and the back-and-forth starts again. */
  resume(route: unknown): ResumeReply;
  /** The core tells the relay that a session changed its state: a session that runs gets what waits for it, and a session that ended fails what waits for it. A value that is no member does nothing. */
  sessionChanged(session: unknown): void;
  /** Closes the relay: what has not reached an engine fails with `closed`, every secret is forgotten, and every timer is cancelled. Reads still answer. */
  close(): void;
  readonly closed: boolean;
  /** How much the relay holds now: its messages (live and settled), the idempotency keys, the session secrets, and the engines that are taking a message. Each is bounded, and each is empty when nothing is live. */
  sizes(): { readonly messages: number; readonly keys: number; readonly secrets: number; readonly inflight: number };
  /** The messages the relay keeps, in the order they were accepted: those that are live, and the newest settled ones. */
  messages(): readonly MessageView[];
  message(id: unknown): MessageView | undefined;
  routes(): readonly RouteView[];
}

export interface Relay {
  readonly write: RelayWrites;
  readonly control: RelayControl;
}

interface Chain { readonly last: string | null; readonly turns: number; readonly lastId: string | null }
const EMPTY_CHAIN: Chain = Object.freeze({ last: null, turns: 0, lastId: null });

interface Rec {
  readonly id: string;
  readonly route: Route;
  readonly envelope: Envelope;
  readonly bodyHash: string;
  state: MessageState;
  reason: FailureReason | null;
  fidelity: Fidelity | null;
  /** The receipt and the nonce of the delivery. They exist from the moment the engine is asked, and never before. */
  token: string | null;
  nonce: string | null;
  /** The order in which the message ended, or was sent. A message that is live has neither. */
  endSeq: number | null;
  sentSeq: number | null;
  /** True while the message holds a place in the count of its route and in the chain of its pair. */
  counted: boolean;
  /** The epoch of its route when it was counted. */
  epoch: number;
  chainBefore: Chain;
  cancel: (() => void) | null;
}

interface RouteState {
  readonly route: Route;
  stopped: StopCause | null;
  stoppedAt: number | null;
  accepted: number;
  /** Counts the resumes after a message cap. A message counted before a resume holds no place in the count after it. */
  epoch: number;
}

const MAX_TOKEN_LENGTH = 256;
const MIN_TOKEN_LENGTH = 16;
const DRAWS = 4;
const REQUEST_SEND = ['session', 'secret', 'route', 'key', 'body'] as const;
const REQUEST_CONFIRM = ['session', 'secret', 'id', 'receipt'] as const;
const MESSAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROUTE_FIELDS = ['id', 'from', 'to', 'rule', 'messageCap', 'loopCap'] as const;

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
const sameText = (given: string, expected: string): boolean => timingSafeEqual(digest(given), digest(expected));
const pairKey = (first: string, second: string): string => (first < second ? `${first}|${second}` : `${second}|${first}`);
const printable = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that has no text';
  }
};
const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
const inRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Checks the routes of a relay. A route that is wrong is a bug of the caller, since a job checks its routes before a run starts. */
function checkedRoutes(value: unknown, members: ReadonlySet<string>): readonly Route[] {
  const items = readList(value, MAX_ROUTES);
  if (items === undefined) throw new TypeError('relay: the routes are not a plain list of at most 32');
  const routes: Route[] = [], ids = new Set<string>(), pairs = new Set<string>();
  for (const item of items) {
    const fields = plainRecord(item);
    if (fields === undefined || !hasExactly(fields, ROUTE_FIELDS)) throw new TypeError('relay: a route is not a plain record of its six fields');
    const id = fields.get('id'), from = fields.get('from'), to = fields.get('to'), rule = fields.get('rule'), messageCap = fields.get('messageCap'), loopCap = fields.get('loopCap');
    if (!isRouteId(id) || typeof from !== 'string' || typeof to !== 'string' || !members.has(from) || !members.has(to) || from === to) throw new TypeError('relay: a route has a bad id, or names a session that is not a member, or goes from a session to itself');
    if (!isRouteRule(rule) || !inRange(messageCap, 1, MAX_MESSAGE_CAP) || !inRange(loopCap, 1, MAX_LOOP_CAP)) throw new TypeError('relay: a route has a rule or a cap that is not good');
    if (ids.has(id) || pairs.has(JSON.stringify([from, to]))) throw new TypeError('relay: two routes share an id, or a sender and a receiver');
    ids.add(id);
    pairs.add(JSON.stringify([from, to]));
    routes.push(Object.freeze({ id, from, to, rule, messageCap, loopCap }));
  }
  return Object.freeze(routes);
}

function checkedMembers(value: unknown): Map<string, SessionPort> {
  const items = readList(value, MAX_START_GROUP);
  if (items === undefined || items.length === 0) throw new TypeError('relay: the members are not a plain list of 1 to 8');
  const ports = new Map<string, SessionPort>();
  for (const item of items) {
    const fields = plainRecord(item);
    if (fields === undefined || !hasExactly(fields, ['session', 'port'])) throw new TypeError('relay: a member is not a record of a session and a port');
    const session = fields.get('session'), port = fields.get('port');
    if (!checkSessionId(session).ok || typeof session !== 'string' || ports.has(session)) throw new TypeError('relay: a member has a bad session id, or the id is used twice');
    if (typeof port !== 'object' || port === null || typeof (port as SessionPort).state !== 'function' || typeof (port as SessionPort).deliver !== 'function') throw new TypeError('relay: the port of a member has no state and no deliver');
    ports.set(session, port as SessionPort);
  }
  return ports;
}

export function createRelay(options: RelayOptions): Relay {
  const run = options.run;
  if (!isRunId(run)) throw new TypeError('relay: the run id is malformed');
  const ports = checkedMembers(options.members);
  const routes = checkedRoutes(options.routes, new Set(ports.keys()));
  const keepSettled = options.keepSettled ?? DEFAULT_KEEP_SETTLED;
  if (!inRange(keepSettled, 1, MAX_KEEP_SETTLED)) throw new RangeError(`relay: keepSettled is a whole number from 1 to ${MAX_KEEP_SETTLED}`);
  const timeoutMs = options.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS;
  if (!inRange(timeoutMs, 1, MAX_DELIVER_TIMEOUT_MS)) throw new RangeError(`relay: deliverTimeoutMs is a whole number from 1 to ${MAX_DELIVER_TIMEOUT_MS}`);
  const schedule = options.schedule ?? defaultSchedule;
  const clock = options.now ?? Date.now;
  const randomId = (): string => `msg-${randomBytes(8).toString('hex')}`;
  const randomText = (): string => randomBytes(16).toString('hex');
  const newId = options.newId ?? randomId;
  const newSecret = options.newSecret ?? ((): string => randomBytes(32).toString('hex'));
  const newNonce = options.newNonce ?? randomText;
  const newReceipt = options.newReceipt ?? randomText;

  const secrets = new Map<string, string>();
  const issued = new Set<string>();
  const ended = new Set<string>();
  const records = new Map<string, Rec>();
  const keys = new Map<string, string>();
  const routeStates = new Map<string, RouteState>(routes.map(route => [route.id, { route, stopped: null, stoppedAt: null, accepted: 0, epoch: 0 }]));
  const chains = new Map<string, Chain>();
  /** The message that an engine is taking now, for each receiver. One at a time, so the order holds and a slow engine is not flooded. */
  const inflight = new Map<string, string>();
  let seq = 0;
  let closed = false;

  /** Every value that a log, a body, or a key must never hold: the secrets of the sessions, and the receipts and nonces of the messages that were handed to an engine and are not yet delivered. */
  const hiddenValues = (): string[] => {
    const hidden = [...secrets.values()];
    for (const rec of records.values()) {
      if (rec.token !== null && rec.state !== 'delivered') hidden.push(rec.token);
      if (rec.nonce !== null && rec.state !== 'delivered') hidden.push(rec.nonce);
    }
    return hidden;
  };
  const log = createLog({ run, hidden: hiddenValues, log: options.log });

  const time = (): number => {
    const at = clock();
    if (!inRange(at, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError('relay: the clock gave no usable time');
    return at;
  };
  const draw = (make: () => string): string => {
    const value = make();
    if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) throw new TypeError('relay: a made token is not 16 to 256 characters');
    return value;
  };

  const view = (rec: Rec): MessageView => Object.freeze({ id: rec.id, state: rec.state, reason: rec.reason, fidelity: rec.fidelity, envelope: rec.envelope });
  const waitingOf = (routeId: string): number => {
    let count = 0;
    for (const rec of records.values()) if (rec.route.id === routeId && (rec.state === 'pending' || rec.state === 'queued' || rec.state === 'sending')) count += 1;
    return count;
  };
  const routeView = (state: RouteState): RouteView => Object.freeze({
    id: state.route.id, from: state.route.from, to: state.route.to, rule: state.route.rule, messageCap: state.route.messageCap, loopCap: state.route.loopCap,
    accepted: state.accepted, waiting: waitingOf(state.route.id), state: state.stopped === null ? 'open' as const : 'stopped' as const, stoppedBy: state.stopped, stoppedAt: state.stoppedAt,
    turns: (chains.get(pairKey(state.route.from, state.route.to)) ?? EMPTY_CHAIN).turns,
  });

  // ---- the history: bounded, and dropped in the order in which messages ended

  const evict = (rec: Rec): void => {
    records.delete(rec.id);
    const key = `${rec.route.id}\u0000${rec.envelope.key}`;
    if (keys.get(key) === rec.id) keys.delete(key);
  };
  const isSettled = (rec: Rec): boolean => rec.state === 'sent' || rec.state === 'delivered' || rec.state === 'declined' || rec.state === 'failed';
  /** Drops the settled messages beyond the room that is kept. The messages that ended go first, the one that ended first before the others, and then the messages that were sent, the one that was sent first first. A live message is never dropped. */
  function prune(): void {
    const settled = [...records.values()].filter(isSettled);
    if (settled.length <= keepSettled) return;
    settled.sort((left, right) => {
      if ((left.endSeq === null) !== (right.endSeq === null)) return left.endSeq === null ? 1 : -1;
      return (left.endSeq ?? left.sentSeq ?? 0) - (right.endSeq ?? right.sentSeq ?? 0);
    });
    for (const rec of settled.slice(0, settled.length - keepSettled)) evict(rec);
  }
  function settle(rec: Rec, state: MessageState, reason: FailureReason | null): void {
    rec.state = state;
    rec.reason = reason;
    if (state === 'delivered' || state === 'declined' || state === 'failed') rec.endSeq = (seq += 1);
    else if (state === 'sent') rec.sentSeq = (seq += 1);
    prune();
  }

  // ---- the count of a route, and the chain of a pair

  /** Gives back the place of a message in the count of its route and in the chain of its pair. It is for a message that failed before the engine was asked. It does nothing for a message that holds no place. */
  function refund(rec: Rec): void {
    if (!rec.counted) return;
    rec.counted = false;
    const state = routeStates.get(rec.route.id);
    if (state !== undefined && state.epoch === rec.epoch) state.accepted -= 1;
    const key = pairKey(rec.route.from, rec.route.to);
    if ((chains.get(key) ?? EMPTY_CHAIN).lastId !== rec.id) return;
    // The chain goes back to what it was before this message. A message before it that was given back already holds no place, so the chain goes back past it.
    let restored = rec.chainBefore;
    while (restored.lastId !== null) {
      const earlier = records.get(restored.lastId);
      if (earlier === undefined || earlier.counted) break;
      restored = earlier.chainBefore;
    }
    chains.set(key, restored);
  }
  function failBeforeEngine(rec: Rec, reason: FailureReason): void {
    refund(rec);
    settle(rec, 'failed', reason);
  }

  const pairRoutes = (state: RouteState): RouteState[] => [...routeStates.values()].filter(other => pairKey(other.route.from, other.route.to) === pairKey(state.route.from, state.route.to));

  /**
   * Stops a route (a loop stops both routes of its pair), and reports the stop in the log. A stop is about new acceptances: a message that was accepted within the cap goes on, and a message that waits for the person stays as it
   * is, and cannot be approved until the person resumes the route.
   */
  function stopRoute(state: RouteState, cause: StopCause, at: number): void {
    for (const target of (cause === 'loop_cap' ? pairRoutes(state) : [state]).filter(other => other.stopped === null)) {
      target.stopped = cause;
      target.stoppedAt = at;
    }
    const [low, high] = [state.route.from, state.route.to].sort();
    log.write(cause === 'loop_cap'
      ? `route ${state.route.id} stopped: the loop cap of ${state.route.loopCap} is reached between ${low} and ${high}`
      : `route ${state.route.id} stopped: the cap of ${state.route.messageCap} messages is reached`);
  }

  const stoppedRefusal = (cause: StopCause): Fail<'GAUGE_RELAY_LOOP_CAP' | 'GAUGE_RELAY_MESSAGE_CAP'> => ({ ok: false, code: cause === 'loop_cap' ? 'GAUGE_RELAY_LOOP_CAP' : 'GAUGE_RELAY_MESSAGE_CAP' });

  /** Takes a message into the count of its route and the chain of its pair, or refuses it, and stops the route when a cap is reached. It changes nothing for a refusal except the stop. */
  function accept(rec: Rec, at: number): Fail<'GAUGE_RELAY_LOOP_CAP' | 'GAUGE_RELAY_MESSAGE_CAP'> | undefined {
    const state = routeStates.get(rec.route.id);
    if (state === undefined) throw new Error('relay: a message names a route that the relay does not hold');
    if (state.stopped !== null) return stoppedRefusal(state.stopped);
    if (state.accepted >= state.route.messageCap) {
      stopRoute(state, 'message_cap', at);
      return stoppedRefusal('message_cap');
    }
    const key = pairKey(rec.route.from, rec.route.to);
    const chain = chains.get(key) ?? EMPTY_CHAIN;
    // A message from the other session extends the back-and-forth. A message from the same session as the last one starts it again.
    const turns = chain.last !== null && chain.last !== rec.route.from ? chain.turns + 1 : 1;
    if (turns > state.route.loopCap) {
      stopRoute(state, 'loop_cap', at);
      return stoppedRefusal('loop_cap');
    }
    state.accepted += 1;
    rec.counted = true;
    rec.epoch = state.epoch;
    rec.chainBefore = chain;
    chains.set(key, Object.freeze({ last: rec.route.from, turns, lastId: rec.id }));
    return undefined;
  }

  // ---- sessions

  const authentic = (session: unknown, secret: unknown): session is string => {
    if (typeof session !== 'string' || typeof secret !== 'string' || secret.length > MAX_TOKEN_LENGTH) return false;
    const expected = secrets.get(session);
    return expected !== undefined && sameText(secret, expected);
  };

  /** Reads the state of a session. `undefined` when the port cannot say: the reader throws, or the value is no state. A failure is logged once for the session. */
  function readState(session: string): SessionState | undefined {
    try {
      const state: unknown = ports.get(session)?.state();
      if (isSessionState(state)) return state;
      log.once(`state:${session}`, `could not read the state of ${session}: it gave no known state`);
    } catch (error) {
      log.once(`state:${session}`, `could not read the state of ${session}: ${printable(error)}`);
    }
    return undefined;
  }

  function leaveSending(rec: Rec): void {
    rec.cancel?.();
    rec.cancel = null;
    if (inflight.get(rec.envelope.receiver) === rec.id) inflight.delete(rec.envelope.receiver);
  }

  /** A session ended: it can no longer write, and what waits for it fails. A message that the engine was taking is failed too, and the text may have arrived. */
  function sessionEnded(session: string): void {
    ended.add(session);
    secrets.delete(session);
    for (const rec of [...records.values()]) {
      if (rec.envelope.receiver !== session) continue;
      if (rec.state === 'pending' || rec.state === 'queued') failBeforeEngine(rec, 'receiver_gone');
      else if (rec.state === 'sending') {
        leaveSending(rec);
        settle(rec, 'failed', 'receiver_gone');
      }
    }
    log.write(`session ${session} ended, so what waited for it has failed`);
  }

  /** Reads the state of a session, and ends its life in the relay when it has ended. True when the session has ended. */
  function refresh(session: string): boolean {
    if (ended.has(session)) return true;
    const state = readState(session);
    if (state !== undefined && isEnded(state)) {
      sessionEnded(session);
      return true;
    }
    return false;
  }

  // ---- delivery

  function pump(session: string): void {
    if (closed || inflight.has(session)) return;
    let next: Rec | undefined;
    for (const rec of records.values()) if (rec.state === 'queued' && rec.envelope.receiver === session) { next = rec; break; }
    if (next === undefined) return;
    if (refresh(session) || readState(session) !== 'running') return;
    startDelivery(next);
  }

  function startDelivery(rec: Rec): void {
    const receiver = rec.envelope.receiver;
    let nonce = '', receipt = '', cancel: () => void = () => undefined;
    try {
      // The core draws a nonce and a receipt that the body does not hold, so the sender cannot close the fence or forge the receipt. A body that holds every draw fails the message.
      let drawn = false;
      for (let attempt = 0; attempt < DRAWS && !drawn; attempt += 1) {
        nonce = draw(newNonce);
        receipt = draw(newReceipt);
        drawn = !rec.envelope.body.includes(nonce) && !rec.envelope.body.includes(receipt) && nonce !== receipt;
      }
      if (!drawn) throw new Error('every nonce that the core drew was in the body');
      cancel = schedule(() => onTimeout(rec), timeoutMs);
    } catch (error) {
      log.write(`message ${rec.id} could not be prepared for ${receiver}: ${printable(error)}`);
      failBeforeEngine(rec, 'not_prepared');
      pump(receiver);
      return;
    }
    const delivery: Delivery = Object.freeze({ envelope: rec.envelope, frame: frameOf(rec.envelope), text: fenceText({ envelope: rec.envelope, message: rec.id, nonce, receipt }) });
    rec.nonce = nonce;
    rec.token = receipt;
    rec.cancel = cancel;
    rec.state = 'sending';
    inflight.set(receiver, rec.id);
    const port = ports.get(receiver);
    let pending: Promise<Fidelity>;
    try {
      pending = Promise.resolve((port as SessionPort).deliver(delivery));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(answer => onAnswer(rec, answer), error => onFailure(rec, error)).catch(error => log.write(`message ${rec.id}: a late step threw: ${printable(error)}`));
  }

  function onAnswer(rec: Rec, answer: unknown): void {
    if (rec.state !== 'sending') return;
    leaveSending(rec);
    if (!isFidelity(answer)) {
      log.write(`the engine of ${rec.envelope.receiver} gave an answer that is no fidelity, for message ${rec.id}`);
      settle(rec, 'failed', 'delivery_failed');
    } else {
      rec.fidelity = answer;
      if (answer === 'absent') settle(rec, 'failed', 'no_delivery_path');
      else settle(rec, 'sent', null);
    }
    pump(rec.envelope.receiver);
  }

  function onFailure(rec: Rec, error: unknown): void {
    if (rec.state !== 'sending') return;
    leaveSending(rec);
    log.write(`delivery of message ${rec.id} to ${rec.envelope.receiver} failed: ${printable(error)}`);
    settle(rec, 'failed', 'delivery_failed');
    pump(rec.envelope.receiver);
  }

  function onTimeout(rec: Rec): void {
    if (closed || rec.state !== 'sending') return;
    leaveSending(rec);
    log.write(`delivery of message ${rec.id} to ${rec.envelope.receiver} timed out after ${timeoutMs} ms, and the text may still reach the engine`);
    settle(rec, 'failed', 'delivery_timeout');
    pump(rec.envelope.receiver);
  }

  // ---- the writes of an engine

  const unauthenticated = (): Fail<'GAUGE_RELAY_UNAUTHENTICATED'> => {
    log.once('unauthenticated', 'a write came without the right session secret');
    return { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' };
  };

  function send(request: unknown): SendReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const fields = plainRecord(request);
    if (fields === undefined || !hasExactly(fields, REQUEST_SEND)) return { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' };
    const session = fields.get('session'), routeId = fields.get('route');
    if (!authentic(session, fields.get('secret')) || refresh(session)) return unauthenticated();
    // A route that does not exist and a route of another sender are one answer, so a session learns nothing of the routes of the others.
    const state = isRouteId(routeId) ? routeStates.get(routeId) : undefined;
    if (state === undefined || state.route.from !== session) return { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' };
    const hidden = hiddenValues();
    const key = checkKey(fields.get('key'), hidden);
    if (!key.ok) return key;
    const body = checkBody(fields.get('body'), hidden);
    if (!body.ok) return body;
    const bodyHash = digest(body.value).toString('hex');
    const known = keys.get(`${state.route.id}\u0000${key.value}`);
    const earlier = known === undefined ? undefined : records.get(known);
    if (earlier !== undefined) {
      // A repeat is dropped. A key that comes back with another body is refused, so the second body is not lost without a word.
      return earlier.bodyHash === bodyHash ? { ok: true, id: earlier.id, state: earlier.state, duplicate: true } : { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key_reused' };
    }
    if (state.stopped !== null) return stoppedRefusal(state.stopped);
    if (refresh(state.route.to)) return { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' };
    if (waitingOf(state.route.id) >= MAX_WAITING_PER_ROUTE) return { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL' };
    // Everything that can throw comes before the first change: the clock and the id.
    const at = time();
    const id = newId();
    if (typeof id !== 'string' || !MESSAGE_ID.test(id) || records.has(id)) throw new Error('relay: newId gave a message id that is malformed or already used');
    const envelope: Envelope = Object.freeze({ run, route: state.route.id, sender: state.route.from, receiver: state.route.to, body: body.value, time: at, key: key.value });
    const rec: Rec = { id, route: state.route, envelope, bodyHash, state: 'pending', reason: null, fidelity: null, token: null, nonce: null, endSeq: null, sentSeq: null, counted: false, epoch: 0, chainBefore: EMPTY_CHAIN, cancel: null };
    if (state.route.rule === 'auto') {
      const refused = accept(rec, at);
      if (refused !== undefined) return refused;
      rec.state = 'queued';
      log.write(`message ${id} accepted on the auto route ${state.route.id}, from ${state.route.from} to ${state.route.to}`);
    }
    records.set(id, rec);
    keys.set(`${state.route.id}\u0000${key.value}`, id);
    if (rec.state === 'queued') pump(state.route.to);
    return { ok: true, id, state: rec.state, duplicate: false };
  }

  function confirm(request: unknown): ConfirmReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const fields = plainRecord(request);
    if (fields === undefined || !hasExactly(fields, REQUEST_CONFIRM)) return { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' };
    const session = fields.get('session'), id = fields.get('id'), receipt = fields.get('receipt');
    if (!authentic(session, fields.get('secret')) || refresh(session)) return unauthenticated();
    // A message that does not exist and a message for another receiver are one answer.
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    if (rec === undefined || rec.envelope.receiver !== session) return { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' };
    // No receipt exists for a message that was never handed to the engine, and none works twice.
    if (rec.token === null || rec.state === 'delivered') return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: rec.state };
    if (typeof receipt !== 'string' || receipt.length > MAX_TOKEN_LENGTH || !sameText(receipt, rec.token)) return { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' };
    // The receipt is in the text that the engine was given, so it proves that the text reached the engine: also when the answer of the engine is late, or the timeout came first.
    if (rec.state === 'sending') leaveSending(rec);
    settle(rec, 'delivered', null);
    pump(rec.envelope.receiver);
    return { ok: true, state: 'delivered' };
  }

  // ---- the person

  function approve(id: unknown): ControlReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    if (rec === undefined) return { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' };
    if (rec.state !== 'pending') return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: rec.state };
    // The end of the receiver has failed this message already, when it is seen here.
    if (refresh(rec.envelope.receiver)) return { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' };
    const refused = accept(rec, time());
    if (refused !== undefined) return refused;
    rec.state = 'queued';
    pump(rec.envelope.receiver);
    return { ok: true, state: rec.state };
  }

  function decline(id: unknown): ControlReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    if (rec === undefined) return { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' };
    if (rec.state !== 'pending' && rec.state !== 'queued') return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: rec.state };
    refund(rec);
    settle(rec, 'declined', null);
    return { ok: true, state: rec.state };
  }

  function resume(routeId: unknown): ResumeReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const state = isRouteId(routeId) ? routeStates.get(routeId) : undefined;
    if (state === undefined) return { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' };
    if (state.stopped === 'message_cap') {
      state.stopped = null;
      state.stoppedAt = null;
      state.accepted = 0;
      state.epoch += 1;
    } else if (state.stopped === 'loop_cap') {
      for (const other of pairRoutes(state)) {
        if (other.stopped !== 'loop_cap') continue;
        other.stopped = null;
        other.stoppedAt = null;
      }
      chains.delete(pairKey(state.route.from, state.route.to));
    }
    return { ok: true };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const rec of [...records.values()]) {
      if (rec.state === 'pending' || rec.state === 'queued') failBeforeEngine(rec, 'closed');
      else if (rec.state === 'sending') {
        leaveSending(rec);
        settle(rec, 'failed', 'closed');
      }
    }
    secrets.clear();
  }

  const control: RelayControl = Object.freeze({
    issueSecret(session: string): string {
      if (closed || typeof session !== 'string' || !ports.has(session) || issued.has(session)) throw new TypeError('relay: a secret is made once for a session of the run, and never after the relay closed');
      const secret = draw(newSecret);
      issued.add(session);
      secrets.set(session, secret);
      return secret;
    },
    approve,
    decline,
    resume,
    sessionChanged(session: unknown): void {
      if (closed || typeof session !== 'string' || !ports.has(session)) return;
      if (!refresh(session)) pump(session);
    },
    close,
    get closed(): boolean { return closed; },
    sizes: () => Object.freeze({ messages: records.size, keys: keys.size, secrets: secrets.size, inflight: inflight.size }),
    messages: (): readonly MessageView[] => Object.freeze([...records.values()].map(view)),
    message(id: unknown): MessageView | undefined {
      const rec = typeof id === 'string' ? records.get(id) : undefined;
      return rec === undefined ? undefined : view(rec);
    },
    routes: (): readonly RouteView[] => Object.freeze([...routeStates.values()].map(routeView)),
  });
  return Object.freeze({ write: Object.freeze({ send, confirm }), control });
}
