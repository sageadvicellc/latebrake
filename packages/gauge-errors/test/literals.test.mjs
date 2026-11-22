// The code literal scanner that builds the old-literal fixture. It is pure text work, so these tests need no git history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeLiterals, isScannedPath, CODE_SHAPE, SCANNED_EXTENSIONS } from '../tools/existing-literals.mjs';

const found = text => [...extractCodeLiterals(text)].sort();

test('a quoted string that is wholly a code is a literal, in any quote style', () => {
  assert.deepEqual(found(`const a = 'BUNDLE_USAGE'; const b = "FAILED"; const c = \`NOT_ALLOWED\`;`), ['BUNDLE_USAGE', 'FAILED', 'NOT_ALLOWED']);
});

test('an object key in code shape is a literal, quoted or not', () => {
  assert.deepEqual(found(`const t = { BUNDLE_FORMAT: 'x', 'ENOSPC': 'y', "TOO_MANY": 'z', OPTIONAL_ONE?: 1 };`), ['BUNDLE_FORMAT', 'ENOSPC', 'OPTIONAL_ONE', 'TOO_MANY']);
});

test('a code in a union type or a case label is a literal', () => {
  assert.deepEqual(found(`type C = 'ONE_CODE' | 'TWO_CODE'; switch (x) { case 'THREE_CODE': break; }`), ['ONE_CODE', 'THREE_CODE', 'TWO_CODE']);
});

test('an enum member, a destructured name, a shorthand member and a class static are literals', () => {
  assert.deepEqual(found(`enum E { FIRST_CODE, SECOND_CODE = 2 }`), ['FIRST_CODE', 'SECOND_CODE']);
  assert.deepEqual(found(`const { THIRD_CODE, FOURTH_CODE: renamed } = codes;`), ['FOURTH_CODE', 'THIRD_CODE']);
  assert.deepEqual(found(`const o = { FIFTH_CODE, SIXTH_CODE };`), ['FIFTH_CODE', 'SIXTH_CODE']);
  assert.deepEqual(found(`class C { static SEVENTH_CODE = 'x'; }`), ['SEVENTH_CODE']);
});

test('a code word inside a longer text is a literal, because the scan reads words and not only whole strings', () => {
  assert.deepEqual(found(`'Bad CODE here'; throw new Error('failed with REFUSED_CODE (see log)')`), ['CODE', 'REFUSED_CODE']);
});

test('a word that is not wholly capitals, digits and single underscores is not a literal', () => {
  assert.deepEqual(found(`'lowercase'; 'MIXED_case'; 'TRAILING_'; '_LEADING'; 'DOUBLE__GAP'; camelCASE; 0xABCD; ''`), []);
});

test('a single letter is not a literal', () => {
  assert.deepEqual(found(`const a = 'X'; const b = { N: 1 };`), []);
});

test('digits are allowed after the first letter of a word', () => {
  assert.deepEqual(found(`'V2_FORMAT'; 'ERR_HTTP2_BAD'`), ['ERR_HTTP2_BAD', 'V2_FORMAT']);
});

test('the same literal found twice is listed once', () => {
  assert.deepEqual(found(`'DUP_CODE'; { DUP_CODE: 1 }`), ['DUP_CODE']);
});

test('the words of other languages are read the same way', () => {
  assert.deepEqual(found(`raise Refused("PY_CODE")`), ['PY_CODE']);
  assert.deepEqual(found(`pub const RS_CODE: &str = "RS_VALUE";`), ['RS_CODE', 'RS_VALUE']);
  assert.deepEqual(found(`kind = "TOML_CODE"`), ['TOML_CODE']);
  assert.deepEqual(found(`code: YAML_CODE`), ['YAML_CODE']);
  assert.deepEqual(found(`exit_with SH_CODE`), ['SH_CODE']);
});

test('the code shape matches whole words in capitals, digits and underscores only', () => {
  for (const ok of ['AB', 'A_B', 'UNKNOWN_GAUGE', 'V2_X']) assert.match(ok, CODE_SHAPE, ok);
  for (const bad of ['', 'A', 'a_b', 'A_', '_A', 'A__B', 'A-B', 'A B', '2A']) assert.doesNotMatch(bad, CODE_SHAPE, JSON.stringify(bad));
});

test('the scanned file kinds are listed, sorted and without a dot', () => {
  assert.deepEqual([...SCANNED_EXTENSIONS], [...SCANNED_EXTENSIONS].sort());
  for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx', 'py', 'rs', 'toml', 'yml', 'yaml', 'sh', 'json']) assert.ok(SCANNED_EXTENSIONS.includes(ext), ext);
  assert.equal(SCANNED_EXTENSIONS.includes('md'), false);
});

test('source, script and data files are scanned', () => {
  for (const file of ['packages/a/src/x.ts', 'apps/desktop/renderer/y.tsx', 'tools/z.mjs', 'a/b.js', 'c.cjs', 'd.mts', 'e.cts', 'f.jsx', 'g.py', 'src-tauri/h.rs', 'Cargo.toml', '.github/ci.yml', 'k.yaml', 'scripts/l.sh', 'data/m.json']) assert.equal(isScannedPath(file), true, file);
});

test('markdown, binary files, lockfiles, dependency and build folders, and the registry package are not scanned', () => {
  for (const file of [
    'README.md', 'logo.svg', 'icon.png', 'package-lock.json', 'apps/desktop/package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock',
    'dist/a.js', 'node_modules/x/y.js', 'apps/desktop/node_modules/x.js', 'a/.git/b.js',
    'packages/gauge-errors/src/registry.ts', 'packages/gauge-errors/test/fixtures/existing-code-literals.json', 'packages/gauge-errors/tools/existing-literals.mjs',
  ]) assert.equal(isScannedPath(file), false, file);
  assert.equal(isScannedPath('packages/gauge-errors-other/src/a.ts'), true);
});
