# gauge-errors

The error registry of the Core API for Gauges (v0.9.1). Every refusal a Gauge can get has one stable code, and every code is in `src/registry.ts`.

## Rules for a code

- Capitals, digits, and single underscores. Every word starts with a capital letter, so `GAUGE_2` is refused. At most 40 characters.
- The word `GAUGE` is one of its words. It may lead (`GAUGE_EXISTS`), follow (`UNKNOWN_GAUGE`), or sit between others. A client must not filter codes by a `GAUGE_` prefix. Use `isGaugeCode`.
- The text `EXTENSION` and the text `MODULE` appear nowhere in a code, not even inside a longer word, because those two names are retired.
- It never equals a code literal that the scan found at the pinned commit of the fixture.
- It never changes its name. A test pins the list.

To add a code, write its test in `test/registry.test.mjs` first, then add one line to the list.

## Scope of the starter set

The set covers manifest, lifecycle, grant, layout, and plan refusals. A refusal to hide, remove, or replace a protected Gauge, such as the Gauge manager, reuses `GAUGE_PROTECTED`. In v0.9.1 Gauges have layout slots and no routes, so there are no route codes. Later tickets own any further codes.

## The old-literal fixture

`test/fixtures/existing-code-literals.json` lists the code literals found in one pinned commit of the product. A test fails when a registry code equals one of them.

What it holds: the pinned commit, the number of files scanned, the rule, and the sorted literals.

What counts as a literal: any token in a scanned file that is one word of two or more characters in capitals, digits, and single underscores, with a non-word character on each side. That reads quoted strings, table and type keys, enum members, destructured and shorthand names, and class statics alike. The full rule is at the top of `tools/existing-literals.mjs`.

What is scanned: files with the extensions `ts`, `tsx`, `mts`, `cts`, `js`, `mjs`, `cjs`, `jsx`, `py`, `rs`, `toml`, `yml`, `yaml`, `sh`, and `json`, tests included. Package lockfiles, `node_modules`, `dist`, `.git`, and this package are skipped, so a re-pin cannot make the registry collide with itself.

What is not scanned: markdown, binary files, other extensions, and names that code builds at run time, such as a template string like `${PREFIX}_FAILED`. The scan also keeps more than it needs, such as system error names. That is safe, because it only forbids more names.

### Commands

Run each from any folder in a clone that holds the commit.

- `npm run check:literals` scans `origin/release/0.9.1` and compares it with the fixture. Exit 0 when the literals are equal, 1 when they differ (the added and removed literals are printed, 50 of each at most), 2 for a wrong call, 3 when the scan fails.
- `node packages/gauge-errors/tools/existing-literals.mjs --write --commit <rev>` re-pins the fixture to `<rev>`.
- `--check` with no `--commit` scans the pinned commit again. It proves that the script still makes the fixture.

### When to re-pin

The guard compares against a pinned snapshot, not against the live base. A literal added after the pinned commit is not in the fixture. So, before a ticket adds a code, run `npm run check:literals` against the current tip of the base branch. If it differs, fetch, re-pin with `--write --commit origin/release/0.9.1`, and run the tests again.

### What the drift check covers

It covers the literals that the scan rule finds in the commit it reads. It does not cover a literal outside that rule (see "What is not scanned"), a branch other than the one you name, or the meaning of a literal. It compares the literals, not the commit hash: a newer commit with the same literals passes and says so.

## Tests

`npm run test:gauge-errors`
