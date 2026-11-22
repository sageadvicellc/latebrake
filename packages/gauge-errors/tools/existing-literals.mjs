#!/usr/bin/env node
// Builds the fixture of code literals that exist in the product at one pinned commit, so a new Gauge code can be checked against it.
//
// The rule. The repository writes a refusal code as a bare word in capitals and underscores, such as BUNDLE_USAGE, NOT_ALLOWED or FAILED. It writes the word in
// three places: as a quoted string (a `code:` value, a union member, a `case` label, an array item), as a key of a table of words (`BUNDLE_USAGE: 'The choices ...'`),
// and as a key of a type. So a code literal is:
//   1. a quoted string ('...', "..." or `...`) whose whole text is one code word, or
//   2. an object or type key that is one code word, quoted or not, followed by a colon.
// A code word is two or more characters: capitals and digits in words that start with a capital, joined by single underscores (CODE_SHAPE).
// The scan reads the source files of the commit (ts, tsx, mts, cts, js, mjs, cjs, jsx) outside node_modules, dist and .git. It reads tests too.
// The scan errs on the side of too many: it also keeps system error names such as ENOSPC, and any capital word in quotes. That is safe, because the fixture only
// forbids a new code from taking one of these names.
//
// Regenerate:  node packages/gauge-errors/tools/existing-literals.mjs --commit <rev> --write
// Check drift: node packages/gauge-errors/tools/existing-literals.mjs --check        (reads the commit from the fixture)
// Print only:  node packages/gauge-errors/tools/existing-literals.mjs --commit <rev>
// Run from the root of a clone that holds the commit.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORD = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
/** A code word, whole: capitals and digits, words joined by single underscores, at least two characters. */
export const CODE_SHAPE = new RegExp(`^(?=.{2,}$)${WORD}$`);

const QUOTED = new RegExp(`(['"\`])(${WORD})\\1`, 'g');
const QUOTED_KEY = new RegExp(`(['"])(${WORD})\\1\\s*\\??\\s*:(?!:)`, 'g');
const BARE_KEY = new RegExp(`(?<![\\w$.'"\`:])(${WORD})(?![\\w$])\\s*\\??\\s*:(?!:)`, 'g');

/** Returns the set of code literals in one text. */
export function extractCodeLiterals(text) {
  const found = new Set();
  const add = word => { if (CODE_SHAPE.test(word)) found.add(word); };
  for (const match of text.matchAll(QUOTED)) add(match[2]);
  for (const match of text.matchAll(QUOTED_KEY)) add(match[2]);
  for (const match of text.matchAll(BARE_KEY)) add(match[1]);
  return found;
}

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git']);

/** True when a repository path (slash separated) is a source file the scan reads. */
export function isScannedPath(file) {
  const parts = file.split('/');
  return SOURCE.test(file) && !parts.slice(0, -1).some(part => SKIPPED_FOLDERS.has(part));
}

const git = (args, options = {}) => {
  const result = spawnSync('git', args, { maxBuffer: 1 << 30, ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`);
  return result.stdout;
};

/** Resolves a revision to its full commit hash. */
export function resolveCommit(rev) {
  return String(git(['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

/** Reads every scanned file of a commit through one `git cat-file --batch` call, and returns the sorted list of literals. */
export function literalsAt(commit) {
  const files = String(git(['ls-tree', '-r', '--name-only', '-z', commit])).split('\0').filter(isScannedPath);
  const out = git(['cat-file', '--batch'], { input: files.map(file => `${commit}:${file}\n`).join('') });
  const literals = new Set();
  let at = 0;
  for (const file of files) {
    const end = out.indexOf(0x0a, at);
    const [, type, size] = out.subarray(at, end).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`${file} is not a blob at ${commit}`);
    const bodyStart = end + 1, bodyEnd = bodyStart + Number(size);
    for (const literal of extractCodeLiterals(out.subarray(bodyStart, bodyEnd).toString('utf8'))) literals.add(literal);
    at = bodyEnd + 1;
  }
  return [...literals].sort();
}

const RULE = 'A code literal is a quoted string, or an object or type key, that is one word of two or more characters in capitals, digits and single underscores. Source files only (ts, tsx, mts, cts, js, mjs, cjs, jsx), tests included, outside node_modules and dist. See packages/gauge-errors/tools/existing-literals.mjs.';

/** The fixture object for a commit. */
export function buildFixture(commit) {
  return { commit, rule: RULE, literals: literalsAt(commit) };
}

export const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'existing-code-literals.json');
const render = fixture => JSON.stringify(fixture, null, 2) + '\n';

function main(argv) {
  const flag = name => argv.includes(name);
  const at = argv.indexOf('--commit');
  const wanted = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && (!wanted || wanted.startsWith('-'))) throw new Error('--commit needs a revision');
  const rev = wanted ?? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).commit;
  const fixture = buildFixture(resolveCommit(rev));
  if (flag('--write')) { fs.writeFileSync(FIXTURE_PATH, render(fixture)); process.stderr.write(`wrote ${fixture.literals.length} literals from ${fixture.commit}\n`); return; }
  if (flag('--check')) {
    const same = fs.readFileSync(FIXTURE_PATH, 'utf8') === render(fixture);
    process.stderr.write(same ? `fixture matches ${fixture.commit}\n` : `fixture differs from a fresh scan of ${fixture.commit}\n`);
    process.exitCode = same ? 0 : 1;
    return;
  }
  process.stdout.write(render(fixture));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
