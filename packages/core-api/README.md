# core-api

The Core API client, the first slice of the Core API for Gauges (v0.9.1). A fake core for tests sits beside it.

A Gauge reaches the core only through the client (`createCoreClient`). The client takes a `Core`, which has one method, `call`. The real core will be another `Core`.

## What it offers

- `listGauges()` gives the Gauges the core holds.
- `getGauge(id)` gives one Gauge, or the refusal `UNKNOWN_GAUGE`.
- `planInstall(folder)`, `planUpdate(folder)`, `planEnable(id)`, `planDisable(id)`, and `planRemove(id)` each give a plan and change nothing.
- `applyPlan(plan, approval?)` applies a plan that the person approved.
- `listRoutes()` gives the routes of the enabled Gauges.
- `planGrant(id, permissions)`, `applyGrant(plan, approval?)`, `revoke(id, permissions)`, `revokeTraces(id)`, `listGrants(id)`, `checkPermission(gauge, permission, engine?)`, and `readAudit()` are the grants calls. See "Permissions and grants".

Each call gives `{ ok: true, value }` or `{ ok: false, code }`. Wire names keep the `bowerloom` prefix, such as `bowerloom.gauges.list`.

## Install, enable, disable, update, and remove

Each of the five steps goes through a plan and an approval. A plan says what would change and changes nothing. A person approves one plan in the app. A Gauge never makes an approval, so the client has no call for it.

A plan has these fields: `action`, `id`, `folder`, `from`, `to`, `origin`, `steps`, `digest`, `manifestHash`, `folderHash`, and `nonce`. An applied plan gives `{ action, id, version, enabled }`.

- The `steps` show the person what the Gauge may do: its permissions, its kind, what its tile can do, and whether it has a page.
- `manifestHash` is the SHA-256 of the bytes of `gauge.json`. `folderHash` is the SHA-256 over the files of the folder: the file names sorted by their UTF-8 bytes (not by UTF-16 units), each as `<byte length of the name>:<name><size>:` and then its bytes, with the manifest as `gauge.json`. It covers files only. It does not model empty folders, file modes, or links inside the folder. A step on a Gauge that is installed carries the hashes from its install. A Gauge the core starts with has none.
- `digest` is the SHA-256 of the plan, hashes included. `nonce` is issued by the core for this one plan and is not in the digest. A nonce is exactly 64 lowercase hexadecimal characters, as part of the seam contract. The client refuses any other form, so a real core must issue that form.

The core applies a plan only when all of these hold:

1. It holds an approval for the plan: no approval, an unknown one, an old one, or one the state has moved past is `GAUGE_PLAN_NOT_APPROVED`. An approval works once and lasts 15 minutes. Any applied step ends every approval given before it, and retires every plan issued before it, so an old approval cannot apply again, and an old plan cannot be approved, after the state returns to what it was. The fake core's own clock is monotonic (`monotonicNow`, from the performance clock), so a system clock that steps back cannot extend an approval.
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
- A folder name that is a link, hidden, a Windows device name, or has two dots is `GAUGE_PATH_UNSAFE`, and so is a folder that is a link. So is a folder name with a control, format, or line or paragraph separator character, a slash, or a backslash (reason `unsafe_folder_name`), because the name is shown in the plan the person approves and must not forge a line of it. The core also escapes each value it puts in a step. A folder the core cannot find is `UNKNOWN_GAUGE`.
- Every id and folder param must be a string. Any other value is `UNKNOWN_GAUGE`.
- `dependencies` of a manifest are not checked at install, and a removal is not blocked by a Gauge that depends on the one removed. A later ticket owns both.
- The fake core keeps a copy of the folders it is given, so a caller that changes its own folders afterwards changes nothing.

### A reason with a refusal

A refusal of a manifest may carry a `reason`, a word of the closed set `MANIFEST_REASONS` of `packages/gauge-manifest`. The code says what class of refusal it is. The reason says which rule, so two refusals with the code `GAUGE_MANIFEST_INVALID` (a duplicate key and a comment, for example) can be told apart. The client throws `CoreProtocolError` when a reason is present and is not a word of that set. A reason of `undefined` counts as none.

## Permissions and grants

The permission list is in `packages/gauge-manifest` (`src/permissions.ts`), with a one-line meaning for each. A manifest may declare only names from it. This package holds the grants.

A grant is made by the person, per Gauge version, and a Gauge never makes one. It goes through a plan and an approval, like a lifecycle step:

- `planGrant` gives `{ action: 'grant', id, version, permissions, steps, digest, manifestHash, folderHash, nonce }` and changes nothing. `permissions` are sorted with no repeat. The two hashes are those of the install plan, which the core already holds, so the grant binds to the manifest hash and the whole folder hash. `digest` and `nonce` follow the lifecycle rules: the nonce is exactly 64 lowercase hexadecimal characters, issued by the core for this one plan.
- Each value in a step goes through the one escape helper, `escapeForPlan`, so no value can add or forge a line. Each permission shows as `permission <name> (<kind>): <meaning>`. A write or act permission says that the Gauge asks for a plan and never skips it. The plan also shows the engines of the Gauge, or `none`.
- `applyGrant` takes the person's approval of this exact plan. The rules are those of the lifecycle: an approval is a random token, works once, lasts 15 minutes, and ends when any applied step, a lifecycle step or a grant, changes the state. A missing, unknown, old, or used approval is `GAUGE_PLAN_NOT_APPROVED`. A plan that is not the approved one is `GAUGE_PLAN_CHANGED`. The approval of a lifecycle plan cannot apply a grant, and the reverse.
- A grant plan is allowed for an installed Gauge that is disabled, so a person can review before enabling.

### What a plan refuses

A plan refuses, with nothing changed: a Gauge that is not installed (`UNKNOWN_GAUGE`); a list that is not a non-empty list of text with no repeat (`GAUGE_GRANT_MISSING`, reason `invalid_request`); a name outside the list (`unknown_permission`); a listed name that the manifest does not declare (`not_declared`). A plan that holds a traces permission and any other permission is `GAUGE_TRACES_OWN_STEP`.

### A call without a grant

`checkPermission(gauge, permission, engine?)` is the one enforcement point. Every call that a permission guards goes through the same check in the core. It runs these checks in this order, and the first that fails refuses:

1. The Gauge is installed, else `UNKNOWN_GAUGE`.
2. The permission is in the list (`GAUGE_GRANT_MISSING`, reason `unknown_permission`), and the manifest declares it (`not_declared`).
3. The Gauge is enabled (`gauge_disabled`). A disabled Gauge holds no active grant. Its grants stay, and enabling it again brings them back.
4. For a permission whose scope is `engine`, the engine is a text that the manifest lists (`engine_not_listed`). A Gauge that lists one engine reads that engine only, and a Gauge that lists none reads none. For a permission whose scope is `none`, an engine is refused (`invalid_request`).
5. The Gauge holds a grant for it, else `GAUGE_GRANT_MISSING` with no reason.
6. The grant is current: both of its hashes equal those of the installed Gauge. An earlier manifest or folder is `GAUGE_GRANT_STALE`, and the person must grant again.

So a changed manifest asks again: an update installs a new manifest hash and folder hash, and every grant of the old version is stale. A removed Gauge keeps no grant, so the same Gauge installed again starts with none. A grant never outlives a revoke, a removal, or an update.

A reason of the grant set (`GRANT_REASONS`, in `packages/gauge-manifest`) goes only with `GAUGE_GRANT_MISSING`. The client throws `CoreProtocolError` when a grant reason comes with another code, or a manifest reason with `GAUGE_GRANT_MISSING`.

### Revoke

`revoke(id, permissions)` revokes in one action, with no plan, and access ends at once. `revokeTraces(id)` revokes every traces permission the Gauge holds in one action. A revoke only narrows access, so it needs no approval and it does not end other approvals. It works on a stale grant and on a disabled Gauge. A revoke of a permission the Gauge does not hold is `GAUGE_GRANT_MISSING` with the reason `not_held`, and then nothing changes, not even the permissions in the same call that were held. Revoking a traces permission restarts the webview in the app. That is a shell effect, and it is not part of this package.

The fake core trusts the Gauge id in a call. Who may call revoke, and the per-Gauge channel and token that bind an id to its caller, belong to the call identity work and are not built here.

### Traces permissions

`traces.facts` and `traces.text` are denied by default: install, enable, and a grant of every other permission leave them denied. They are granted in a plan of their own, so one approval never covers traces and something else. They are revoked with `revokeTraces`. The facts and the text can be granted apart. The rule that text needs the facts too is for the Traces API.

### The audit file

Every grant and every revoke of a permission appends one record to the audit file. A core writes the record before the change it describes, so a grant never takes effect without its record, and a clock that fails stops the step before anything changes. The file is JSON Lines in UTF-8: one record on each line, ended by one line feed, with these fields in this order: `seq`, `at`, `action`, `via`, `id`, `version`, `permission`, `manifestHash`, `folderHash`.

- `seq` starts at 1 and counts every record ever written. It is never reused, also after old records are dropped.
- `at` is an ISO 8601 time in UTC with milliseconds, from the wall clock (the option `wall`). It is a time of day, so it is not the monotonic clock of the approvals.
- `action` is `grant` or `revoke`. `via` is `plan` for a grant, and `revoke` or `remove` for a revoke. A removal of a Gauge writes a `revoke` record, `via` `remove`, for each grant it held. An update that makes grants stale writes none, because no grant was removed.
- A grant writes one record for each permission, sorted by name. The hashes are those the grant is bound to, so a revoke record of a stale grant shows the old hashes.
- The file holds no secret and no text a Gauge sent.

The size cap is 64 KiB by default (`DEFAULT_AUDIT_MAX_BYTES`). A core takes a cap of at least 4,096 bytes (`MIN_AUDIT_MAX_BYTES`), as a whole number, and refuses another when it is made. When a new record would push the file over the cap, the core drops the oldest whole records until the new one fits. A file of exactly the cap fits. A revoke is never refused because the file is full. `readAudit()` gives the records the file holds, oldest first, as frozen copies. Dropped records are gone, and the gap shows in `seq`.

`FakeCore.auditFile()` gives the file text for a test. It is not on the `Core` seam.

### What is not covered

Who calls revoke and the Gauge channel token (call identity); the webview restart after a traces revoke; the pairing rule of traces text and facts; calls that read engines, sessions, usage, models, or traces, which belong to the Engine Host and Traces API work and will call the same enforcement; a file on disk for the audit log, and how it survives a crash; two cores writing one file; and a stale grant caused by a change in a folder that keeps the same version (the fake core installs a copy, and an update must raise the version, so only an update makes a grant stale).

## What the client checks in a reply

The client does not trust the core. It throws `CoreProtocolError` when any of these is false:

- The reply is a non-null object that is not a list.
- Its `ok` is exactly `true` or exactly `false`.
- On a refusal, `code` is a string, and it is a code of the registry.
- On a list, the result is a list, and every element is a Gauge summary.
- On a read, the result is a Gauge summary, and its `id` is the id that was asked for.

Only the own properties of an object count. A field that an object inherits, from its prototype, reads as missing.

The client checks the result of an apply against the plan: an install returns `enabled` false and the planned version, an update returns the planned version, an enable returns `enabled` true, a disable returns `enabled` false, and a remove returns `version` null. It checks that each route of `listRoutes` is exactly `/gauges/<id>` for a valid id.

The grants calls are checked as strictly, from own properties, into fresh frozen objects. A grant plan must be for the Gauge and the permissions that were asked, with sorted permissions that are all in the list, and all traces or none. An applied grant must name the plan's Gauge and permissions. A revoke must name the permissions that were asked, and a traces revoke only traces permissions, at least one. A list of grants is sorted by permission with no repeat. A permission check must name the Gauge, the permission, and the engine that were asked, and `engine` is `null` when none was asked. An audit read has records that rise in `seq`, with a valid time, and an action that fits its way (`grant` by `plan`, `revoke` by `revoke` or `remove`).

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

## The grants suite

`test/grants-suite.ts` exports `runGrantsSuite(name, makeHarness)`, the grants suite, built the same way. `makeHarness(folders, options)` gives a core that holds those folders, a way to approve a plan of either kind, and a way to move the clock. `options.auditMaxBytes` sets the audit cap for the cap test. The suite covers the plan, approval, bound hashes, a changed manifest, a missing grant, traces, revoke, engine scope, and the audit file. `test/fake-core-grants.test.ts` runs it on the fake core and adds the fake's own checks. `test/grants.test.ts` tests the pure helpers, and `test/client-grants.test.ts` tests the strict reply checks.

## The client suite

`test/client-suite.ts` exports `runClientSuite(name, makeCore, expected?)`. The core is its parameter. `expected` is the list of Gauges the core holds. It defaults to a list written out in the suite, so the fake core is checked against fixed values and not against itself. `test/fake-core.test.ts` runs the suite on the fake core. When the real core exists, another test file calls it with the real core and that core's own list.

## Adding a call

Write its test in `test/client-suite.ts` first. Then add the method name to `CoreMethod`, the fake core case, and the client method.

## Tests

`npm run test:core-api`
