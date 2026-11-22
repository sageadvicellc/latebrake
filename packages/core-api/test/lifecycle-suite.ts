// The lifecycle suite: install, enable, disable, update, and remove, each through a plan and an approval. Like the client suite, it takes the core
// as a parameter. `makeHarness` gives a fresh core that holds the given Gauge folders, and a way to approve a plan. In the app the person approves
// with a click that no Gauge can make, so a harness supplies that step. A Gauge never approves a plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { GaugeFolder } from '../src/fake-core.js';
import type { Core, GaugePlan, GaugeSummary } from '../src/types.js';
import { INVALID_MANIFESTS, validManifest } from '../../gauge-manifest/src/fixtures.js';

export type { GaugeFolder };

export interface LifecycleHarness {
  readonly core: Core;
  /** The person approves one plan, the one they saw. Gives back the approval. */
  approve(plan: GaugePlan): string | Promise<string>;
  /** Replaces the folder with the same name, as if its files changed on disk. A harness for a real core writes the files. */
  replaceFolder(folder: GaugeFolder): void | Promise<void>;
  /** Moves the clock of the core forward, in milliseconds. */
  advance(milliseconds: number): void | Promise<void>;
}

/** How long an approval lasts. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

const tile = validManifest('tile-only');
const asManager = (text: string, version: string, isProtected: boolean) =>
  text.replace('fixture-tile', 'fixture-manager').replace('"version":"1.0.0"', `"version":"${version}"`).replace('"protected":false', `"protected":${isProtected}`);
const protectedTile = tile.replace('"protected":false', '"protected":true');
const FILE = 'export default 1;';
const asClock = (text: string, version: string) => text.replace('fixture-tile', 'fixture-clock').replace('"version":"1.0.0"', `"version":"${version}"`);

/** The folders the suite loads. Written out here, so a wrong core fails the suite. */
export const SUITE_FOLDERS: readonly GaugeFolder[] = [
  { name: 'tile-folder', location: 'user', manifest: tile },
  { name: 'both-folder', location: 'bundled', manifest: validManifest('tile-and-page') },
  { name: 'clash-folder', location: 'user', manifest: asClock(tile, '1.0.0') },
  { name: 'clock-update-bundled', location: 'bundled', manifest: asClock(tile, '1.3.0') },
  { name: 'clock-update-user', location: 'user', manifest: asClock(tile, '1.3.0') },
  { name: 'tile-update', location: 'user', manifest: tile.replace('"version":"1.0.0"', '"version":"1.1.0"') },
  { name: 'clock-same', location: 'bundled', manifest: asClock(tile, '1.2.0') },
  { name: 'clock-older', location: 'bundled', manifest: asClock(tile, '1.1.0') },
  { name: 'manager-lower', location: 'bundled', manifest: asManager(tile, '2.0.0', false) },
  { name: 'manager-raise', location: 'bundled', manifest: asManager(tile, '1.1.0', true) },
  { name: 'both-clash', location: 'user', manifest: validManifest('tile-and-page') },
  { name: 'astral-folder', location: 'user', manifest: tile.replace('fixture-tile', 'fixture-astral'), files: { '\u{1F600}.js': FILE, '\uFF21.js': FILE, 'ui/a.js': FILE } },
  { name: 'files-folder', location: 'user', manifest: tile.replace('fixture-tile', 'fixture-files'), files: { 'ui/tile.js': FILE } },
  ...Object.entries(INVALID_MANIFESTS).map(([name, manifest]): GaugeFolder => ({ name: `bad-${name}`, location: 'user', manifest })),
  { name: 'protected-user', location: 'user', manifest: protectedTile },
  { name: 'protected-bundled', location: 'bundled', manifest: protectedTile.replace('fixture-tile', 'fixture-guard') },
  { name: 'link-folder', location: 'user', manifest: tile, isLink: true },
];

/** The refusal each invalid fixture gets at load, written out here and not read from the fixtures. The reason is checked for the four that share one invalid code and for the three path codes. */
const EXPECTED: Readonly<Record<string, { code: string; reason?: string }>> = {
  'duplicate-key': { code: 'GAUGE_MANIFEST_INVALID', reason: 'duplicate_key' },
  'comment': { code: 'GAUGE_MANIFEST_INVALID', reason: 'comment' },
  'trailing-comma': { code: 'GAUGE_MANIFEST_INVALID', reason: 'trailing_comma' },
  'unknown-field': { code: 'GAUGE_MANIFEST_INVALID', reason: 'unknown_field' },
  'secret-value': { code: 'GAUGE_SECRET_FOUND' },
  'link': { code: 'GAUGE_PATH_UNSAFE', reason: 'link' },
  'hidden-name': { code: 'GAUGE_PATH_UNSAFE', reason: 'hidden_name' },
  'dotdot-name': { code: 'GAUGE_PATH_UNSAFE', reason: 'dotdot_name' },
  'over-size': { code: 'GAUGE_MANIFEST_TOO_LARGE' },
  'origin-set': { code: 'GAUGE_MANIFEST_INVALID' },
  'newer-api': { code: 'GAUGE_API_UNSUPPORTED' },
};

const sha256 = (...parts: (string | Uint8Array)[]) => { const hash = createHash('sha256'); for (const part of parts) hash.update(part); return hash.digest('hex'); };
/** The folder hash rule, written out here: files in order of the UTF-8 bytes of the name, and for each `<name byte length>:<name><size>:` then the bytes. The manifest is `gauge.json`. */
const folderHashOf = (manifest: string, files: Record<string, string> = {}) => {
  const all = Object.entries({ ...files, 'gauge.json': manifest }).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(...all.flatMap(([name, content]) => [`${Buffer.byteLength(name)}:${name}${Buffer.byteLength(content)}:`, content]));
};
/** One folder of the suite, by name. A name the suite does not hold fails the test. */
const folderNamed = (name: string): GaugeFolder => {
  const folder = SUITE_FOLDERS.find(candidate => candidate.name === name);
  assert.ok(folder, name);
  return folder;
};

const PLAN_KEYS = ['action', 'digest', 'folder', 'folderHash', 'from', 'id', 'manifestHash', 'nonce', 'origin', 'steps', 'to'];

/** Registers the lifecycle tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runLifecycleSuite(name: string, makeHarness: (folders: readonly GaugeFolder[]) => LifecycleHarness | Promise<LifecycleHarness>): void {
  const start = async () => {
    const harness = await makeHarness(SUITE_FOLDERS);
    return { client: createCoreClient(harness.core), approve: async (plan: GaugePlan) => harness.approve(plan), harness };
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

  test(`${name}: the same request gives the same plan twice, with a new nonce each time`, async () => {
    const { client } = await start();
    const one = await plan(client.planInstall('tile-folder')), two = await plan(client.planInstall('tile-folder'));
    assert.deepEqual({ ...one, nonce: '' }, { ...two, nonce: '' });
    assert.match(one.nonce, /^[0-9a-f]{64}$/);
    assert.notEqual(one.nonce, two.nonce);
  });

  test(`${name}: the core sets the origin from where it found the folder`, async () => {
    const session = await start();
    const user = await plan(session.client.planInstall('tile-folder'));
    assert.equal(user.origin, 'third-party');
    await run(session, user);
    const bundled = await plan(session.client.planInstall('both-folder'));
    assert.equal(bundled.origin, 'stock');
    await run(session, bundled);
    const one = await session.client.getGauge('fixture-tile'), two = await session.client.getGauge('fixture-both');
    assert.ok(one.ok && two.ok);
    assert.equal(one.value.origin, 'third-party');
    assert.equal(two.value.origin, 'stock');
  });

  test(`${name}: a manifest that sets its own origin is refused at load`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planInstall('bad-origin-set'), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'origin_set_by_core' });
  });

  test(`${name}: each invalid manifest is refused at load with its own code, and nothing is installed`, async () => {
    const { client } = await start();
    const before = await ids(client);
    for (const [fixture, expected] of Object.entries(EXPECTED)) {
      const refused = await client.planInstall(`bad-${fixture}`);
      assert.ok(!refused.ok, fixture);
      assert.equal(refused.code, expected.code, fixture);
      if (expected.reason !== undefined) assert.equal(refused.reason, expected.reason, fixture);
    }
    assert.deepEqual(await ids(client), before);
  });

  test(`${name}: a Gauge that needs a newer Core API version is refused at load, also for an update`, async () => {
    const { client } = await start();
    const refused = [await client.planInstall('bad-newer-api'), await client.planUpdate('bad-newer-api')];
    for (const result of refused) assert.deepEqual({ ...result }, { ok: false, code: 'GAUGE_API_UNSUPPORTED', reason: 'api_unsupported' });
  });

  test(`${name}: a folder that is a link, or has a hidden name or a name with two dots, is refused`, async () => {
    const { client } = await start();
    for (const folder of ['link-folder', '.hidden', 'a..b', '..', 'https://example.test/x', 'CON']) {
      const refused = await client.planInstall(folder);
      assert.ok(!refused.ok, folder);
      assert.equal(refused.code, 'GAUGE_PATH_UNSAFE', folder);
    }
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
    for (const changed of [{ ...planned, to: '9.9.9' }, { ...planned, steps: [...planned.steps, 'extra step'] }, { ...planned, origin: 'stock' as const }, { ...planned, id: 'fixture-clock' }, { ...planned, manifestHash: 'e'.repeat(64) }, { ...planned, folderHash: 'e'.repeat(64) }, { ...planned, manifestHash: null }, { ...planned, nonce: 'f'.repeat(64) }]) {
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
    assert.deepEqual(await client.planInstall('clash-folder'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
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
    const stock = await session.client.getGauge('fixture-guard');
    assert.ok(stock.ok);
    assert.equal(stock.value.protected, true);
    assert.deepEqual(await session.client.planRemove('fixture-guard'), { ok: false, code: 'GAUGE_PROTECTED' });
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

  test(`${name}: an approval that was given before the state changed is refused after`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const stale = await plan(session.client.planEnable('fixture-tile'));
    const staleApproval = await session.approve(stale);
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    assert.deepEqual(await session.client.applyPlan(stale, staleApproval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    const second = await plan(session.client.planInstall('both-folder'));
    const secondApproval = await session.approve(second);
    await run(session, await plan(session.client.planInstall('both-folder')));
    assert.deepEqual(await session.client.applyPlan(second, secondApproval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  });

  test(`${name}: an old approval does not apply again after the state returns to what it was`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const enable = await plan(session.client.planEnable('fixture-tile'));
    const approval = await session.approve(enable);
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    await run(session, await plan(session.client.planDisable('fixture-tile')));
    assert.deepEqual(await session.client.applyPlan(enable, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), false);
    // The same, when the old approval was already used once.
    const again = await plan(session.client.planEnable('fixture-tile'));
    const used = await session.approve(again);
    assert.equal((await session.client.applyPlan(again, used)).ok, true);
    await run(session, await plan(session.client.planDisable('fixture-tile')));
    assert.deepEqual(await session.client.applyPlan(again, used), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
  });

  test(`${name}: an approval of one plan does not apply a second plan of the same request`, async () => {
    const session = await start();
    const one = await plan(session.client.planInstall('tile-folder')), two = await plan(session.client.planInstall('tile-folder'));
    assert.equal(one.digest, two.digest);
    assert.deepEqual(await session.client.applyPlan(two, await session.approve(one)), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.equal((await ids(session.client)).includes('fixture-tile'), false);
  });

  test(`${name}: an approval lasts 15 minutes and then is refused`, async () => {
    const session = await start();
    const first = await plan(session.client.planInstall('tile-folder'));
    const firstApproval = await session.approve(first);
    await session.harness.advance(APPROVAL_TTL_MS - 1);
    assert.equal((await session.client.applyPlan(first, firstApproval)).ok, true, 'one millisecond before the end');
    const second = await plan(session.client.planInstall('both-folder'));
    const secondApproval = await session.approve(second);
    await session.harness.advance(APPROVAL_TTL_MS);
    assert.deepEqual(await session.client.applyPlan(second, secondApproval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await ids(session.client)).includes('fixture-both'), false);
  });

  test(`${name}: the plan shows what the person grants: permissions, kind, and what the tile can do`, async () => {
    const { client } = await start();
    const both = await plan(client.planInstall('both-folder')), plain = await plan(client.planInstall('tile-folder'));
    for (const line of ['permissions: engines.read', 'kind: ui', 'tile: expandable and resizable', 'page: yes']) assert.ok(both.steps.includes(line), line);
    for (const line of ['permissions: none', 'kind: ui', 'tile: resizable', 'page: no']) assert.ok(plain.steps.includes(line), line);
  });

  test(`${name}: the plan carries the hash of the manifest and the hash of the whole folder`, async () => {
    const { client } = await start();
    const planned = await plan(client.planInstall('files-folder'));
    const manifest = folderNamed('files-folder').manifest as string;
    assert.equal(planned.manifestHash, sha256(manifest));
    assert.equal(planned.folderHash, folderHashOf(manifest, { 'ui/tile.js': FILE }));
    assert.notEqual(planned.manifestHash, planned.folderHash);
    const bare = await plan(client.planInstall('tile-folder'));
    assert.notEqual(bare.folderHash, planned.folderHash);
  });

  test(`${name}: a Gauge that changes after approval is refused when applied`, async () => {
    const original = folderNamed('files-folder');
    const manifest = original.manifest as string;
    const changes: [string, GaugeFolder][] = [
      ['the manifest', { ...original, manifest: manifest.replace('"permissions":[]', '"permissions":["engines.read"]') }],
      ['the title', { ...original, manifest: manifest.replace('Fixture Tile', 'Fixture Other') }],
      ['a file that is not the manifest', { ...original, files: { 'ui/tile.js': `${FILE} // changed` } }],
      ['an added file', { ...original, files: { 'ui/tile.js': FILE, 'ui/extra.js': FILE } }],
      ['the manifest, to one that is not valid', { ...original, manifest: `${manifest.slice(0, -1)},}` }],
    ];
    for (const [what, replacement] of changes) {
      const session = await start();
      const planned = await plan(session.client.planInstall('files-folder'));
      const approval = await session.approve(planned);
      await session.harness.replaceFolder(replacement);
      assert.deepEqual(await session.client.applyPlan(planned, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' }, what);
      assert.equal((await ids(session.client)).includes('fixture-files'), false, what);
      await session.harness.replaceFolder(original);
      assert.equal((await session.client.applyPlan(planned, approval)).ok, true, `${what}: the same files apply again`);
    }
  });

  test(`${name}: the folder hash sorts the file names by their UTF-8 bytes, not by UTF-16 units`, async () => {
    const { client } = await start();
    const astral = folderNamed('astral-folder');
    const planned = await plan(client.planInstall('astral-folder'));
    assert.equal(planned.folderHash, folderHashOf(astral.manifest as string, { '\u{1F600}.js': FILE, '\uFF21.js': FILE, 'ui/a.js': FILE }));
    // The two orders differ for these names, so the test would fail if the core sorted by UTF-16 units.
    assert.ok('\u{1F600}.js' < '\uFF21.js');
    assert.ok(Buffer.compare(Buffer.from('\u{1F600}.js'), Buffer.from('\uFF21.js')) > 0);
  });

  test(`${name}: a folder name that could forge a line of the plan is refused, for install and for update`, async () => {
    const session = await start();
    const names = ['tile\nlines: permissions: none', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u200Bb', 'a/b', 'a\\b', '/abs/path', '/'];
    for (const folderName of names) {
      await session.harness.replaceFolder({ name: folderName, location: 'user', manifest: tile });
      for (const refused of [await session.client.planInstall(folderName), await session.client.planUpdate(folderName)]) {
        assert.deepEqual({ ...refused }, { ok: false, code: 'GAUGE_PATH_UNSAFE', reason: 'unsafe_folder_name' }, JSON.stringify(folderName));
      }
    }
    assert.deepEqual(await ids(session.client), ['fixture-manager', 'fixture-clock', 'fixture-preset']);
  });

  test(`${name}: no step of a plan holds a line break`, async () => {
    const { client } = await start();
    for (const folder of ['tile-folder', 'both-folder', 'files-folder']) {
      const planned = await plan(client.planInstall(folder));
      for (const step of planned.steps) assert.equal(/[\n\r\u2028\u2029]/.test(step), false, step);
    }
  });

  test(`${name}: a plan that was applied cannot be approved again after the state returns to what it was`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const first = await plan(session.client.planEnable('fixture-tile'));
    await run(session, first);
    await run(session, await plan(session.client.planDisable('fixture-tile')));
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    await run(session, await plan(session.client.planDisable('fixture-tile')));
    // The state is the one the first plan was made for. Approving that plan now is refused, or the approval does not apply it.
    let approval: string | undefined;
    try { approval = await session.approve(first); } catch { approval = undefined; }
    if (approval !== undefined) assert.deepEqual(await session.client.applyPlan(first, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), false);
  });

  test(`${name}: a plan that was made before the state changed cannot be approved after the state returns`, async () => {
    const session = await start();
    await run(session, await plan(session.client.planInstall('tile-folder')));
    const early = await plan(session.client.planEnable('fixture-tile'));
    await run(session, await plan(session.client.planEnable('fixture-tile')));
    await run(session, await plan(session.client.planDisable('fixture-tile')));
    let approval: string | undefined;
    try { approval = await session.approve(early); } catch { approval = undefined; }
    if (approval !== undefined) assert.deepEqual(await session.client.applyPlan(early, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await routes(session.client)).includes('/gauges/fixture-tile'), false);
  });

  test(`${name}: an update cannot lower protection, and cannot change the origin`, async () => {
    const session = await start();
    assert.deepEqual(await session.client.planUpdate('manager-lower'), { ok: false, code: 'GAUGE_PROTECTED' });
    const raised = await plan(session.client.planUpdate('manager-raise'));
    assert.deepEqual(await run(session, raised), { action: 'update', id: 'fixture-manager', version: '1.1.0', enabled: true });
    const manager = await session.client.getGauge('fixture-manager');
    assert.ok(manager.ok);
    assert.equal(manager.value.protected, true);
    await run(session, await plan(session.client.planInstall('tile-folder')));
    await session.harness.replaceFolder({ name: 'tile-update-bundled', location: 'bundled', manifest: tile.replace('"version":"1.0.0"', '"version":"1.1.0"') });
    assert.deepEqual(await session.client.planUpdate('tile-update-bundled'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
  });

  test(`${name}: an update to the same or an older version is refused`, async () => {
    const { client } = await start();
    assert.deepEqual(await client.planUpdate('clock-same'), { ok: false, code: 'GAUGE_VERSION_NOT_NEWER' });
    assert.deepEqual(await client.planUpdate('clock-older'), { ok: false, code: 'GAUGE_VERSION_NOT_NEWER' });
    assert.equal((await client.planUpdate('clock-update-bundled')).ok, true);
  });

  test(`${name}: an id of a stock Gauge stays reserved for ever, also after the stock Gauge is removed`, async () => {
    const session = await start();
    assert.deepEqual(await session.client.planInstall('both-clash'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
    await run(session, await plan(session.client.planRemove('fixture-clock')));
    assert.deepEqual(await session.client.getGauge('fixture-clock'), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await session.client.planInstall('clash-folder'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
    assert.deepEqual(await session.client.planUpdate('clock-update-user'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
    await run(session, await plan(session.client.planInstall('both-folder')));
    await run(session, await plan(session.client.planRemove('fixture-both')));
    assert.deepEqual(await session.client.planInstall('both-clash'), { ok: false, code: 'GAUGE_NAME_RESERVED' });
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
