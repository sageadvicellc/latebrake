import { checkSessionId, readList } from '../../engine-sessions/src/request.js';
import { routeId, type RouteId } from './brand.js';
import { DEFAULT_LOOP_CAP, DEFAULT_MESSAGE_CAP, MAX_LOOP_CAP, MAX_MESSAGE_CAP, MAX_ROUTES, isRouteRule, type RouteReason, type RouteRule } from './vocab.js';
import { plainRecord } from './read.js';

/**
 * The routes of a job. A route is a person-approved cable between two sessions of the job: a sender, a receiver, and one rule. It grants no authority to run anything or to write anything. A route names sessions by their
 * labels in the job. When a run starts, the labels turn into session ids (`resolveRoutes`), so a rename of a label never breaks delivery.
 */

export type RouteRefusal = { readonly ok: false; readonly code: 'GAUGE_ROUTE_INVALID'; readonly reason: RouteReason };
const refuse = (reason: RouteReason): RouteRefusal => ({ ok: false, code: 'GAUGE_ROUTE_INVALID', reason });

/** A route of a job, as the job holds it. The caps always have a value: a cap that the definition leaves out takes the default (an `auto` route may not leave one out). */
export interface RouteDefinition {
  readonly from: string;
  readonly to: string;
  readonly rule: RouteRule;
  /** The most messages the route accepts in one run, until the person resumes it. */
  readonly messageCap: number;
  /** The most messages in one back-and-forth between the two sessions. */
  readonly loopCap: number;
}

/** A route of a run: the same, with the ids of the sessions, and an id of its own. */
export interface Route {
  readonly id: RouteId;
  readonly from: string;
  readonly to: string;
  readonly rule: RouteRule;
  readonly messageCap: number;
  readonly loopCap: number;
}

const FIELDS: ReadonlySet<string> = new Set(['from', 'to', 'rule', 'messageCap', 'loopCap']);
const wholeIn = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;

/** Reads one route. `labels` are the sessions of the job. */
function checkRoute(value: unknown, labels: ReadonlySet<string>): { readonly ok: true; readonly value: RouteDefinition } | RouteRefusal {
  const fields = plainRecord(value);
  if (fields === undefined || [...fields.keys()].some(key => !FIELDS.has(key))) return refuse('request');
  const from = fields.get('from'), to = fields.get('to');
  if (typeof from !== 'string' || typeof to !== 'string' || !labels.has(from) || !labels.has(to)) return refuse('session');
  if (from === to) return refuse('self');
  // A route that names no rule is an `accepted-output` route, the safe default: the person approves each message. An `auto` route is written out, with both caps.
  const rule = fields.has('rule') ? fields.get('rule') : 'accepted-output';
  if (!isRouteRule(rule)) return refuse('rule');
  const messageCap = fields.has('messageCap') ? fields.get('messageCap') : DEFAULT_MESSAGE_CAP;
  const loopCap = fields.has('loopCap') ? fields.get('loopCap') : DEFAULT_LOOP_CAP;
  // A cap that is written must be good, on both rules. An auto route must write both.
  if (!wholeIn(messageCap, MAX_MESSAGE_CAP) || !wholeIn(loopCap, MAX_LOOP_CAP)) return refuse('cap');
  if (rule === 'auto' && (!fields.has('messageCap') || !fields.has('loopCap'))) return refuse('cap');
  return { ok: true, value: Object.freeze({ from, to, rule, messageCap, loopCap }) };
}

/**
 * Checks the routes of a job against the labels of its sessions. The list is a plain list read with the one list reader, so an iterator, a subclass, a hole, and an accessor are refused. At most 32 routes, no route from a
 * session to itself, none that names a session the job lacks, and at most one for each sender and receiver (the opposite direction is a route of its own). The first failure in the order of the list is the one that is told.
 * The value that comes out is new and frozen.
 */
export function checkRouteDefinitions(value: unknown, labels: readonly string[]): { readonly ok: true; readonly value: readonly RouteDefinition[] } | RouteRefusal {
  // The list is read with the cap of the reader, and then counted: a list that is only too long is a limit, and a list that is no plain list is a malformed request.
  const items = readList(value);
  if (items === undefined) return refuse('request');
  if (items.length > MAX_ROUTES) return refuse('limit');
  const known = new Set(labels);
  const routes: RouteDefinition[] = [];
  const pairs = new Set<string>();
  for (const item of items) {
    const checked = checkRoute(item, known);
    if (!checked.ok) return checked;
    const pair = JSON.stringify([checked.value.from, checked.value.to]);
    if (pairs.has(pair)) return refuse('repeat');
    pairs.add(pair);
    routes.push(checked.value);
  }
  return { ok: true, value: Object.freeze(routes) };
}

/**
 * Turns the routes of a job into the routes of a run: the labels become the ids of the sessions that the run started, and each route gets the id `route-<n>` in the order of the job. A label that no member has is a bug
 * of the caller, since the routes were checked against the labels, and throws.
 */
export function resolveRoutes(definitions: readonly RouteDefinition[], members: readonly { readonly label: string; readonly session: string }[]): readonly Route[] {
  const byLabel = new Map(members.map(member => [member.label, member.session]));
  return Object.freeze(definitions.map((definition, index): Route => {
    const from = byLabel.get(definition.from), to = byLabel.get(definition.to);
    if (from === undefined || to === undefined || !checkSessionId(from).ok || !checkSessionId(to).ok) throw new TypeError('a route names a label that no session of the run has');
    return Object.freeze({ id: routeId(`route-${index + 1}`), from, to, rule: definition.rule, messageCap: definition.messageCap, loopCap: definition.loopCap });
  }));
}
