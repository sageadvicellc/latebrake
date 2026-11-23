# jobs

Jobs and runs (v0.9.1). A job is a saved definition of AI work. A run is one execution of a job: a group of sessions that start from one approved plan. This package holds the rules. `packages/core-api` carries them over the seam, with the plans, the grants, and the approvals, and asks the Engine Host (`packages/engine-sessions`) to start the sessions. This README is the contract.

Out of scope here: relay routes between the sessions of a run, the traces of a run, a Jobs Gauge, schedules, and unattended runs. The Core API refuses a schedule and an unattended run.

## The job definition

A definition is `{ title, sessions }`. Each session is `{ label, engine, harness, folder, model, task }`, and all six fields are required. `checkDefinition` reads own data properties only, once each, from a plain record (an accessor, a symbol key, a prototype of its own, and a class instance are refused), and gives a new frozen copy. A list is read by index with the one list reader of `engine-sessions` (`readList`): no iterator, no subclass, no hole, no accessor.

| field | rule | reason when wrong |
|---|---|---|
| the record | a plain record with `title` and `sessions` and no other field | `request` |
| `title` | 1 to 80 characters, no control or format character, no space at either end | `title` |
| `sessions` | a plain list of 1 to 8 | `sessions` |
| `label` | lower-case words joined by single hyphens, at most 32 characters, used once in the job | `label` |
| `engine`, `harness` | lower-case words joined by single hyphens, at most 64 characters | `engine`, `harness` |
| `folder` | an absolute path that is already normal (the rule of the Engine Host) | `folder` |
| `model` | `null` for the engine's own default, or exactly a provider and a model | `model` |
| `task` | 1 to 4,096 characters, no control, format, or separator character except a line feed and a tab | `task` |
| title, label, engine, harness, folder, model, task | looks like a secret (the scan of `gauge-manifest`), checked after the field is found good | `secret` |

The secret scan is the one of `gauge-manifest`: it knows a private key header, an access key id, tokens with a known prefix, a signed web token, and any run of 32 or more letters, digits, `_`, `+`, `=`, and `-` that mixes lower case, upper case, and a digit. It finds no secret that has none of these shapes, and it refuses a harmless word of that last shape (a 32-character mixed-case name in a title, a model, an engine id, or a folder segment is a false alarm). A job is stored and shown to every Gauge that may read jobs, so the scan is a floor and not a guarantee.

A field that is left out is refused with the reason of that field, and `model` must be written as `null`, never left out. The reasons are the closed set `JOB_REASONS`, with `job` for a malformed job id. A reason never holds a value that a caller sent.

**No schedule, no unattended run.** The definition and every session are scanned for a `schedule` field and an `unattended` field, with any value, before any other field is looked at. One of them anywhere is refused first with `GAUGE_JOB_NOT_INTERACTIVE` and the reason `schedule` or `unattended` (a schedule anywhere is named before an unattended flag anywhere), whatever else is wrong, and wherever it sits: an invalid first session never hides a schedule in a later one. v0.9.1 runs are interactive: the person watches. The `harness` is recorded and shown to the person. The Engine Host does not deliver a harness or a task to an engine yet, so they are the person's own record of the work, and nothing starts an engine with them.

`hashDefinition` is the SHA-256 of `canonicalDefinition`, a compact JSON text with a fixed order of fields. A plan for a change holds the hash of the job it was made for, so an approval is for the job the person saw.

## Ids

`src/ids.ts` is pure, with no `node:` import: the cap on jobs, `checkJobId`, and `isRunId` (a short lower-case token each). The Core API client imports it, and not the store or the run book, so a webview bundle holds neither the id maker nor the host.

## The store

`createJobStore({ cap, newId })` (with `full`, true at the cap) holds at most 64 jobs (`MAX_JOBS`), in the order they were made, in a Map. The store makes the ids (`job-` and sixteen hexadecimal characters, or the injected `newId`). A bad or repeated id is a bug and throws, before the store changes. `create` past the cap gives `GAUGE_JOB_LIMIT` and changes nothing, and a `replace` adds no job. `list` gives `{ id, title, sessions }` for each job. `get` gives a frozen job, or `undefined`.

## The run book

`createRunBook({ host, newId })` plans, begins, reads, and undoes runs.

- **`plan(job)`** plans every session through the group plan of the host (`planStartGroup`), from live state, and changes nothing. A refusal is the refusal of the host for the first session that cannot start, with its `index` and the `label` of that session: `ENGINE_NOT_FOUND`, `ENGINE_REQUEST_INVALID`, `MODEL_NOT_FOR_ENGINE`, `ENGINE_PAIR_BUSY` (also two sessions of one run in one folder with one engine), `ENGINE_LIMIT` (the run and the sessions that live now count together), or `ENGINE_START_FAILED` for a host that is shutting down. The plan lists every session with its label, engine, harness, real program, real folder, model, billing source, variables, task, and `sharedWith`: every other engine in the folder, those that run there now and those that the run starts there. It also keeps `requestedFolder` (the folder as the job names it) and `configuredProgram` (the program as the engine is configured), so a core can show a Gauge those and the person the real ones. The book never decides who reads what: that is the core. `shared` is true when any session shares its folder, and then the run needs the second approval, once for the whole run.
- **`begin(planned, { sharedApproved })`** begins every session as one group before it returns, and records the run at once (a second call in the same tick sees it and its places). The group is planned again from live state, and a plan that no longer matches is a bug of the caller and throws. Only `true` is the second approval. A refusal starts nothing and records nothing. The run id is made before any session starts, so a bad or repeated id throws with nothing running. `settled` is described below.
- **A run waits until every session says that it runs.** A spawn is not enough: a program can spawn and end at once. `settled` resolves when every session has left `starting` (`started` of the host): all of them `running` or `waiting`, or the run was undone. It is bounded by the start timeout of the host (30 s by default, and the host's `schedule` is injectable), which fails a session that does not say it runs.
- **An engine never starts another engine.** The sessions of a run are the sessions of the plan. No call adds a session to a run. What a program prints can only claim `running` or `waiting` for its own session. Any other claim, also one that an adapter makes out of a line that asks for a start, fails that session and kills its program (`engine-sessions`), and a test proves it with an adapter that does turn such lines into claims.
- **A start that fails part way is undone, at once.** The first session that does not run (its launch failed, its program ended before it said it runs, the start timeout failed it, or the person stopped it) starts the stop of every session of the run at that moment, and the wait goes on for the rest, which the stop brings out of `starting`. A stop, then the kill signal when the first stop times out. Only the first failure, in the order things happened and not the order of the plan, is reported, with its reason, the run id, and the place and label of its session (`ENGINE_START_FAILED`): the others are its consequence. It is logged with its session. When a session cannot be stopped even then, the outcome is `GAUGE_RUN_ROLLBACK_FAILED` with the same run, session, and the reason of the first failure as `cause`. The session that cannot be stopped is left running, and the run stays recorded, so the person sees which session still runs (it reads `stopping`) and stops it. A session that has ended already needs nothing. A session that cannot be stopped is logged (the `log` option, standard error by default): the run, the session, and the cause (a throw, a refusal that is not a timeout, or a stop that timed out twice), with every value escaped. A log that throws never stops the outcome from arriving. After an undo the places are free. The run is recorded in both cases and reads as a group that ended.
- **`list()` and `get(id)`** read a run as a group of its sessions, in the order of the plan: `{ id, job, title, sessions: [{ label, engine, session, state }] }`. A session reads as the state the host holds, or `forgotten` when the host has dropped it. The run holds no state of its own: it is what its sessions are, so a Gauge reads one answer. A read gives new frozen values.
- **The history is bounded by the history of the host.** The host keeps every live session and the newest 256 that have ended, and drops the one that ended first. The book keeps a run while the host keeps any of its sessions, and drops it when the last is gone, so runs go in the order their sessions ended, and a long run that ends last outlives runs that began after it. The book has no clock and no timer. `size` is the number of records now: a call to `begin` prunes first, so it stays within one of what the host keeps even when nobody reads the list.

Stopping a whole run is not built: each session of a run is stopped through the session calls of the Core API, with their own plans.

## Codes

| code | when | reason |
|---|---|---|
| `GAUGE_JOB_INVALID` | a definition or a job id is malformed | one of `JOB_REASONS` (always one) |
| `GAUGE_JOB_UNKNOWN` | no job has the id | none |
| `GAUGE_JOB_LIMIT` | 64 jobs are held already | none |
| `GAUGE_JOB_NOT_INTERACTIVE` | a schedule or an unattended run | `schedule` or `unattended` (always one) |
| `GAUGE_RUN_UNKNOWN` | no run has the id | none |
| `GAUGE_RUN_ROLLBACK_FAILED` | a session failed to start and one that had started could not be stopped | none (the reply holds `run`, `member`, and `cause`) |

The engine codes of a run are those of the sessions (`packages/engine-sessions`). All codes are in `packages/gauge-errors`.

## Not built

Relay routes inside a job (ticket 8), traces of a run, stopping a whole run, delivering the task to the engine (needs the message paths of the adapters), a check that a harness exists, a refusal that names the session that failed, a Jobs Gauge, and persistence of jobs on disk.

## Tests

`npm run test:jobs`
