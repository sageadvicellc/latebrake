# engine-sessions

The engine sessions of the Engine Host (v0.9.1): the session states and their legal moves, the session machine, the host that starts, watches, and stops sessions, and a process launcher. It holds the rules of the cap, of one session for each engine and folder pair, and of a folder that two engines share. The Core API carries it over the seam: `packages/core-api` holds the plans and the approvals, and asks the host to do what the person approved. This README is the contract.

Out of scope here: real engine adapters, model sources and keys, relay, traces, the terminal pane, and the app. The fake engines of the tests stand in for real ones.

## Session states

The states are `detected`, `ready`, `starting`, `running`, `waiting`, `stopping`, `stopped`, and `failed`. `waiting` is a state and not an error: the engine waits for the person, for example for its own sign-in.

A session reaches `stopped` or `failed` once. A new start makes a new session. These 18 moves are legal, and every other move of the 8 x 8 table is illegal, a move to the same state included:

| from | to |
|---|---|
| `detected` | `ready`, `failed` |
| `ready` | `starting`, `failed` |
| `starting` | `running`, `waiting`, `stopping`, `failed` |
| `running` | `waiting`, `stopping`, `stopped`, `failed` |
| `waiting` | `running`, `stopping`, `stopped`, `failed` |
| `stopping` | `stopped`, `failed` |
| `stopped`, `failed` | none |

The spec names the states and says "only the allowed moves are legal", and it does not list them. This table is a decision of this ticket. `starting` to `waiting` is legal because an engine may ask for its sign-in at once. `running` or `waiting` to `stopped` is the engine ending on its own with code 0. `starting` to `stopped` is not legal: an engine that ends before it runs is a failed start. A test lists every legal move and every illegal move by hand, and does not read the table from the source.

### An illegal move

`createSession(id, log).move(to)` is the one way the state changes. An illegal move is a fault:

- A session that has not ended is marked `failed` with the failure `illegal_move`, and the fault is logged with the session id and both states: `engine session <id>: illegal move <from> -> <to>`. The log gets `{ session, from, to, message }`. The state changes before the log runs, so a log that throws cannot leave the wrong state. A log that throws is reported on standard error. The default log is standard error.
- A session that has ended keeps its state, because it reaches `stopped` or `failed` once. The fault is logged all the same.
- A value that is not a state is an illegal move too, and the log prints it as an escaped text.
- In the host, a session that is failed while its program still runs gets the kill signal, so a failed session never has a live process.

`fail(cause)` is the legal move to `failed` with a named cause: `start_failed` (the program did not start, or ended before it ran), `crashed` (it ended with an error code or a signal while running or waiting), or `illegal_move`. It does nothing, and logs nothing, for a session that has ended.

## The host

`createEngineHost(options)` gives the host. Only the core calls it. A Gauge reaches it through the Core API, with a plan and an approval.

- **Engines.** An `EngineSpec` has an `id` (lower-case words joined by single hyphens, at most 64 characters), a `title`, a `program`, `args`, the `env` names that the engine declares, a `billing` source, `signalOf`, and an optional `modelArgs`. At most 16 engines, with no repeat. The host keeps its own copy. The adapters for Claude Code, Codex, and OpenCode are later work.
- **Reading the state of an engine.** `signalOf(line)` reads one line of the standard output of the program and says which state it claims, or `null`. The machine decides whether the claim is a legal move. A line that claims the state the session is in is no move. A stopping session, and a session that has ended, ignore what the engine still says. A claim that is not a legal move is a fault. An adapter that throws on a line is reported on standard error, and the session is left as it was.
- **When the program ends.** While `starting`: `failed` with `start_failed`, with any code. While `running` or `waiting`: `stopped` for code 0 with no signal, and `failed` with `crashed` otherwise. While `stopping`: `stopped`. After the program has gone, whatever it left in its process group is killed.

### The plan of a start

`planStart(request)` plans from live state and changes nothing. The request has `engine`, `folder`, and optionally `model` and `variables`. Every field is read from own data properties, once. The checks run in this order, and the first that fails refuses:

1. The shape of the request (`ENGINE_REQUEST_INVALID` with the reason `engine`, `folder`, `model`, or `variables`).
2. The engine is held, and its program is on this computer (`ENGINE_NOT_FOUND`). A program whose real path holds a control or separator character is not offered, and reads as not found.
3. The folder is a real folder (the reason `folder`).
4. A model choice needs an engine with a delivery path (`MODEL_NOT_FOR_ENGINE`).
5. The engine has no session that has not ended in this folder (`ENGINE_PAIR_BUSY`).
6. The cap is not reached (`ENGINE_LIMIT`).

The plan holds `engine`, `title`, `program` (the real path), `folder` (the real folder), `model`, `billing`, `variables` (those the engine declares and those the person allowed, sorted, with no repeat), and `sharedWith` (the engines that already run in the folder, sorted).

- **The cap** is 4 by default (`DEFAULT_SESSION_CAP`), a whole number from 1 to 64. It counts the sessions that have not ended. A stopped or failed session frees its place. A stopping session keeps its place, because its process may still run.
- **One session for each engine and folder pair.** A second start of the pair is `ENGINE_PAIR_BUSY`. This is checked before the cap.
- **A folder is the real folder.** The folder text must be an absolute path that is already normal (no `..`, no `.`, no empty segment, no trailing slash), at most 1,024 characters, with no control, format, or separator character, and it is never the root. The host then takes its real path (`realpath`), which must be a directory. So two names for one folder, a link and its target, are one folder for the pair rule and the shared folder rule, and the plan shows the real folder. A project folder under iCloud Drive is not refused yet: it is not built.
- **A second engine in one folder.** `sharedWith` names the engines already there. `beginStart` refuses such a plan with `ENGINE_FOLDER_SHARED` unless the core says the person gave the second approval.
- **A model choice** is `null` (the engine's own default) or a provider and a model, each 1 to 128 plain characters. The core never picks another model on its own, so a choice for an engine with no `modelArgs` is refused. It is never dropped. An engine with `modelArgs` gets the choice as the arguments that function gives, after the arguments of the spec. Slice two of the spec (a main model for a session) ships only where a delivery path is proved, so no real engine has one yet. The host does not check the choice against a catalog of providers: that is not built.
- **Billing.** The source comes from the engine spec: `engine-plan` or `local`. A caller cannot pick it. A spec with a provider key as its source is refused when the host is made, because the keys and the spend approval are not built.
- **Variables.** The request lists names. The values are never in a request, a plan, or a log: the host copies each value from its environment (`process.env` by default) when the program starts. A name is letters, digits, and underscores, not starting with a digit, at most 64 characters, at most 32 names, with no repeat. A name that starts with `LD_` or `DYLD_`, and `NODE_OPTIONS`, are refused, because they make a program load code of the caller's choice. A spec cannot declare them either.

### Starting

`beginStart(plan, { sharedApproved })` plans again from live state. The plan given must be the plan that comes out: a plan that no longer matches is a bug in the caller, and it throws. It then makes the session and asks the launcher to run the program, all before it returns, so a second call in the same tick sees the first. The session walks `detected`, `ready`, `starting`. `settled` resolves when the program has started, with the session in `starting` (it may have moved on), or with `ENGINE_START_FAILED` when it could not start. A start that fails still leaves a `failed` session, so the person can see it.

The program is started with the argument list, never through a shell, in the real folder, with a clean environment: exactly the variables of the plan that are set in the host's environment, and nothing else. There is no start-signal timeout: an engine that never says it runs stays in `starting`. That is not built.

### Stopping

`beginStop(id)` moves a `starting`, `running`, or `waiting` session to `stopping` and sends the stop signal (SIGTERM) to the program and everything it started. `settled` resolves when the program has gone, with the session `stopped`.

- **A stop that times out** leaves the session `stopping` and gives `ENGINE_STOP_TIMEOUT`. The wait is 5,000 ms by default (`DEFAULT_STOP_TIMEOUT_MS`), a whole number from 1 to 600,000. When the program goes later, the session becomes `stopped`.
- **A second stop** of a session that is `stopping` sends the kill signal (SIGKILL), which cannot be ignored. The spec does not say how a stuck session ends, and this is the decision of this ticket. The plan of that stop says so, with `force: true`.
- A session that is not there is `ENGINE_SESSION_UNKNOWN`. One that has ended is `ENGINE_SESSION_ENDED`. A session id that is not a short lower-case token is a malformed request (the reason `session`).
- `stop(id)` begins and waits. The app will use it for "Stop all". `killAll()` kills every program that is left and waits for it, for the end of the app and for the clean-up of a test.

### Reads

`list(engine?)` and `get(id)` give new frozen copies: `id`, `engine`, `folder`, `state`, `billing`, `model`, `failure`. They hold no output of the engine. Reading output is a stream, and needs a permission of its own.

## The process launcher

`createProcessLauncher()` starts real programs. The host takes any `Launcher`, so a test can pass its own.

- An argument list, `shell: false`. A shell word in an argument is a plain word.
- The environment is exactly the one given.
- No standard input (`/dev/null`). The core never answers a permission prompt of the engine: the person answers it in the app. A pane that lets the person type is later work.
- The program leads its own process group. A signal reaches the program and everything it started. When the program has gone, its group gets SIGKILL, so a helper it left behind cannot outlive it and no process is orphaned. A signal sent after the group is gone is dropped. There is a short window in which an operating system could reuse the group id, since a group is named by the pid of its leader. The launcher kills at the moment of exit, to keep that window small.
- Standard output is read in lines of at most 4,096 characters. The rest of a longer line is dropped. Standard error is read and dropped.
- After the program has gone, the launcher waits up to 500 ms for its output to close, and then closes it, so a helper that kept the pipe cannot hold a session.

## Codes

All codes are in `packages/gauge-errors`.

| code | when | reason |
|---|---|---|
| `ENGINE_REQUEST_INVALID` | the request is malformed | `engine`, `folder`, `model`, `variables`, or `session` (always one) |
| `ENGINE_NOT_FOUND` | no such engine, or its program is not on this computer | none |
| `MODEL_NOT_FOR_ENGINE` | a model choice for an engine that cannot take one | none |
| `ENGINE_PAIR_BUSY` | the engine has a session in this folder | none |
| `ENGINE_LIMIT` | the cap is reached | none |
| `ENGINE_FOLDER_SHARED` | another engine runs in the folder, and the second approval is missing | none |
| `ENGINE_START_FAILED` | the program could not start | none |
| `ENGINE_SESSION_UNKNOWN` | no session has the id | none |
| `ENGINE_SESSION_ENDED` | the session has stopped or failed already | none |
| `ENGINE_STOP_TIMEOUT` | the program did not go in time | none |

`ENGINE_LIMIT` and `ENGINE_STOP_TIMEOUT` are the names in the spec. The registry's naming rule now takes `ENGINE` as a second scope word beside `GAUGE`, so these names stand. The other names follow them.

## Not built

Real engine adapters, detection and the list of engines on the computer, the preview switch, `ENGINE_VERSION_UNKNOWN`, `ENGINE_PREVIEW_OFF`, `ENGINE_HARNESS_BLOCKED`, the iCloud Drive refusal, the model catalog and its checks, keys, `MODEL_SPEND_NOT_APPROVED`, the live message stream, attach and send, the terminal pane, "Stop all" on quit, a start-signal timeout, Windows and Linux process handling, and a check of the engine version.

## The fake engine

`src/fake-engine-program.ts` is a scriptable engine that the process launcher starts as a child process: `node fake-engine-program.js --tag <tag> --script <json>`. The script is a list of steps: `say`, `sleep`, `exit`, `ignoreTerm`, `spawnChild`, `printEnv`, `printArgs`, `printCwd`, `readStdin`, `hold`, and `crash`. `src/fixtures.ts` has the types and `fakeEngine(...)`, which gives an `EngineSpec` for it. A line `state:<name>` claims that state. The fixtures are for tests, and `src/index.ts` does not export them.

The tag goes in the argument list of the engine and of every helper it starts. `test/leaks.ts` is the orphan detector: it lists the processes of the computer (`ps`) and finds each live one that holds the tag. Every test that starts an engine ends with `assertNoLeaks(tag)`, in a `finally` or an `after` hook, which fails the test and kills what it found. A test proves the detector itself with a fake engine that it leaves running on purpose, outside any host, and kills in a `finally`.

The detector reads `ps`, so the process tests run on macOS and Linux.

## Tests

`npm run test:engine-sessions`
