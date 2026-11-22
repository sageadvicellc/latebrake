// The lifecycle suite: install, enable, disable, update, and remove, each through a plan and an approval. Like the client suite, it takes the core
// as a parameter. `makeHarness` gives a fresh core that holds the given Gauge folders, and a way to approve a plan. In the app the person approves
// with a click that no Gauge can make, so a harness supplies that step. A Gauge never approves a plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { GaugeFolder } from '../src/fake-core.js';
import type { Core, GaugePlan, GaugeSummary } from '../src/types.js';
import { INVALID_MANIFESTS, validManifest } from '../../gauge-manifest/src/fixtures.js';

export type { GaugeFolder };

export interface LifecycleHarness {
  readonly core: Core;
  /** The person approves a plan by its digest. Gives back the approval. */
  approve(digest: string): string | Promise<string>;
}

const tile = validManifest('tile-only');
const protectedTile = tile.replace('"protected":false', '"protected":true');
const asClock = (text: string, version: string) => text.replace('fixture-tile', 'fixture-clock').replace('"version":"1.0.0"', `"version":"${version}"`);

/** The folders the suite loads. Written out here, so a wrong core fails the suite. */
export const SUITE_FOLDERS: readonly GaugeFolder[] = [
  { name: 'tile-folder', location: 'user', manifest: tile },
  { name: 'both-folder', location: 'bundled', manifest: validManifest('tile-and-page') },
  { name: 'clash-folder', location: 'user', manifest: asClock(tile, '1.0.0') },
  { name: 'clock-update-bundled', location: 'bundled', manifest: asClock(tile, '1.3.0') },
  { name: 'clock-update-user', location: 'user', manifest: asClock(tile, '1.3.0') },
  { name: 'tile-update', location: 'user', manifest: tile.replace('"version":"1.0.0"', '"version":"1.1.0"') },
  ...Object.entries(INVALID_MANIFESTS).map(([name, manifest]): GaugeFolder => ({ name: `bad-${name}`, location: 'user', manifest })),
  { name: 'protected-user', location: 'user', manifest: protectedTile },
  { name: 'protected-bundled', location: 'bundled', manifest: protectedTile },
  { name: 'link-folder', location: 'user', manifest: tile, isLink: true },
];

/** The refusal each invalid fixture gets at load, written out here and not read from the fixtures. */
const EXPECTED_CODES: Readonly<Record<string, string>> = {
  'duplicate-key': 'GAUGE_MANIFEST_INVALID',
  'comment': 'GAUGE_MANIFEST_INVALID',
  'trailing-comma': 'GAUGE_MANIFEST_INVALID',
  'unknown-field': 'GAUGE_MANIFEST_INVALID',
  'secret-value': 'GAUGE_SECRET_FOUND',
  'link': 'GAUGE_PATH_UNSAFE',
  'hidden-name': 'GAUGE_PATH_UNSAFE',
  'dotdot-name': 'GAUGE_PATH_UNSAFE',
  'over-size': 'GAUGE_MANIFEST_TOO_LARGE',
  'origin-set': 'GAUGE_MANIFEST_INVALID',
  'newer-api': 'GAUGE_API_UNSUPPORTED',
};

const PLAN_KEYS = ['action', 'digest', 'folder', 'from', 'id', 'origin', 'steps', 'to'];

/** Registers the lifecycle tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runLifecycleSuite(name: string, makeHarness: (folders: readonly GaugeFolder[]) => LifecycleHarness | Promise<LifecycleHarness>): void {
  const start = async () => {
    const harness = await makeHarness(SUITE_FOLDERS);
    return { client: createCoreClient(harness.core), approve: async (plan: GaugePlan) => harness.approve(plan.digest) };
  };
  type Session = Awaited<ReturnType<typeof start>>;
  const plan = async <T extends GaugePlan>(result: Promise<{ ok: true; value: T } | { ok: false; code: string }>): Promise<T> => {
    const planned = await result;
    assert.ok(planned.ok, JSON.stringify(planned));
    return planned.value;
  };
  /** Plans, approves, and applies one step, and checks that it worked. */
  const run = async (session: Session, planned: GaugePlan) => {
    const applied = await session.client.applyPlan(planned, await session.approve(planned));
    assert.ok(applied.ok, JSON.stringify(applied));
    return applied.value;
  };
  const ids = async (client: CoreClient) => {
    const list = await client.listGauges();
    assert.ok(list.ok);
    return list.value.map(gauge => gauge.id);
  };
  const routes = async (client: CoreClient) => {
    const result = await client.listRoutes();
    assert.ok(result.ok);
    return result.value;
  };

  test(`${name}: an install plan is returned first and changes nothing`, async () => {
    const { client } = await start();
    const before = await client.listGauges();
    const planned = await plan(client.planInstall('tile-folder'));
    assert.deepEqual(Object.keys(planned).sort(), PLAN_KEYS);
    assert.deepEqual({ action: planned.action, id: planned.id, folder: planned.folder, from: planned.from, to: planned.to }, { action: 'install', id: 'fixture-tile', folder: 'tile-folder', from: null, to: '1.0.0' });
    assert.match(planned.digest, /^[0-9a-f]{64}$/);
    assert.ok(planned.steps.length > 0);
    assert.deepEqual(await client.listGauges(), before);
    assert.deepEqual(await client.getGauge('fixture-tile'), { ok: false, code: 'UNKNOWN_GAUGE' });
  });

  test(`${name}: the same request gives the same plan twice`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('tile-folder'), await client.planInstall('tile-folder'));
  });

  test(`${name}: the core sets the origin from where it found the folder`, async () => {
    const session = await start();
    const user = await plan(session.client.planInstall('tile-folder')), bundled = await plan(session.client.planInstall('both-folder'));
    assert.equal(user.origin, 'third-party');
    assert.equal(bundled.origin, 'stock');
    await run(session, user);
    await run(session, bundled);
    const one = await session.client.getGauge('fixture-tile'), two = await session.client.getGauge('fixture-both');
    assert.ok(one.ok && two.ok);
    assert.equal(one.value.origin, 'third-party');
    assert.equal(two.value.origin, 'stock');
  });

  test(`${name}: a manifest that sets its own origin is refused at load`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('bad-origin-set'), { ok: false, code: 'GAUGE_MANIFEST_INVALID' });
  });

  test(`${name}: each invalid manifest is refused at load with its own code, and nothing is installed`, async () => {
    const { client } = await start();
    const before = await ids(client);
    for (const [fixture, code] of Object.entries(EXPECTED_CODES)) assert.deepEqual(await client.planInstall(`bad-${fixture}`), { ok: false, code }, fixture);
    assert.deepEqual(await ids(client), before);
  });

  test(`${name}: a Gauge that needs a newer Core API version is refused at load, also for an update`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('bad-newer-api'), { ok: false, code: 'GAUGE_API_UNSUPPORTED' });
    assert.deepEqual(await client.planUpdate('bad-newer-api'), { ok: false, code: 'GAUGE_API_UNSUPPORTED' });
  });

  test(`${name}: a folder that is a link, or has a hidden name or a name with two dots, is refused`, async () => {
    const { client } = await start();
    for (const folder of ['link-folder', '.hidden', 'a..b', '..', 'https://example.test/x']) assert.deepEqual(await client.planInstall(folder), { ok: false, code: 'GAUGE_PATH_UNSAFE' }, folder);
  });

  test(`${name}: a folder that does not exist is refused with UNKNOWN_GAUGE`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('no-such-folder'), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await client.planUpdate('no-such-folder'), { ok: false, code: 'UNKNOWN_GAUGE' });
  });

  test(`${name}: applying a plan with no approval is refused and changes nothing`, async () => {
    const { client } = await start();
    const planned = await plan(client.planInstall('tile-folder'));
    assert.deepEqual(await client.applyPlan(planned), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await client.applyPlan(planned, 'made-up-approval'), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await client.applyPlan(planned, ''), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await ids(client)).includes('fixture-tile'), false);
  });

  test(`${name}: an approval of one plan does not apply another plan`, async () => {
    const session = await start();
    const one = await plan(session.client.planInstall('tile-folder')), two = await plan(session.client.planInstall('both-folder'));
    const approval = await session.approve(one);
    assert.deepEqual(await session.client.applyPlan(two, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await ids(session.client), ['fixture-manager', 'fixture-clock', 'fixture-preset']);
  });

  test(`${name}: a plan that was changed after approval is refused with GAUGE_PLAN_CHANGED`, async () => {
    const session = await start();
    const planned = await plan(session.client.planInstall('tile-folder'));
    const approval = await session.approve(planned);
    for (const changed of [{ ...planned, to: '9.9.9' }, { ...planned, steps: [...planned.steps, 'extra step'] }, { ...planned, origin: 'stock' as const }, { ...planned, id: 'fixture-clock' }]) {
      assert.deepEqual(await session.client.applyPlan(changed, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, JSON.stringify(changed.id + changed.to + changed.origin));
    }
    assert.equal((await ids(session.client)).includes('fixture-tile'), false);
    assert.equal((await session.client.applyPlan(planned, approval)).ok, true, 'the exact plan still applies with its approval');
  });

  test(`${name}: an approval works once`, async () => {
    const session = await start();
    const planned = await plan(session.client.planInstall('tile-folder'));
    const approval = await session.approve(planned);
    assert.equal((await session.client.applyPlan(planned, approval)).ok, true);
    assert.deepEqual(await session.client.applyPlan(planned, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  });

  test(`${name}: install adds the Gauge disabled, enable gives it a route, disable takes the route away`, async () => {
    const session = await start();
    const installed = await run(session, await plan(session.client.planInstall('tile-folder')));
    assert.deepEqual(installed, { action: 'install', id: 'fixture-tile', version: '1.0.0', enabled: false });
    assert.deepEqual(await ids(session.client), ['fixture-manager', 'fixture-clock', 'fixture-preset', 'fixture-tile']);
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), false);
    const enabled = await run(session, await plan(session.client.planEnable('fixture-tile')));
    assert.deepEqual(enabled, { action: 'enable', id: 'fixture-tile', version: '1.0.0', enabled: true });
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), true);
    const disabled = await run(session, await plan(session.client.planDisable('fixture-tile')));
    assert.deepEqual(disabled, { action: 'disable', id: 'fixture-tile', version: '1.0.0', enabled: false });
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), false);
    assert.equal((await ids(session.client)).includes('fixture-tile'), true, 'a disabled Gauge stays installed');
  });

  test(`${name}: the Gauges the core starts with are enabled and have routes`, async () => {
    const { client } = await start();
    assert.deepEqual(await routes(client), ['/gauges/fixture-manager', '/gauges/fixture-clock', '/gauges/fixture-preset']);
  });

  test(`${name}: a removed Gauge leaves no route and no entry`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), true);
    const removed = await run(session, await plan(session.client.planRemove('fixture-tile')));
    assert.deepEqual(removed, { action: 'remove', id: 'fixture-tile', version: null, enabled: false });
    assert.deepEqual(await session.client.getGauge('fixture-tile'), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.equal((await ids(session.client)).includes('fixture-tile'), false);
    assert.equal((await routes(session.client)).some(route => route.includes('fixture-tile')), false);
    await run(session, await plan(session.client.planRemove('fixture-clock')));
    assert.deepEqual(await routes(session.client), ['/gauges/fixture-manager', '/gauges/fixture-preset']);
  });

  test(`${name}: a removed Gauge can be installed again`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    await run(session, await plan(session.client.planRemove('fixture-tile')));
    assert.equal((await session.client.planInstall('tile-folder')).ok, true);
  });

  test(`${name}: update installs the new version and keeps the Gauge enabled`, async () => {
    const session = await start();
    const planned = await plan(session.client.planUpdate('clock-update-bundled'));
    assert.deepEqual({ action: planned.action, id: planned.id, from: planned.from, to: planned.to }, { action: 'update', id: 'fixture-clock', from: '1.2.0', to: '1.3.0' });
    assert.deepEqual(await run(session, planned), { action: 'update', id: 'fixture-clock', version: '1.3.0', enabled: true });
    const read = await session.client.getGauge('fixture-clock');
    assert.ok(read.ok);
    assert.equal(read.value.version, '1.3.0');
    assert.equal((await routes(session.client)).includes('/gauges/fixture-clock'), true);
  });

  test(`${name}: update keeps a disabled Gauge disabled`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    assert.deepEqual(await run(session, await plan(session.client.planUpdate('tile-update'))), { action: 'update', id: 'fixture-tile', version: '1.1.0', enabled: false });
  });

  test(`${name}: update of a Gauge that is not installed is refused`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planUpdate('tile-folder'), { ok: false, code: 'UNKNOWN_GAUGE' });
  });

  test(`${name}: a user folder cannot replace a stock Gauge, by install or by update`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('clash-folder'), { ok: false, code: 'GAUGE_EXISTS' });
    assert.deepEqual(await client.planUpdate('clock-update-user'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
  });

  test(`${name}: only a stock Gauge can be protected, so a third-party Gauge is always one the person can remove`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('protected-user')));
    const user = await session.client.getGauge('fixture-tile');
    assert.ok(user.ok);
    assert.equal(user.value.protected, false);
    assert.equal((await session.client.planRemove('fixture-tile')).ok, true);
    await run(session, await plan(session.client.planRemove('fixture-tile')));
    await run(session, await plan(session.client.planInstall('protected-bundled')));
    const stock = await session.client.getGauge('fixture-tile');
    assert.ok(stock.ok);
    assert.equal(stock.value.protected, true);
    assert.deepEqual(await session.client.planRemove('fixture-tile'), { ok: false, code: 'GAUGE_PROTECTED' });
  });

  test(`${name}: install of an id that is already installed is refused`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    assert.deepEqual(await session.client.planInstall('tile-folder'), { ok: false, code: 'GAUGE_EXISTS' });
  });

  test(`${name}: a protected Gauge cannot be disabled or removed, and can be enabled and updated`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planDisable('fixture-manager'), { ok: false, code: 'GAUGE_PROTECTED' });
    assert.deepEqual(await client.planRemove('fixture-manager'), { ok: false, code: 'GAUGE_PROTECTED' });
    assert.equal((await client.planEnable('fixture-manager')).ok, true);
  });

  test(`${name}: enable, disable, and remove of a Gauge that is not installed are refused`, async () => {
    const { client } = await start();
    for (const id of ['no-such-gauge', '', '../escape']) {
      assert.deepEqual(await client.planEnable(id), { ok: false, code: 'UNKNOWN_GAUGE' }, id);
      assert.deepEqual(await client.planDisable(id), { ok: false, code: 'UNKNOWN_GAUGE' }, id);
      assert.deepEqual(await client.planRemove(id), { ok: false, code: 'UNKNOWN_GAUGE' }, id);
    }
  });

  test(`${name}: a plan that the state has moved past is refused when applied`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const stale = await plan(session.client.planEnable('fixture-tile'));
    const staleApproval = await session.approve(stale);
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    assert.deepEqual(await session.client.applyPlan(stale, staleApproval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    const second = await plan(session.client.planInstall('both-folder'));
    const secondApproval = await session.approve(second);
    await run(session, await plan(session.client.planInstall('both-folder')));
    assert.deepEqual(await session.client.applyPlan(second, secondApproval), { ok: false, code: 'GAUGE_EXISTS' });
  });

  test(`${name}: each of the five steps needs a plan and an approval`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const steps: [string, () => ReturnType<CoreClient['planInstall']>][] = [
      ['install', () => session.client.planInstall('both-folder')],
      ['enable', () => session.client.planEnable('fixture-tile')],
      ['disable', () => session.client.planDisable('fixture-clock')],
      ['update', () => session.client.planUpdate('tile-update')],
      ['remove', () => session.client.planRemove('fixture-preset')],
    ];
    for (const [action, makePlan] of steps) {
      const planned = await plan(makePlan());
      assert.equal(planned.action, action);
      const before = JSON.stringify([await session.client.listGauges(), await routes(session.client)]);
      assert.deepEqual(await session.client.applyPlan(planned), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, action);
      assert.equal(JSON.stringify([await session.client.listGauges(), await routes(session.client)]), before, `${action} changed state without approval`);
      assert.equal((await session.client.applyPlan(planned, await session.approve(planned))).ok, true, action);
      assert.notEqual(JSON.stringify([await session.client.listGauges(), await routes(session.client)]), before, `${action} changed nothing with approval`);
    }
  });

  test(`${name}: two cores do not share state`, async () => {
    const one = await start(), two = await start();
    await run(one, await plan(one.client.planInstall('tile-folder')));
    assert.equal((await ids(two.client)).includes('fixture-tile'), false);
  });

  test(`${name}: the Gauges the core held stay the same shape after a lifecycle`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const read = await session.client.getGauge('fixture-tile');
    assert.ok(read.ok);
    const expected: GaugeSummary = { id: 'fixture-tile', title: 'Fixture Tile', version: '1.0.0', kind: 'ui', origin: 'third-party', protected: false };
    assert.deepEqual(read.value, expected);
  });
}
