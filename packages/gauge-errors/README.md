# gauge-errors

The error registry of the Core API for Gauges (v0.9.1). Every refusal a Gauge can get has one stable code, and every code is in `src/registry.ts`.

## Rules for a code

- Capitals and underscores only, in words joined by single underscores, at most 40 characters.
- It holds the word `GAUGE` and not `EXTENSION` or `MODULE`. A code follows the old module code with the new name: `UNKNOWN_EXTENSION` became `UNKNOWN_GAUGE`.
- It never equals a code literal that exists in the product at the pinned commit of the fixture.
- It never changes its name. A test pins the list.

To add a code, write its test in `test/registry.test.mjs` first, then add one line to the list.

## The old-literal fixture

`test/fixtures/existing-code-literals.json` lists every code literal in the source of one pinned commit. A test fails when a registry code equals one of them.

Regenerate it from a commit with `node packages/gauge-errors/tools/existing-literals.mjs --commit <rev> --write`, run from the root of a clone that holds the commit. `--check` scans the commit named in the fixture again and exits 1 when the fixture differs. The rule that decides what a code literal is sits at the top of `tools/existing-literals.mjs`.

## Tests

`npm run test:gauge-errors`
