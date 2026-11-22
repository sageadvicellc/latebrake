import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_API_VERSION, MAX_MANIFEST_BYTES, validateManifest } from '../src/index.js';
import { INVALID_MANIFESTS, VALID_MANIFESTS, validManifest } from '../src/fixtures.js';

const refusal = (input: string | Uint8Array) => {
  const result = validateManifest(input);
  assert.equal(result.ok, false);
  return result.ok ? undefined : { code: result.code, reason: result.reason };
};
const withField = (field: string, value: unknown) => JSON.stringify({ ...JSON.parse(validManifest('tile-only')), [field]: value });
const without = (field: string) => { const object = JSON.parse(validManifest('tile-only')); delete object[field]; return JSON.stringify(object); };

test('each valid fixture passes', () => {
  for (const name of Object.keys(VALID_MANIFESTS)) {
    const result = validateManifest(VALID_MANIFESTS[name as keyof typeof VALID_MANIFESTS]);
    assert.equal(result.ok, true, name);
  }
});

test('a valid manifest comes back as a frozen, complete record with no origin', () => {
  const result = validateManifest(validManifest('tile-and-page'));
  assert.ok(result.ok);
  assert.deepEqual(result.manifest, {
    format: 'bowerloom/gauge/1', id: 'fixture-both', title: 'Fixture Both', version: '1.0.0', coreApi: '>=1.0.0 <2.0.0', kind: 'ui', protected: false,
    engines: ['fixture-engine'], tile: { expandable: true, resizable: true, entry: 'ui/tile.js' }, page: { entry: 'ui/page.js' },
    permissions: ['engines.read'], dependencies: [{ id: 'fixture-clock', range: '>=1.0.0' }],
  });
  assert.equal(Object.hasOwn(result.manifest, 'origin'), false);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.tile), true);
  assert.equal(Object.isFrozen(result.manifest.engines), true);
});

test('a Gauge says whether its tile is expandable, resizable, both, or neither', () => {
  const flags = (name: keyof typeof VALID_MANIFESTS) => {
    const result = validateManifest(VALID_MANIFESTS[name]);
    assert.ok(result.ok, name);
    return [result.manifest.tile?.expandable, result.manifest.tile?.resizable];
  };
  assert.deepEqual(flags('tile-and-page'), [true, true]);
  assert.deepEqual(flags('tile-only'), [false, true]);
  assert.deepEqual(flags('tile-neither'), [false, false]);
  assert.deepEqual(flags('tile-expandable-only'), [true, false]);
});

test('a Gauge may be a tile only, or a page only', () => {
  const tile = validateManifest(VALID_MANIFESTS['tile-only']), page = validateManifest(VALID_MANIFESTS['page-only']);
  assert.ok(tile.ok && page.ok);
  assert.equal(tile.manifest.page, null);
  assert.equal(page.manifest.tile, null);
});

// The expected code and reason of each invalid fixture, written out here and not read from the fixtures.
const EXPECTED_REFUSALS = {
  'duplicate-key': { code: 'GAUGE_MANIFEST_INVALID', reason: 'duplicate_key' },
  'comment': { code: 'GAUGE_MANIFEST_INVALID', reason: 'comment' },
  'trailing-comma': { code: 'GAUGE_MANIFEST_INVALID', reason: 'trailing_comma' },
  'unknown-field': { code: 'GAUGE_MANIFEST_INVALID', reason: 'unknown_field' },
  'secret-value': { code: 'GAUGE_SECRET_FOUND', reason: 'secret' },
  'link': { code: 'GAUGE_PATH_UNSAFE', reason: 'link' },
  'hidden-name': { code: 'GAUGE_PATH_UNSAFE', reason: 'hidden_name' },
  'dotdot-name': { code: 'GAUGE_PATH_UNSAFE', reason: 'dotdot_name' },
  'over-size': { code: 'GAUGE_MANIFEST_TOO_LARGE', reason: 'too_large' },
  'origin-set': { code: 'GAUGE_MANIFEST_INVALID', reason: 'origin_set_by_core' },
  'newer-api': { code: 'GAUGE_API_UNSUPPORTED', reason: 'api_unsupported' },
} as const;

test('the invalid fixtures are exactly the ones this suite expects', () => {
  assert.deepEqual(Object.keys(INVALID_MANIFESTS).sort(), Object.keys(EXPECTED_REFUSALS).sort());
});

test('each invalid fixture is refused with its own code and reason', () => {
  for (const [name, expected] of Object.entries(EXPECTED_REFUSALS)) {
    assert.deepEqual(refusal(INVALID_MANIFESTS[name as keyof typeof INVALID_MANIFESTS]), expected, name);
  }
});

test('the refusal of a secret never repeats the secret', () => {
  const result = validateManifest(INVALID_MANIFESTS['secret-value']);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('AKIA'), false);
});

test('a manifest cannot set origin, not even to a valid value', () => {
  for (const origin of ['stock', 'third-party', null, 3]) assert.deepEqual(refusal(withField('origin', origin)), { code: 'GAUGE_MANIFEST_INVALID', reason: 'origin_set_by_core' });
});

test('a manifest of exactly the size cap passes and one byte more is refused', () => {
  const base = validManifest('tile-only');
  const at = base + ' '.repeat(MAX_MANIFEST_BYTES - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(at), MAX_MANIFEST_BYTES);
  assert.equal(validateManifest(at).ok, true);
  assert.deepEqual(refusal(at + ' '), { code: 'GAUGE_MANIFEST_TOO_LARGE', reason: 'too_large' });
});

test('the size cap counts bytes, so a manifest of multi-byte characters is measured in bytes', () => {
  const base = validManifest('tile-only');
  const big = base + ' '.repeat(MAX_MANIFEST_BYTES - 30 - base.length - 60) + 'é'.repeat(60);
  assert.equal(big.length, MAX_MANIFEST_BYTES - 30);
  assert.equal(Buffer.byteLength(big), MAX_MANIFEST_BYTES + 30);
  assert.deepEqual(refusal(big), { code: 'GAUGE_MANIFEST_TOO_LARGE', reason: 'too_large' });
});

test('bytes that are not UTF-8 are refused, and a byte order mark is refused', () => {
  assert.deepEqual(refusal(Uint8Array.from([0x7b, 0xff, 0x7d])), { code: 'GAUGE_MANIFEST_INVALID', reason: 'not_utf8' });
  assert.deepEqual(refusal(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validManifest('tile-only'))])), { code: 'GAUGE_MANIFEST_INVALID', reason: 'syntax' });
});

test('a manifest given as bytes passes the same as one given as text', () => {
  assert.equal(validateManifest(Buffer.from(validManifest('page-only'))).ok, true);
});

test('a secret in an unknown field or in a key is still found, and a secret written with escapes is found too', () => {
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  assert.deepEqual(refusal(withField('extra', key)), { code: 'GAUGE_SECRET_FOUND', reason: 'secret' });
  assert.deepEqual(refusal(withField(key, 1)), { code: 'GAUGE_SECRET_FOUND', reason: 'secret' });
  const escaped = validManifest('tile-only').replace('"Fixture Tile"', ['"\\u0041', 'KIA', 'ABCDEFGHIJKLMNOP"'].join(''));
  assert.notEqual(escaped, validManifest('tile-only'));
  assert.deepEqual(refusal(escaped), { code: 'GAUGE_SECRET_FOUND', reason: 'secret' });
});

test('a manifest that is not an object is refused', () => {
  for (const text of ['[]', '"x"', '1', 'null', 'true']) assert.deepEqual(refusal(text), { code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' }, text);
});

test('a missing required field is refused, for each field', () => {
  for (const field of ['format', 'id', 'title', 'version', 'coreApi', 'kind', 'protected', 'engines', 'permissions', 'dependencies']) {
    assert.deepEqual(refusal(without(field)), { code: 'GAUGE_MANIFEST_INVALID', reason: 'missing_field' }, field);
  }
});

test('a wrong format is refused, and the format keeps the bowerloom prefix', () => {
  assert.deepEqual(refusal(withField('format', 'bowerloom/gauge/2')), { code: 'GAUGE_MANIFEST_INVALID', reason: 'unsupported_format' });
  assert.deepEqual(refusal(withField('format', 'latebrake/gauge/1')), { code: 'GAUGE_MANIFEST_INVALID', reason: 'unsupported_format' });
  assert.deepEqual(refusal(withField('format', 1)), { code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' });
});

test('a field of the wrong type or shape is refused', () => {
  const bad: [string, unknown][] = [
    ['id', 5], ['id', 'Fixture'], ['id', ''], ['id', 'a'.repeat(65)], ['id', 'a--b'], ['title', ''], ['title', ' x'], ['title', 'x'.repeat(81)], ['title', 'a\nb'], ['title', 3],
    ['version', '1.0'], ['version', 1], ['coreApi', 'latest'], ['coreApi', 1], ['kind', 'x'], ['protected', 'yes'], ['engines', 'a'], ['engines', ['A']], ['engines', ['a', 'a']],
    ['engines', Array.from({ length: 17 }, (_, i) => `e${i}`)], ['engines', [1]], ['permissions', 'x'], ['permissions', ['Engines']], ['permissions', ['engines.read', 'engines.read']],
    ['permissions', ['x'.repeat(70) + '.y']], ['permissions', Array.from({ length: 65 }, (_, i) => `a.p${i}`)], ['dependencies', {}], ['dependencies', ['x']], ['dependencies', [{ id: 'a' }]],
    ['dependencies', [{ id: 'a', range: 'x' }]], ['dependencies', [{ id: 'a', range: '>=1.0.0', extra: 1 }]], ['dependencies', [{ id: 'fixture-tile', range: '>=1.0.0' }]],
    ['dependencies', [{ id: 'a', range: '>=1.0.0' }, { id: 'a', range: '>=1.0.0' }]], ['dependencies', Array.from({ length: 33 }, (_, i) => ({ id: `d${i}`, range: '>=1.0.0' }))],
    ['tile', 5], ['tile', []], ['tile', { expandable: 'x', resizable: true, entry: 'a.js' }], ['tile', { expandable: false, resizable: true }], ['tile', { expandable: false, entry: 'a.js' }],
    ['tile', { expandable: false, resizable: true, entry: 'a.js', size: 3 }], ['tile', { expandable: false, resizable: true, entry: 5 }],
    ['page', 5], ['page', {}], ['page', { entry: 'a.js', extra: 1 }], ['page', { entry: 5 }],
  ];
  for (const [field, value] of bad) assert.equal(refusal(withField(field, value))?.code, 'GAUGE_MANIFEST_INVALID', `${field} ${JSON.stringify(value)}`);
});

test('a tile that is expandable needs a page to open', () => {
  const text = withField('tile', { expandable: true, resizable: true, entry: 'ui/tile.js' });
  assert.deepEqual(refusal(text), { code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' });
});

test('a UI Gauge has a tile or a page, and a data Gauge holds no code', () => {
  const bare = JSON.parse(validManifest('tile-only'));
  delete bare.tile;
  assert.deepEqual(refusal(JSON.stringify(bare)), { code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' });
  const data = JSON.parse(validManifest('data-preset'));
  assert.equal(refusal(JSON.stringify({ ...data, page: { entry: 'ui/page.js' } }))?.reason, 'invalid_field');
  assert.equal(refusal(JSON.stringify({ ...data, tile: { expandable: false, resizable: true, entry: 'ui/tile.js' } }))?.reason, 'invalid_field');
  assert.equal(refusal(JSON.stringify({ ...data, tile: null }))?.reason, 'invalid_field');
  delete data.tile;
  assert.equal(validateManifest(JSON.stringify(data)).ok, true);
});

test('the process and adapter kinds are not built, so a manifest of those kinds is refused', () => {
  for (const kind of ['process', 'adapter']) assert.deepEqual(refusal(withField('kind', kind)), { code: 'GAUGE_MANIFEST_INVALID', reason: 'unsupported_kind' });
});

test('a path in a tile or page entry is checked: link, hidden, dots, and absolute', () => {
  const entry = (value: string) => refusal(withField('tile', { expandable: false, resizable: true, entry: value }));
  assert.deepEqual(entry('https://example.test/a.js'), { code: 'GAUGE_PATH_UNSAFE', reason: 'link' });
  assert.deepEqual(entry('ui/.hidden.js'), { code: 'GAUGE_PATH_UNSAFE', reason: 'hidden_name' });
  assert.deepEqual(entry('ui/../a.js'), { code: 'GAUGE_PATH_UNSAFE', reason: 'dotdot_name' });
  assert.deepEqual(entry('/etc/a.js'), { code: 'GAUGE_PATH_UNSAFE', reason: 'absolute_path' });
  assert.deepEqual(entry('ui//a.js'), { code: 'GAUGE_MANIFEST_INVALID', reason: 'invalid_field' });
  const page = refusal(JSON.stringify({ ...JSON.parse(validManifest('page-only')), page: { entry: '../a.js' } }));
  assert.deepEqual(page, { code: 'GAUGE_PATH_UNSAFE', reason: 'dotdot_name' });
});

test('a Gauge id is checked as a name: hidden, dots, and link', () => {
  assert.deepEqual(refusal(withField('id', '.hidden')), { code: 'GAUGE_PATH_UNSAFE', reason: 'hidden_name' });
  assert.deepEqual(refusal(withField('id', 'a..b')), { code: 'GAUGE_PATH_UNSAFE', reason: 'dotdot_name' });
  assert.deepEqual(refusal(withField('id', 'https://example.test')), { code: 'GAUGE_PATH_UNSAFE', reason: 'link' });
});

test('a Gauge that needs a newer Core API version is refused at load', () => {
  assert.deepEqual(refusal(withField('coreApi', '>=99.0.0')), { code: 'GAUGE_API_UNSUPPORTED', reason: 'api_unsupported' });
  assert.deepEqual(refusal(withField('coreApi', '>=1.0.0 <1.0.0')), { code: 'GAUGE_API_UNSUPPORTED', reason: 'api_unsupported' });
  assert.deepEqual(refusal(withField('coreApi', '<1.0.0')), { code: 'GAUGE_API_UNSUPPORTED', reason: 'api_unsupported' });
});

test('a Gauge that accepts the current Core API version is not refused', () => {
  assert.equal(CORE_API_VERSION, '1.0.0');
  for (const range of ['=1.0.0', '>=0.1.0', '>=1.0.0 <2.0.0', '<=1.0.0']) assert.equal(validateManifest(withField('coreApi', range)).ok, true, range);
});

test('hostile text never throws', () => {
  for (const text of ['', '\u0000', '{"__proto__":{"x":1}}', '{"id":"\ud800"}', '\u{1F4A5}', '{'.repeat(50_000)]) assert.doesNotThrow(() => validateManifest(text));
});
