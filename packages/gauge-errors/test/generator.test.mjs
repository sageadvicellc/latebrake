// The generator of the old-literal fixture, run against small throwaway git repositories made under the system temporary folder.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCANNED_EXTENSIONS, buildFixture, literalsAt, parseArgs, run, USAGE } from '../tools/existing-literals.mjs';

const TOOL = new URL('../tools/existing-literals.mjs', import.meta.url).pathname;
const roots = [];
after(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const tempDir = prefix => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(dir); return dir; };
const put = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
/** A repository with one commit of mixed files. Returns its folder and the hash of its first commit. */
function makeRepo() {
  const root = tempDir('gauge-errors-repo-');
  git(root, 'init', '-q');
  put(root, 'src/a.ts', `export const X = 'ALPHA_CODE';\n`);
  put(root, 'tools/b.py', `raise = "BETA_CODE"\n`);
  put(root, 'cfg/c.toml', `kind = "GAMMA_CODE"\n`);
  put(root, 'e.rs', `enum E { DELTA_CODE, }\n`);
  put(root, 'f.sh', `echo EPSILON_CODE\n`);
  put(root, 'g.yml', `code: ZETA_CODE\n`);
  put(root, 'h.json', `{"code": "ETA_CODE"}\n`);
  put(root, 'package-lock.json', `{"x": "LOCK_ONLY"}\n`);
  put(root, 'README.md', `DOC_ONLY\n`);
  put(root, 'node_modules/x/y.js', `'NM_ONLY'\n`);
  put(root, 'packages/gauge-errors/src/self.ts', `'SELF_CODE'\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  return { root, first: git(root, 'rev-parse', 'HEAD') };
}
const capture = () => { const text = { out: '', err: '' }; return { text, io: { out: s => { text.out += s; }, err: s => { text.err += s; } } }; };

// The fixture file lives outside the repository, so that committing the repository never adds it to the scan.
const writeFixture = (root, first) => {
  const fixturePath = path.join(tempDir('gauge-errors-fixture-'), 'fixture.json');
  run(['--write', '--commit', first], { cwd: root, fixturePath, ...capture().io });
  return { fixturePath, saved: JSON.parse(fs.readFileSync(fixturePath, 'utf8')) };
};

const ALL = ['ALPHA_CODE', 'BETA_CODE', 'DELTA_CODE', 'EPSILON_CODE', 'ETA_CODE', 'GAMMA_CODE', 'ZETA_CODE'];

test('a scan lists the literals of scanned files only, sorted, and counts the files', () => {
  const { root, first } = makeRepo();
  const scan = buildFixture(first, root);
  assert.deepEqual(scan.literals, [...ALL].sort());
  assert.equal(scan.filesScanned, 7);
  assert.equal(scan.commit, first);
  assert.equal(typeof scan.rule, 'string');
  assert.deepEqual(Object.keys(scan), ['commit', 'rule', 'extensions', 'filesScanned', 'literals']);
  assert.deepEqual(scan.extensions, [...SCANNED_EXTENSIONS]);
});

test('the scan does not read lockfiles, markdown, dependency folders, or the registry package, so a re-pin cannot make the registry collide with itself', () => {
  const { root, first } = makeRepo();
  const { literals } = buildFixture(first, root);
  for (const hidden of ['LOCK_ONLY', 'DOC_ONLY', 'NM_ONLY', 'SELF_CODE']) assert.equal(literals.includes(hidden), false, hidden);
});

test('a scan is pinned to its commit, and a later change does not show', () => {
  const { root, first } = makeRepo();
  put(root, 'src/later.ts', `'LATER_CODE'\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'second');
  assert.equal(buildFixture(first, root).literals.includes('LATER_CODE'), false);
  assert.equal(buildFixture('HEAD', root).literals.includes('LATER_CODE'), true);
  assert.deepEqual(literalsAt(first, root).literals, buildFixture(first, root).literals);
});

test('a scan run from a subfolder reads the whole repository', () => {
  const { root, first } = makeRepo();
  const sub = path.join(root, 'cfg');
  assert.deepEqual(buildFixture(first, sub).literals, [...ALL].sort());
});

test('a scan refuses a tree entry that is not a plain file, and names it', () => {
  const { root } = makeRepo();
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendored.ts`);
  git(root, 'commit', '-q', '-m', 'gitlink');
  assert.throws(() => buildFixture('HEAD', root), /vendored\.ts/);
});

test('a scan that finds no file to read fails and never gives an empty list', () => {
  const root = tempDir('gauge-errors-empty-');
  git(root, 'init', '-q');
  put(root, 'README.md', 'nothing to scan\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'docs only');
  assert.throws(() => buildFixture('HEAD', root), /no files/i);
});

test('a revision that does not exist fails', () => {
  const { root } = makeRepo();
  assert.throws(() => buildFixture('no-such-rev', root));
});

test('the arguments are read strictly', () => {
  assert.deepEqual(parseArgs(['--check']), { ok: true, mode: 'check', commit: undefined });
  assert.deepEqual(parseArgs(['--write', '--commit', 'abc']), { ok: true, mode: 'write', commit: 'abc' });
  assert.deepEqual(parseArgs(['--commit', 'abc', '--print']), { ok: true, mode: 'print', commit: 'abc' });
  for (const bad of [[], ['--chek'], ['--check=1'], ['--check', 'extra'], ['--check', '--write'], ['--check', '--check'], ['--commit'], ['--commit', '--write'], ['--write', '--commit', 'a', '--commit', 'b'], ['--commit', 'abc'], ['-c'], ['write']]) {
    const parsed = parseArgs(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.equal(typeof parsed.error, 'string', JSON.stringify(bad));
  }
});

test('a bad call prints the usage and exits 2', () => {
  const { root } = makeRepo();
  for (const argv of [['--chek'], [], ['--check', '--write'], ['--check=1'], ['--check', 'extra']]) {
    const { text, io } = capture();
    assert.equal(run(argv, { cwd: root, fixturePath: path.join(root, 'fixture.json'), ...io }), 2, JSON.stringify(argv));
    assert.ok(text.err.includes(USAGE), JSON.stringify(argv));
    assert.equal(fs.existsSync(path.join(root, 'fixture.json')), false, 'a bad call writes nothing');
  }
});

test('write makes the fixture, check exits 0 on a match, and both print the file count and the kinds read', () => {
  const { root, first } = makeRepo();
  const fixturePath = path.join(root, 'fixture.json');
  const sub = path.join(root, 'cfg');
  const wrote = capture();
  assert.equal(run(['--write', '--commit', first], { cwd: sub, fixturePath, ...wrote.io }), 0);
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.deepEqual(saved.literals, [...ALL].sort());
  assert.equal(saved.filesScanned, 7);
  assert.equal(saved.commit, first);
  assert.match(wrote.text.err, /7 files/);
  assert.match(wrote.text.err, /\bts\b.*\bpy\b|\bpy\b.*\bts\b/);
  const checked = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...checked.io }), 0);
  assert.match(checked.text.err, /reproduces/);
  assert.match(checked.text.err, /pinned commit/);
  assert.match(checked.text.err, /7 files/);
});

test('check exits 1 when the fixture differs, and lists the added and removed literals with counts', () => {
  const { root, first } = makeRepo();
  const fixturePath = path.join(root, 'fixture.json');
  run(['--write', '--commit', first], { cwd: root, fixturePath, ...capture().io });
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  saved.literals = saved.literals.filter(l => l !== 'ALPHA_CODE').concat('STALE_CODE').sort();
  fs.writeFileSync(fixturePath, JSON.stringify(saved));
  const { text, io } = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /1 added/);
  assert.match(text.err, /1 removed/);
  assert.match(text.err, /\+ ALPHA_CODE/);
  assert.match(text.err, /- STALE_CODE/);
});

test('the list of differences is capped at 50 each, and the count stays whole', () => {
  const { root, first } = makeRepo();
  const fixturePath = path.join(root, 'fixture.json');
  run(['--write', '--commit', first], { cwd: root, fixturePath, ...capture().io });
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const extra = Array.from({ length: 60 }, (_, i) => `EXTRA_${String(i).padStart(2, '0')}`);
  saved.literals = [...saved.literals.filter(l => !l.startsWith('A') && !l.startsWith('B')), ...extra].sort();
  fs.writeFileSync(fixturePath, JSON.stringify(saved));
  const { text, io } = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /2 added/);
  assert.match(text.err, /60 removed/);
  assert.equal(text.err.split('\n').filter(line => line.startsWith('- ')).length, 50);
  assert.match(text.err, /10 more/);
});

test('check on a newer commit with the same literals exits 0 and says the commit moved', () => {
  const { root, first } = makeRepo();
  const { fixturePath } = writeFixture(root, first);
  put(root, 'docs-only.md', 'more words\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'docs');
  const { text, io } = capture();
  assert.equal(run(['--check', '--commit', 'HEAD'], { cwd: root, fixturePath, ...io }), 0);
  assert.match(text.err, /newer|differs from the pinned|pinned commit/i);
  assert.doesNotMatch(text.err, /re-?pin/i, 'a newer commit never suggests moving the pin');
});

test('check exits 1 when only the stored count of files differs, and names the field', () => {
  const { root, first } = makeRepo();
  const { fixturePath, saved } = writeFixture(root, first);
  fs.writeFileSync(fixturePath, JSON.stringify({ ...saved, filesScanned: saved.filesScanned + 1 }));
  const { text, io } = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /filesScanned/);
  assert.match(text.err, /0 added, 0 removed/);
});

test('check exits 1 when only the stored rule differs, and names the field', () => {
  const { root, first } = makeRepo();
  const { fixturePath, saved } = writeFixture(root, first);
  fs.writeFileSync(fixturePath, JSON.stringify({ ...saved, rule: 'an older rule' }));
  const { text, io } = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /\brule\b/);
});

test('check exits 1 when only the stored list of file kinds differs, and names the field', () => {
  const { root, first } = makeRepo();
  const { fixturePath, saved } = writeFixture(root, first);
  fs.writeFileSync(fixturePath, JSON.stringify({ ...saved, extensions: saved.extensions.filter(ext => ext !== 'py') }));
  const { text, io } = capture();
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /extensions/);
});

test('a newer commit is compared on the rule, the kinds, and the literals, and the count of files may differ', () => {
  const { root, first } = makeRepo();
  const { fixturePath } = writeFixture(root, first);
  put(root, 'src/more.ts', `const note = 'quiet';\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'one more file, no new literal');
  const { text, io } = capture();
  assert.equal(run(['--check', '--commit', 'HEAD'], { cwd: root, fixturePath, ...io }), 0);
  assert.doesNotMatch(text.err, /re-?pin/i);
});

test('the guard compares against the pinned baseline: a literal added after the pin is not in it', () => {
  const { root, first } = makeRepo();
  const { fixturePath, saved } = writeFixture(root, first);
  put(root, 'src/later.ts', `'LATER_CODE'\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a later literal');
  assert.equal(saved.literals.includes('LATER_CODE'), false);
  const { text, io } = capture();
  assert.equal(run(['--check', '--commit', 'HEAD'], { cwd: root, fixturePath, ...io }), 1);
  assert.match(text.err, /\+ LATER_CODE/);
  assert.doesNotMatch(text.err, /re-?pin/i);
  assert.equal(run(['--check'], { cwd: root, fixturePath, ...capture().io }), 0, 'checked from its own pinned commit, the fixture still reproduces');
});

test('a failure to read the fixture or the repository exits 3', () => {
  const { root } = makeRepo();
  assert.equal(run(['--check'], { cwd: root, fixturePath: path.join(root, 'missing.json'), ...capture().io }), 3);
  const outside = tempDir('gauge-errors-norepo-');
  assert.equal(run(['--print', '--commit', 'HEAD'], { cwd: outside, fixturePath: path.join(outside, 'x.json'), ...capture().io }), 3);
});

test('the command line, started in a subfolder, prints the whole list and never an empty one', () => {
  const { root, first } = makeRepo();
  const sub = path.join(root, 'cfg');
  const result = spawnSync(process.execPath, [TOOL, '--print', '--commit', first], { cwd: sub, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).literals, [...ALL].sort());
});

test('the command line exits 2 on an unknown flag', () => {
  const result = spawnSync(process.execPath, [TOOL, '--chek'], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(USAGE));
});
