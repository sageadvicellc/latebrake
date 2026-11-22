# core-api

The Core API client and a fake core, the first slice of the Core API for Gauges (v0.9.1).

A Gauge reaches the core only through the client (`createCoreClient`). The client takes a `Core`, which has one method, `call`. The fake core (`createFakeCore`) is a `Core` that answers from synthetic fixture data. The real core will be another `Core`.

## What it offers

- `listGauges()` gives the Gauges the core holds.
- `getGauge(id)` gives one Gauge, or the refusal `UNKNOWN_GAUGE`.

Each call gives `{ ok: true, value }` or `{ ok: false, code }`. A code always comes from `@bowerloom/gauge-errors`. A core that sends a code outside the registry, or a result of the wrong shape, makes the client throw `CoreProtocolError`.

Wire names keep the `bowerloom` prefix, such as `bowerloom.gauges.list`.

## The client suite

`test/client-suite.ts` exports `runClientSuite(name, makeCore)`. The core is its parameter. `test/fake-core.test.ts` runs it on the fake core. When the real core exists, another test file calls it with the real core, which must hold the fixture Gauges.

## Adding a call

Write its test in `test/client-suite.ts` first. Then add the method name to `CoreMethod`, the fake core case, and the client method.

## Tests

`npm run test:core-api`
