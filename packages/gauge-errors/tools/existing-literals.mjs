#!/usr/bin/env node
// Builds the fixture of code literals that exist in the product at one pinned commit, so a new Gauge code can be checked against it.
//
// The rule. The repository writes a refusal code as a bare word in capitals and underscores, such as BUNDLE_USAGE, NOT_ALLOWED or FAILED. It writes the word as a
// quoted string, as a key of a table or a type, as an enum member, as a destructured or shorthand name, as a class static, and in files that are not TypeScript.
// So the scan does not try to tell these places apart. A code literal is any token in a scanned file that is one code word:
//   capitals and digits, the words joined by single underscores, at least two characters, with a non-word character (or the edge of the file) on both sides.
// `MIXED_case`, `TRAILING_`, `_LEADING`, `DOUBLE__GAP`, `0xABCD` and a single letter are not tokens of this kind. A word inside a longer string is read: the text 'failed
// with REFUSED_CODE' gives REFUSED_CODE.
// The scan reads the files of the commit that have one of SCANNED_EXTENSIONS. It reads tests too. It skips: package lockfiles, node_modules, dist, .git, and the
// package `packages/gauge-errors/` itself (so a re-pin to a newer commit can never make the registry collide with its own codes).
// It skips a token that looks like a secret or a hash, because the fixture is public: a token of the shape AKIA or ASIA plus 16 capitals and digits, and a token of
// only 0-9 and A-F that is 16 or more characters long. No code is shaped like that.
// It errs on the side of too many: it also keeps system error names such as ENOSPC, constants such as PATH_SHOWN_CHARS, and capital words in comments. That is safe,
// because the fixture only forbids a new code from taking one of these names.
// It does not read: markdown, binary files, any other extension, or a name that code builds at run time (a template string such as `${PREFIX}_FAILED`).
//
//   node packages/gauge-errors/tools/existing-literals.mjs --write --commit <rev>   scan <rev> and write the fixture
//   node packages/gauge-errors/tools/existing-literals.mjs --check [--commit <rev>] scan again and compare with the fixture (default: the commit in the fixture)
// The pin never moves forward. It is the baseline of what existed before the Gauge codes, and a newer pin would contain the registry's own codes, because later work
// uses GAUGE codes in other packages. `--check` with no `--commit` proves that the fixture reproduces exactly from its own pinned commit. With a newer commit it
// compares the rule, the kinds and the literals, and reports what a newer commit holds that the baseline does not.
//   node packages/gauge-errors/tools/existing-literals.mjs --print [--commit <rev>] scan and print the fixture to the standard output
// Run it from any folder inside a clone that holds the commit. Exit codes: 0 done or equal, 1 the literals differ, 2 the call is wrong, 3 the scan failed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORD = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
/** A code word, whole: capitals and digits, words joined by single underscores, at least two characters. */
export const CODE_SHAPE = new RegExp(`^(?=.{2,}$)${WORD}$`);
const TOKEN = new RegExp(`(?<![A-Za-z0-9_$])${WORD}(?![A-Za-z0-9_$])`, 'g');

// The fixture is public, and secret scanners flag tokens of these two shapes. A cloud access key id, and a long run of hex digits (a hash, a key, a dump).
const KEY_ID = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;
const LONG_HEX = /^[0-9A-F]{16,}$/;
/** True for a token that looks like a secret or a hash: an access key id, or 16 or more characters of 0-9 and A-F. The scan skips it. */
export const isSecretShaped = token => KEY_ID.test(token) || LONG_HEX.test(token);

/** Returns the set of code literals in one text. */
export function extractCodeLiterals(text) {
  const found = new Set();
  for (const [token] of text.matchAll(TOKEN)) if (token.length >= 2 && !isSecretShaped(token)) found.add(token);
  return found;
}

/** The file kinds the scan reads, sorted, without the dot. */
export const SCANNED_EXTENSIONS = Object.freeze(['cjs', 'cts', 'js', 'json', 'jsx', 'mjs', 'mts', 'py', 'rs', 'sh', 'toml', 'ts', 'tsx', 'yaml', 'yml']);
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git']);
const SKIPPED_PREFIX = 'packages/gauge-errors/';
const LOCKFILE = /(?:-lock\.(?:json|ya?ml)|^npm-shrinkwrap\.json)$/;

/** True when a repository path (slash separated, from the root) is a file the scan reads. */
export function isScannedPath(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf('.');
  if (dot < 0 || !SCANNED_EXTENSIONS.includes(name.slice(dot + 1))) return false;
  if (LOCKFILE.test(name)) return false;
  if (file.startsWith(SKIPPED_PREFIX)) return false;
  return !parts.slice(0, -1).some(part => SKIPPED_FOLDERS.has(part));
}

// A git call. It never reads GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from the caller, so a run inside a hook reads the repository it is told to read.
const git = (cwd, args, input) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(name)));
  const result = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: 1 << 30, env, input });
  if (result.error) throw new Error(`git ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
};

/** The root folder of the repository that holds `cwd`. */
export const repoRoot = cwd => String(git(cwd, ['rev-parse', '--show-toplevel'])).trim();

/** Resolves a revision to its full commit hash. */
export function resolveCommit(rev, cwd = process.cwd()) {
  return String(git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

/**
 * Reads every scanned file of a commit through one `git cat-file --batch` call. Returns the sorted literals and the number of files read.
 * It fails, and never gives an empty list, when the commit holds no file to read, or when an entry is not a plain file.
 */
export function literalsAt(commit, cwd = process.cwd()) {
  const root = repoRoot(cwd);
  const files = String(git(root, ['ls-tree', '-r', '--full-tree', '--name-only', '-z', commit])).split('\0').filter(file => file && isScannedPath(file));
  if (files.length === 0) throw new Error(`no files to scan at ${commit} (looked in ${root})`);
  const out = git(root, ['cat-file', '--batch'], files.map(file => `${commit}:${file}\n`).join(''));
  const literals = new Set();
  let at = 0;
  for (const file of files) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) throw new Error(`git ended early before ${file}`);
    const [, type, size] = out.subarray(at, end).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`${file} is not a plain file at ${commit} (git says: ${type})`);
    const bodyStart = end + 1, bodyEnd = bodyStart + Number(size);
    for (const literal of extractCodeLiterals(out.subarray(bodyStart, bodyEnd).toString('utf8'))) literals.add(literal);
    at = bodyEnd + 1;
  }
  return { literals: [...literals].sort(), filesScanned: files.length };
}

const RULE = 'A code literal is any token in a scanned file that is one word of two or more characters in capitals, digits and single underscores, with a non-word character on both sides. Files with these extensions: ' + SCANNED_EXTENSIONS.join(', ') + '. Lockfiles, node_modules, dist, .git, markdown, and packages/gauge-errors are not scanned. Tests are. A token shaped like an AKIA or ASIA access key id (20 characters), or made only of 0-9 and A-F with 16 or more characters, is skipped. See packages/gauge-errors/tools/existing-literals.mjs.';

/** The fixture object for a commit (a revision is resolved to its full hash). */
export function buildFixture(rev, cwd = process.cwd()) {
  const commit = resolveCommit(rev, cwd);
  const { literals, filesScanned } = literalsAt(commit, cwd);
  return { commit, rule: RULE, extensions: [...SCANNED_EXTENSIONS], filesScanned, literals };
}

export const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'existing-code-literals.json');
export const USAGE = [
  'usage: existing-literals.mjs (--write | --check | --print) [--commit <rev>]',
  '  --write   scan <rev> and write the fixture (--commit is required)',
  '  --check   scan again and compare with the fixture (rule, kinds, literals, and the file count at the pinned commit); exit 1 on any difference',
  '  --print   scan and print the fixture to the standard output',
  '  --commit  the revision to scan; --check and --print default to the commit in the fixture',
].join('\n');

/** Reads the arguments strictly. Returns { ok: true, mode, commit } or { ok: false, error }. */
export function parseArgs(argv) {
  let mode, commit;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--write' || arg === '--print') {
      if (mode) return { ok: false, error: `only one of --check, --write and --print is allowed (got ${mode === arg.slice(2) ? 'a repeat of ' : ''}${arg})` };
      mode = arg.slice(2);
    } else if (arg === '--commit') {
      const value = argv[i + 1];
      if (commit !== undefined) return { ok: false, error: '--commit is given twice' };
      if (value === undefined || value.startsWith('-')) return { ok: false, error: '--commit needs a revision' };
      commit = value; i += 1;
    } else return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (!mode) return { ok: false, error: 'choose one of --check, --write and --print' };
  if (mode === 'write' && commit === undefined) return { ok: false, error: '--write needs --commit <rev>, so the pinned commit is a choice and not a default' };
  return { ok: true, mode, commit };
}

const render = fixture => JSON.stringify(fixture, null, 2) + '\n';
const SHOWN = 50;
const listed = (sign, items) => items.slice(0, SHOWN).map(item => `${sign} ${item}`).concat(items.length > SHOWN ? [`  ... and ${items.length - SHOWN} more`] : []);

/** Runs the tool. Returns the exit code. `io` lets a test point it at its own fixture file, folder and output. */
export function run(argv, io = {}) {
  const { cwd = process.cwd(), fixturePath = FIXTURE_PATH, out = text => process.stdout.write(text), err = text => process.stderr.write(text) } = io;
  const parsed = parseArgs(argv);
  if (!parsed.ok) { err(`${parsed.error}\n${USAGE}\n`); return 2; }
  try {
    const pinned = parsed.mode === 'write' ? undefined : JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const scan = buildFixture(parsed.commit ?? pinned.commit, cwd);
    err(`scanned ${scan.filesScanned} files at ${scan.commit}; kinds: ${SCANNED_EXTENSIONS.join(', ')}; ${scan.literals.length} literals\n`);
    if (parsed.mode === 'write') { fs.writeFileSync(fixturePath, render(scan)); err(`wrote the fixture\n`); return 0; }
    if (parsed.mode === 'print') { out(render(scan)); return 0; }
    const before = new Set(pinned.literals), after = new Set(scan.literals);
    const added = scan.literals.filter(literal => !before.has(literal)), removed = pinned.literals.filter(literal => !after.has(literal));
    const same = scan.commit === pinned.commit;
    // The count of files is compared only at the pinned commit: a newer commit may hold more files.
    const fields = [
      ...(pinned.rule !== scan.rule ? ['rule'] : []),
      ...(JSON.stringify(pinned.extensions) !== JSON.stringify(scan.extensions) ? ['extensions'] : []),
      ...(same && pinned.filesScanned !== scan.filesScanned ? ['filesScanned'] : []),
    ];
    if (added.length || removed.length || fields.length) {
      err(`the fixture differs from a fresh scan of ${scan.commit}: ${added.length} added, ${removed.length} removed; fields that differ: ${fields.length ? fields.join(', ') : 'none'}\n`);
      if (added.length || removed.length) err(['added (in the scan, not in the fixture):', ...listed('+', added), 'removed (in the fixture, not in the scan):', ...listed('-', removed)].join('\n') + '\n');
      return 1;
    }
    err(same
      ? `fixture reproduces exactly from its own pinned commit ${pinned.commit}\n`
      : `fixture holds the same rule, kinds and literals at the newer commit ${scan.commit} as at the pinned commit ${pinned.commit}. The pin stays at ${pinned.commit} on purpose.\n`);
    return 0;
  } catch (error) {
    err(`${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = run(process.argv.slice(2));
