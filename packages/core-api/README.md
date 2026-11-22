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

Only the own properties of an object count. A field that an object inherits, from its prototype, reads as missing.

A Gauge summary has these six fields, all present: `id`, `title`, and `version` are strings, `kind` is `ui` or `data`, `origin` is `stock` or `third-party`, and `protected` is a boolean. The client reads each field once and checks the value it read. It hands back a new frozen object made from those six values. Any other field is dropped. A list is frozen too.

`ok` decides. A reply with `ok: true` is a success, and a `code` that it also carries is ignored. A reply with `ok: false` is a refusal, and a `result` that it also carries is ignored.

A throw while the client reads a reply, from a getter or a proxy, becomes a `CoreProtocolError`.

`CoreProtocolError` carries the `method` that failed, and its message starts with it. A value that is shown in a message is printed as JSON on one line. It is cut once to 64 characters, between two pieces of text so an escape is never split, and it ends with `...` when it was cut.

A core that throws from the call itself is not wrapped. Its own error reaches the caller unchanged. A later ticket decides how transport failures map to codes.

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
