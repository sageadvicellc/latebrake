# gauge-errors

The error registry of the Core API for Gauges (v0.9.1). Every refusal a Gauge can get has one stable code, and every code is in `src/registry.ts`.

## Rules for a code

- Capitals, digits, and single underscores. Every word starts with a capital letter, so `GAUGE_2` is refused. At most 40 characters.
- The word `GAUGE` or the word `ENGINE` is one of its words. It may lead (`GAUGE_EXISTS`, `ENGINE_LIMIT`), follow (`UNKNOWN_GAUGE`, `MODEL_NOT_FOR_ENGINE`), or sit between others. The Engine Host spec names its codes `ENGINE_LIMIT` and `ENGINE_STOP_TIMEOUT`, so `ENGINE` is the second scope word. A client must not filter codes by a `GAUGE_` prefix. Use `isGaugeCode`.
- The text `EXTENSION` and the text `MODULE` appear nowhere in a code, not even inside a longer word, because those two names are retired.
- It never equals a code literal that the scan found at the pinned commit of the fixture.
- It never changes its name. A test pins the list.

To add a code, write its test in `test/registry.test.mjs` first, then add one line to the list.

## Scope of the starter set

The set covers manifest, lifecycle, grant, layout, and plan refusals. `GAUGE_TRACES_OWN_STEP` and `GAUGE_AUDIT_FAILED` are the codes of the grants ticket: the other grant refusals reuse `GAUGE_GRANT_MISSING` with a reason. `GAUGE_GRANT_STALE` stays in the registry, but the fake core no longer produces it: an update drops the grants of the old version, so none can be stale. A refusal to hide, remove, or replace a protected Gauge, such as the Gauge manager, reuses `GAUGE_PROTECTED`, with the reason `hidden`, `removed`, or `replaced` when the layout refuses it. `GAUGE_LAYOUT_INVALID` always has a reason, from `packages/gauge-layout`. In v0.9.1 Gauges have layout slots and no routes, so there are no route codes. The engine session codes (ticket 711) are `ENGINE_NOT_FOUND` (always with a reason: `engine`, `program_missing`, or `program_not_executable`), `ENGINE_REQUEST_INVALID` (always with a reason from `packages/engine-sessions`), `MODEL_NOT_FOR_ENGINE`, `ENGINE_LIMIT`, `ENGINE_PAIR_BUSY`, `ENGINE_FOLDER_SHARED`, `ENGINE_START_FAILED` (always with a reason: `program_missing`, `not_executable`, `folder_unusable`, `resource_limit`, `adapter_error`, `shutting_down`, `timed_out`, or `other`), `ENGINE_SESSION_UNKNOWN`, `ENGINE_SESSION_ENDED`, and `ENGINE_STOP_TIMEOUT`. The plan refusals of a session start or stop reuse `GAUGE_PLAN_NOT_APPROVED` and `GAUGE_PLAN_CHANGED`. The other engine, model, and key codes of the Engine Host spec stay for the tickets that build them. The jobs and runs codes (ticket 712) are `GAUGE_JOB_INVALID` (always with a reason from `packages/jobs`), `GAUGE_JOB_UNKNOWN`, `GAUGE_JOB_LIMIT`, `GAUGE_JOB_NOT_INTERACTIVE` (always with a reason: `schedule` or `unattended`), `GAUGE_RUN_UNKNOWN`, and `GAUGE_RUN_ROLLBACK_FAILED`. Later tickets own any further codes.

## The old-literal fixture

`test/fixtures/existing-code-literals.json` records the code literals found in one pinned commit of the product, as SHA-256 digests. A test hashes each registry code and fails when its digest is in the fixture.

The fixture holds digests and no plain literal, because it is public and the scanned source may hold names that this repository must not print. Do not add a list of names, or plain literals, to any file of this package.

What it holds: the pinned commit, the rule, the file kinds, the number of files scanned, and the sorted digests of the literals.

What counts as a literal: any token in a scanned file that is one word of two or more characters in capitals, digits, and single underscores, with a non-word character on each side. That reads quoted strings, table and type keys, enum members, destructured and shorthand names, and class statics alike. The full rule is at the top of `tools/existing-literals.mjs`.

What is scanned: files with the extensions `ts`, `tsx`, `mts`, `cts`, `js`, `mjs`, `cjs`, `jsx`, `py`, `rs`, `toml`, `yml`, `yaml`, `sh`, and `json`, tests included. Package lockfiles, `node_modules`, `dist`, `.git`, and this package are skipped, so the registry can never collide with itself.

What is skipped on purpose: a token shaped like a secret, because the fixture is public and secret scanners flag such values. That is an `AKIA` or `ASIA` access key id (20 characters), or a token of only `0-9` and `A-F` with 16 or more characters. No code is shaped like that.

What is not scanned: markdown, binary files, other extensions, and names that code builds at run time, such as a template string like `${PREFIX}_FAILED`. The scan also keeps more than it needs, such as system error names. That is safe, because it only forbids more names.

### The pin stays where it is

The fixture is pinned to `107445d66c71b09ac7972e44f9d3d67c09ff44a9` on purpose. That commit is the baseline of what existed before the Gauge codes. A new code is checked against that baseline only. The pin never moves forward: later tickets legitimately use `GAUGE` codes in other packages, so a newer pin would contain the registry's own codes and break the collision test.

### Commands

Run each from any folder in a clone that holds the pinned commit.

- `npm run check:literals` scans the pinned commit again and compares the result with the fixture. It proves that the fixture reproduces exactly from its own pinned commit, and that the script still makes it. Exit 0 when it does, 1 when anything differs. A difference prints, to the terminal only, the added literals in plain form and the removed ones as digests, 50 of each at most, with the names of any other field that differs. A check never writes a file, 2 for a wrong call, 3 when the scan fails.
- `node packages/gauge-errors/tools/existing-literals.mjs --check --commit <rev>` scans a newer commit. It compares the rule, the file kinds, and the digests. It prints the literals the newer commit holds that the baseline does not, on the terminal only. It never suggests moving the pin.
- `--write --commit <rev>` writes the fixture from `<rev>`. Use it only to fix the script or its rule, and keep `<rev>` at the pinned commit.

### What the drift check covers

It covers the literals that the scan rule finds in the commit it reads. It compares the stored rule, the list of file kinds, and the set of digests. At the pinned commit it also compares the number of files scanned. It prints which field differs. It does not cover a literal outside the rule (see "What is not scanned"), or the meaning of a literal. A newer commit with the same rule, kinds, and literals passes and says so.

## Tests

`npm run test:gauge-errors`
