// The group start of the host: a run starts several sessions through one plan. The host plans the group as one unit (the cap, the pair rule, and the shared folder count the members too) and begins every
// member before it returns. A launcher that starts no process stands in for the programs, so every event is made by the test and no test waits on a timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_START_GROUP, createEngineHost, type EngineHost, type EngineSpec, type HostOptions } from '../src/host.js';
import { fakeSignal } from '../src/fixtures.js';
import type { Launched, LaunchSpec, Launcher } from '../src/launcher.js';
import { manualLauncher } from './support.js';

const spec = (id: string): EngineSpec => ({ id, title: `Engine ${id}`, program: `/bin/${id}`, args: [], env: [], billing: 'engine-plan', signalOf: fakeSignal });

interface Rig {
  readonly host: EngineHost;
  readonly launcher: ReturnType<typeof manualLauncher>;
}
function rig(options: Partial<HostOptions> = {}, launcher: ReturnType<typeof manualLauncher> = manualLauncher()): Rig {
  let counter = 0;
  const engines = ['alpha', 'beta', 'gamma', 'delta'].map(spec);
  const host = createEngineHost({ engines, launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined, newId: () => `s-${(counter += 1)}`, schedule: () => () => undefined, ...options });
  return { host, launcher };
}
const asked = (engine: string, folder: string) => ({ engine, folder });
/** Plans one group and gives the plans, failing the test when it is refused. */
function planned(host: EngineHost, requests: readonly unknown[]) {
  const group = host.planStartGroup(requests);
  assert.ok(group.ok, JSON.stringify(group));
  return group.plans;
}
const refusal = (result: { ok: boolean }) => {
  assert.equal(result.ok, false);
  return result as { ok: false; code: string; reason?: string; index: number };
};

test('a group plan holds one plan for each request, the same as a single plan, and changes nothing', () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/work/one'), asked('beta', '/work/two')]);
  const single = r.host.planStart(asked('alpha', '/work/one'));
  assert.ok(single.ok);
  assert.deepEqual(plans[0], single.plan);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map(plan => plan.engine), ['alpha', 'beta']);
  assert.deepEqual(r.host.list(), []);
  assert.equal(r.host.launched, 0);
  assert.equal(Object.isFrozen(plans), true);
});

test('the cap counts the members of the group: a group that does not fit is refused at the first member that does not, and nothing starts', async () => {
  const r = rig({ cap: 2 });
  assert.equal(planned(r.host, [asked('alpha', '/a'), asked('beta', '/b')]).length, 2);
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/a'), asked('beta', '/b'), asked('gamma', '/c')])), { ok: false, code: 'ENGINE_LIMIT', index: 2 });
  // One place is taken already, so the second member is the one that does not fit.
  const first = r.host.planStart(asked('delta', '/d'));
  assert.ok(first.ok);
  const begun = r.host.beginStart(first.plan, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/a'), asked('beta', '/b')])), { ok: false, code: 'ENGINE_LIMIT', index: 1 });
  assert.equal(r.launcher.programs.length, 1, 'a refused group launches nothing');
});

test('an engine twice in one folder inside a group is the pair rule, at the second member', () => {
  const r = rig();
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/w'), asked('alpha', '/w')])), { ok: false, code: 'ENGINE_PAIR_BUSY', index: 1 });
  assert.equal(planned(r.host, [asked('alpha', '/w'), asked('alpha', '/x')]).length, 2, 'the same engine in two folders is two pairs');
});

test('a member that shares its folder with an earlier member lists that engine in sharedWith, and a group with sharing needs the second approval', () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/w'), asked('beta', '/w'), asked('gamma', '/x')]);
  assert.deepEqual(plans.map(plan => plan.sharedWith), [[], ['alpha'], []]);
  assert.deepEqual(refusal(r.host.beginStartGroup(plans, { sharedApproved: false })), { ok: false, code: 'ENGINE_FOLDER_SHARED', index: 1 });
  assert.equal(r.launcher.programs.length, 0, 'a refusal for the second approval launches nothing');
  assert.deepEqual(r.host.list(), []);
  const begun = r.host.beginStartGroup(plans, { sharedApproved: true });
  assert.ok(begun.ok);
  assert.equal(r.launcher.programs.length, 3);
});

test('when several members share a folder, the refusal for the second approval names the first of them', () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/w'), asked('beta', '/w'), asked('gamma', '/w')]);
  assert.deepEqual(plans.map(plan => plan.sharedWith), [[], ['alpha'], ['alpha', 'beta']]);
  assert.deepEqual(refusal(r.host.beginStartGroup(plans, { sharedApproved: false })), { ok: false, code: 'ENGINE_FOLDER_SHARED', index: 1 });
});

test('only the value true is the second approval of a group', () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/w'), asked('beta', '/w')]);
  for (const value of [1, 'true', {}, undefined]) {
    assert.equal(refusal(r.host.beginStartGroup(plans, { sharedApproved: value as unknown as boolean })).code, 'ENGINE_FOLDER_SHARED', String(value));
  }
  assert.equal(r.launcher.programs.length, 0);
});

test('a refusal of a member names its index and keeps its own code and reason', () => {
  const r = rig();
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/a'), asked('no-such', '/b')])), { ok: false, code: 'ENGINE_NOT_FOUND', reason: 'engine', index: 1 });
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', 'relative')])), { ok: false, code: 'ENGINE_REQUEST_INVALID', reason: 'folder', index: 0 });
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/a'), { ...asked('beta', '/b'), model: { provider: 'p', model: 'm' } }])), { ok: false, code: 'MODEL_NOT_FOR_ENGINE', index: 1 });
});

test('a group begins every member before it returns, in order, and each member settles on its own', async () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/a'), asked('beta', '/b'), asked('gamma', '/c')]);
  const begun = r.host.beginStartGroup(plans, { sharedApproved: false });
  assert.ok(begun.ok);
  assert.deepEqual(begun.members.map(member => member.session), ['s-1', 's-2', 's-3']);
  assert.equal(r.launcher.programs.length, 3, 'every program was asked for before the call returned');
  assert.deepEqual(r.launcher.programs.map(program => program.spec.program), ['/bin/alpha', '/bin/beta', '/bin/gamma']);
  assert.deepEqual(r.host.list().map(session => session.state), ['starting', 'starting', 'starting']);
  for (const program of r.launcher.programs) program.spawn();
  const settled = await Promise.all(begun.members.map(member => member.settled));
  assert.ok(settled.every(result => result.ok));
});

test('a member whose launch fails at once leaves the places of the others right: a later member still begins from the plan that was approved', async () => {
  let launches = 0;
  const inner = manualLauncher();
  const launcher: Launcher & { readonly programs: typeof inner.programs } = {
    programs: inner.programs,
    launch(launchSpec: LaunchSpec): Launched {
      launches += 1;
      if (launches === 2) throw new Error('the second program cannot start');
      return inner.launch(launchSpec);
    },
  };
  let counter = 0;
  const host = createEngineHost({ engines: ['alpha', 'beta', 'gamma'].map(spec), launcher, locate: program => program, canonical: folder => ({ path: folder, key: folder }), log: () => undefined, newId: () => `s-${(counter += 1)}`, schedule: () => () => undefined, cap: 3 });
  // Three members share one folder. If the failed member's place were freed at once, the third member would plan again with fewer neighbours, and its plan would no longer match.
  const plans = planned(host, [asked('alpha', '/w'), asked('beta', '/w'), asked('gamma', '/w')]);
  const begun = host.beginStartGroup(plans, { sharedApproved: true });
  assert.ok(begun.ok);
  assert.equal(begun.members.length, 3);
  inner.programs[0]?.spawn();
  inner.programs[1]?.spawn();
  const [one, two, three] = await Promise.all(begun.members.map(member => member.settled));
  assert.ok(one?.ok);
  assert.deepEqual(two, { ok: false, code: 'ENGINE_START_FAILED', reason: 'other' });
  assert.ok(three?.ok);
  assert.deepEqual(host.list().map(session => session.state), ['starting', 'failed', 'starting']);
});

test('a group that no longer fits the state now is refused with its index, and nothing begins', () => {
  const r = rig({ cap: 2 });
  const plans = planned(r.host, [asked('alpha', '/a'), asked('beta', '/b')]);
  const other = r.host.planStart(asked('gamma', '/c'));
  assert.ok(other.ok);
  assert.ok(r.host.beginStart(other.plan, { sharedApproved: false }).ok);
  assert.deepEqual(refusal(r.host.beginStartGroup(plans, { sharedApproved: false })), { ok: false, code: 'ENGINE_LIMIT', index: 1 });
  assert.equal(r.launcher.programs.length, 1, 'only the single start launched');
});

test('plans that differ from what the host plans now are a bug of the caller, and throw before any member begins: a changed folder neighbour, a changed field, and a changed order of members that share a folder', () => {
  const r = rig();
  const plans = planned(r.host, [asked('alpha', '/w'), asked('beta', '/w')]);
  assert.throws(() => r.host.beginStartGroup([plans[1]!, plans[0]!], { sharedApproved: true }), /do not match the state now/);
  assert.throws(() => r.host.beginStartGroup([{ ...plans[0]!, program: '/bin/other' }, plans[1]!], { sharedApproved: true }), /do not match the state now/);
  assert.throws(() => r.host.beginStartGroup([plans[0]!, { ...plans[1]!, sharedWith: [] }], { sharedApproved: true }), /do not match the state now/);
  assert.equal(r.launcher.programs.length, 0);
});

test('a group is a plain list of one to the most members: anything else is a bug of the caller, and throws', () => {
  const r = rig();
  const sparse = [asked('alpha', '/a')];
  sparse.length = 2;
  const accessor = [asked('alpha', '/a')];
  Object.defineProperty(accessor, 0, { get: () => asked('alpha', '/a'), enumerable: true });
  const many = Array.from({ length: MAX_START_GROUP + 1 }, (_value, index) => asked('alpha', `/w${index}`));
  for (const bad of [undefined, null, 'alpha', {}, [], sparse, accessor, many]) {
    assert.throws(() => r.host.planStartGroup(bad), TypeError);
    assert.throws(() => r.host.beginStartGroup(bad as never, { sharedApproved: false }), TypeError);
  }
  assert.equal(MAX_START_GROUP, 8);
  const roomy = rig({ cap: 8 });
  assert.equal(planned(roomy.host, Array.from({ length: MAX_START_GROUP }, (_value, index) => asked('alpha', `/w${index}`))).length, 8, 'the largest group is accepted');
});

test('a host that is shutting down plans no group', async () => {
  const r = rig();
  await r.host.killAll();
  assert.deepEqual(refusal(r.host.planStartGroup([asked('alpha', '/a')])), { ok: false, code: 'ENGINE_START_FAILED', reason: 'shutting_down', index: 0 });
});

test('a throw while a member begins (a bad session id) stops the members that began, and rethrows', () => {
  const ids = ['s-1', 'not a valid id'];
  const r = rig({ newId: () => ids.shift() ?? 's-9' });
  const plans = planned(r.host, [asked('alpha', '/a'), asked('beta', '/b')]);
  assert.throws(() => r.host.beginStartGroup(plans, { sharedApproved: false }), /malformed or already used/);
  assert.equal(r.launcher.programs.length, 1);
  assert.deepEqual(r.launcher.programs[0]?.signals, ['term'], 'the member that began was asked to stop');
  assert.equal(r.host.get('s-1')?.state, 'stopping');
});
