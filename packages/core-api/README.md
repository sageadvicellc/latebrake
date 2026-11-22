# core-api

The Core API client, the first slice of the Core API for Gauges (v0.9.1). A fake core for tests sits beside it.

A Gauge reaches the core only through the client (`createCoreClient`). The client takes a `Core`, which has one method, `call`. The real core will be another `Core`.

## What it offers

- `listGauges()` gives the Gauges the core holds.
- `getGauge(id)` gives one Gauge, or the refusal `UNKNOWN_GAUGE`.
- `planInstall(folder)`, `planUpdate(folder)`, `planEnable(id)`, `planDisable(id)`, and `planRemove(id)` each give a plan and change nothing.
- `applyPlan(plan, approval?)` applies a plan that the person approved.
- `listRoutes()` gives the routes of the enabled Gauges.

Each call gives `{ ok: true, value }` or `{ ok: false, code }`. Wire names keep the `bowerloom` prefix, such as `bowerloom.gauges.list`.

## Install, enable, disable, update, and remove

Each of the five steps goes through a plan and an approval. A plan says what would change and changes nothing. A person approves one plan in the app. A Gauge never makes an approval, so the client has no call for it.

A plan has these fields: `action`, `id`, `folder`, `from`, `to`, `origin`, `steps`, `digest`, `manifestHash`, `folderHash`, and `nonce`. An applied plan gives `{ action, id, version, enabled }`.

- The `steps` show the person what the Gauge may do: its permissions, its kind, what its tile can do, and whether it has a page.
- `manifestHash` is the SHA-256 of the bytes of `gauge.json`. `folderHash` is the SHA-256 over every file of the folder, in order of name, each as `<byte length of the name>:<name><size>:` and then its bytes, with the manifest as `gauge.json`. A step on a Gauge that is installed carries the hashes from its install. A Gauge the core starts with has none.
- `digest` is the SHA-256 of the plan, hashes included. `nonce` is issued by the core for this one plan and is not in the digest.

The core applies a plan only when all of these hold:

1. It holds an approval for the plan: no approval, an unknown one, an old one, or one the state has moved past is `GAUGE_PLAN_NOT_APPROVED`. An approval works once and lasts 15 minutes. Any applied step ends every approval given before it, so an old approval cannot apply again after the state returns to what it was.
2. The plan is the one that was approved: another plan, a changed plan, or a plan with another nonce is `GAUGE_PLAN_CHANGED`.
3. The folder still has the approved hashes. A changed manifest, title, or other file is `GAUGE_PLAN_CHANGED`.
4. The plan would still be the same plan now. A plan that no longer applies gives the code of that refusal, such as `GAUGE_EXISTS`.

A real core must not copy how the fake core mints an approval. The fake core is a test double: it makes a random token in the test process and holds it in memory. A real core ties the approval to the person's click in the app and to its own store. The `FakeCore` type adds `approve(nonce)` and `replaceFolder(folder)` for tests. Neither is on the `Core` seam. The clock is injectable (`now`), so a test moves time.

Install adds a Gauge disabled. Update is an install plan of the new version, and it keeps the Gauge enabled or disabled as it was. Only an enabled Gauge has a route, `/gauges/<id>`, so a disabled or removed Gauge has none. A removed Gauge is gone from the list, from reads, and from the routes.

### Rules of the lifecycle

- The core loads a folder through `packages/gauge-manifest`. It sets `origin` from where it found the folder (`bundled` is stock, `user` is third-party), and a manifest cannot set it.
- A manifest that needs a newer Core API version is refused at the plan, so it never loads.
- A third-party Gauge is never protected.
- Stock ids are reserved for ever: a user folder whose id is a stock Gauge id is `GAUGE_NAME_RESERVED`, on install and on update, also after the stock Gauge is removed.
- An update cannot lower `protected` (`GAUGE_PROTECTED`), cannot change the origin (`GAUGE_NAME_RESERVED`), and must be a newer version (`GAUGE_VERSION_NOT_NEWER`).
- A folder name that is a link, hidden, a Windows device name, or has two dots is `GAUGE_PATH_UNSAFE`, and so is a folder that is a link. A folder the core cannot find is `UNKNOWN_GAUGE`.
- Every id and folder param must be a string. Any other value is `UNKNOWN_GAUGE`.
- `dependencies` of a manifest are not checked at install, and a removal is not blocked by a Gauge that depends on the one removed. A later ticket owns both.
- The fake core keeps a copy of the folders it is given, so a caller that changes its own folders afterwards changes nothing.

### A reason with a refusal

A refusal of a manifest may carry a `reason`, a word of the closed set `MANIFEST_REASONS` of `packages/gauge-manifest`. The code says what class of refusal it is. The reason says which rule, so two refusals with the code `GAUGE_MANIFEST_INVALID` (a duplicate key and a comment, for example) can be told apart. The client throws `CoreProtocolError` when a reason is present and is not a word of that set. A reason of `undefined` counts as none.

## What the client checks in a reply

The client does not trust the core. It throws `CoreProtocolError` when any of these is false:

- The reply is a non-null object that is not a list.
- Its `ok` is exactly `true` or exactly `false`.
- On a refusal, `code` is a string, and it is a code of the registry.
- On a list, the result is a list, and every element is a Gauge summary.
- On a read, the result is a Gauge summary, and its `id` is the id that was asked for.

Only the own properties of an object count. A field that an object inherits, from its prototype, reads as missing.

The client checks the result of an apply against the plan: an install returns `enabled` false and the planned version, an update returns the planned version, an enable returns `enabled` true, a disable returns `enabled` false, and a remove returns `version` null. It checks that each route of `listRoutes` is exactly `/gauges/<id>` for a valid id.

A Gauge summary has these six fields, all present: `id`, `title`, and `version` are strings, `kind` is `ui` or `data`, `origin` is `stock` or `third-party`, and `protected` is a boolean. The client reads each field once and checks the value it read. It hands back a new frozen object made from those six values. Any other field is dropped. A list is frozen too.

`ok` decides. A reply with `ok: true` is a success, and a `code` that it also carries is ignored. A reply with `ok: false` is a refusal, and a `result` that it also carries is ignored.

A throw while the client reads a reply, from a getter or a proxy, becomes a `CoreProtocolError`.

`CoreProtocolError` carries the `method` that failed, and its message starts with it. A value that is shown in a message is printed as JSON on one line. It is cut once to 64 characters, between two pieces of text so an escape is never split, and it ends with `...` when it was cut.

A core that throws from the call itself is not wrapped. Its own error reaches the caller unchanged. A later ticket decides how transport failures map to codes.

## Where the codes come from

Codes come from the registry in `packages/gauge-errors`, which is the package `@bowerloom/gauge-errors`. This package imports it by a relative path (`../../gauge-errors/src/index.js`), as the other packages here import each other. The build writes every package into `dist/packages/<name>`, and a relative path works there with no package entry point. The registry holds the codes. This package adds none.

## The fake core is for tests

`src/index.ts` exports the client, its types, and `CoreProtocolError`. It does not export the fake core or the fixtures, so product code cannot reach them by accident. A test imports them from their own modules: `createFakeCore` from `src/fake-core.js` and `FIXTURE_GAUGES` from `src/fixtures.js`.

## The lifecycle suite

`test/lifecycle-suite.ts` exports `runLifecycleSuite(name, makeHarness)`. `makeHarness(folders)` gives a core that holds those Gauge folders, a way to approve a plan, a way to replace a folder (as if its files changed on disk), and a way to move the clock. In the app a person approves, so the real core's harness supplies that step. The suite checks the manifest fixtures at load (each with its code), origin, the plan and approval rules for all five steps, and the routes. `test/fake-core.test.ts` runs it on the fake core, which has its own `approve`.

## The client suite

`test/client-suite.ts` exports `runClientSuite(name, makeCore, expected?)`. The core is its parameter. `expected` is the list of Gauges the core holds. It defaults to a list written out in the suite, so the fake core is checked against fixed values and not against itself. `test/fake-core.test.ts` runs the suite on the fake core. When the real core exists, another test file calls it with the real core and that core's own list.

## Adding a call

Write its test in `test/client-suite.ts` first. Then add the method name to `CoreMethod`, the fake core case, and the client method.

## Tests

`npm run test:core-api`
