// The routes of a job: who may send to whom, and under which rule. A route is a person-approved cable between two sessions. It grants no authority to run or write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRouteDefinitions, resolveRoutes } from '../src/routes.js';

const labels = ['writer', 'checker', 'planner'];
const refused = (reason: string) => ({ ok: false, code: 'GAUGE_ROUTE_INVALID', reason });

test('a job with no routes is good, and a plain list of routes gives new frozen routes with their rule and caps', () => {
  assert.deepEqual(checkRouteDefinitions([], labels), { ok: true, value: [] });
  const checked = checkRouteDefinitions([{ from: 'writer', to: 'checker', rule: 'accepted-output' }], labels);
  assert.deepEqual(checked, { ok: true, value: [{ from: 'writer', to: 'checker', rule: 'accepted-output', messageCap: 50, loopCap: 6 }] });
  assert.ok(checked.ok);
  assert.equal(Object.isFrozen(checked.value), true);
  assert.equal(Object.isFrozen(checked.value[0]), true);
});

test('a new route that names no rule is not allowed: the rule is written out, and accepted-output is the one a person is shown first', () => {
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker' }], labels), refused('rule'));
});

test('an auto route needs a message cap and a loop cap, each a whole number in range', () => {
  const route = { from: 'writer', to: 'checker', rule: 'auto' };
  assert.deepEqual(checkRouteDefinitions([{ ...route, messageCap: 10, loopCap: 3 }], labels), { ok: true, value: [{ ...route, messageCap: 10, loopCap: 3 }] });
  assert.deepEqual(checkRouteDefinitions([route], labels), refused('cap'));
  assert.deepEqual(checkRouteDefinitions([{ ...route, messageCap: 10 }], labels), refused('cap'));
  assert.deepEqual(checkRouteDefinitions([{ ...route, loopCap: 3 }], labels), refused('cap'));
  assert.deepEqual(checkRouteDefinitions([{ ...route, messageCap: 1000, loopCap: 100 }], labels).ok, true);
  assert.deepEqual(checkRouteDefinitions([{ ...route, messageCap: 1, loopCap: 1 }], labels).ok, true);
});

test('a cap that is zero, negative, over the highest, not whole, not a number, or unsafe is refused, on both rules', () => {
  for (const rule of ['auto', 'accepted-output']) {
    for (const bad of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true, 2 ** 53]) {
      assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker', rule, messageCap: bad, loopCap: 3 }], labels), refused('cap'), `${rule} message ${String(bad)}`);
    }
    for (const bad of [0, -1, 101, 2.5, Number.NaN, '3', null]) {
      assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker', rule, messageCap: 10, loopCap: bad }], labels), refused('cap'), `${rule} loop ${String(bad)}`);
    }
  }
});

test('an accepted-output route may name its caps, and it takes the defaults for a cap it leaves out', () => {
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker', rule: 'accepted-output', messageCap: 7 }], labels), { ok: true, value: [{ from: 'writer', to: 'checker', rule: 'accepted-output', messageCap: 7, loopCap: 6 }] });
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker', rule: 'accepted-output', loopCap: 2 }], labels), { ok: true, value: [{ from: 'writer', to: 'checker', rule: 'accepted-output', messageCap: 50, loopCap: 2 }] });
});

test('a rule that is not one of the two is refused', () => {
  for (const rule of ['manual', 'AUTO', 'auto ', '', null, 5, undefined]) assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'checker', rule }], labels), refused('rule'), String(rule));
});

test('a route that names a session the job does not have is refused, for the sender and for the receiver, and the reason is the same for both', () => {
  assert.deepEqual(checkRouteDefinitions([{ from: 'ghost', to: 'checker', rule: 'accepted-output' }], labels), refused('session'));
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'ghost', rule: 'accepted-output' }], labels), refused('session'));
  for (const bad of [undefined, null, 5, {}, ['writer']]) assert.deepEqual(checkRouteDefinitions([{ from: bad, to: 'checker', rule: 'accepted-output' }], labels), refused('session'));
});

test('a route from a session to itself is refused', () => {
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'writer', rule: 'accepted-output' }], labels), refused('self'));
});

test('a second route for the same sender and receiver is refused, and the opposite direction is a route of its own', () => {
  const one = { from: 'writer', to: 'checker', rule: 'accepted-output' };
  assert.deepEqual(checkRouteDefinitions([one, { ...one, rule: 'auto', messageCap: 5, loopCap: 2 }], labels), refused('repeat'));
  assert.equal(checkRouteDefinitions([one, { from: 'checker', to: 'writer', rule: 'accepted-output' }], labels).ok, true);
});

test('a route holds exactly the five fields, and a field that a route does not have is refused, such as a start or a run', () => {
  const base = { from: 'writer', to: 'checker', rule: 'accepted-output' };
  for (const extra of [{ start: true }, { run: 'x' }, { schedule: 'daily' }, { grants: ['write'] }, { id: 'route-1' }]) assert.deepEqual(checkRouteDefinitions([{ ...base, ...extra }], labels), refused('request'));
});

test('anything that is not a plain list of plain records is refused as a malformed request', () => {
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', { get: () => ({ from: 'writer', to: 'checker', rule: 'accepted-output' }), enumerable: true });
  const holey = new Array(1);
  class Routes extends Array {}
  const iterator = [{ from: 'writer', to: 'checker', rule: 'accepted-output' }];
  Object.defineProperty(iterator, Symbol.iterator, { value: function* () { yield { from: 'x', to: 'y', rule: 'auto' }; } });
  const accessorRoute = { from: 'writer', to: 'checker' };
  Object.defineProperty(accessorRoute, 'rule', { get: () => 'accepted-output', enumerable: true });
  class RouteClass { from = 'writer'; to = 'checker'; rule = 'accepted-output'; }
  for (const value of [undefined, null, 'x', 5, {}, accessor, holey, Routes.from([{ from: 'writer', to: 'checker', rule: 'accepted-output' }]), [null], [[]], ['route'], [accessorRoute], [new RouteClass()], [{ from: 'writer', to: 'checker', rule: 'accepted-output', [Symbol('s')]: 1 }]]) {
    assert.deepEqual(checkRouteDefinitions(value, labels), refused('request'));
  }
  // The iterator of the list is never followed: the one item that the list holds is read by index.
  assert.deepEqual(checkRouteDefinitions(iterator, labels), { ok: true, value: [{ from: 'writer', to: 'checker', rule: 'accepted-output', messageCap: 50, loopCap: 6 }] });
});

test('at most 32 routes: 32 are good, 33 are refused as a limit, and a long list is refused as a limit and never read to its end', () => {
  const many = (count: number) => {
    const names = Array.from({ length: 8 }, (_v, index) => `s${index}`);
    const routes: unknown[] = [];
    for (const from of names) for (const to of names) if (from !== to && routes.length < count) routes.push({ from, to, rule: 'accepted-output' });
    return { names, routes };
  };
  const full = many(32);
  assert.equal(checkRouteDefinitions(full.routes, full.names).ok, true);
  const over = many(33);
  assert.deepEqual(checkRouteDefinitions(over.routes, over.names), refused('limit'));
  const forty = many(56);
  assert.deepEqual(checkRouteDefinitions(forty.routes, forty.names), refused('limit'));
  const huge = new Array(5000).fill({ from: 'writer', to: 'checker', rule: 'accepted-output' });
  assert.deepEqual(checkRouteDefinitions(huge, labels), refused('request'));
});

test('the first failure in the order of the list is the one that is told, so one wrong route hides no earlier right one', () => {
  assert.deepEqual(checkRouteDefinitions([{ from: 'writer', to: 'writer', rule: 'accepted-output' }, { from: 'ghost', to: 'writer', rule: 'accepted-output' }], labels), refused('self'));
  assert.deepEqual(checkRouteDefinitions([{ from: 'ghost', to: 'writer', rule: 'accepted-output' }, { from: 'writer', to: 'writer', rule: 'accepted-output' }], labels), refused('session'));
});

test('routes name labels, and resolving them gives ids of sessions and ids of routes in the order of the job', () => {
  const checked = checkRouteDefinitions([
    { from: 'writer', to: 'checker', rule: 'accepted-output' },
    { from: 'checker', to: 'writer', rule: 'auto', messageCap: 4, loopCap: 2 },
  ], labels);
  assert.ok(checked.ok);
  const routes = resolveRoutes(checked.value, [{ label: 'writer', session: 'sess-w' }, { label: 'checker', session: 'sess-c' }, { label: 'planner', session: 'sess-p' }]);
  assert.deepEqual(routes, [
    { id: 'route-1', from: 'sess-w', to: 'sess-c', rule: 'accepted-output', messageCap: 50, loopCap: 6 },
    { id: 'route-2', from: 'sess-c', to: 'sess-w', rule: 'auto', messageCap: 4, loopCap: 2 },
  ]);
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(Object.isFrozen(routes[0]), true);
});

test('a label that no member has is a bug of the caller, since the definitions were checked against the labels', () => {
  const checked = checkRouteDefinitions([{ from: 'writer', to: 'checker', rule: 'accepted-output' }], labels);
  assert.ok(checked.ok);
  assert.throws(() => resolveRoutes(checked.value, [{ label: 'writer', session: 'sess-w' }]), TypeError);
});
