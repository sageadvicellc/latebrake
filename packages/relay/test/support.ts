// Helpers for the tests of the relay: a schedule that a test moves by hand, a clock, counters for ids and secrets, and a relay built over fake engines.
import { createFakeEngine, type FakeEngine } from '../src/fixtures.js';
import { createRelay, type Relay, type RelayOptions } from '../src/bus.js';
import type { Route } from '../src/routes.js';
import type { RouteRule } from '../src/vocab.js';

export interface ManualSchedule {
  readonly schedule: (run: () => void, ms: number) => () => void;
  /** Timers that were set, not cancelled, and not fired. */
  live(): number;
  /** The delays of the live timers. */
  delays(): number[];
  /** Fires every live timer, oldest first. */
  fireAll(): void;
}

export function manualSchedule(): ManualSchedule {
  const timers: { run: () => void; ms: number; done: boolean }[] = [];
  return {
    schedule(run, ms) {
      const timer = { run, ms, done: false };
      timers.push(timer);
      return () => { timer.done = true; };
    },
    live: () => timers.filter(timer => !timer.done).length,
    delays: () => timers.filter(timer => !timer.done).map(timer => timer.ms),
    fireAll() {
      for (const timer of [...timers]) {
        if (timer.done) continue;
        timer.done = true;
        timer.run();
      }
    },
  };
}

/** Lets every promise that is ready run, and the ones that those start, so a delivery that resolved at once has been seen by the relay. It waits for the next turn of the loop of events and sets no timer. */
export const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

export const route = (id: string, from: string, to: string, rule: RouteRule = 'accepted-output', messageCap = 50, loopCap = 6): Route => ({ id, from, to, rule, messageCap, loopCap });

export interface Built {
  readonly relay: Relay;
  readonly engines: Readonly<Record<string, FakeEngine>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly lines: string[];
  readonly timers: ManualSchedule;
  readonly clock: { now: number };
  /** An engine writes to the bus with its own secret. */
  send(from: string, routeId: string, key: string, body: string): ReturnType<Relay['write']['send']>;
  confirm(session: string, id: string, receipt: string): ReturnType<Relay['write']['confirm']>;
}

export interface BuildOptions {
  readonly sessions?: readonly string[];
  readonly routes?: readonly Route[];
  readonly states?: Readonly<Record<string, FakeEngine['state'] extends () => infer S ? S : never>>;
  readonly options?: Partial<RelayOptions>;
  /** When true, the secrets are not issued. */
  readonly noSecrets?: boolean;
}

export function build(config: BuildOptions = {}): Built {
  const names = config.sessions ?? ['sess-a', 'sess-b'];
  const engines: Record<string, FakeEngine> = {};
  for (const name of names) engines[name] = createFakeEngine(name, config.states?.[name] === undefined ? {} : { state: config.states[name] });
  const timers = manualSchedule();
  const clock = { now: 1_700_000_000_000 };
  const lines: string[] = [];
  let ids = 0, secretCount = 0, nonces = 0, receipts = 0;
  const relay = createRelay({
    run: 'run-1',
    routes: config.routes ?? [route('route-1', names[0] ?? 'sess-a', names[1] ?? 'sess-b'), route('route-2', names[1] ?? 'sess-b', names[0] ?? 'sess-a')],
    members: names.map(session => ({ session, port: engines[session] as FakeEngine })),
    schedule: timers.schedule,
    now: () => clock.now,
    newId: () => `msg-${(ids += 1)}`,
    newSecret: () => `secret-${(secretCount += 1)}-${'q'.repeat(30)}`,
    newNonce: () => `nonce-${(nonces += 1)}-${'n'.repeat(24)}`,
    newReceipt: () => `rcpt-${(receipts += 1)}-${'r'.repeat(24)}`,
    log: line => { lines.push(line); },
    ...config.options,
  });
  const secrets: Record<string, string> = {};
  if (config.noSecrets !== true) for (const name of names) secrets[name] = relay.control.issueSecret(name);
  return {
    relay, engines, secrets, lines, timers, clock,
    send: (from, routeId, key, body) => relay.write.send({ session: from, secret: secrets[from], route: routeId, key, body }),
    confirm: (session, id, receipt) => relay.write.confirm({ session, secret: secrets[session], id, receipt }),
  };
}
