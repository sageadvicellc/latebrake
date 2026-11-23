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
- `readLayout()`, `listLayoutRevisions()`, `exportLayout()`, `planLayoutSet(text)`, `planLayoutSwap(place, gauge)`, `planLayoutDefault(place)`, `planLayoutRestore(revision)`, `planLayoutPropose(gauge)`, and `applyLayout(plan, approval?)` are the layout calls. See "The layout".

- `planSessionStart(gauge, request)`, `planSessionStop(gauge, session)`, `applySession(plan, approval?, sharedApproval?)`, `listSessions(gauge, engine)`, and `getSession(gauge, session)` are the session calls. See "Engine sessions".

- `listJobs(gauge)`, `getJob(gauge, job)`, `planJobCreate(gauge, definition)`, `planJobUpdate(gauge, job, definition)`, `planJobDelete(gauge, job)`, `applyJob(plan, approval?)`, `planRun(gauge, job)`, `applyRun(plan, approval?, sharedApproval?)`, `listRuns(gauge)`, and `getRun(gauge, run)` are the jobs and runs calls. See "Jobs and runs".

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

The permission list is in `packages/gauge-manifest` (`src/permissions.ts`), with a one-line meaning for each. A manifest may declare only names from it. Each name has a literal type, `PermissionName`. This package holds the grants.

A grant is made by the person, per Gauge version, and a Gauge never makes one. It goes through a plan and an approval, like a lifecycle step:

- `planGrant` gives `{ action: 'grant', id, version, permissions, steps, digest, manifestHash, folderHash, nonce }` and changes nothing. `permissions` are sorted with no repeat. The two hashes are those of the install plan, which the core already holds, so the grant binds to the manifest hash and the whole folder hash. `digest` and `nonce` follow the lifecycle rules: the nonce is exactly 64 lowercase hexadecimal characters, issued by the core for this one plan.
- `applyGrant` takes the person's approval of this exact plan. The rules are those of the lifecycle: an approval is a random token, works once, lasts 15 minutes, and ends when any applied step, a lifecycle step or a grant, changes the state. A missing, unknown, old, or used approval is `GAUGE_PLAN_NOT_APPROVED`. A plan that is not the approved one is `GAUGE_PLAN_CHANGED`. The approval of a lifecycle plan cannot apply a grant, and the reverse.
- A grant plan is allowed for an installed Gauge that is disabled, so a person can review before enabling.

### The text of a grant plan

The `steps` of a grant plan are the text the person approves. They are a contract, in this order, and every value goes through the one escape helper, `escapeForPlan` (`src/plan-text.ts`), so no value can add or forge a line. A line break, a control, format, or separator character, and a backslash become a visible escape such as `\u{a}`.

1. The header: `grant <n> permission to <id> <version>`, with `permissions` when `n` is not 1.
2. One line for each permission, sorted: `permission <name> (<kind>): <meaning>`. A write or act permission says that the Gauge asks for a plan and never skips it.
3. The engines: `engines: <ids joined by a comma and a space>`, or `engines: none`.
4. The traces notice, in a plan of traces permissions only: `traces permissions start denied, are granted only here, and one revoke removes them all`.
5. The bind line: `bind the grant to manifest <hash> and folder <hash>`, with `none` for a Gauge that has no hash.

Tests pin the full text of a plain plan and of a traces plan, and the escape of hostile values. A manifest cannot hold a hostile id, title, or engine, because the manifest rules refuse it at install, so the escape is also tested on the helper directly.

### What a plan refuses

A plan refuses, with nothing changed: a Gauge that is not installed (`UNKNOWN_GAUGE`); a list that is not a non-empty list of text with no repeat (`GAUGE_GRANT_MISSING`, reason `invalid_request`); a name outside the list (`unknown_permission`); a listed name that the manifest does not declare (`not_declared`). A plan that holds a traces permission and any other permission is `GAUGE_TRACES_OWN_STEP`.

### A call without a grant

`checkPermission(gauge, permission, engine?)` is the one enforcement point. Every call that a permission guards goes through the same check in the core. It runs these checks in this order, and the first that fails refuses:

1. The Gauge is installed, else `UNKNOWN_GAUGE`.
2. The permission is in the list (`GAUGE_GRANT_MISSING`, reason `unknown_permission`), and the manifest declares it (`not_declared`).
3. The Gauge is enabled (`gauge_disabled`). A disabled Gauge holds no active grant.
4. For a permission whose scope is `engine`, the engine is a text that the manifest lists (`engine_not_listed`). A Gauge that lists one engine reads that engine only, and a Gauge that lists none reads none. For a permission whose scope is `none`, an engine is refused (`invalid_request`).
5. The Gauge holds a grant for it, else `GAUGE_GRANT_MISSING` with no reason.
6. `traces.text` is allowed only while `traces.facts` is also held, else the reason `facts_required`. The Traces API owns the pairing at its reader (ticket 714). This check keeps the one enforcement point from allowing a state that the spec forbids.

`invalid_request` is used in four places: a list of names that is not a non-empty list of text with no repeat (plan and revoke); a revoke that names both a list and a group, or neither; a revoke group that is not `traces`; and an engine given for a permission that touches no engine.

### When grants end

A grant never outlives the thing it was made for. Each of these ends grants at once, and each writes one `revoke` record for every grant it ends:

- A `revoke` or `revokeTraces` call (`via` `revoke`).
- The removal of the Gauge, which drops every grant (`via` `remove`). The same Gauge installed again starts with none.
- Disabling the Gauge, which clears its traces grants and keeps its other grants (`via` `disable`). Enabling brings the other grants back. The traces grants must be granted again, in their own step. The disable plan says so.
- An update, which drops every grant of the old version (`via` `update`). So a changed manifest asks again, and no stale grant lingers. The record names the version that was replaced, and the hashes of the grant. Because of this, the fake core never produces `GAUGE_GRANT_STALE`: there is no stale grant to find. The code stays in the registry, and the dead comparison was removed.

### Revoke

`revoke(id, permissions)` revokes in one action, with no plan, and access ends at once. `revokeTraces(id)` revokes every traces permission the Gauge holds in one action. A revoke only narrows access, so it needs no approval, and it works on a disabled Gauge.

- A permission that the Gauge does not hold is a no-op, so a repeated revoke is not an error. `revoked` lists the permissions that were held, sorted, and may be empty. Only an unknown Gauge (`UNKNOWN_GAUGE`), an unknown name, and a request of the wrong shape are refused.
- A revoke that ends at least one grant also retires every pending grant plan of that Gauge and every approval of one, so an approved regrant, such as a `traces.text` plan, cannot apply after the person revoked. A revoke does not end other approvals.
- Revoking a traces permission restarts the webview in the app. That is a shell effect, and it is not part of this package.

The fake core trusts the Gauge id in a call. Who may call revoke, and the per-Gauge channel and token that bind an id to its caller, belong to the call identity work and are not built here.

### Traces permissions

`traces.facts` and `traces.text` are denied by default: install, enable, and a grant of every other permission leave them denied. They are granted in a plan of their own, so one approval never covers traces and something else. They are revoked with `revokeTraces`. The facts and the text can be granted apart, but the text works only while the facts are held.

### The audit file

Every grant and every revoke of a permission appends one record to the audit file. The file is JSON Lines in UTF-8: one record on each line, ended by one line feed, with these fields in this order: `seq`, `at`, `action`, `via`, `id`, `version`, `permission`, `manifestHash`, `folderHash`.

- `seq` starts at 1 and counts every record that was written. It is never reused, also after old records are dropped. The records held have no gap between them.
- `at` is an ISO 8601 time in UTC with milliseconds, from the wall clock (the option `wall`). It is a time of day, so it is not the monotonic clock of the approvals.
- `action` is `grant` or `revoke`. `via` is `plan` for a grant, and `revoke`, `remove`, `disable`, or `update` for a revoke.
- `version` is the installed version at the time of the record. For an update it is the version that was replaced. `manifestHash` and `folderHash` are those the grant is bound to, so a record of a revoke shows the hashes of the grant that ended.
- A grant writes one record for each permission, sorted by name.
- The file holds no secret and no text a Gauge sent.

**A grant fails closed.** Its records are written first, and the grant takes effect only after they are. If the clock gives no usable time, the grant is refused with `GAUGE_AUDIT_FAILED` and the reason `clock_unusable`. If the file cannot be written, it is refused with `GAUGE_AUDIT_FAILED` and the reason `write_failed`. In both cases nothing changed, and the approval stays good for a retry.

**A revoke fails open on the record, never on access.** A revoke, a removal, a disable, and an update take effect first. Their records are written after, on a best effort, and the step always succeeds. If the clock gives no usable time, the record takes the time `1970-01-01T00:00:00.000Z`. If the file cannot be written, the record is not written and takes no number. In both cases the file is marked `auditFailed`, and the marker stays.

**The size cap.** It is 64 KiB by default (`DEFAULT_AUDIT_MAX_BYTES`). A core takes a cap from `MIN_AUDIT_MAX_BYTES` (5,970 bytes) to `MAX_AUDIT_MAX_BYTES` (1 MiB), as a whole number, and refuses another when it is made. The bound keeps the number of records of a file below `MAX_AUDIT_RECORDS` (16,384), which is the most a read may hold: a longer list is a protocol error that says it is too long. That minimum is 15 records of the longest possible line (398 bytes: the largest `seq`, the longest `via` and permission name, an id of 64 characters, a version of three nine-digit numbers, and two hashes), because the largest single step grants or ends all 15 permissions at once. When a step would push the file over the cap, the core drops the oldest whole records until the whole step fits. A step never drops a record of its own, and a step larger than the cap is refused before any change. A revoke is never refused because the file is full.

**The file is not a complete history.** Its oldest records are dropped. `readAudit()` gives `{ entries, firstSeq, droppedCount, auditFailed }`: the records held, oldest first, as frozen copies; the `seq` of the oldest (`null` when empty); how many records were dropped (`firstSeq - 1`); and the failure marker. A reader that needs a full history must copy the records before they are dropped.

`FakeCore.auditFile()` gives the file text for a test, and the option `onAuditWrite` stands for the file: it gets the whole new text, and a throw stands for a write that failed. Neither is on the `Core` seam.

### What is not covered

Who calls revoke and the Gauge channel token (call identity); the webview restart after a traces revoke; calls that read engines, sessions, usage, models, or traces, which belong to the Engine Host and Traces API work and will call the same enforcement; a file on disk for the audit log, and how it survives a crash; two cores writing one file; and a grant that goes stale because a file changes on disk under an installed Gauge (the fake core installs a copy, and an update must raise the version).

## The layout

The grid, the layout file, its revisions, the way back, and safe mode are in `packages/gauge-layout`, and its README is the contract. This package carries them over the seam. The wire names are `bowerloom.layout.read`, `bowerloom.layout.revisions`, `bowerloom.layout.export`, `bowerloom.layout.plan`, and `bowerloom.layout.apply`.

- `readLayout()` gives `{ layout, revision, safe }`. `layout` is the layout in use. `revision` is its number, from 1. In safe mode `revision` is 0, `safe` is `{ code, reason }` (the refusal that the saved file got), and `layout` is the default layout, which is not saved until the person makes a change. Otherwise `safe` is `null`.
- `listLayoutRevisions()` gives the earlier layouts, newest first, at most 10, as `{ revision, layout }`.
- `exportLayout()` gives the canonical text of the layout in use. Importing it gives the same layout, in the same bytes.
- **Only the person changes the layout.** There is no call that changes it without a plan, so a Gauge can never change it. Every change is a plan that the person approves, with the same rules as every other plan: a random approval that works once, lasts 15 minutes, is bound to the digest and the nonce of the plan, ends when any applied step changes the state, and cannot apply a plan of another kind.
- `planLayoutSet(text)` is a save and an import. The text is validated as the README of `gauge-layout` says. `planLayoutSwap(place, gauge)` swaps which Gauge fills a place. `planLayoutDefault(place)` puts the default Gauge of a place back, so the default is always one action away. `planLayoutRestore(revision)` restores an earlier layout, which becomes a new revision and keeps the one it replaced. `planLayoutPropose(gauge)` is how a Gauge asks to add itself. It needs the `layout.propose` grant (the one enforcement point), and the person approves the plan like any other. The fake core trusts the Gauge id, and a Gauge cannot name a place.
- A layout plan has `action` (`layout`), `kind` (`set`, `swap`, `default`, `restore`, or `propose`), `place`, `gauge`, `revision`, `text` (each `null` when the kind does not use it), `steps`, `digest`, `baseHash`, `nextHash`, and `nonce`. `baseHash` is the SHA-256 of the canonical text of the layout in use, and `nextHash` that of the layout it would give. Both are in the digest, so an approval is for the change the person saw. Applying gives `{ kind, revision, changed }`. A change that gives the layout already in use writes no revision (`changed` is false).
- **The text of a layout plan** is the text the person approves. It is a contract, in this order, and every value goes through `escapeForPlan`: the change; `after the change: <n> tile[s], <n> on the shelf, <n> hidden`; one `tile <place>: <gauge> <size> at column <col> row <row>` line for each tile; `shelf: ...`; `hidden: ...`; what happens to the file (`no change: the layout stays as it is`, or `keep the layout now in use as revision <n>, and keep at most 10 earlier revisions`, or in safe mode `leave safe mode and save the layout as revision 1`); and `bind the change to layout <hash> and result <hash>`. The layout plan text also has, before the tile lines, a line for each Gauge that will show again, and after the keep line the drop line when the file is full. Tests pin the full text of a swap plan.
- The core plans again from the state now when a plan is applied, and nothing is kept until every check has passed. A refused change leaves the layout, the revisions, and the file as they were. A revoke of `layout.propose` retires the pending proposal plans of that Gauge and their approvals at once.
- **A lifecycle step keeps the layout in line.** Disable, remove, update, and enable reconcile the layout in the same approved plan and save it as a normal revision (the rules are in `packages/gauge-layout/README.md`). The plan of the step adds lines that start with `layout: ` (`layout: drop tile <place> (<gauge>)`, `layout: add tile <place> (<gauge> <size> at column <col> row <row>)`, `layout: tile <place> holds <gauge> <size> instead of <gauge>`, `layout: tile <place> changes from <size> to <size>`, `layout: tile <place> moves from column <col> row <row> to column <col> row <row>`, `layout: place <place> has the default <gauge>`, `layout: remove <id> from the shelf`, `layout: add <id> to the shelf`, `layout: remove <id> from the hidden list`, `layout: add <id> to the hidden list`, then the keep line and, when the file already holds 10 earlier revisions, the drop line; or, when the revision counter is full, `layout: replace revision <n> in place, the revision counter is full and the old layout is not kept`). Every difference has a line. They are in the digest, so an approval is for the layout change too. A step that does not change the layout adds none. In safe mode nothing is saved, and the one line is `layout: the saved layout can be read again`, when the step makes the saved file readable. A step is never refused because the revision counter is full: the layout is replaced in place. A layout plan that would write a revision is refused at plan time with `bad_revision`, as applying it would.
- **A plan names what it drops and what it shows again.** When the file holds 10 earlier revisions, a plan that saves a layout says `drop revision <n>, the oldest, because the file keeps at most 10 earlier revisions`. A Gauge that was hidden and is shown after the change has a line `<gauge> was hidden and will show again`.
- **Safe mode keeps the saved file.** A change that leaves safe mode keeps the raw bytes of the saved file as a backup (`FakeCore.layoutBackup()`, a copy each time). The plan says so. When there was no file (a value that is not text or bytes, an empty file), there is nothing to keep, `layoutBackup()` is `null`, and the plan reads `leave safe mode and save the layout as revision 1`. The backup is one slot in the fake core. A real core must never overwrite an earlier backup: it names each one with a counter or a time.
- **A lifecycle step can end safe mode.** In safe mode the core reads the saved bytes again after each step. When a step makes the file readable (for example the Gauge that it names is installed and enabled), the core loads it, and the plan says `layout: the saved layout can be read again`. Its revisions come back, and no backup is made. A file that stays broken keeps safe mode, and the cause is what the file gets now. A start that broke inside the reader (`internal`) is not read again.
- **A lifecycle step is all or nothing.** The layout after the step is worked out before any state changes, so a failure in it leaves the Gauges, the grants, the audit file, the layout, and the approval as they were, and the approval still works. The option `reconcile` replaces the function that does the work, for a test that proves this. At a full revision counter the plan says `layout: replace revision <n> in place, the revision counter is full and the old layout is not kept`, with no keep or drop line.
- **The start check reads the saved bytes.** `FakeCore.layoutStartCheck()` reads the raw bytes of the file as they are on disk, and not the text decoded from them, so a file that a start would refuse is refused by the check too. When the start broke inside the reader (`internal`), every layout plan is refused with `GAUGE_LAYOUT_INVALID` and `internal`, so nothing overwrites the file. A `layoutFile` option that is not text or bytes starts safe mode with `syntax`. `FakeCore.layoutStartCheck()` says what the next start would find in the saved file against the Gauges now, for a test.
- The id `settings` is the Settings page. No Gauge can install under it, from any origin (`GAUGE_NAME_RESERVED`).
- The refusals are the codes of the registry with a reason: `GAUGE_LAYOUT_INVALID` always has a layout reason, `GAUGE_PROTECTED` has `hidden`, `removed`, or `replaced` when the layout refused it, `UNKNOWN_GAUGE` is a Gauge that a change names and no Gauge has (an id that is not text is the same), and the proposal reuses `GAUGE_GRANT_MISSING` with its grant reasons. This package adds no code.
- A defence that no test can reach: the core compares the digest of the plan again after it plans again from the state now. The epoch already retires every plan when any step changes the state, so the comparison is a second line. A plan sent back for apply (lifecycle, grant, and layout) is read from own properties only, a field that is missing or of the wrong type is refused, and a revision that is not a whole number is refused.

`FakeCoreOptions` has two options for this: `home` (the core holds the nine stock Gauges of the bento home after the fixture Gauges, off by default so that the older suites keep their list) and `layoutFile` (the saved layout file that the core finds when it starts, as text or bytes, kept as a copy). `FakeCore.layoutFile()` gives the text of the saved file, for a test. Without `home` the default layout has no tile, since none of the five default Gauges is there. A real core holds all nine.

## Engine sessions

The states, the legal moves, the cap, the pair rule, the shared folder rule, the host, and the process launcher are in `packages/engine-sessions`, and its README is the contract. This package carries them over the seam, with a plan and an approval for every start and every stop. The wire names are `bowerloom.sessions.plan`, `bowerloom.sessions.apply`, `bowerloom.sessions.list`, and `bowerloom.sessions.get`.

- **A start is a plan.** `planSessionStart(gauge, { engine, folder, model?, variables? })` needs the `sessions.start` grant for the engine (the one enforcement point, `checkPermission`). It gives a plan and changes nothing. The plan lists the engine, the program, the folder, the model choice, the billing source, and the variables. The person reads the real program and the real folder (a link is followed), and a Gauge reads the folder as it wrote it and the program as the engine is configured: see "Two views of one plan" below. No start happens without the person's approval of this exact plan. A Gauge never starts an engine on its own.
- **A stop is a plan too.** `sessions.stop` is an act permission, which lets a Gauge ask for a plan and never skip it. `planSessionStop(gauge, session)` needs the grant for the engine of the session. A stop of a session that is `stopping` already gets a plan that kills it (`force`).
- **A read** (`listSessions`, `getSession`) needs `sessions.read` for the engine, so a Gauge that lists one engine reads that engine only. A read holds no output of the engine. Its `folder` is the folder as the session was asked for, never the real folder behind a link. `listSessions` gives the sessions of one engine, oldest first.
- **Which refusal first.** For a start: the grant check (`UNKNOWN_GAUGE`, then the reasons of `GAUGE_GRANT_MISSING`), then the host (the request, the engine, the model, the pair, the cap). For a stop and a get, the grant comes first and the session second: an unknown Gauge, the grant check over every engine the Gauge lists (a Gauge with no grant at all gets the grant refusal for any id), a malformed id, and only then the lookup. A session that does not exist and a session of an engine that the Gauge has no grant for give the same refusal, `ENGINE_SESSION_UNKNOWN`, so a Gauge cannot find which session ids exist. The oracle is closed.

### A plan of a session

A plan has `action` (`start` or `stop`), `gauge`, `engine`, `folder`, `session`, `program`, `model`, `billing`, `variables`, `sharedWith`, `force`, `steps`, `digest`, and `nonce`. A field that the action does not use is `null`, `[]`, or `false`. A start has `session` null, and a stop has `program` and `model` null. `digest` is a keyed hash (HMAC-SHA-256, 64 lowercase hexadecimal characters) of the nonce and the full plan, with a key that only the core holds. A Gauge cannot work it out, so it cannot test a guess of a real folder or of an engine against it, and two plans have two digests even when they say the same, so a Gauge cannot tell from digests that two plans agree. The nonce is exactly 64 lowercase hexadecimal characters. A real core must keep both properties: a digest that holds a secret that the Gauge lacks, and that holds the nonce.

The core applies a session plan only when all of these hold, in this order:

1. It holds an approval for the plan: no approval, an unknown one, an old one, or one the state has moved past is `GAUGE_PLAN_NOT_APPROVED`. The rules of the other plans hold: an approval works once, lasts 15 minutes, and ends when any applied step changes the state.
2. The plan is the one that was issued: the plan that the caller sends must be, field for field, the plan that a Gauge read (digest and nonce included). Another plan, a changed plan, a plan of the person, the nonce of a plan of another kind, or another nonce is `GAUGE_PLAN_CHANGED`.
3. The plan would still be the same plan now. The core plans again from live state, the permission included, and from the folder as the Gauge asked for it, so a link that moved since the plan was made gives another real folder. The digest of the new full plan must be the digest that the person approved. A plan that no longer applies gives the code of that refusal. A plan whose engines in the folder changed, for example because another engine began or went, is `GAUGE_PLAN_CHANGED`, also when that engine is one that the Gauge may not read.
4. A start whose full plan has `sharedWith` also needs the second approval (`sharedApproval`). Without it the refusal is `ENGINE_FOLDER_SHARED` when the plan that the Gauge read names an engine, and `GAUGE_PLAN_NOT_APPROVED` when it names none (see "Two views of one plan", which says what that refusal does and does not hide). Nothing starts, and the first approval is not used up.

Only then the core asks the host. The approval is used up, and every older plan is retired, before the core waits for the program, so a second call in the same tick finds the approval gone. A start that gets past every check uses up its approval even when the program then fails to start (`ENGINE_START_FAILED`), because a session record, in the state `failed`, now exists. A throw from the host before it makes the session leaves the approval, the nonce, the epoch, and the audit file as they were.

### The text of a session plan

The `steps` are the text the person approves. They are a contract, in this order, and every value goes through `escapeForPlan`, which escapes a control, format, or separator character, a backslash, a space that is not the plain space, a blank letter (U+3164, U+2800, U+115F, U+1160, U+FFA0), and a combining mark, as `\u{...}`. The helper is the one of `packages/engine-sessions`, which the logs use too. `src/session-plan.ts` has the lines, and the tests pin the full text.

Start: `Gauge <gauge> asks for a new session of the engine <engine> (<title>)`; `program: <path>`; `folder: <path>`; in the plan of the person, when the Gauge wrote the folder in another way than the real one, `the Gauge named this folder as <name>`; `model: <provider> <model>, as the Gauge asks` or `model: the engine's own default, and the core picks none`; `billing source: ...`; `variables passed: <names>` or `none`; `the program gets these variables only, and it starts with an argument list and never through a shell`; `the core never answers a permission prompt of the engine: you answer it yourself`; for a shared folder, the `notice: ...` line and `a second approval is needed, for the shared folder`; and `start the program in the folder, and keep the session until it stops or fails`.

Stop: `Gauge <gauge> asks to stop session <session> of the engine <engine>`; `folder: <path>`; in the plan of the person, when the session was asked for in another folder name, `the session was asked for in the folder <name>`; the stop signal line with the wait in milliseconds, or the kill signal line for a session that is stopping already, or, for a session that has ended but whose program may still run, the line `the session has ended, but its program may still be running: send the kill signal again, ...`; and `if they do not go in time, the session stays stopping and the core refuses with ENGINE_STOP_TIMEOUT`, or, for an ended session, the line that it keeps its state and that its place is free when the program has gone.

### Two views of one plan

A start, a stop, and a run make **one** plan with **two views**. The core keeps the full plan (the one that the person approves) and gives a Gauge a trimmed copy of it, with the same digest and the same nonce.

| | The person reads | A Gauge reads |
|---|---|---|
| `folder` | the real folder, a link followed | the folder as the Gauge (or the job) wrote it |
| `program` | the real path of the program | the program as the engine is configured |
| `sharedWith` | every engine that runs in the folder | the engines for which the Gauge holds `sessions.read` (and its manifest lists) |
| `steps` | the text of the full values, and the line that names the folder as the Gauge wrote it | the text of the trimmed values |
| `shared` (a run) | true when any session shares its folder | true when a session shares its folder with an engine that the Gauge may read |

Everything else is the same, and a test pins that the two plans differ in those fields and no other. A Gauge learns no path behind a link, and no name of an engine that it may not read, in a plan, a refusal, an error, or a read of a session (`listSessions` and `getSession` give the folder as the session was asked for). The chosen design is one stored full plan and a trimmed view of it, and not two plans with two digests: the digest, the nonce, and the approval are made once, for the full plan, so what the person approves is exactly what runs.

- **The digest is for the full plan and cannot be tested.** It is a keyed hash (see above). A plain hash of the plan would let a Gauge that guesses a real folder or an engine check its guess against the digest that it reads.
- **A Gauge applies the plan it read.** The core compares the plan that a Gauge sends with the view it issued, then plans again from the folder as the Gauge asked for it, then compares the digest of the full plan with the approved digest. A link that moved, or an engine that began or ended in the folder, makes the plan stale (`GAUGE_PLAN_CHANGED`). The Gauge learns that something changed, and not what.
- **A second approval that a Gauge does not know it needs.** The person reads the notice and gives both approvals. If the second is missing and the Gauge may not read any engine that shares, the refusal is `GAUGE_PLAN_NOT_APPROVED`, as for any missing approval, so it carries no name and no member. This narrows what a Gauge learns, and does not close it: a Gauge that holds a valid first approval learns one bit, that its apply was refused for a missing approval (and not that it succeeded), which tells it that the person did not give the second approval for a folder that it cannot see. When the Gauge may read an engine that shares, the refusal is `ENGINE_FOLDER_SHARED` (in a run, with `member`). The person is told the true cause in `personNotices()`.
- **A Gauge that may read an engine.** "May read" is `sessions.read` for an engine that the manifest lists, the one enforcement point at work. A `sessions.start` grant alone does not show a Gauge what an engine does. The engines of one run that share a folder are shown to a Gauge by the same rule.
- **Refusals stay closed.** A refusal holds a code and, for the request and start codes, a word of a closed set. `ENGINE_PAIR_BUSY` and `ENGINE_LIMIT` hold nothing more, and a refusal of a run holds a `member` (a place and the label from the job). No refusal holds a path or an engine name. A request for a folder that does not exist is still `ENGINE_REQUEST_INVALID` with the reason `folder`, so a Gauge can still find whether a path it names is a folder: it needs that to ask for a start, and it learns nothing about a path that it did not name.
- **No log that a Gauge can read.** The host log holds real paths, for the person. No call of this package gives a Gauge any log line. A later call that does must go through the same trimming.
- **The person view.** `PersonView.personView(nonce)` (in `src/types.ts`) is what a core must offer to the part that shows the person a plan before it approves it. It gives a `PersonSessionPlan` or a `PersonRunPlan`: types of their own, with their own field names (`realFolder`, `realProgram`, `allSharedWith`, `requestedFolder`, `configuredProgram`), so a plan of the person cannot be given as the plan that a Gauge reads, and the other way round (a test fails to compile when one is). It is not on the `Core` seam: no call reaches it, so no Gauge can. **An approval screen must be built from `personView`, never from the plan that a Gauge read**, which lacks the real folder, the real program, and the engines that the Gauge may not read. The fake core reads it the same way: the second approval is given when `personView` names an engine in the folder, and `approveShared` refuses a plan that names none. The core also tells the person what a Gauge is not told: `FakeCore.personNotices()` gives the true cause of a refusal that holds back its cause (the engines in the folder and the true session of a run), the newest 64. `personSessionPlan` and `personRunPlan` are the same read, typed by the kind of plan.
- **Plans are bounded.** A Gauge holds at most 64 plans (`MAX_LIVE_PLANS_PER_GAUGE`). A plan past that makes the core drop the oldest plan of that Gauge. An approval that was given for the dropped plan stays, and it is for a plan that is gone: the apply is `GAUGE_PLAN_CHANGED`, and the person cannot approve it any more. A step that is applied drops every plan and every approval of before. The core keeps the SHA-256 of the plan that a Gauge read, and not its text.
- **A Gauge that may start an engine can learn where it runs.** The pair rule counts the real folder, so a Gauge that holds `sessions.start` for an engine, and not `sessions.read`, and asks for a start at a name of its own, learns from `ENGINE_PAIR_BUSY` whether that name leads to a folder where that engine already runs. That confirms a guessed real path for a link, and tells it that its engine runs there. This is accepted, and the refusal stays: the Gauge needs it to ask for a start. A real core must limit how many plans a Gauge may ask for in a time. `ENGINE_LIMIT` counts every session, also those that the Gauge may not read, and it holds nothing more than its code.
- **What the client checks.** The client checks the folder of a start plan against the folder that was asked for. A stop plan and a run plan have no expected value to compare: the folder of a stop is that of a session that another Gauge may have started, and the folders of a run are in the job, which the client does not hold.
- **Choices that help a Gauge and a person.** A configured program that is an absolute path may include a home directory, and a Gauge reads it as configured: prefer a bare name, which a Gauge reads as that name. The `shared` of a run plan is false for a Gauge that may read no engine, also when its sessions share a real folder: that is correct for what it may read, and it does not say that the run needs no second approval, so a Gauge that is refused with `GAUGE_PLAN_NOT_APPROVED` must ask the person, and must not ask again and again.

### The second approval

A start in a folder that another engine uses needs a second approval, as the spec says: "Two engines in one folder need a notice and approval before the second start." The notice is in the plan. The approval is a second token, of another kind. The fake core mints it with `approveShared(nonce)`, which refuses a plan that names no other engine. The first token never stands for the second, and the second never stands for the first. A real core ties each to its own click in the app.

### What an applied plan gives

`{ action, session, engine, state }`. A start gives the state when the program has started, which is usually `starting`. A stop gives `stopped`, except the forced stop (`force: true`) of a session that failed and whose program had not gone, which gives `failed`: the kill again, and the client accepts that state only for a forced stop. A stop that times out is `ENGINE_STOP_TIMEOUT`: the session stays `stopping`, and a second stop plan kills it.

### The fake core and the host

`FakeCoreOptions.engineHost` is the host that holds the sessions (`createEngineHost`). The default is a host with no engine, so every engine is `ENGINE_NOT_FOUND`. A test passes a host over the scriptable fake engines of `packages/engine-sessions`. `FakeCore.approveShared(nonce)` is for tests, and is not on the `Core` seam.

A start and a stop write nothing to the audit file. Its records are `grant` and `revoke` of a permission, with the hashes of a Gauge, and it has no generic kind, so a session record would need a new kind and a new contract. That is left to a later ticket. Faults and failed starts go to the host's log, with the session id and no variable value.

### What is not covered

Who may call these methods (the call identity work); the live stream of a session and sending to it (`sessions.stream`, `sessions.attach`, `sessions.send`); engines and usage reads (`engines.read`, `usage.read`); and a cap or a pair that the core could not already see. The cap and the pair checks cannot fail at apply through the core, since a start ends every older plan, so those two checks at apply are a second line, and the host tests drive them directly.

## Jobs and runs

The rules are in `packages/jobs`, and its README is the contract: the definition and its check, the store, and the run book. This package carries them over the seam, with a plan, a grant, and an approval for every write and for every run. The wire names are `bowerloom.jobs.list`, `.get`, `.plan`, and `.apply`, and `bowerloom.runs.list`, `.get`, `.plan`, and `.apply`.

A job is a saved definition of AI work: a title and one to eight sessions, each with a label, an engine, a harness, a folder, a model choice, and a task. A run is one execution of a job: a group of sessions that start from one plan. Jobs belong to the person: a Gauge asks for a change through a plan, and no Gauge owns a job. A job outlives the Gauge that made it, and a delete of a job stops no run.

- **A write is a plan.** `planJobCreate`, `planJobUpdate`, and `planJobDelete` need the `jobs.write` grant. The plan is `{ action: 'job', kind, gauge, job, definition, baseHash, nextHash, steps, digest, nonce }`. `job` is `null` for a create, since the core makes the id when the plan is applied. `baseHash` is the hash of the job as it is now, `nextHash` is the hash of the definition, and both are in the digest. A job that changed since the plan was made gives a different plan, so the approval no longer holds. The plan changes nothing. The rules of approvals are those of every plan: a random token, once, 15 minutes, ended by any applied step, for one nonce.
- **The definition is sent as it is.** The client copies the own data of the definition and sends it, with a field that it does not know too, so the core refuses a `schedule` or an `unattended` field with its own code, `GAUGE_JOB_NOT_INTERACTIVE`, and the client never drops it. A list that cannot be read, or a value nested deeper than 5 levels, is a bug of the caller and throws before anything is sent.
- **A read** (`listJobs`, `getJob`) needs `jobs.read`. A list gives the id, the title, and the count of sessions, and no folder and no task. At most 64 jobs are held: the 65th create is refused with `GAUGE_JOB_LIMIT`, an update adds none, and a delete makes room.
- **A run is one plan.** `planRun(gauge, job)` needs the `jobs.run` grant, and the `sessions.start` grant for the engine of every session of the job. The second rule is the one enforcement point at work: a Gauge that lists one engine never starts another engine through a job, and an engine that is not held reads as an engine that is not listed, so the refusal says nothing about which engines exist. The Engine Host plans the whole group (the cap, the pair rule, and the shared folder count the members), and the plan lists every session with its real program, its real folder, its model, its billing source, its variables, its task, and the engines that share its folder. The plan that the person reads has the real program, the real folder, and every engine; the plan that a Gauge reads has the program as configured, the folder as the job names it, and the engines it may read (see "Two views of one plan"). `shared` says when the run needs the second approval, once for the whole run (`approveShared`, `sharedApproval`).
- **A run starts all or none, and waits until every session says that it runs.** `applyRun` starts every session before it waits for any program, and then waits until every session has left `starting`: a spawn is not enough, since a program can spawn and end at once. The first session that does not run (its launch failed, its program ended before it said it runs (`exited`), the start timeout of the host failed it (`timed_out`, 30 s by default), or the person stopped it (`stopped`)) starts the stop of every session of the run at that moment. The refusal is that first failure, in the order things happened and not in the order of the plan: `ENGINE_START_FAILED` with its reason, `member` (the place and the label of the session), and `run` (the id of the run). The run stays recorded, and reads as a group that ended, so a Gauge finds it by that id. Only the first failure is reported, and it is logged with its session. When a session that had started cannot be stopped, the refusal is `GAUGE_RUN_ROLLBACK_FAILED` with the same `run` and `member` (the session that failed first, which may not be the one that stays) and the reason of the first failure as `cause`: a session of the run is left running, the run shows it as `stopping`, and the person stops it with the session calls. The approval is used up when the run begins, before the programs have started.
- **A run reads as a group of its sessions.** `getRun` and `listRuns` need `jobs.read`. A run is `{ id, job, title, sessions: [{ label, engine, session, state }] }`, in the order of the plan. A session of an engine that the Gauge holds no `sessions.read` grant for reads as `{ session: null, state: 'hidden' }`, the same whatever the session is. A session that the host has dropped from its history reads `forgotten`. The runs are kept as long as the host keeps their sessions, so the list is bounded by the history of the host (at most 320). A run that is not there, or whose id is malformed, is `GAUGE_RUN_UNKNOWN`.
- **An engine never starts another engine.** The sessions of a run are the sessions of its plan. No call adds a session to a run, and nothing that a program prints starts a program. A test uses an engine that prints requests to start another engine.
- **Interactive only.** The definition and every session of it are scanned first for a `schedule` field and an `unattended` field, with any value, so an invalid first session never hides one in a later session. A raw call to `jobs.plan`, `runs.plan`, or `runs.apply` that carries a `schedule` or an `unattended` key is refused the same way, and a key that the call does not know is `GAUGE_JOB_INVALID` with the reason `request`. `jobs.plan` and `runs.plan` look at the keys after the grant check, so a Gauge with no grant learns nothing. `runs.apply` has no grant check of its own (the plan it carries was made under one) and looks at the keys before any approval. The client has no way to send such a key.
- **Which refusal first.** For a write: the grant (`UNKNOWN_GAUGE`, then `GAUGE_GRANT_MISSING`), the shape of the job id (`GAUGE_JOB_INVALID` with the reason `job`), the definition (`GAUGE_JOB_NOT_INTERACTIVE` first, then `GAUGE_JOB_INVALID` with the field), then whether the job is there (`GAUGE_JOB_UNKNOWN`), and for a create whether there is room (`GAUGE_JOB_LIMIT`). For a run: the grant, `unattended`, the job id and the job, the `sessions.start` grant for each engine, and then the host. A Gauge with no jobs grant gets the grant refusal for any id, so it cannot find which jobs exist.

### The text of a plan

The `steps` of a job plan and of a run plan are the text the person approves. They are a contract, in the order given in `src/job-plan.ts`, and every value goes through the one escape helper, `escapeForPlan`. A task is shown as its count of characters and its first 120. The plan says that the core does not send a task to an engine: the Engine Host has no message path yet, so the person gives the task in the pane of the engine. It also says that the harness of a session is recorded and shown, and that nothing applies it to an engine yet, in a job plan (create and update) and in a run plan; that the run waits until every session has said that it runs; and that a session that cannot be stopped is left running for the person to stop, and only the first failure is reported. A job update shows the new title and the old and the new count of sessions.

**A rule for the ticket that delivers a task.** A plan must show the whole task, or its hash together with a step that lets the person view all of it, before a task is ever sent to an engine. Until then a plan shows its first 120 characters and its count, which is true only because nothing is sent.

### Notes for the real core

- The fake core keeps the plans it issued, and every approval, until a step changes the state (`issued` and `approvals`): then it drops them all. A Gauge holds at most 64 plans, and the oldest goes first. A real core needs the same bounds, and must also cap the plans that are made without a Gauge (a lifecycle plan has no Gauge), and must limit how many plans a Gauge may ask for in a time.
- A real core must show the person the full plan, and build its approval screen from the person view of `src/types.ts` (see "Two views of one plan"), and give a Gauge only the trimmed view. It must make the digest of the full plan with a key that no Gauge holds and with the nonce, and it must plan again from the folder as the Gauge wrote it, never from the real folder, so a moved link is a stale plan. The host throws a `StalePlanError` when the folder moves between its read and the core's, and a core must answer that as `GAUGE_PLAN_CHANGED`.
- `getJob` and `listJobs` give every job, with its folder and task text of each session, to any Gauge that holds `jobs.read`. Jobs belong to the person, and `jobs.read` is the permission that reads them all. The text of the permission says so.
- A Gauge that holds `jobs.run` and not `jobs.read` can still learn whether a job id exists, since `planRun` says `GAUGE_JOB_UNKNOWN`. This is accepted: a job id is `job-` and 64 random bits, so it cannot be guessed.
- The test of a start that fails part way locks a folder with `chmod`. It skips as root, and on a file system that ignores modes.

### What is not covered

Relay routes between the sessions of a run (ticket 8 of the W4 list); the traces of a run; stopping a whole run in one plan (each session is stopped with its own plan); delivering the task and the harness to the engine; a check that a harness exists; a refusal that names the session that cannot start; a Jobs Gauge; saving jobs on disk; and the call identity work (who may call these methods).

## What the client checks in a reply

The client does not trust the core. It throws `CoreProtocolError` when any of these is false:

- The reply is a non-null object that is not a list.
- Its `ok` is exactly `true` or exactly `false`.
- On a refusal, `code` is a string, and it is a code of the registry.
- On a list, the result is a list, and every element is a Gauge summary.
- On a read, the result is a Gauge summary, and its `id` is the id that was asked for.

Only the own properties of an object count. A field that an object inherits, from its prototype, reads as missing.

The client checks the result of an apply against the plan: an install returns `enabled` false and the planned version, an update returns the planned version, an enable returns `enabled` true, a disable returns `enabled` false, and a remove returns `version` null. It checks that each route of `listRoutes` is exactly `/gauges/<id>` for a valid id.

The grants calls are checked as strictly, from own properties, into fresh frozen objects. A grant plan must be for the Gauge and the permissions that were asked, with sorted permissions that are all in the list, and all traces or none. An applied grant must name the plan's Gauge and permissions. A revoke may name only permissions that were asked, and a traces revoke only traces permissions. A list of grants is sorted by permission with no repeat, and has no `current` field. A permission check must name the Gauge, the permission, and the engine that were asked, and `engine` is `null` when none was asked. An audit read has records that follow each other by one in `seq`, with a valid time, and an action that fits its way (`grant` by `plan`, `revoke` by `revoke`, `remove`, `disable`, or `update`), and its `firstSeq` and `droppedCount` must fit the first record. Every list that a reply holds is read once, by index, with no hole, getter, iterator, or subclass of Array (`readList`), so a sparse or hostile list is a protocol error. A list that a caller sends (permissions, variables, and the lists of a plan) is copied the same way before anything is sent, and a list that cannot be read is a `TypeError` of the caller. The caps are explicit: sessions `MAX_SESSIONS_LISTED`, audit records `MAX_AUDIT_RECORDS`, grants the number of permissions, and Gauges and routes 4,096 (a layout shelves at most 200). A refusal reason is typed by its code: `GAUGE_GRANT_MISSING` has a grant reason or none, `GAUGE_AUDIT_FAILED` always has an audit reason, `GAUGE_LAYOUT_INVALID` always has a layout reason, `GAUGE_PROTECTED` has a protected reason or none, and every other code has a manifest reason or none.

The layout calls are checked the same way. A layout is read from own properties, with the grid and the tiles checked and no unknown field, and it must be in canonical order. A state in safe mode has revision 0 and a cause, and a saved state has a revision of 1 or more. A list of revisions is newest first, with falling numbers, at most 10. An export must be the canonical text of a layout. A layout plan must answer the request: the same kind, place, Gauge, revision, and text. Its last line must be the bind line that names its own two hashes, and for a plan that sets a layout the `nextHash` must be the SHA-256 of the canonical text of the text that was sent (a text that is not a layout has no plan). The client's own code uses no platform module: the hash is pure code, and a text is measured with `TextEncoder` after a cheap check of its length. The client still imports `node:crypto` through `packages/gauge-errors` and `Buffer` through `packages/gauge-manifest`, so a webview bundle needs a polyfill until a later ticket removes them. An applied change must name the plan's kind, and a plan that changes the layout cannot come back as unchanged.

The session calls are checked the same way, into fresh frozen objects, from own data properties: a getter never runs, and an own accessor reads as missing. A list is read once, by index (an iterator, a subclass of Array, a hole, and an accessor index are refused), so a list that changes between two reads cannot put a number in a frozen plan. A session plan must have every field, with the fields of the other action empty (a start has no session and no `force`, a stop has no program, model, variables, or shared engines). Its Gauge, engine, folder, billing source, and nonce are checked, its `variables` and `sharedWith` must be dense lists in strict order, the program may hold no control, format, or separator character, and no step may hold a character that `escapeForPlan` escapes. The request of `planSessionStart` is read once, and the plan is checked against those values. `applySession` reads the action, the engine, and the session from the copy that it sends, and throws a `TypeError` for a plan with no own action, engine, or (for a stop) session. A plan must answer the request: the same action, Gauge, and engine; a start has the model that was asked and every variable that was asked; a stop has the session that was asked. An applied plan must fit its plan: the same action and engine, a stop for the same session that gives `stopped`, and a start in a state past `ready`. A session has a failure if and only if it is `failed`. A list holds only sessions of the asked engine, with no repeat. `ENGINE_REQUEST_INVALID` always has a request reason of the closed set, `ENGINE_NOT_FOUND` always has one of `engine`, `program_missing`, or `program_not_executable`, `ENGINE_START_FAILED` always has one of `program_missing`, `not_executable`, `folder_unusable`, `resource_limit`, `adapter_error`, `shutting_down`, `timed_out`, or `other`, and every other engine code has no reason. A session list holds at most 320 sessions (`MAX_SESSIONS_LISTED`), the live sessions and the 256 that ended last.

The jobs and runs calls are checked the same way, with `src/jobs-reply.ts`, into fresh frozen objects, from own data properties. A job is read with the one definition check of `packages/jobs`, so a core that stores a definition that the check refuses is found at once, and a job plan must hold the definition that was asked for, with the hash of it as `nextHash`, and the shape of its kind (a create has no job and no base hash, an update has both, a delete has a job and a base hash and no definition and no next hash). The last step of a job plan binds the change to its two hashes. A run plan has one to eight sessions with distinct labels, every field checked, and `shared` must be true exactly when a session shares its folder. A run answers its plan: the same job, and the same labels and engines in the same order. A session of a run has a state of the host, `forgotten`, or `hidden`, and it has no id exactly when it is hidden.

A Gauge summary has these six fields, all present: `id`, `title`, and `version` are strings, `kind` is `ui` or `data`, `origin` is `stock` or `third-party`, and `protected` is a boolean. The client reads each field once and checks the value it read. It hands back a new frozen object made from those six values. Any other field is dropped. A list is frozen too.

`ok` decides. A reply with `ok: true` is a success, and a `code` that it also carries is ignored. A reply with `ok: false` is a refusal, and a `result` that it also carries is ignored.

A throw while the client reads a reply, from a getter or a proxy, becomes a `CoreProtocolError`.

`CoreProtocolError` carries the `method` that failed, and its message starts with it. A value that is shown in a message is printed as JSON on one line. It is cut once to 64 characters, between two pieces of text so an escape is never split, and it ends with `...` when it was cut.

A core that throws from the call itself is not wrapped. Its own error reaches the caller unchanged. A later ticket decides how transport failures map to codes.

## The client reaches no host

The client imports only the pure modules of `packages/engine-sessions` (`request`, `states`, `session`, `text`, `vocab`), never its host, its launcher, or its fixtures, so a webview bundle holds no file system and no child process. `test/client-purity.test.ts` reads the compiled module graph of the client and fails when it reaches `host`, `process-launcher`, `fake-core`, `node:fs`, `node:child_process`, or any platform module but `node:crypto` (through the error registry).

## Where the codes come from

Codes come from the registry in `packages/gauge-errors`, which is the package `@bowerloom/gauge-errors`. `ENGINE_CODES` is tied to the registry at compile time (`EngineCodesMatchRegistry` in `src/types.ts`, checked by `test/engine-codes-type.test.ts`), so a code added to one and not the other stops the build. This package imports it by a relative path (`../../gauge-errors/src/index.js`), as the other packages here import each other. The build writes every package into `dist/packages/<name>`, and a relative path works there with no package entry point. The registry holds the codes. This package adds none.

## The fake core is for tests

`src/index.ts` exports the client, its types, and `CoreProtocolError`. It does not export the fake core or the fixtures, so product code cannot reach them by accident. A test imports them from their own modules: `createFakeCore` from `src/fake-core.js` and `FIXTURE_GAUGES` from `src/fixtures.js`.

## The lifecycle suite

`test/lifecycle-suite.ts` exports `runLifecycleSuite(name, makeHarness)`. `makeHarness(folders)` gives a core that holds those Gauge folders, a way to approve a plan, a way to replace a folder (as if its files changed on disk), and a way to move the clock. In the app a person approves, so the real core's harness supplies that step. The suite checks the manifest fixtures at load (each with its code), origin, the plan and approval rules for all five steps, and the routes. `test/fake-core.test.ts` runs it on the fake core, which has its own `approve`.

## The grants suite

`test/grants-suite.ts` exports `runGrantsSuite(name, makeHarness)`, the grants suite, built the same way. `makeHarness(folders, options)` gives a core that holds those folders, a way to approve a plan of either kind, and a way to move the clock. `options.auditMaxBytes` sets the audit cap for the cap test. The suite covers the plan, approval, bound hashes, a changed manifest, a missing grant, traces, revoke, engine scope, and the audit file. `test/fake-core-grants.test.ts` runs it on the fake core and adds the fake's own checks. `test/grants.test.ts` tests the pure helpers, and `test/client-grants.test.ts` tests the strict reply checks.

## The layout suite

`test/layout-suite.ts` exports `runLayoutSuite(name, makeHarness)`, built the same way. `makeHarness(folders, options)` gives a core that holds the nine stock Gauges of the bento home, the three fixture Gauges, and the given folders, with a way to approve a plan and a way to move the clock. `options.layoutFile` is the saved file the core finds when it starts. The suite covers the home, export and import (with the hostile texts), the way back, the sizes a Gauge allows, swap, the default action, plans and approvals, the 10 revisions, restore, safe mode, and a Gauge that proposes to add itself. Every expected value is written out in the suite. `test/fake-core-layout.test.ts` runs it on the fake core and adds the fake's own checks. `test/client-layout.test.ts` tests the strict reply checks.

## The sessions suite

`test/sessions-suite.ts` exports `runSessionsSuite(name, makeHarness)`, built the same way. `makeHarness(folders)` gives a core that holds those Gauge folders and the engines of `SESSION_ENGINES`, each behaving as its steps say, with an environment of `SESSION_ENVIRONMENT`, a way to approve a plan (and to give the second approval), a way to move the clock, folders that exist, and the means to count the programs the core started and to read what each wrote. The suite covers the plan, the approval rules, the states a session moves through, the cap, the pair rule, the shared folder, the stop, a stop that times out, the reads, and the scope of the grants. `test/fake-core-sessions.test.ts` runs it on the fake core over real fake engines, with a check at the end of every test that no process is left behind, and adds the fake's own checks. `test/client-sessions.test.ts` tests the strict reply checks, and `test/session-plan.test.ts` pins the text of a plan. A harness may also give `link(name, target)` (a link on disk to a real folder) and `person(plan)` (what the person reads for a plan): the suite then runs the test of what a Gauge may read, with the second approval taken from the plan of the person, and a search of every reply for the real folder and for an engine that the Gauge may not read.

## The jobs suite

`test/jobs-suite.ts` exports `runJobsSuite(name, makeHarness)`, built the same way. `makeHarness(folders)` gives a core that holds those Gauge folders and the engines of `JOB_ENGINES` (those of the sessions suite and an engine that prints requests to start another), with an environment of `SESSION_ENVIRONMENT`, a way to approve a plan (and to give the second approval), a way to move the clock, folders that exist, and the means to count the programs that were started. Every expected value is written out in the suite. `test/fake-core-jobs.test.ts` runs the suite on the fake core over real fake engines, and adds checks over a host whose programs the test makes by hand, for the paths that a real program cannot reach on a fixed schedule (a session that fails to start while others run, and an undo that cannot stop a session). A harness may also give `link` and `person` (for a run plan): the suite then runs the same test for a run.

## The client suite

`test/client-suite.ts` exports `runClientSuite(name, makeCore, expected?)`. The core is its parameter. `expected` is the list of Gauges the core holds. It defaults to a list written out in the suite, so the fake core is checked against fixed values and not against itself. `test/fake-core.test.ts` runs the suite on the fake core. When the real core exists, another test file calls it with the real core and that core's own list.

## Adding a call

Write its test in the suite of its area first (`test/client-suite.ts` for a plain call). Then add the method name to `CoreMethod`, the fake core case, and the client method.

## Tests

`npm run test:core-api`
