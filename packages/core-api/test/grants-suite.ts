// The grants suite: permissions, grants, the audit file, and engine scope, all through the client. Like the client suite and the lifecycle suite, it takes the core
// as a parameter, so the same suite runs against the fake core now and against the real core later. `makeHarness` gives a fresh core that holds the given
// Gauge folders and a way to approve a plan. In the app the person approves with a click that no Gauge can make, so a harness supplies that step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoreClient, type CoreClient } from '../src/client.js';
import type { AuditRead, Core, GaugePlan } from '../src/types.js';
import type { GaugeFolder } from '../src/fake-core.js';
import { validManifest } from '../../gauge-manifest/src/fixtures.js';
import { APPROVAL_TTL_MS } from './lifecycle-suite.js';

export interface GrantsHarness {
  readonly core: Core;
  /** The person approves one plan, the one they saw. Works for a lifecycle plan and for a grant plan. Gives back the approval. */
  approve(plan: { readonly nonce: string }): string | Promise<string>;
  /** Moves the clock of the core forward, in milliseconds. */
  advance(milliseconds: number): void | Promise<void>;
}
export interface GrantsHarnessOptions {
  /** The size cap of the audit file, in bytes. The suite asks for the smallest cap the contract allows, so that a few dozen records fill it. */
  readonly auditMaxBytes?: number;
}

/**
 * The smallest size cap of the audit file that a core must accept: 15 records of the longest line (398 bytes), because the largest single step grants or ends all 15 permissions at once.
 * Written out here as a number, and not read from the core, so a wrong cap fails the suite.
 */
export const MIN_AUDIT_MAX_BYTES = 5970;

const FILE = 'export default 1;';
const base = JSON.parse(validManifest('tile-only')) as Record<string, unknown>;
const manifestOf = (fields: Record<string, unknown>): string => JSON.stringify({ ...base, ...fields });
/** Every permission of the list, written out here. */
const ALL_PERMISSIONS = [
  'engines.read', 'usage.read', 'models.read', 'sessions.read', 'sessions.stream', 'sessions.start', 'sessions.stop', 'sessions.attach', 'sessions.send',
  'layout.propose', 'jobs.read', 'jobs.write', 'jobs.run', 'traces.facts', 'traces.text',
];
const TRACED_PERMISSIONS = ['engines.read', 'sessions.start', 'layout.propose', 'traces.facts', 'traces.text'];
const traced = (version: string, title: string, permissions: readonly string[] = TRACED_PERMISSIONS): string =>
  manifestOf({ id: 'fixture-traced', title, version, engines: ['fixture-engine', 'fixture-other'], permissions });

/** The folders the suite loads. Written out here, so a wrong core fails the suite. */
export const GRANT_FOLDERS: readonly GaugeFolder[] = [
  { name: 'traced-folder', location: 'user', manifest: traced('1.0.0', 'Fixture Traced'), files: { 'ui/tile.js': FILE } },
  { name: 'traced-update', location: 'user', manifest: traced('1.1.0', 'Fixture Traced Two'), files: { 'ui/tile.js': FILE } },
  { name: 'traced-narrow', location: 'user', manifest: traced('1.2.0', 'Fixture Traced Two', ['engines.read']), files: { 'ui/tile.js': FILE } },
  { name: 'solo-folder', location: 'user', manifest: manifestOf({ id: 'fixture-solo', title: 'Fixture Solo', engines: ['fixture-engine'], permissions: ['engines.read', 'usage.read'] }) },
  { name: 'all-folder', location: 'user', manifest: manifestOf({ id: 'fixture-all', title: 'Fixture All', engines: ['fixture-engine'], permissions: ALL_PERMISSIONS }) },
  { name: 'bare-folder', location: 'user', manifest: manifestOf({ id: 'fixture-bare', title: 'Fixture Bare', engines: [], permissions: ['engines.read', 'layout.propose'] }) },
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const GRANT_KEYS = ['action', 'digest', 'folderHash', 'id', 'manifestHash', 'nonce', 'permissions', 'steps', 'version'];
const MISSING = { ok: false, code: 'GAUGE_GRANT_MISSING' } as const;
const missing = (reason: string) => ({ ok: false, code: 'GAUGE_GRANT_MISSING', reason });

/** Registers the grants tests. `makeHarness` gives a fresh core for each test, so no test depends on another. */
export function runGrantsSuite(name: string, makeHarness: (folders: readonly GaugeFolder[], options: GrantsHarnessOptions) => GrantsHarness | Promise<GrantsHarness>): void {
  const start = async (options: GrantsHarnessOptions = {}) => {
    const harness = await makeHarness(GRANT_FOLDERS, options);
    return { harness, core: harness.core, client: createCoreClient(harness.core) };
  };
  type Session = Awaited<ReturnType<typeof start>>;

  const must = <T>(result: { ok: true; value: T } | { ok: false; code: string; reason?: string }): T => {
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  /** Plans, approves, and applies one lifecycle step. */
  const step = async (s: Session, planned: Promise<{ ok: true; value: GaugePlan } | { ok: false; code: string }>) => {
    const value = must(await planned);
    must(await s.client.applyPlan(value, await s.harness.approve(value)));
    return value;
  };
  const bring = async (s: Session, folder: string, id: string, enable = true) => {
    const install = await step(s, s.client.planInstall(folder));
    if (enable) await step(s, s.client.planEnable(id));
    return install;
  };
  const grant = async (s: Session, id: string, permissions: readonly string[]) => {
    const plan = must(await s.client.planGrant(id, permissions));
    return must(await s.client.applyGrant(plan, await s.harness.approve(plan)));
  };
  const outcome = (result: { ok: boolean; code?: string; reason?: string }) => (result.ok ? { ok: true } : result.reason === undefined ? { ok: false, code: result.code } : { ok: false, code: result.code, reason: result.reason });
  const auditRead = async (client: CoreClient): Promise<AuditRead> => must(await client.readAudit());
  const audit = async (client: CoreClient) => (await auditRead(client)).entries;
  const withoutTime = (entries: readonly { at: string }[]) => entries.map(({ at, ...rest }) => { assert.match(at, TIME); return rest; });

  test(`${name}: makeHarness gives a distinct core on each call`, async () => {
    const one = await start(), two = await start();
    assert.notEqual(one.core, two.core);
  });

  // The grant plan

  test(`${name}: a grant plan names the permissions, shows each meaning, and carries the hashes of the install, and it changes nothing`, async () => {
    const s = await start();
    const install = await bring(s, 'traced-folder', 'fixture-traced');
    const plan = must(await s.client.planGrant('fixture-traced', ['sessions.start', 'engines.read']));
    assert.deepEqual(Object.keys(plan).sort(), GRANT_KEYS);
    assert.deepEqual({ action: plan.action, id: plan.id, version: plan.version, permissions: plan.permissions }, { action: 'grant', id: 'fixture-traced', version: '1.0.0', permissions: ['engines.read', 'sessions.start'] });
    assert.equal(plan.manifestHash, sha256(traced('1.0.0', 'Fixture Traced')));
    assert.equal(plan.manifestHash, install.manifestHash);
    assert.equal(plan.folderHash, install.folderHash);
    assert.notEqual(plan.folderHash, plan.manifestHash);
    assert.match(plan.digest, HEX);
    assert.match(plan.nonce, HEX);
    for (const line of [
      'permission engines.read (read): Read the state of the engines the Gauge lists.',
      'permission sessions.start (act): Ask for a plan to start a session on an engine the Gauge lists. The Gauge never skips the plan.',
      'engines: fixture-engine, fixture-other',
    ]) assert.ok(plan.steps.includes(line), line);
    for (const line of plan.steps) assert.equal(/[\n\r\u2028\u2029]/.test(line), false, line);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine')), MISSING);
  });

  test(`${name}: a plain grant plan reads exactly like this`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const plan = must(await s.client.planGrant('fixture-solo', ['usage.read', 'engines.read']));
    assert.deepEqual(plan.steps, [
      'grant 2 permissions to fixture-solo 1.0.0',
      'permission engines.read (read): Read the state of the engines the Gauge lists.',
      'permission usage.read (read): Read the usage figures of the engines the Gauge lists.',
      'engines: fixture-engine',
      'bind the grant to manifest 98be40e5c42f11b50a63f270324e3a32d32bb700ba84cd2cab5c5a838c205a86 and folder f81312d87c751ef78e7c64be4b9018f6de33a1b8f1bf1482cdf33d8e44aa34ea',
    ]);
    assert.equal(plan.manifestHash, '98be40e5c42f11b50a63f270324e3a32d32bb700ba84cd2cab5c5a838c205a86');
    assert.equal(plan.folderHash, 'f81312d87c751ef78e7c64be4b9018f6de33a1b8f1bf1482cdf33d8e44aa34ea');
  });

  test(`${name}: a traces grant plan reads exactly like this, with the notice line`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    const plan = must(await s.client.planGrant('fixture-traced', ['traces.text', 'traces.facts']));
    assert.deepEqual(plan.steps, [
      'grant 2 permissions to fixture-traced 1.0.0',
      'permission traces.facts (read): Read the recorded facts of traces from the engines the Gauge lists. Denied until the person grants it.',
      'permission traces.text (read): Read the prompt and reply text of traces, together with traces.facts. Denied until the person grants it.',
      'engines: fixture-engine, fixture-other',
      'traces permissions start denied, are granted only here, and one revoke removes them all',
      'bind the grant to manifest 312b3c224780cca21d60bf603beee2478551e77a3e55e9ef19bc11f403f4d46a and folder 3040cfd9adb64ede2150a4e4d91210dc85eed94d1bb7c97c4d107eeedd15cc6a',
    ]);
  });

  test(`${name}: a manifest with a hostile id, title, or engine never reaches a plan, because the manifest rules refuse it at install`, async () => {
    const hostile = ['a\nb', 'a\u2028b', 'a\u0085b', `a${'x'.repeat(100)}`];
    const folders: GaugeFolder[] = hostile.flatMap((text, index): GaugeFolder[] => [
      { name: `hostile-id-${index}`, location: 'user', manifest: manifestOf({ id: text, title: 'Fixture Hostile' }) },
      { name: `hostile-title-${index}`, location: 'user', manifest: manifestOf({ id: 'fixture-hostile', title: text }) },
      { name: `hostile-engine-${index}`, location: 'user', manifest: manifestOf({ id: 'fixture-hostile', title: 'Fixture Hostile', engines: [text], permissions: ['engines.read'] }) },
    ]);
    const harness = await makeHarness(folders, {});
    const client = createCoreClient(harness.core);
    for (const folder of folders) {
      const planned = await client.planInstall(folder.name);
      assert.equal(planned.ok, false, folder.name);
    }
  });

  test(`${name}: a grant plan for a Gauge that lists no engine says so`, async () => {
    const s = await start();
    await bring(s, 'bare-folder', 'fixture-bare');
    const plan = must(await s.client.planGrant('fixture-bare', ['layout.propose']));
    assert.ok(plan.steps.includes('engines: none'));
    assert.ok(plan.steps.includes('permission layout.propose (write): Ask for a plan to add the Gauge to the layout. The Gauge never skips the plan.'));
  });

  test(`${name}: the same request gives the same grant plan twice, with a new nonce each time`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const one = must(await s.client.planGrant('fixture-solo', ['usage.read', 'engines.read'])), two = must(await s.client.planGrant('fixture-solo', ['engines.read', 'usage.read']));
    assert.deepEqual({ ...one, nonce: '' }, { ...two, nonce: '' });
    assert.notEqual(one.nonce, two.nonce);
  });

  test(`${name}: a grant plan for an installed Gauge that is disabled is allowed, so a person can review before enabling`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo', false);
    await grant(s, 'fixture-solo', ['engines.read']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), missing('gauge_disabled'));
  });

  test(`${name}: a grant plan is refused for a Gauge that is not installed, with UNKNOWN_GAUGE`, async () => {
    const s = await start();
    for (const id of ['no-such-gauge', 'fixture-traced', '', '../escape', '__proto__']) assert.deepEqual(await s.client.planGrant(id, ['engines.read']), { ok: false, code: 'UNKNOWN_GAUGE' }, id);
  });

  test(`${name}: a grant plan refuses a name outside the list, and a request of the wrong shape, and changes nothing`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    for (const permissions of [['engines.write'], ['engines.read', 'nothing.here'], ['__proto__'], ['constructor'], ['Engines.read'], ['engines.read\n'], ['engines.read '], [''], ['\u{1F4A5}'], ["x' OR '1'='1"]]) {
      assert.deepEqual(outcome(await s.client.planGrant('fixture-traced', permissions)), missing('unknown_permission'), JSON.stringify(permissions));
    }
    for (const permissions of [undefined, null, 'engines.read', [], [5], [null], [['engines.read']], ['engines.read', 'engines.read'], { 0: 'engines.read', length: 1 }, new Set(['engines.read'])]) {
      assert.deepEqual(await s.core.call('bowerloom.grants.plan', { id: 'fixture-traced', permissions }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'invalid_request' }, String(permissions));
    }
    assert.deepEqual(await s.core.call('bowerloom.grants.plan', { id: 'fixture-traced' }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'invalid_request' });
    assert.deepEqual(await s.core.call('bowerloom.grants.plan', { id: 5, permissions: ['engines.read'] }), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await s.core.call('bowerloom.grants.plan', { id: { toString: () => 'fixture-traced' }, permissions: ['engines.read'] }), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
    assert.deepEqual(await audit(s.client), []);
  });

  test(`${name}: a grant plan refuses a listed permission that the manifest does not declare`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    for (const permissions of [['jobs.run'], ['engines.read', 'sessions.start'], ['traces.facts']]) {
      assert.deepEqual(outcome(await s.client.planGrant('fixture-solo', permissions)), missing('not_declared'), permissions.join(','));
    }
    const stock = await s.client.planGrant('fixture-clock', ['engines.read']);
    assert.deepEqual(outcome(stock), missing('not_declared'));
  });

  // Approval

  test(`${name}: a grant needs the person's approval of this exact plan, and without one nothing is granted`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const plan = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    assert.deepEqual(await s.client.applyGrant(plan), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    for (const approval of ['approval-1', '0'.repeat(64), plan.nonce, plan.digest, '']) {
      assert.deepEqual(await s.client.applyGrant(plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' }, approval);
    }
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')), []);
    assert.deepEqual(await audit(s.client), []);
  });

  test(`${name}: an approval of one grant plan does not apply another, or a changed one`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const small = must(await s.client.planGrant('fixture-solo', ['engines.read'])), wide = must(await s.client.planGrant('fixture-solo', ['engines.read', 'usage.read']));
    const approval = await s.harness.approve(small);
    assert.deepEqual(await s.client.applyGrant(wide, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await s.client.applyGrant({ ...small, permissions: ['engines.read', 'usage.read'] }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await s.client.applyGrant({ ...small, steps: [...small.steps, 'permission jobs.run'] }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await s.client.applyGrant({ ...small, nonce: wide.nonce }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await s.client.applyGrant({ ...small, manifestHash: sha256('other') }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(await s.client.applyGrant({ ...small, folderHash: sha256('other') }, approval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')), []);
    must(await s.client.applyGrant(small, approval));
  });

  test(`${name}: the approval of a lifecycle plan cannot apply a grant`, async () => {
    const s = await start();
    const install = must(await s.client.planInstall('solo-folder'));
    must(await s.client.applyPlan(install, await s.harness.approve(install)));
    const enable = must(await s.client.planEnable('fixture-solo'));
    const lifecycleApproval = await s.harness.approve(enable);
    const plan = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    assert.deepEqual(await s.client.applyGrant(plan, lifecycleApproval), { ok: false, code: 'GAUGE_PLAN_CHANGED' });
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')), []);
  });

  test(`${name}: an approval of a grant works once`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const plan = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    const approval = await s.harness.approve(plan);
    must(await s.client.applyGrant(plan, approval));
    assert.deepEqual(await s.client.applyGrant(plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.equal((await audit(s.client)).length, 1);
  });

  test(`${name}: an approval of a grant lasts 15 minutes and no longer`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const late = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    const lateApproval = await s.harness.approve(late);
    await s.harness.advance(APPROVAL_TTL_MS);
    assert.deepEqual(await s.client.applyGrant(late, lateApproval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    const inTime = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    const approval = await s.harness.approve(inTime);
    await s.harness.advance(APPROVAL_TTL_MS - 1);
    must(await s.client.applyGrant(inTime, approval));
  });

  test(`${name}: a grant that was approved is not applied after the state moved on`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    const plan = must(await s.client.planGrant('fixture-traced', ['engines.read']));
    const approval = await s.harness.approve(plan);
    await step(s, s.client.planUpdate('traced-update'));
    assert.deepEqual(await s.client.applyGrant(plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
  });

  // The grant

  test(`${name}: an approved grant lets the Gauge call, and lists with the hashes it is bound to`, async () => {
    const s = await start();
    const install = await bring(s, 'traced-folder', 'fixture-traced');
    const applied = await grant(s, 'fixture-traced', ['sessions.start', 'engines.read']);
    assert.deepEqual(applied, { id: 'fixture-traced', permissions: ['engines.read', 'sessions.start'] });
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), [
      { permission: 'engines.read', manifestHash: install.manifestHash, folderHash: install.folderHash },
      { permission: 'sessions.start', manifestHash: install.manifestHash, folderHash: install.folderHash },
    ]);
    assert.deepEqual(must(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine')), { gauge: 'fixture-traced', permission: 'engines.read', engine: 'fixture-engine' });
    assert.deepEqual(must(await s.client.checkPermission('fixture-traced', 'sessions.start', 'fixture-other')), { gauge: 'fixture-traced', permission: 'sessions.start', engine: 'fixture-other' });
  });

  test(`${name}: a call without a grant is refused with GAUGE_GRANT_MISSING, for each permission the Gauge declares and has not been given`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['engines.read']);
    for (const permission of ['sessions.start', 'layout.propose', 'traces.facts', 'traces.text']) {
      assert.deepEqual(await s.client.checkPermission('fixture-traced', permission, ...(permission === 'layout.propose' ? [] : ['fixture-engine'])), MISSING, permission);
    }
  });

  test(`${name}: a call for a permission the manifest does not declare, or the list does not hold, is refused`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'jobs.run')), missing('not_declared'));
    for (const permission of ['nothing.here', '__proto__', 'constructor', '', 'engines.read\n']) {
      assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', permission, 'fixture-engine')), missing('unknown_permission'), JSON.stringify(permission));
    }
    for (const permission of [5, null, undefined, ['engines.read'], { toString: () => 'engines.read' }]) {
      assert.deepEqual(await s.core.call('bowerloom.permissions.check', { gauge: 'fixture-solo', permission, engine: 'fixture-engine' }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'unknown_permission' }, String(permission));
    }
  });

  test(`${name}: a call from a Gauge that is not installed is refused with UNKNOWN_GAUGE`, async () => {
    const s = await start();
    for (const gauge of ['no-such-gauge', '', '__proto__']) assert.deepEqual(await s.client.checkPermission(gauge, 'engines.read', 'fixture-engine'), { ok: false, code: 'UNKNOWN_GAUGE' }, gauge);
    for (const gauge of [5, null, undefined, ['fixture-clock'], { toString: () => 'fixture-clock' }]) {
      assert.deepEqual(await s.core.call('bowerloom.permissions.check', { gauge, permission: 'engines.read' }), { ok: false, code: 'UNKNOWN_GAUGE' }, String(gauge));
    }
    assert.deepEqual(await s.client.listGrants('no-such-gauge'), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await s.client.revoke('no-such-gauge', ['engines.read']), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await s.client.revokeTraces('no-such-gauge'), { ok: false, code: 'UNKNOWN_GAUGE' });
  });

  test(`${name}: a grant to one Gauge is not a grant to another`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-traced', ['engines.read']);
    assert.deepEqual(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine'), MISSING);
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')), []);
  });

  test(`${name}: a grant that is made again replaces the earlier one`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    await grant(s, 'fixture-solo', ['engines.read']);
    assert.equal(must(await s.client.listGrants('fixture-solo')).length, 1);
  });

  // The Gauge is disabled, updated, or removed

  test(`${name}: a disabled Gauge holds no active grant, and enabling it again brings the grant back`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    await step(s, s.client.planDisable('fixture-solo'));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), missing('gauge_disabled'));
    assert.equal(must(await s.client.listGrants('fixture-solo')).length, 1);
    await step(s, s.client.planEnable('fixture-solo'));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), { ok: true });
  });

  test(`${name}: a changed manifest asks again: an update drops every grant of the old version, and a new grant binds to the new hashes`, async () => {
    const s = await start();
    const first = await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['engines.read', 'layout.propose']);
    const update = await step(s, s.client.planUpdate('traced-update'));
    assert.notEqual(update.manifestHash, first.manifestHash);
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine'), MISSING);
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'layout.propose'), MISSING);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
    const plan = must(await s.client.planGrant('fixture-traced', ['engines.read']));
    assert.equal(plan.version, '1.1.0');
    assert.equal(plan.manifestHash, update.manifestHash);
    must(await s.client.applyGrant(plan, await s.harness.approve(plan)));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine')), { ok: true });
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'layout.propose'), MISSING);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), [{ permission: 'engines.read', manifestHash: update.manifestHash, folderHash: update.folderHash }]);
  });

  test(`${name}: an update ends each grant with a record: the old version, the old hashes, and the way update`, async () => {
    const s = await start();
    const first = await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['engines.read', 'layout.propose']);
    await step(s, s.client.planUpdate('traced-update'));
    const hashes = { manifestHash: first.manifestHash, folderHash: first.folderHash };
    const common = { id: 'fixture-traced', version: '1.0.0', ...hashes };
    assert.deepEqual(withoutTime(await audit(s.client)), [
      { seq: 1, action: 'grant', via: 'plan', permission: 'engines.read', ...common },
      { seq: 2, action: 'grant', via: 'plan', permission: 'layout.propose', ...common },
      { seq: 3, action: 'revoke', via: 'update', permission: 'engines.read', ...common },
      { seq: 4, action: 'revoke', via: 'update', permission: 'layout.propose', ...common },
    ]);
  });

  test(`${name}: a disabled Gauge clears its traces grants and keeps the others, and the traces grants must be made again in their own step`, async () => {
    const s = await start();
    const install = await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['traces.facts', 'traces.text']);
    await grant(s, 'fixture-traced', ['engines.read', 'layout.propose']);
    await step(s, s.client.planDisable('fixture-traced'));
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')).map(entry => entry.permission), ['engines.read', 'layout.propose']);
    const hashes = { manifestHash: install.manifestHash, folderHash: install.folderHash };
    const records = (await audit(s.client)).slice(4);
    assert.deepEqual(withoutTime(records), [
      { seq: 5, action: 'revoke', via: 'disable', permission: 'traces.facts', id: 'fixture-traced', version: '1.0.0', ...hashes },
      { seq: 6, action: 'revoke', via: 'disable', permission: 'traces.text', id: 'fixture-traced', version: '1.0.0', ...hashes },
    ]);
    await step(s, s.client.planEnable('fixture-traced'));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine')), { ok: true });
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'layout.propose')), { ok: true });
    for (const permission of ['traces.facts', 'traces.text']) assert.deepEqual(await s.client.checkPermission('fixture-traced', permission, 'fixture-engine'), MISSING, permission);
    assert.deepEqual(await s.client.planGrant('fixture-traced', ['traces.facts', 'engines.read']), { ok: false, code: 'GAUGE_TRACES_OWN_STEP' });
    await grant(s, 'fixture-traced', ['traces.facts']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine')), { ok: true });
  });

  test(`${name}: disabling a Gauge that holds no traces grant writes no record`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    await step(s, s.client.planDisable('fixture-solo'));
    assert.equal((await audit(s.client)).length, 1);
  });

  test(`${name}: an update that drops a permission leaves a Gauge that cannot use it, and the old grant for it is not usable`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['sessions.start']);
    await step(s, s.client.planUpdate('traced-narrow'));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'sessions.start', 'fixture-engine')), missing('not_declared'));
    assert.deepEqual(outcome(await s.client.planGrant('fixture-traced', ['sessions.start'])), missing('not_declared'));
  });

  test(`${name}: a removed Gauge keeps no grant, so the same Gauge installed again starts with none`, async () => {
    const s = await start();
    const install = await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read', 'usage.read']);
    await step(s, s.client.planRemove('fixture-solo'));
    assert.deepEqual(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine'), { ok: false, code: 'UNKNOWN_GAUGE' });
    assert.deepEqual(await s.client.listGrants('fixture-solo'), { ok: false, code: 'UNKNOWN_GAUGE' });
    const again = await bring(s, 'solo-folder', 'fixture-solo');
    assert.equal(again.manifestHash, install.manifestHash);
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')), []);
    assert.deepEqual(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine'), MISSING);
    assert.deepEqual(await s.client.checkPermission('fixture-solo', 'usage.read', 'fixture-engine'), MISSING);
  });

  // Engines

  test(`${name}: a Gauge that lists one engine reads that engine only`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read', 'usage.read']);
    assert.deepEqual(must(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')).engine, 'fixture-engine');
    for (const engine of ['fixture-other', 'Fixture-Engine', 'fixture-engine ', '', '__proto__', 'constructor', 'fixture-engine\n']) {
      assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'usage.read', engine)), missing('engine_not_listed'), JSON.stringify(engine));
    }
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'usage.read')), missing('engine_not_listed'));
    for (const engine of [5, null, ['fixture-engine'], { toString: () => 'fixture-engine' }]) {
      assert.deepEqual(await s.core.call('bowerloom.permissions.check', { gauge: 'fixture-solo', permission: 'usage.read', engine }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'engine_not_listed' }, String(engine));
    }
  });

  test(`${name}: a Gauge that lists two engines reads both and no third`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['engines.read']);
    for (const engine of ['fixture-engine', 'fixture-other']) assert.equal(must(await s.client.checkPermission('fixture-traced', 'engines.read', engine)).engine, engine);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-third')), missing('engine_not_listed'));
  });

  test(`${name}: a Gauge that lists no engine reads no engine, even with a grant`, async () => {
    const s = await start();
    await bring(s, 'bare-folder', 'fixture-bare');
    await grant(s, 'fixture-bare', ['engines.read', 'layout.propose']);
    for (const engine of ['fixture-engine', '', 'anything']) assert.deepEqual(outcome(await s.client.checkPermission('fixture-bare', 'engines.read', engine)), missing('engine_not_listed'), engine);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-bare', 'engines.read')), missing('engine_not_listed'));
  });

  test(`${name}: a permission that touches no engine needs no engine, and refuses one`, async () => {
    const s = await start();
    await bring(s, 'bare-folder', 'fixture-bare');
    await grant(s, 'fixture-bare', ['layout.propose']);
    assert.deepEqual(must(await s.client.checkPermission('fixture-bare', 'layout.propose')), { gauge: 'fixture-bare', permission: 'layout.propose', engine: null });
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-bare', 'layout.propose', 'fixture-engine')), missing('invalid_request'));
  });

  // Traces

  test(`${name}: traces permissions start denied, also after install, enable, and a grant of everything else`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    for (const permission of ['traces.facts', 'traces.text']) assert.deepEqual(await s.client.checkPermission('fixture-traced', permission, 'fixture-engine'), MISSING, permission);
    await grant(s, 'fixture-traced', ['engines.read', 'sessions.start', 'layout.propose']);
    for (const permission of ['traces.facts', 'traces.text']) assert.deepEqual(await s.client.checkPermission('fixture-traced', permission, 'fixture-engine'), MISSING, permission);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')).map(entry => entry.permission), ['engines.read', 'layout.propose', 'sessions.start']);
  });

  test(`${name}: traces permissions are granted in their own step, and a plan that mixes them with others is refused with GAUGE_TRACES_OWN_STEP`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    for (const permissions of [['traces.facts', 'engines.read'], ['traces.text', 'traces.facts', 'layout.propose'], ['sessions.start', 'traces.text']]) {
      assert.deepEqual(await s.client.planGrant('fixture-traced', permissions), { ok: false, code: 'GAUGE_TRACES_OWN_STEP' }, permissions.join(','));
    }
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
    const own = await grant(s, 'fixture-traced', ['traces.text', 'traces.facts']);
    assert.deepEqual(own, { id: 'fixture-traced', permissions: ['traces.facts', 'traces.text'] });
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine')), { ok: true });
    await grant(s, 'fixture-traced', ['engines.read']);
  });

  test(`${name}: a traces plan can grant the facts and leave the text denied`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['traces.facts']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine')), { ok: true });
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'traces.text', 'fixture-engine'), MISSING);
  });

  test(`${name}: the text of traces is allowed only while the facts are also held`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['traces.text']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.text', 'fixture-engine')), missing('facts_required'));
    await grant(s, 'fixture-traced', ['traces.facts']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.text', 'fixture-engine')), { ok: true });
    must(await s.client.revoke('fixture-traced', ['traces.facts']));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.text', 'fixture-engine')), missing('facts_required'));
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine'), MISSING);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')).map(entry => entry.permission), ['traces.text']);
  });

  test(`${name}: one action revokes every traces permission at once, and no other`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['traces.facts', 'traces.text']);
    await grant(s, 'fixture-traced', ['engines.read']);
    assert.deepEqual(must(await s.client.revokeTraces('fixture-traced')), { id: 'fixture-traced', revoked: ['traces.facts', 'traces.text'] });
    for (const permission of ['traces.facts', 'traces.text']) assert.deepEqual(await s.client.checkPermission('fixture-traced', permission, 'fixture-engine'), MISSING, permission);
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')).map(entry => entry.permission), ['engines.read']);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'engines.read', 'fixture-engine')), { ok: true });
    assert.deepEqual(must(await s.client.revokeTraces('fixture-traced')), { id: 'fixture-traced', revoked: [] });
  });

  test(`${name}: a revoked traces permission is denied again, and granting it again needs a new approval`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    const plan = must(await s.client.planGrant('fixture-traced', ['traces.facts']));
    const approval = await s.harness.approve(plan);
    must(await s.client.applyGrant(plan, approval));
    must(await s.client.revokeTraces('fixture-traced'));
    assert.deepEqual(await s.client.applyGrant(plan, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine'), MISSING);
  });

  // Revoke

  test(`${name}: a revoke takes effect at once, in one action, and leaves the other grants`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read', 'usage.read']);
    assert.deepEqual(must(await s.client.revoke('fixture-solo', ['usage.read'])), { id: 'fixture-solo', revoked: ['usage.read'] });
    assert.deepEqual(await s.client.checkPermission('fixture-solo', 'usage.read', 'fixture-engine'), MISSING);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), { ok: true });
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')).map(entry => entry.permission), ['engines.read']);
  });

  test(`${name}: a revoke of several permissions gives them back sorted`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read', 'usage.read']);
    assert.deepEqual(must(await s.client.revoke('fixture-solo', ['usage.read', 'engines.read'])), { id: 'fixture-solo', revoked: ['engines.read', 'usage.read'] });
  });

  test(`${name}: a revoke of a permission the Gauge does not hold is a no-op, and a repeated revoke is too`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    assert.deepEqual(must(await s.client.revoke('fixture-solo', ['engines.read', 'usage.read'])), { id: 'fixture-solo', revoked: ['engines.read'] });
    assert.equal((await audit(s.client)).length, 2);
    for (let again = 0; again < 3; again += 1) assert.deepEqual(must(await s.client.revoke('fixture-solo', ['engines.read', 'usage.read'])), { id: 'fixture-solo', revoked: [] });
    assert.deepEqual(must(await s.client.revoke('fixture-solo', ['usage.read'])), { id: 'fixture-solo', revoked: [] });
    assert.deepEqual(must(await s.client.revokeTraces('fixture-solo')), { id: 'fixture-solo', revoked: [] });
    assert.equal((await audit(s.client)).length, 2);
  });

  test(`${name}: a revoke refuses an unknown Gauge, an unknown name, and a request of the wrong shape, and then changes nothing`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    const before = await audit(s.client);
    assert.deepEqual(outcome(await s.client.revoke('fixture-solo', ['nothing.here'])), missing('unknown_permission'));
    assert.deepEqual(outcome(await s.client.revoke('fixture-solo', ['engines.read', '__proto__'])), missing('unknown_permission'));
    assert.deepEqual(outcome(await s.client.revoke('fixture-solo', [])), missing('invalid_request'));
    assert.deepEqual(outcome(await s.client.revoke('fixture-solo', ['engines.read', 'engines.read'])), missing('invalid_request'));
    assert.equal(must(await s.client.listGrants('fixture-solo')).length, 1);
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), { ok: true });
    assert.deepEqual(await audit(s.client), before);
  });

  test(`${name}: a revoke retires the pending grant plans and approvals of that Gauge, so an approved regrant cannot apply later`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-traced', ['traces.facts']);
    const regrant = must(await s.client.planGrant('fixture-traced', ['traces.text']));
    const approval = await s.harness.approve(regrant);
    const other = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    const otherApproval = await s.harness.approve(other);
    must(await s.client.revoke('fixture-traced', ['traces.facts']));
    assert.deepEqual(await s.client.applyGrant(regrant, approval), { ok: false, code: 'GAUGE_PLAN_NOT_APPROVED' });
    assert.deepEqual(must(await s.client.listGrants('fixture-traced')), []);
    assert.deepEqual(await s.client.checkPermission('fixture-traced', 'traces.text', 'fixture-engine'), MISSING);
    // The plan of another Gauge is not touched by that revoke.
    must(await s.client.applyGrant(other, otherApproval));
  });

  test(`${name}: a revoke that holds nothing does not retire any plan`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const plan = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    const approval = await s.harness.approve(plan);
    must(await s.client.revoke('fixture-solo', ['usage.read']));
    must(await s.client.applyGrant(plan, approval));
  });

  test(`${name}: a revoke call must name permissions or the traces group, and not both`, async () => {
    const s = await start();
    await bring(s, 'traced-folder', 'fixture-traced');
    await grant(s, 'fixture-traced', ['traces.facts']);
    const bad: Record<string, unknown>[] = [{}, { permissions: undefined }, { permissions: 'traces.facts' }, { group: 'other' }, { group: 'traces', permissions: ['traces.facts'] }, { group: 5 }, { permissions: [5] }, { permissions: null }];
    for (const extra of bad) assert.deepEqual(await s.core.call('bowerloom.grants.revoke', { id: 'fixture-traced', ...extra }), { ok: false, code: 'GAUGE_GRANT_MISSING', reason: 'invalid_request' }, JSON.stringify(extra));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-traced', 'traces.facts', 'fixture-engine')), { ok: true });
  });

  test(`${name}: a revoke works on a Gauge that is disabled`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read', 'usage.read']);
    await step(s, s.client.planDisable('fixture-solo'));
    assert.deepEqual(must(await s.client.revoke('fixture-solo', ['usage.read'])), { id: 'fixture-solo', revoked: ['usage.read'] });
    assert.deepEqual(must(await s.client.listGrants('fixture-solo')).map(entry => entry.permission), ['engines.read']);
  });

  // The audit file

  test(`${name}: every grant and every revoke is appended to the audit file, one record for each permission, in order`, async () => {
    const s = await start();
    const install = await bring(s, 'solo-folder', 'fixture-solo');
    assert.deepEqual(await audit(s.client), []);
    await grant(s, 'fixture-solo', ['usage.read', 'engines.read']);
    must(await s.client.revoke('fixture-solo', ['engines.read']));
    await grant(s, 'fixture-solo', ['engines.read']);
    await step(s, s.client.planRemove('fixture-solo'));
    const hashes = { manifestHash: install.manifestHash, folderHash: install.folderHash };
    const common = { id: 'fixture-solo', version: '1.0.0', ...hashes };
    assert.deepEqual(withoutTime(await audit(s.client)), [
      { seq: 1, action: 'grant', via: 'plan', permission: 'engines.read', ...common },
      { seq: 2, action: 'grant', via: 'plan', permission: 'usage.read', ...common },
      { seq: 3, action: 'revoke', via: 'revoke', permission: 'engines.read', ...common },
      { seq: 4, action: 'grant', via: 'plan', permission: 'engines.read', ...common },
      { seq: 5, action: 'revoke', via: 'remove', permission: 'engines.read', ...common },
      { seq: 6, action: 'revoke', via: 'remove', permission: 'usage.read', ...common },
    ]);
  });

  test(`${name}: a refused grant, or a revoke of nothing, adds no record`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    const plan = must(await s.client.planGrant('fixture-solo', ['engines.read']));
    await s.client.applyGrant(plan);
    await s.client.applyGrant(plan, 'nope');
    await s.client.revoke('fixture-solo', ['usage.read']);
    await s.client.planGrant('fixture-solo', ['jobs.run']);
    assert.deepEqual(await audit(s.client), []);
  });

  test(`${name}: the audit file has a size cap: it drops the oldest records, keeps the order and the numbers, says what was lost, and never refuses a revoke`, async () => {
    const s = await start({ auditMaxBytes: MIN_AUDIT_MAX_BYTES });
    await bring(s, 'solo-folder', 'fixture-solo');
    for (let round = 0; round < 20; round += 1) {
      await grant(s, 'fixture-solo', ['engines.read']);
      must(await s.client.revoke('fixture-solo', ['engines.read']));
    }
    await grant(s, 'fixture-solo', ['engines.read']);
    const read = await auditRead(s.client);
    // 41 records of 301 bytes and more were written. The cap of 5,970 bytes holds 19 of them.
    assert.equal(read.entries.length, 19);
    assert.equal(read.firstSeq, 23);
    assert.equal(read.droppedCount, 22);
    assert.equal(read.entries[18]?.seq, 41);
    assert.equal(read.auditFailed, false);
    assert.equal(read.entries.reduce((sum, entry) => sum + Buffer.byteLength(`${JSON.stringify(entry)}\n`), 0), 5746);
    read.entries.forEach((entry, index) => assert.equal(entry.seq, 23 + index));
    assert.deepEqual(outcome(await s.client.checkPermission('fixture-solo', 'engines.read', 'fixture-engine')), { ok: true });
    must(await s.client.revoke('fixture-solo', ['engines.read']));
    const after = await auditRead(s.client);
    assert.equal(after.entries.length, 19);
    assert.equal(after.firstSeq, 24);
    assert.equal(after.droppedCount, 23);
    assert.equal(after.entries[18]?.seq, 42);
    assert.equal(after.entries[18]?.action, 'revoke');
  });

  test(`${name}: at the smallest cap, a step that touches all 15 permissions keeps every one of its own records`, async () => {
    const s = await start({ auditMaxBytes: MIN_AUDIT_MAX_BYTES });
    await bring(s, 'all-folder', 'fixture-all');
    for (let round = 0; round < 10; round += 1) {
      await grant(s, 'fixture-all', ALL_PERMISSIONS.filter(permission => !permission.startsWith('traces.')));
      await grant(s, 'fixture-all', ['traces.facts', 'traces.text']);
      must(await s.client.revoke('fixture-all', ALL_PERMISSIONS));
    }
    await grant(s, 'fixture-all', ALL_PERMISSIONS.filter(permission => !permission.startsWith('traces.')));
    await grant(s, 'fixture-all', ['traces.facts', 'traces.text']);
    assert.equal(must(await s.client.listGrants('fixture-all')).length, 15);
    const grantStep = await audit(s.client);
    assert.deepEqual(grantStep.slice(-2).map(entry => [entry.via, entry.permission]), [['plan', 'traces.facts'], ['plan', 'traces.text']]);
    await step(s, s.client.planRemove('fixture-all'));
    const read = await auditRead(s.client);
    const removed = read.entries.filter(entry => entry.via === 'remove');
    assert.equal(removed.length, 15);
    assert.deepEqual(removed.map(entry => entry.permission), [...ALL_PERMISSIONS].sort());
    assert.deepEqual(removed.map(entry => entry.seq), Array.from({ length: 15 }, (_, index) => (removed[0]?.seq ?? 0) + index));
    // 10 rounds of 13 + 2 grants and 15 revokes, then 13 + 2 grants and the removal of 15: 330 records.
    assert.equal(read.entries[read.entries.length - 1]?.seq, 330);
    assert.equal(read.droppedCount, (read.firstSeq ?? 0) - 1);
    assert.ok(read.droppedCount > 0);
  });

  test(`${name}: a core that has written nothing reports an empty file with no first number, nothing dropped, and no failure`, async () => {
    const s = await start();
    assert.deepEqual(await auditRead(s.client), { entries: [], firstSeq: null, droppedCount: 0, auditFailed: false });
  });

  test(`${name}: the audit file holds no secret, no text a Gauge sent, and only the fields of the contract`, async () => {
    const s = await start();
    await bring(s, 'solo-folder', 'fixture-solo');
    await grant(s, 'fixture-solo', ['engines.read']);
    for (const entry of await audit(s.client)) {
      assert.deepEqual(Object.keys(entry), ['seq', 'at', 'action', 'via', 'id', 'version', 'permission', 'manifestHash', 'folderHash']);
      assert.match(entry.at, TIME);
    }
  });
}
