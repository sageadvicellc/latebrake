# core-api

The Core API client, the first slice of the Core API for Gauges (v0.9.1). A fake core for tests sits beside it.

A Gauge reaches the core only through the client (`createCoreClient`). The client takes a `Core`, which has one method, `call`. The real core will be another `Core`.

## What it offers

- `listGauges()` gives the Gauges the core holds.
- `getGauge(id)` gives one Gauge, or the refusal `UNKNOWN_GAUGE`.

Each call gives `{ ok: true, value }` or `{ ok: false, code }`. Wire names keep the `bowerloom` prefix, such as `bowerloom.gauges.list`.

## What the client checks in a reply

The client does not trust the core. It throws `CoreProtocolError` when any of these is false:

- The reply is a non-null object that is not a list.
- Its `ok` is exactly `true` or exactly `false`.
- On a refusal, `code` is a string, and it is a code of the registry.
- On a list, the result is a list, and every element is a Gauge summary.
- On a read, the result is a Gauge summary, and its `id` is the id that was asked for.

A Gauge summary has these fields, all present: `id`, `title`, and `version` are strings, `kind` is `ui` or `data`, `origin` is `stock` or `third-party`, and `protected` is a boolean. A field beyond these is not checked and passes through.

`CoreProtocolError` carries the `method` that failed, and its message starts with it. A code that is not valid is printed as a quoted string, cut to 64 characters, on one line.

A core that throws is not wrapped. Its own error reaches the caller unchanged. A later ticket decides how transport failures map to codes.

## Where the codes come from

Codes come from the registry in `packages/gauge-errors`, which is the package `@bowerloom/gauge-errors`. This package imports it by a relative path (`../../gauge-errors/src/index.js`), as the other packages here import each other. The build writes every package into `dist/packages/<name>`, and a relative path works there with no package entry point. The registry holds the codes. This package adds none.

## The fake core is for tests

`src/index.ts` exports the client, its types, and `CoreProtocolError`. It does not export the fake core or the fixtures, so product code cannot reach them by accident. A test imports them from their own modules: `createFakeCore` from `src/fake-core.js` and `FIXTURE_GAUGES` from `src/fixtures.js`.

## The client suite

`test/client-suite.ts` exports `runClientSuite(name, makeCore, expected?)`. The core is its parameter. `expected` is the list of Gauges the core holds. It defaults to a list written out in the suite, so the fake core is checked against fixed values and not against itself. `test/fake-core.test.ts` runs the suite on the fake core. When the real core exists, another test file calls it with the real core and that core's own list.

## Adding a call

Write its test in `test/client-suite.ts` first. Then add the method name to `CoreMethod`, the fake core case, and the client method.

## Tests

`npm run test:core-api`
