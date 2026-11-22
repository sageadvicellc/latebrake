import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, PERMISSION_NAMES, isPermission, isTracesPermission, permissionOf, GRANT_REASONS, isGrantReason, validateManifest } from '../src/index.js';
import { validManifest } from '../src/fixtures.js';

// The list, written out here so a change to it fails a test on purpose: a permission name is a promise to Gauge authors.
const EXPECTED: readonly (readonly [string, string, string, boolean])[] = [
  ['engines.read', 'read', 'engine', false],
  ['usage.read', 'read', 'engine', false],
  ['models.read', 'read', 'engine', false],
  ['sessions.read', 'read', 'engine', false],
  ['sessions.stream', 'read', 'engine', false],
  ['sessions.start', 'act', 'engine', false],
  ['sessions.stop', 'act', 'engine', false],
  ['sessions.attach', 'act', 'engine', false],
  ['sessions.send', 'act', 'engine', false],
  ['layout.propose', 'write', 'none', false],
  ['jobs.read', 'read', 'none', false],
  ['jobs.write', 'write', 'none', false],
  ['jobs.run', 'act', 'none', false],
  ['traces.facts', 'read', 'engine', true],
  ['traces.text', 'read', 'engine', true],
];

test('the permission list holds exactly these names, with their kind, scope, and traces flag, in this order', () => {
  assert.deepEqual(PERMISSIONS.map(p => [p.name, p.kind, p.scope, p.traces]), EXPECTED);
  assert.deepEqual([...PERMISSION_NAMES], EXPECTED.map(row => row[0]));
});

test('the list and each entry are frozen', () => {
  assert.equal(Object.isFrozen(PERMISSIONS), true);
  assert.equal(Object.isFrozen(PERMISSION_NAMES), true);
  for (const permission of PERMISSIONS) assert.equal(Object.isFrozen(permission), true, permission.name);
});

test('each permission has a one-line meaning that ends in a full stop', () => {
  for (const { name, meaning } of PERMISSIONS) {
    assert.match(meaning, /^[^\n\r\u2028\u2029]{10,140}\.$/u, name);
  }
});

test('each write or act permission says that it asks for a plan and never skips it, and no read permission mentions a plan', () => {
  for (const { name, kind, meaning } of PERMISSIONS) {
    if (kind === 'read') assert.equal(/plan/i.test(meaning), false, name);
    else assert.match(meaning, /^Ask for a plan to [^.]+\. The Gauge never skips the plan\.$/, name);
  }
});

test('each name is two or more dotted lower-case words, once', () => {
  assert.equal(new Set(PERMISSION_NAMES).size, PERMISSION_NAMES.length);
  for (const name of PERMISSION_NAMES) assert.match(name, /^[a-z]+(?:\.[a-z]+)+$/, name);
});

test('the only permissions that read traces are the facts and the text, and both are flagged as traces', () => {
  assert.deepEqual(PERMISSIONS.filter(p => p.traces).map(p => p.name), ['traces.facts', 'traces.text']);
  assert.deepEqual(PERMISSIONS.filter(p => p.name.startsWith('traces.')).map(p => p.traces), [true, true]);
});

test('no permission lets a Gauge react for the person', () => {
  for (const name of PERMISSION_NAMES) assert.equal(/react|reaction/.test(name), false, name);
});

test('isPermission accepts a listed name only, and never a prototype key or a near miss', () => {
  for (const name of PERMISSION_NAMES) assert.equal(isPermission(name), true, name);
  for (const value of ['engines', 'Engines.read', 'engines.read ', 'engines.write', 'traces', '__proto__', 'constructor', 'toString', '', undefined, null, 5, {}, ['engines.read']]) {
    assert.equal(isPermission(value), false, String(value));
  }
});

test('permissionOf gives the entry of a name, and undefined for anything else', () => {
  assert.equal(permissionOf('traces.text')?.traces, true);
  assert.equal(permissionOf('sessions.send')?.kind, 'act');
  assert.equal(permissionOf('nothing.here'), undefined);
  assert.equal(permissionOf('constructor'), undefined);
});

test('isTracesPermission is true for the two traces permissions only', () => {
  assert.deepEqual(PERMISSION_NAMES.filter(isTracesPermission), ['traces.facts', 'traces.text']);
  assert.equal(isTracesPermission('nothing.here'), false);
  assert.equal(isTracesPermission(undefined), false);
});

test('the grant reasons are a closed set of lower-case words, once each', () => {
  assert.deepEqual([...GRANT_REASONS], ['unknown_permission', 'not_declared', 'engine_not_listed', 'gauge_disabled', 'not_held', 'invalid_request']);
  for (const reason of GRANT_REASONS) assert.equal(isGrantReason(reason), true, reason);
  for (const value of ['syntax', 'toString', '', undefined, null, 5]) assert.equal(isGrantReason(value), false, String(value));
});

const withPermissions = (permissions: unknown) => JSON.stringify({ ...JSON.parse(validManifest('tile-only')), permissions });

test('a manifest that declares only listed permissions passes', () => {
  for (const permissions of [[], ['engines.read'], ['traces.facts', 'traces.text'], [...PERMISSION_NAMES]]) {
    assert.equal(validateManifest(withPermissions(permissions)).ok, true, permissions.join(','));
  }
});

test('a manifest that declares a permission outside the list is refused with the reason unknown_permission', () => {
  for (const permissions of [['engines.write'], ['engines.read', 'traces.all'], ['a.b'], ['traces.text', 'nothing.here']]) {
    assert.deepEqual(validateManifest(withPermissions(permissions)), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'unknown_permission' }, permissions.join(','));
  }
});

test('a permission with a wrong shape is still invalid_field, and the shape check comes before the list check', () => {
  for (const permissions of [['Engines.read'], ['engines'], ['engines.read', 'engines.read'], [5]]) {
    assert.deepEqual(validateManifest(withPermissions(permissions)), { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' }, JSON.stringify(permissions));
  }
});
