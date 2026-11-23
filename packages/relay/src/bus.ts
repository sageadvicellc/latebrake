import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkSessionId, readList } from '../../engine-sessions/src/request.js';
import { isSessionState, type SessionState } from '../../engine-sessions/src/states.js';
import { MAX_START_GROUP } from '../../engine-sessions/src/vocab.js';
import { isRunId } from '../../jobs/src/ids.js';
import { isMessageId, isNonce, isReceipt, isRouteId, isSessionSecret, MAX_TOKEN_LENGTH, type MessageId, type Nonce, type Receipt, type RouteId, type SessionSecret } from './brand.js';
import { checkBody, checkEnvelope, checkKey, fenceText, frameOf, type Envelope } from './envelope.js';
import { createLog, redactText } from './log.js';
import { hasExactly, plainRecord } from './read.js';
import type { Route } from './routes.js';
import {
  DEFAULT_ABANDON_MS, DEFAULT_DECLINE_CAP, DEFAULT_DELIVER_TIMEOUT_MS, DEFAULT_KEEP_KEYS, DEFAULT_KEEP_SETTLED, DEFAULT_RUN_CAP, DECLINED_SLACK, MAX_ABANDON_MS, MAX_DECLINE_CAP, MAX_DELIVER_TIMEOUT_MS,
  MAX_KEEP_KEYS, MAX_KEEP_SETTLED, MAX_LOOP_CAP, MAX_MESSAGE_CAP, MAX_ROUTES, MAX_RUN_CAP, MAX_WAITING_PER_ROUTE, MIN_KEEP_KEYS, isAdapterFidelity, isEnded, isRouteRule,
  type AdapterFidelity, type FailureReason, type Fidelity, type MessageInvalidReason, type MessageState, type QueueReason, type RouteRule, type SecretReason, type StopCause, type WaitingCause,
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
 * - Two deliveries never run into one engine at once, and a delivery that the core gave up on is told to stop (`delivery.signal`).
 */

/** What a session offers to the relay. The core builds one from the Engine Host session and the adapter of the engine. The relay reads `state` and `deliver` once, when it is made. */
export interface SessionPort {
  /** The state of the session now. A state that is no state, or a reader that throws, holds a message back and is logged. */
  state(): SessionState;
  /**
   * Gives the text to the engine as its next input, and says how faithfully the engine took it. A rejection or a throw is a failed delivery. `absent` says that the engine has no way to take a message while it runs.
   * The receipt is inside `delivery.text` only. It never travels in the envelope or the frame. The adapter must not write after `delivery.signal` is aborted, must write the text as one bracketed paste, and must read the state
   * of the engine again at the moment of the write (see the README). A promise that never settles keeps the engine busy: no other delivery goes into it.
   */
  deliver(delivery: Delivery): Promise<AdapterFidelity>;
}

/** What an engine adapter is given for one message: the envelope, its frame (one JSON line), the text for the engine, which holds the body inside the fence, and a signal that the core aborts when it gives up on the delivery. Frozen. */
export interface Delivery {
  readonly envelope: Envelope;
  readonly frame: string;
  readonly text: string;
  readonly signal: AbortSignal;
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
  /** How many idempotency keys the ledger keeps, from 16 to 65,536. 4,096 by default. The ledger is apart from the messages: dropping a message does not free its key. */
  readonly keepKeys?: number;
  /** How long the core waits for an engine to take a message, from 1 to 600,000 milliseconds. 10,000 by default. */
  readonly deliverTimeoutMs?: number;
  /** How long the core waits, after a timeout, for the adapter to settle its promise, from 1 to 600,000 milliseconds. 30,000 by default. After it the engine reads as stuck, and what waits for it fails. */
  readonly abandonMs?: number;
  /** The most accepted `auto` messages in the run since the last act of the person (an approval or a resume), from 1 to 10,000. 200 by default. */
  readonly runCap?: number;
  /** The most messages of a route that the person may decline before the route is paused until the person resumes it, from 1 to 100. 8 by default. */
  readonly declineCap?: number;
  /** Runs a callback after a delay and gives the function that cancels it. An unref-ed timer by default. A test passes a schedule that it moves by hand. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /** The time, in milliseconds since the epoch. A time that is not a whole number of at least 0 is a bug of the clock and throws before anything changes. */
  readonly now?: () => number;
  /** Makes a message id. `msg-` and sixteen hexadecimal characters by default. A bad or repeated id throws before anything changes. */
  readonly newId?: () => string;
  /** Makes a session secret: 16 to 256 characters, and not the secret of another session. 64 hexadecimal characters by default. */
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
  /** How the message failed before a receipt proved it delivered, or `null`. */
  readonly failedBefore: FailureReason | null;
  /** How faithfully the engine took the message, or `null` while no answer came. `unknown` when a receipt came before the answer of the adapter. */
  readonly fidelity: Fidelity | null;
  readonly envelope: Envelope;
}

/** One route as a read gives it. Frozen. */
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
  /** What the waiting messages wait for, in the detail that the person may see, or `null` when none waits. */
  readonly waitingOn: WaitingCause | null;
  /** The messages that the person declined on this route since the last resume. */
  readonly declines: number;
  readonly state: 'open' | 'stopped';
  readonly stoppedBy: StopCause | null;
  readonly stoppedAt: number | null;
  /** The messages accepted between the two sessions of the route, in both directions, since the last act of the person. */
  readonly exchanged: number;
}

type Fail<C extends string> = { readonly ok: false; readonly code: C };
type Invalid = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_INVALID'; readonly reason: MessageInvalidReason };
type NotAccepted = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_NOT_ACCEPTED'; readonly reason: MessageState };
type SecretFound = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_SECRET_FOUND'; readonly reason: SecretReason };
type QueueFull = { readonly ok: false; readonly code: 'GAUGE_RELAY_QUEUE_FULL'; readonly reason: QueueReason };
type Unknown = { readonly ok: false; readonly code: 'GAUGE_MESSAGE_UNKNOWN'; readonly reason?: 'evicted' };
type Stopped = Fail<'GAUGE_RELAY_LOOP_CAP' | 'GAUGE_RELAY_MESSAGE_CAP' | 'GAUGE_RELAY_ROUTE_PAUSED'>;
export type SendRefusal = Invalid | SecretFound | QueueFull | NotAccepted | Stopped
  | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_RELAY_UNAUTHENTICATED' | 'GAUGE_RELAY_SESSION_ENDED' | 'GAUGE_ROUTE_UNKNOWN' | 'GAUGE_MESSAGE_TOO_LARGE' | 'GAUGE_RELAY_RECEIVER_GONE'>;
/** A message that was taken, or a repeat of one: then `duplicate` is true, and `state` and `reason` are those of the first message, or `evicted` when the relay dropped it. */
export type SendReply = { readonly ok: true; readonly id: string; readonly state: MessageState | 'evicted'; readonly reason: FailureReason | null; readonly duplicate: boolean } | SendRefusal;
export type ConfirmReply = { readonly ok: true; readonly state: 'delivered' } | Invalid | NotAccepted | Unknown | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_RELAY_UNAUTHENTICATED' | 'GAUGE_RELAY_SESSION_ENDED' | 'GAUGE_RELAY_RECEIPT_INVALID'>;
/** A control reply that worked: the state of the message after the call, and the reason when it failed in the same call (a message that could not be made for the engine fails at once). */
export type ControlReply = { readonly ok: true; readonly state: MessageState; readonly reason: FailureReason | null } | NotAccepted | Stopped | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_MESSAGE_UNKNOWN' | 'GAUGE_RELAY_RECEIVER_GONE'>;
/** `reopened` lists the routes that the resume opened. */
export type ResumeReply = { readonly ok: true; readonly reopened: readonly string[] } | Fail<'GAUGE_RELAY_CLOSED' | 'GAUGE_ROUTE_UNKNOWN'>;

/** What an engine reaches: two writes, each with the secret of its own session. Nothing here approves, declines, resumes, reads, or closes. Hand an adapter this object and not the whole relay. */
export interface RelayWrites {
  /** `{ session, secret, route, key, body }`. A request of any other shape is refused. */
  send(request: unknown): SendReply;
  /** `{ session, secret, id, receipt }`. The receiver proves that it read the message. */
  confirm(request: unknown): ConfirmReply;
}

/** What the core and the person reach. The Core API carries these calls behind its own plans and grants. */
export interface RelayControl {
  /** Makes the secret of a session and gives it, once. Throws (`TypeError`) for a session that is not a member, one that has its secret already, one that has ended, a secret that another session holds, and a closed relay. */
  issueSecret(session: string): string;
  /** The person approves a message that waits on an `accepted-output` route. It is accepted now, and moves when the receiver runs. An approval starts the counts of the loop caps again. */
  approve(id: unknown): ControlReply;
  /** The person declines a message that waits, or that is accepted and has not reached the engine. A decline is final: the same body is refused on the route until the person resumes it. */
  decline(id: unknown): ControlReply;
  /**
   * The person resumes a route. A route that a message cap stopped starts its count again from zero. A route that a loop cap stopped opens, with every other route that a loop cap stopped. A route that declines paused opens.
   * On any route, stopped or open, a resume is an act of the person: the counts of the loop caps start again, and the declines and the declined bodies of the route are forgotten.
   */
  resume(route: unknown): ResumeReply;
  /** The core tells the relay that a session changed its state: a session that runs gets what waits for it, and a session that ended fails what waits for it. A value that is no member, and a closed relay, do nothing and give nothing back. */
  sessionChanged(session: unknown): void;
  /** Closes the relay: what has not reached an engine fails with `closed`, every secret is forgotten, every delivery is told to stop, and every timer is cancelled. Reads still answer. */
  close(): void;
  readonly closed: boolean;
  /**
   * How much the relay holds now. `messages` is the live messages and up to `keepSettled` settled ones. `keys` is the ledger of keys (up to `keepKeys`), which dropping a message does not shrink. `secrets` is the live session secrets.
   * `inflight` is the engines that are busy with a delivery. `declined` is the declined bodies that are remembered, for each route at most its decline cap and 16 more.
   */
  sizes(): { readonly messages: number; readonly keys: number; readonly secrets: number; readonly inflight: number; readonly declined: number };
  /** The messages the relay keeps, in the order they were sent (the order in which the relay made them). They are given to an engine in the order in which they were accepted. */
  messages(): readonly MessageView[];
  message(id: unknown): MessageView | undefined;
  routes(): readonly RouteView[];
}

export interface Relay {
  readonly write: RelayWrites;
  readonly control: RelayControl;
}

interface Rec {
  readonly id: MessageId;
  readonly route: Route;
  readonly envelope: Envelope;
  readonly bodyHash: string;
  state: MessageState;
  reason: FailureReason | null;
  failedBefore: FailureReason | null;
  fidelity: Fidelity | null;
  /** The receipt and the nonce of the delivery. They exist from the moment the engine is asked, and never before. */
  token: Receipt | null;
  nonce: Nonce | null;
  /** The order in which the message ended, or was sent. A message that is live has neither. */
  endSeq: number | null;
  sentSeq: number | null;
  /** The order in which the message was accepted: the order of delivery. */
  acceptSeq: number | null;
  /** True while the message holds a place in the count of its route and in the counts of the loop caps. */
  counted: boolean;
  /** The epochs of the route, of its pair, and of the run count when it was counted. A reset by the person ends an epoch, and a message of an earlier epoch holds no place. */
  epoch: number;
  pairEpoch: number;
  runEpoch: number;
  runCounted: boolean;
  cancel: (() => void) | null;
  abort: AbortController | null;
}

interface RouteState {
  readonly route: Route;
  stopped: StopCause | null;
  stoppedAt: number | null;
  accepted: number;
  epoch: number;
  declines: number;
  /** What a loop stop covered, so a resume opens what the stop closed: `pair` (the two routes of a pair) or `run` (every route that the run cap stopped). The public cause stays `loop_cap`. */
  scope: 'pair' | 'run' | null;
}

/** The messages accepted between two sessions since the last act of the person that reopened or approved in this pair. */
interface PairState {
  count: number;
  epoch: number;
}

/** An engine that a delivery is running into. It stays until the adapter settles its promise, or a receipt comes, so two deliveries never overlap. */
interface Busy {
  readonly id: MessageId;
  cancelStuck: (() => void) | null;
  stuck: boolean;
}

interface PortRef {
  readonly port: SessionPort;
  readonly state: SessionPort['state'];
  readonly deliver: SessionPort['deliver'];
}

const DRAWS = 4;
const REQUEST_SEND = ['session', 'secret', 'route', 'key', 'body'] as const;
const REQUEST_CONFIRM = ['session', 'secret', 'id', 'receipt'] as const;
const ROUTE_FIELDS = ['id', 'from', 'to', 'rule', 'messageCap', 'loopCap'] as const;
const NEVER = digestOf(`relay never matches ${randomBytes(16).toString('hex')}`);
/** The text that is hashed in place of a secret when a session has none, so the work of a check is the same whether the session has a live secret or not. It is never equal to a secret that a session holds, and a match is refused in any case. */
const DUMMY_SECRET = `relay has no secret for this session ${randomBytes(16).toString('hex')}`;

function digestOf(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}
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
/** Drops the oldest entries of a Map or a Set until it holds at most `room`. Both keep the order of insertion. */
const trim = (held: { readonly size: number; keys(): IterableIterator<string>; delete(key: string): boolean }, room: number): void => {
  while (held.size > room) {
    const oldest = held.keys().next();
    if (oldest.done === true) return;
    held.delete(oldest.value);
  }
};
const inRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const optionIn = (value: number | undefined, fallback: number, min: number, max: number, name: string): number => {
  const chosen = value ?? fallback;
  if (!inRange(chosen, min, max)) throw new RangeError(`relay: ${name} is a whole number from ${min} to ${max}`);
  return chosen;
};

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

/** Checks the members, and reads `state` and `deliver` of each port once. The relay never reads them again. */
function checkedMembers(value: unknown): Map<string, PortRef> {
  const items = readList(value, MAX_START_GROUP);
  if (items === undefined || items.length === 0) throw new TypeError('relay: the members are not a plain list of 1 to 8');
  const ports = new Map<string, PortRef>();
  for (const item of items) {
    const fields = plainRecord(item);
    if (fields === undefined || !hasExactly(fields, ['session', 'port'])) throw new TypeError('relay: a member is not a record of a session and a port');
    const session = fields.get('session'), port = fields.get('port');
    if (!checkSessionId(session).ok || typeof session !== 'string' || ports.has(session)) throw new TypeError('relay: a member has a bad session id, or the id is used twice');
    if (typeof port !== 'object' || port === null) throw new TypeError('relay: the port of a member is not an object');
    const state: unknown = (port as Partial<SessionPort>).state, deliver: unknown = (port as Partial<SessionPort>).deliver;
    if (typeof state !== 'function' || typeof deliver !== 'function') throw new TypeError('relay: the port of a member has no state and no deliver');
    ports.set(session, { port: port as SessionPort, state: state as SessionPort['state'], deliver: deliver as SessionPort['deliver'] });
  }
  return ports;
}

export function createRelay(options: RelayOptions): Relay {
  const run = options.run;
  if (!isRunId(run)) throw new TypeError('relay: the run id is malformed');
  const ports = checkedMembers(options.members);
  const routes = checkedRoutes(options.routes, new Set(ports.keys()));
  const keepSettled = optionIn(options.keepSettled, DEFAULT_KEEP_SETTLED, 1, MAX_KEEP_SETTLED, 'keepSettled');
  const keepKeys = optionIn(options.keepKeys, DEFAULT_KEEP_KEYS, MIN_KEEP_KEYS, MAX_KEEP_KEYS, 'keepKeys');
  const timeoutMs = optionIn(options.deliverTimeoutMs, DEFAULT_DELIVER_TIMEOUT_MS, 1, MAX_DELIVER_TIMEOUT_MS, 'deliverTimeoutMs');
  const abandonMs = optionIn(options.abandonMs, DEFAULT_ABANDON_MS, 1, MAX_ABANDON_MS, 'abandonMs');
  const runCap = optionIn(options.runCap, DEFAULT_RUN_CAP, 1, MAX_RUN_CAP, 'runCap');
  const declineCap = optionIn(options.declineCap, DEFAULT_DECLINE_CAP, 1, MAX_DECLINE_CAP, 'declineCap');
  const schedule = options.schedule ?? defaultSchedule;
  const clock = options.now ?? Date.now;
  const randomText = (): string => randomBytes(16).toString('hex');
  const newId = options.newId ?? ((): string => `msg-${randomBytes(8).toString('hex')}`);
  const newSecret = options.newSecret ?? ((): string => randomBytes(32).toString('hex'));
  const newNonce = options.newNonce ?? randomText;
  const newReceipt = options.newReceipt ?? randomText;

  const secrets = new Map<string, SessionSecret>();
  /** The digest of the secret of each session that ended, so a write from it gets its own answer. Nothing else of the secret is kept. */
  const retired = new Map<string, Buffer>();
  const issued = new Set<string>();
  const ended = new Set<string>();
  const records = new Map<string, Rec>();
  /** The ledger of idempotency keys: route and key to the hash of the body and the id of the message. Oldest first. Dropping a message does not touch it. */
  const ledger = new Map<string, { readonly hash: string; readonly id: MessageId }>();
  /** The ids of the messages that the history dropped, with their receivers, oldest first. */
  const gone = new Map<string, string>();
  /** The bodies that the person declined, for each route, as hashes, oldest first. A set holds at most the decline cap and 16 more. They stay refused on their route until the person resumes it. */
  const declined = new Map<string, Set<string>>();
  const routeStates = new Map<string, RouteState>(routes.map(route => [route.id, { route, stopped: null, stoppedAt: null, accepted: 0, epoch: 0, declines: 0, scope: null }]));
  const pairCaps = new Map<string, number>();
  for (const route of routes) pairCaps.set(pairKey(route.from, route.to), Math.min(pairCaps.get(pairKey(route.from, route.to)) ?? MAX_LOOP_CAP, route.loopCap));
  /** The messages accepted between each pair of sessions since the last act of the person on that pair, and the `auto` messages accepted in the run since the last act of the person on a run stop. */
  const pairs = new Map<string, PairState>(routes.map(route => [pairKey(route.from, route.to), { count: 0, epoch: 0 }]));
  let runCount = 0;
  let runEpoch = 0;
  const busy = new Map<string, Busy>();
  let seq = 0;
  let acceptSeq = 0;
  let closed = false;

  /** Every value that a body or a key must never hold: the secrets of the sessions, and the receipts and nonces of the messages that were handed to an engine and are not yet delivered. */
  const relayValues = (): string[] => {
    const hidden: string[] = [...secrets.values()];
    for (const rec of records.values()) {
      if (rec.token !== null && rec.state !== 'delivered') hidden.push(rec.token);
      if (rec.nonce !== null && rec.state !== 'delivered') hidden.push(rec.nonce);
    }
    return hidden;
  };
  /** What a log line must not hold: the same values. The body of a message that an engine is taking is cut out of the error text of its adapter only (`printableFor`), since a body that holds a word of a fixed line would blank it. */
  const logHidden = (): string[] => relayValues();
  const log = createLog({ run, hidden: logHidden, log: options.log });

  const time = (): number => {
    const at = clock();
    if (!inRange(at, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError('relay: the clock gave no usable time');
    return at;
  };
  function draw<T extends string>(make: () => string, guard: (value: unknown) => value is T): T {
    const value = make();
    if (!guard(value)) throw new TypeError('relay: a made token is not 16 to 256 characters');
    return value;
  }
  /** The text of an error of the adapter of a message, with the body of the message cut out of it: an adapter may echo what it was given. */
  const printableFor = (rec: Rec, error: unknown): string => redactText([rec.envelope.body], printable(error));
  /** Calls a function that cancels a timer or a delivery. It must be a function and it must not throw. */
  const safely = (name: string, call: (() => void) | null | undefined): void => {
    if (typeof call !== 'function') return;
    try {
      call();
    } catch (error) {
      log.write(`${name} failed: ${printable(error)}`);
    }
  };
  /** A timer callback that cannot throw out of the timer. */
  const guarded = (name: string, call: () => void): (() => void) => () => safely(name, call);

  const view = (rec: Rec): MessageView => Object.freeze({ id: rec.id, state: rec.state, reason: rec.reason, failedBefore: rec.failedBefore, fidelity: rec.fidelity, envelope: rec.envelope });
  const isWaiting = (rec: Rec): boolean => rec.state === 'pending' || rec.state === 'queued' || rec.state === 'sending';
  const waitingOf = (routeId: string): number => {
    let count = 0;
    for (const rec of records.values()) if (rec.route.id === routeId && isWaiting(rec)) count += 1;
    return count;
  };

  // ---- sessions and their states

  /** Reads the state of a session. `undefined` when the port cannot say: the reader throws, or the value is no state. A failure is logged for the session at counts 1, 2, 4, 8, and so on. */
  function readState(session: string): SessionState | undefined {
    const ref = ports.get(session);
    if (ref === undefined) return undefined;
    try {
      const state: unknown = ref.state.call(ref.port);
      if (isSessionState(state)) return state;
      log.counted(`state:${session}`, `could not read the state of ${session}: it gave no known state`);
    } catch (error) {
      log.counted(`state:${session}`, `could not read the state of ${session}: ${printable(error)}`);
    }
    return undefined;
  }

  /** What the waiting messages of a route wait for, in the detail that the person sees: the person when most of them are pending, else the receiver (not running or unreadable, or busy with an earlier delivery). A stuck engine has nothing waiting for it, since what waited failed. */
  function waitingCause(state: RouteState): WaitingCause {
    let pending = 0, accepted = 0;
    for (const rec of records.values()) {
      if (rec.route.id !== state.route.id) continue;
      if (rec.state === 'pending') pending += 1;
      else if (rec.state === 'queued' || rec.state === 'sending') accepted += 1;
    }
    if (pending >= accepted) return 'pending_approval';
    return readState(state.route.to) === 'running' ? 'receiver_busy' : 'receiver_not_running';
  }
  /** The same cause as the writer of the route is told: a receiver that does not run is a receiver that does not take the messages now, and the writer is not told which. */
  const queueCause = (state: RouteState): QueueReason => {
    const cause = waitingCause(state);
    return cause === 'receiver_not_running' ? 'receiver_busy' : cause;
  };

  const routeView = (state: RouteState): RouteView => {
    const waiting = waitingOf(state.route.id);
    return Object.freeze({
      id: state.route.id, from: state.route.from, to: state.route.to, rule: state.route.rule, messageCap: state.route.messageCap, loopCap: state.route.loopCap,
      accepted: state.accepted, waiting, waitingOn: waiting === 0 ? null : waitingCause(state), declines: state.declines,
      state: state.stopped === null ? 'open' as const : 'stopped' as const, stoppedBy: state.stopped, stoppedAt: state.stoppedAt, exchanged: pairs.get(pairKey(state.route.from, state.route.to))?.count ?? 0,
    });
  };

  // ---- the history: bounded, and dropped in the order in which messages ended

  const rememberGone = (id: MessageId, receiver: string): void => {
    gone.set(id, receiver);
    trim(gone, keepKeys);
  };
  const evict = (rec: Rec): void => {
    records.delete(rec.id);
    rememberGone(rec.id, rec.envelope.receiver);
    // A message that waits for a receipt is dropped last, and never without a line: its receipt can no longer be taken.
    if (rec.state === 'sent') log.write(`message ${rec.id} was sent and was dropped from the history before a receipt came`);
  };
  const isSettled = (rec: Rec): boolean => rec.state === 'sent' || rec.state === 'delivered' || rec.state === 'declined' || rec.state === 'failed';
  /** Drops the settled messages beyond the room that is kept. The messages that ended (delivered, declined, failed) go first, the one that ended first before the others, and then the messages that were sent, the one that was sent first first. A live message is never dropped. */
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

  // ---- the counts of a route, and the caps of the loops

  /** The person has acted on a pair: its count starts again. A message that was counted before holds no place in the new count. */
  function resetPair(key: string): void {
    const pair = pairs.get(key);
    if (pair === undefined) return;
    pair.count = 0;
    pair.epoch += 1;
  }
  /** The person has reopened a stop of the run cap: the run count starts again. */
  function resetRun(): void {
    runCount = 0;
    runEpoch += 1;
  }

  /** Gives back the place of a message in the count of its route and in the counts of the loop caps. It is for a message that failed before the engine was asked. It does nothing for a message that holds no place. */
  function refund(rec: Rec): void {
    if (!rec.counted) return;
    rec.counted = false;
    const state = routeStates.get(rec.route.id);
    if (state !== undefined && state.epoch === rec.epoch) state.accepted -= 1;
    const pair = pairs.get(pairKey(rec.route.from, rec.route.to));
    if (pair !== undefined && pair.epoch === rec.pairEpoch) pair.count -= 1;
    if (rec.runCounted && rec.runEpoch === runEpoch) runCount -= 1;
  }
  function failBeforeEngine(rec: Rec, reason: FailureReason): void {
    refund(rec);
    settle(rec, 'failed', reason);
  }

  const pairRoutes = (state: RouteState): RouteState[] => [...routeStates.values()].filter(other => pairKey(other.route.from, other.route.to) === pairKey(state.route.from, state.route.to));

  function stopAll(targets: readonly RouteState[], cause: StopCause, scope: 'pair' | 'run' | null, at: number, line: string): void {
    for (const target of targets) {
      if (target.stopped !== null) continue;
      target.stopped = cause;
      target.stoppedAt = at;
      target.scope = scope;
    }
    log.write(line);
  }

  /**
   * A stop is about new acceptances: a message that was accepted within a cap goes on, and a message that waits for the person stays as it is, and cannot be approved until the person resumes the route.
   * A loop cap stops both routes of its pair. The run cap stops every route that is open.
   */
  const stopPair = (state: RouteState, at: number, cap: number): void => {
    const [low, high] = [state.route.from, state.route.to].sort();
    stopAll(pairRoutes(state), 'loop_cap', 'pair', at, `route ${state.route.id} stopped: the loop cap of ${cap} is reached between ${low} and ${high}`);
  };

  const stoppedRefusal = (cause: StopCause): Stopped => ({
    ok: false, code: cause === 'loop_cap' ? 'GAUGE_RELAY_LOOP_CAP' : cause === 'message_cap' ? 'GAUGE_RELAY_MESSAGE_CAP' : 'GAUGE_RELAY_ROUTE_PAUSED',
  });

  /**
   * Takes a message into the count of its route and the counts of the loop caps, or refuses it, and stops routes when a cap is reached. It changes nothing for a refusal except the stop. An approval (`approved`) is an act of the person
   * on its own pair: the count of the pair starts again at this message. It starts nothing again before the message is taken, so a refused approval changes no count.
   */
  function accept(rec: Rec, at: number, approved = false): Stopped | undefined {
    const state = routeStates.get(rec.route.id);
    if (state === undefined) throw new Error('relay: a message names a route that the relay does not hold');
    if (state.stopped !== null) return stoppedRefusal(state.stopped);
    if (state.accepted >= state.route.messageCap) {
      stopAll([state], 'message_cap', null, at, `route ${state.route.id} stopped: the cap of ${state.route.messageCap} messages is reached`);
      return stoppedRefusal('message_cap');
    }
    // Every message between a pair counts, in both directions, and a repeat of one sender is no reset: two engines cannot talk on with a trick of order.
    const key = pairKey(rec.route.from, rec.route.to);
    const pair = pairs.get(key);
    if (pair === undefined) throw new Error('relay: a message names a pair that the relay does not hold');
    const exchanged = (approved ? 0 : pair.count) + 1;
    const cap = pairCaps.get(key) ?? MAX_LOOP_CAP;
    if (exchanged > cap) {
      stopPair(state, at, cap);
      return stoppedRefusal('loop_cap');
    }
    const automatic = rec.route.rule === 'auto';
    if (automatic && runCount + 1 > runCap) {
      stopAll([...routeStates.values()], 'loop_cap', 'run', at, `route ${state.route.id} stopped: the run cap of ${runCap} messages is reached, so every route of the run is stopped`);
      return stoppedRefusal('loop_cap');
    }
    state.accepted += 1;
    if (approved) pair.epoch += 1;
    pair.count = exchanged;
    if (automatic) runCount += 1;
    rec.counted = true;
    rec.runCounted = automatic;
    rec.epoch = state.epoch;
    rec.pairEpoch = pair.epoch;
    rec.runEpoch = runEpoch;
    rec.acceptSeq = (acceptSeq += 1);
    return undefined;
  }

  // ---- secrets

  /** Compares the secret that was given with the live secret of the session, and with the digest of the secret of a session that ended. The given secret is hashed once, and the live secret (or a dummy text when the session has none) is hashed once, in every case. The digest of an ended session is stored, and is compared as it is. */
  function authenticate(session: unknown, secret: unknown): { readonly kind: 'ok'; readonly session: string } | { readonly kind: 'ended' } | { readonly kind: 'bad' } {
    const usable = typeof session === 'string' && typeof secret === 'string' && secret.length <= MAX_TOKEN_LENGTH;
    const given = digestOf(usable ? secret : '');
    const live = usable ? secrets.get(session) : undefined;
    const old = usable ? retired.get(session) : undefined;
    const liveMatch = timingSafeEqual(given, digestOf(live ?? DUMMY_SECRET)) && live !== undefined;
    const oldMatch = timingSafeEqual(given, old ?? NEVER) && old !== undefined;
    if (usable && liveMatch) return { kind: 'ok', session };
    return oldMatch ? { kind: 'ended' } : { kind: 'bad' };
  }

  // ---- delivery

  /** Stops the clocks of a delivery that was timed. It does not touch the engine: the engine stays busy until the adapter settles, or a receipt comes. */
  function leaveSending(rec: Rec): void {
    const cancel = rec.cancel;
    rec.cancel = null;
    safely(`the timer of message ${rec.id}`, cancel);
  }
  /** Tells the adapter to write no more. */
  function abortDelivery(rec: Rec): void {
    const controller = rec.abort;
    rec.abort = null;
    safely(`the abort of message ${rec.id}`, controller === null ? null : () => controller.abort());
  }
  /** The engine is free: the adapter settled, a receipt came, the session ended, or the relay closed. */
  function releaseBusy(receiver: string, id?: MessageId): void {
    const entry = busy.get(receiver);
    if (entry === undefined || (id !== undefined && entry.id !== id)) return;
    busy.delete(receiver);
    const cancel = entry.cancelStuck;
    entry.cancelStuck = null;
    safely(`the timer of the engine of ${receiver}`, cancel);
  }

  /** A session ended: it can no longer write, and what waits for it fails. A message that the engine was taking is failed too, and the text may have arrived. */
  function sessionEnded(session: string): void {
    ended.add(session);
    const secret = secrets.get(session);
    if (secret !== undefined) retired.set(session, digestOf(secret));
    secrets.delete(session);
    for (const rec of [...records.values()]) {
      if (rec.envelope.receiver !== session) continue;
      if (rec.state === 'pending' || rec.state === 'queued') failBeforeEngine(rec, 'receiver_gone');
      else if (rec.state === 'sending') {
        leaveSending(rec);
        abortDelivery(rec);
        settle(rec, 'failed', 'receiver_gone');
      }
    }
    releaseBusy(session);
    log.write(`session ${session} ended, so what waited for it has failed`);
  }

  /** Looks at a session once: reads its state, and ends its life in the relay when it has ended. Gives `'ended'` for a session that has ended, the state that was read, or `undefined` when the port could not say. */
  function look(session: string): SessionState | 'ended' | undefined {
    if (ended.has(session)) return 'ended';
    const state = readState(session);
    if (state !== undefined && isEnded(state)) {
      sessionEnded(session);
      return 'ended';
    }
    return state;
  }
  /** True when the session has ended. */
  const refresh = (session: string): boolean => look(session) === 'ended';

  function failQueued(receiver: string, reason: FailureReason): void {
    for (const rec of [...records.values()]) if (rec.state === 'queued' && rec.envelope.receiver === receiver) failBeforeEngine(rec, reason);
  }

  /** Gives what waits for a session to its engine, when it runs and is free. `known` is a state that the caller read just now, so it is not read twice. */
  function pump(session: string, known?: { readonly state: SessionState | undefined }): void {
    if (closed) return;
    const entry = busy.get(session);
    if (entry !== undefined) {
      // An engine that never settled its earlier delivery is stuck, and nothing more is given to it.
      if (entry.stuck) failQueued(session, 'receiver_stuck');
      return;
    }
    let next: Rec | undefined;
    for (const rec of records.values()) {
      if (rec.state === 'queued' && rec.envelope.receiver === session && (next === undefined || (rec.acceptSeq ?? 0) < (next.acceptSeq ?? 0))) next = rec;
    }
    if (next === undefined) return;
    // One look: the state is read once, so the log of a state that cannot be read keeps its schedule.
    if ((known === undefined ? look(session) : known.state) !== 'running') return;
    startDelivery(next);
  }

  function startDelivery(rec: Rec): void {
    const receiver = rec.envelope.receiver;
    const ref = ports.get(receiver);
    if (ref === undefined) throw new Error('relay: a message names a receiver that the relay does not hold');
    let nonce: Nonce | undefined, receipt: Receipt | undefined, cancel: () => void = () => undefined;
    try {
      // The core draws a nonce and a receipt that the body does not hold, so the sender cannot close the fence or forge the receipt. A body that holds every draw fails the message.
      for (let attempt = 0; attempt < DRAWS && nonce === undefined; attempt += 1) {
        const drawnNonce = draw(newNonce, isNonce), drawnReceipt = draw(newReceipt, isReceipt);
        if (!rec.envelope.body.includes(drawnNonce) && !rec.envelope.body.includes(drawnReceipt) && `${drawnNonce}` !== `${drawnReceipt}`) {
          nonce = drawnNonce;
          receipt = drawnReceipt;
        }
      }
      if (nonce === undefined || receipt === undefined) throw new Error('every nonce that the core drew was in the body');
      cancel = schedule(guarded(`the timeout of message ${rec.id}`, () => onTimeout(rec)), timeoutMs);
    } catch (error) {
      log.write(`message ${rec.id} could not be prepared for ${receiver}: ${printable(error)}`);
      failBeforeEngine(rec, 'not_prepared');
      pump(receiver);
      return;
    }
    const controller = new AbortController();
    const delivery: Delivery = Object.freeze({
      envelope: rec.envelope, frame: frameOf(rec.envelope), text: fenceText({ envelope: rec.envelope, message: rec.id, nonce, receipt }), signal: controller.signal,
    });
    rec.nonce = nonce;
    rec.token = receipt;
    rec.cancel = cancel;
    rec.abort = controller;
    rec.state = 'sending';
    busy.set(receiver, { id: rec.id, cancelStuck: null, stuck: false });
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(ref.deliver.call(ref.port, delivery));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(answer => onAnswer(rec, answer), error => onFailure(rec, error)).catch(error => log.write(`message ${rec.id}: a late step threw: ${printableFor(rec, error)}`));
  }

  /**
   * An answer that came after the message left the sending state. A fidelity is kept when none is known. The fidelity `unknown` (a receipt came first) is replaced by an answer, except `absent`, which contradicts the receipt: that is logged
   * and the fidelity stays. The state never changes.
   */
  function lateFidelity(rec: Rec, answer: unknown): void {
    if (!isAdapterFidelity(answer)) {
      log.write(`the engine of ${rec.envelope.receiver} gave an answer that is no fidelity, for message ${rec.id}, after the message was settled`);
      return;
    }
    if (rec.fidelity === null) rec.fidelity = answer;
    else if (rec.fidelity === 'unknown') {
      if (answer === 'absent') log.write(`the adapter of ${rec.envelope.receiver} said absent for message ${rec.id}, which a receipt had proved delivered`);
      else rec.fidelity = answer;
    }
  }

  function onAnswer(rec: Rec, answer: unknown): void {
    // The adapter settled: the engine is free, whatever became of the message.
    releaseBusy(rec.envelope.receiver, rec.id);
    if (rec.state !== 'sending') {
      lateFidelity(rec, answer);
      pump(rec.envelope.receiver);
      return;
    }
    leaveSending(rec);
    if (!isAdapterFidelity(answer)) {
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
    releaseBusy(rec.envelope.receiver, rec.id);
    if (rec.state !== 'sending') {
      // The rejection is the only account of why an engine hung. The line is fixed and holds no text of the error: the body is hidden only while the engine takes it.
      log.write(`the adapter of ${rec.envelope.receiver} rejected its delivery of message ${rec.id} after the message was settled`);
      pump(rec.envelope.receiver);
      return;
    }
    leaveSending(rec);
    log.write(`delivery of message ${rec.id} to ${rec.envelope.receiver} failed: ${printableFor(rec, error)}`);
    settle(rec, 'failed', 'delivery_failed');
    pump(rec.envelope.receiver);
  }

  /** Arms the wait for an adapter that has not settled: after `abandonMs` the engine reads as stuck. */
  function armStuck(rec: Rec): void {
    const entry = busy.get(rec.envelope.receiver);
    if (entry === undefined || entry.id !== rec.id) return;
    try {
      entry.cancelStuck = schedule(guarded(`the stuck timer of ${rec.envelope.receiver}`, () => onStuck(rec)), abandonMs);
    } catch (error) {
      log.write(`the stuck timer of ${rec.envelope.receiver} could not be set: ${printable(error)}`);
      onStuck(rec);
    }
  }

  function onTimeout(rec: Rec): void {
    if (closed || rec.state !== 'sending') return;
    // The timer has fired, so there is nothing to cancel.
    rec.cancel = null;
    // The adapter is told to write no more. Its promise may still be pending, and then the engine stays busy: nothing else is given to it until the promise settles, a receipt comes, or the core gives up on it.
    abortDelivery(rec);
    log.write(`delivery of message ${rec.id} to ${rec.envelope.receiver} timed out after ${timeoutMs} ms, and the text may still reach the engine`);
    settle(rec, 'failed', 'delivery_timeout');
    // The engine stays busy, so nothing else goes into it until the adapter settles, a receipt comes, or the wait for the adapter ends.
    armStuck(rec);
  }

  function onStuck(rec: Rec): void {
    const entry = busy.get(rec.envelope.receiver);
    if (closed || entry === undefined || entry.id !== rec.id) return;
    entry.stuck = true;
    entry.cancelStuck = null;
    log.write(`the engine of ${rec.envelope.receiver} never settled its delivery of message ${rec.id}, so nothing more is given to it until it does`);
    failQueued(rec.envelope.receiver, 'receiver_stuck');
  }

  // ---- the writes of an engine

  const unauthenticated = (session: unknown): Fail<'GAUGE_RELAY_UNAUTHENTICATED'> => {
    // One line for each member at counts 1, 2, 4, 8, and so on, and one key for all the writes that name no member. No value of the request is in the line.
    if (typeof session === 'string' && ports.has(session)) log.counted(`unauthenticated:${session}`, `a write for ${session} came without the right session secret`);
    else log.counted('unauthenticated:unknown', 'a write came without the right session secret');
    return { ok: false, code: 'GAUGE_RELAY_UNAUTHENTICATED' };
  };
  const sessionEndedRefusal = (): Fail<'GAUGE_RELAY_SESSION_ENDED'> => ({ ok: false, code: 'GAUGE_RELAY_SESSION_ENDED' });

  const rememberKey = (route: RouteId, key: string, hash: string, id: MessageId): void => {
    ledger.set(`${route}\u0000${key}`, { hash, id });
    trim(ledger, keepKeys);
  };

  function send(request: unknown): SendReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const fields = plainRecord(request);
    if (fields === undefined || !hasExactly(fields, REQUEST_SEND)) return { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' };
    const asked = fields.get('session'), routeValue = fields.get('route');
    const auth = authenticate(asked, fields.get('secret'));
    if (auth.kind === 'bad') return unauthenticated(asked);
    if (auth.kind === 'ended' || refresh(auth.session)) return sessionEndedRefusal();
    const session = auth.session;
    // A route that does not exist and a route of another sender are one answer, so a session learns nothing of the routes of the others.
    const state = isRouteId(routeValue) ? routeStates.get(routeValue) : undefined;
    if (state === undefined || state.route.from !== session) return { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' };
    const hidden = relayValues();
    const key = checkKey(fields.get('key'), hidden);
    if (!key.ok) return key;
    const body = checkBody(fields.get('body'), hidden);
    if (!body.ok) return body;
    const bodyHash = digestOf(body.value).toString('hex');
    const known = ledger.get(`${state.route.id}\u0000${key.value}`);
    if (known !== undefined) {
      // A repeat is dropped. A key that comes back with another body is refused, so the second body is not lost without a word.
      if (known.hash !== bodyHash) return { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'key_reused' };
      const first = records.get(known.id);
      return { ok: true, id: known.id, state: first === undefined ? 'evicted' : first.state, reason: first?.reason ?? null, duplicate: true };
    }
    // A body that the person declined on this route is not asked again, under another key either, until the person resumes the route.
    if (declined.get(state.route.id)?.has(bodyHash) === true) return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: 'declined' };
    if (state.stopped !== null) return stoppedRefusal(state.stopped);
    if (refresh(state.route.to)) return { ok: false, code: 'GAUGE_RELAY_RECEIVER_GONE' };
    // An engine that never settled an earlier delivery is written to no more: no message, no key, no count, and a line at counts 1, 2, 4, 8, and so on.
    if (busy.get(state.route.to)?.stuck === true) {
      log.counted(`stuck:${state.route.to}`, `a write to ${state.route.to} was refused, because its engine never settled an earlier delivery`);
      return { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: 'receiver_stuck' };
    }
    if (waitingOf(state.route.id) >= MAX_WAITING_PER_ROUTE) return { ok: false, code: 'GAUGE_RELAY_QUEUE_FULL', reason: queueCause(state) };
    // Everything that can throw comes before the first change: the clock and the id.
    const at = time();
    const id = newId();
    if (!isMessageId(id) || records.has(id)) throw new Error('relay: newId gave a message id that is malformed or already used');
    // The envelope takes the sender and the receiver from the route, and goes through the one check of the envelope.
    const checked = checkEnvelope({ run, route: state.route.id, sender: state.route.from, receiver: state.route.to, body: body.value, time: at, key: key.value });
    if (!checked.ok) throw new Error('relay: the envelope of a message is refused by its own check');
    const rec: Rec = {
      id, route: state.route, envelope: checked.value, bodyHash, state: 'pending', reason: null, failedBefore: null, fidelity: null, token: null, nonce: null, endSeq: null, sentSeq: null, acceptSeq: null,
      counted: false, epoch: 0, pairEpoch: 0, runEpoch: 0, runCounted: false, cancel: null, abort: null,
    };
    if (state.route.rule === 'auto') {
      const refused = accept(rec, at);
      if (refused !== undefined) return refused;
      rec.state = 'queued';
      log.write(`message ${id} accepted on the auto route ${state.route.id}, from ${state.route.from} to ${state.route.to}`);
    }
    records.set(id, rec);
    rememberKey(state.route.id, key.value, bodyHash, id);
    if (rec.state === 'queued') pump(state.route.to);
    // A message can fail in this very call (the engine is stuck, or the text could not be made), and then the first reply says why.
    return { ok: true, id, state: rec.state, reason: rec.reason, duplicate: false };
  }

  function confirm(request: unknown): ConfirmReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const fields = plainRecord(request);
    if (fields === undefined || !hasExactly(fields, REQUEST_CONFIRM)) return { ok: false, code: 'GAUGE_MESSAGE_INVALID', reason: 'request' };
    const asked = fields.get('session'), id = fields.get('id'), given = fields.get('receipt');
    const auth = authenticate(asked, fields.get('secret'));
    if (auth.kind === 'bad') return unauthenticated(asked);
    if (auth.kind === 'ended' || refresh(auth.session)) return sessionEndedRefusal();
    const session = auth.session;
    // A message that does not exist and a message for another receiver are one answer. A message that the history dropped says so, to its own receiver only.
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    if (rec === undefined || rec.envelope.receiver !== session) {
      return typeof id === 'string' && gone.get(id) === session ? { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN', reason: 'evicted' } : { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' };
    }
    // No receipt exists for a message that was never handed to the engine, and none works twice.
    if (rec.token === null || rec.state === 'delivered') return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: rec.state };
    // `absent` says that the adapter had no way to give the engine a message, so no receipt for it can be right.
    if (rec.fidelity === 'absent' || typeof given !== 'string' || given.length > MAX_TOKEN_LENGTH || !timingSafeEqual(digestOf(given), digestOf(rec.token))) return { ok: false, code: 'GAUGE_RELAY_RECEIPT_INVALID' };
    // The receipt is in the text that the engine was given, so it proves that the text reached the engine: also when the answer of the engine is late, or the timeout came first.
    // The adapter may still hold its promise, so the engine stays busy until it settles or the wait for it ends, and the signal is aborted: it must write no more.
    if (rec.state === 'sending') {
      leaveSending(rec);
      abortDelivery(rec);
      armStuck(rec);
    }
    rec.failedBefore = rec.state === 'failed' ? rec.reason : null;
    if (rec.fidelity === null) rec.fidelity = 'unknown';
    // The engine is not freed by a receipt, so there is nothing to give it now: the settle of the adapter does that.
    settle(rec, 'delivered', null);
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
    // An approval is an act of the person on the pair of its route: the count of the pair starts again, once the message is taken. A refused approval changes no count.
    const refused = accept(rec, time(), true);
    if (refused !== undefined) return refused;
    rec.state = 'queued';
    pump(rec.envelope.receiver);
    return { ok: true, state: rec.state, reason: rec.reason };
  }

  function decline(id: unknown): ControlReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    if (rec === undefined) return { ok: false, code: 'GAUGE_MESSAGE_UNKNOWN' };
    if (rec.state !== 'pending' && rec.state !== 'queued') return { ok: false, code: 'GAUGE_MESSAGE_NOT_ACCEPTED', reason: rec.state };
    const at = time();
    const state = routeStates.get(rec.route.id);
    refund(rec);
    settle(rec, 'declined', null);
    let held = declined.get(rec.route.id);
    if (held === undefined) {
      held = new Set<string>();
      declined.set(rec.route.id, held);
    }
    held.add(rec.bodyHash);
    trim(held, declineCap + DECLINED_SLACK);
    if (state !== undefined) {
      state.declines += 1;
      // A sender that keeps proposing what the person declines is paused: the person decides when it goes on.
      if (state.declines >= declineCap && state.stopped === null) stopAll([state], 'declines', null, at, `route ${state.route.id} paused: the person declined ${state.declines} of its messages`);
    }
    return { ok: true, state: rec.state, reason: null };
  }

  function resume(routeValue: unknown): ResumeReply {
    if (closed) return { ok: false, code: 'GAUGE_RELAY_CLOSED' };
    const state = isRouteId(routeValue) ? routeStates.get(routeValue) : undefined;
    if (state === undefined) return { ok: false, code: 'GAUGE_ROUTE_UNKNOWN' };
    const reopened: string[] = [];
    const reopen = (target: RouteState): void => {
      if (target.stopped === null) return;
      target.stopped = null;
      target.stoppedAt = null;
      target.scope = null;
      reopened.push(target.route.id);
    };
    if (state.stopped === 'message_cap') {
      state.accepted = 0;
      state.epoch += 1;
      reopen(state);
    } else if (state.stopped === 'declines') {
      reopen(state);
    } else if (state.stopped === 'loop_cap' && state.scope === 'run') {
      // A stop of the run cap is reopened as a whole, with the pair of each route that it opened. A route that a pair or a cap stopped before stays stopped.
      for (const other of routeStates.values()) {
        if (other.stopped !== 'loop_cap' || other.scope !== 'run') continue;
        reopen(other);
        resetPair(pairKey(other.route.from, other.route.to));
      }
      resetRun();
    } else if (state.stopped === 'loop_cap') {
      // A stop of a pair opens the routes of that pair, and no other.
      for (const other of pairRoutes(state)) if (other.stopped === 'loop_cap' && other.scope === 'pair') reopen(other);
    }
    // A resume is an act of the person on the route that it names: the count of its pair starts again.
    resetPair(pairKey(state.route.from, state.route.to));
    // It also forgets what the person declined on the route: the route is trusted again.
    state.declines = 0;
    declined.delete(state.route.id);
    return { ok: true, reopened: Object.freeze(reopened) };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const rec of [...records.values()]) {
      if (rec.state === 'pending' || rec.state === 'queued') failBeforeEngine(rec, 'closed');
      else if (rec.state === 'sending') {
        leaveSending(rec);
        abortDelivery(rec);
        settle(rec, 'failed', 'closed');
      }
    }
    for (const receiver of [...busy.keys()]) releaseBusy(receiver);
    secrets.clear();
    retired.clear();
  }

  const control: RelayControl = Object.freeze({
    issueSecret(session: string): string {
      if (closed || typeof session !== 'string' || !ports.has(session) || issued.has(session) || ended.has(session)) {
        throw new TypeError('relay: a secret is made once for a live session of the run, and never after the relay closed');
      }
      const secret = draw(newSecret, isSessionSecret);
      if ([...secrets.values()].includes(secret) || [...retired.values()].some(old => timingSafeEqual(old, digestOf(secret)))) throw new TypeError('relay: a made secret is the secret of another session');
      issued.add(session);
      secrets.set(session, secret);
      return secret;
    },
    approve,
    decline,
    resume,
    sessionChanged(session: unknown): void {
      if (closed || typeof session !== 'string' || !ports.has(session)) return;
      const seen = look(session);
      if (seen !== 'ended') pump(session, { state: seen });
    },
    close,
    get closed(): boolean { return closed; },
    sizes: () => Object.freeze({ messages: records.size, keys: ledger.size, secrets: secrets.size, inflight: busy.size, declined: [...declined.values()].reduce((total, held) => total + held.size, 0) }),
    messages: (): readonly MessageView[] => Object.freeze([...records.values()].map(view)),
    message(id: unknown): MessageView | undefined {
      const rec = typeof id === 'string' ? records.get(id) : undefined;
      return rec === undefined ? undefined : view(rec);
    },
    routes: (): readonly RouteView[] => Object.freeze([...routeStates.values()].map(routeView)),
  });
  return Object.freeze({ write: Object.freeze({ send, confirm }), control });
}
