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

The spec names the states and says "only the allowed moves are legal", and it does not list them. This table is a decision of this ticket. `starting` to `waiting` is legal because an engine may ask for its sign-in at once. `running` or `waiting` to `stopped` is the engine ending on its own with code 0, and that is the exit of its program, never a line it prints (see "What a line of an engine can do"). `starting` to `stopped` is not legal: an engine that ends before it runs is a failed start. A test lists every legal move and every illegal move by hand, and does not read the table from the source.

The table says what the machine allows. The host allows less: the claims of an engine reach only two of these moves, and a move to `failed` always has a cause.

### An illegal move

`createSession(id, log).move(to)` is the one way the state changes. An illegal move is a fault:

- A session that has not ended is marked `failed` with the failure `illegal_move`, and the fault is logged with the session id and both states: `engine session <id>: illegal move <from> -> <to>`. The log gets `{ session, from, to, message }`. The state changes before the log runs, so a log that throws cannot leave the wrong state. A log that throws is reported on standard error. The default log is standard error.
- A session that has ended keeps its state, because it reaches `stopped` or `failed` once. The fault is logged all the same.
- A value that is not a state is an illegal move too. Every text in a log line or an entry is escaped (`escapeText`): a control, format, or separator character, a backslash, a look-alike space, a blank letter, and a combining mark show as `\u{...}`, so what an engine prints cannot forge a line of the log. `FaultEntry.to` holds the escaped text.
- `move('failed')` with no cause is a bug of the caller and throws. The way to `failed` is `fail(cause)`. `fault(to)` is the host's way to refuse a claim of an engine that the table would allow: it fails the session with `illegal_move` and logs it, exactly as an illegal move does.
- In the host, a session that is failed while its program still runs gets the kill signal, so a failed session never has a live process.

`fail(cause)` is the legal move to `failed` with a named cause: `start_failed` (the program did not start, did not say it runs in time, or ended before it ran), `crashed` (it ended with an error code or a signal while running or waiting), `illegal_move`, or `adapter_error` (the adapter threw on a line). It does nothing, and logs nothing, for a session that has ended.

## The host

`createEngineHost(options)` gives the host. Only the core calls it. A Gauge reaches it through the Core API, with a plan and an approval.

- **Engines.** An `EngineSpec` has an `id` (lower-case words joined by single hyphens, at most 64 characters), a `title`, a `program`, `args`, the `env` names that the engine declares, a `billing` source, `signalOf`, and an optional `modelArgs`. At most 16 engines, with no repeat. The host keeps its own copy. The adapters for Claude Code, Codex, and OpenCode are later work. An adapter is a plain function of the app: the host runs `signalOf` and `modelArgs` as given and does not guard against an adapter that never returns.
- **What a line of an engine can do.** `signalOf(line)` reads one line of the standard output of the program and says which state it claims, as text, or `null`. A line may move a session only to `running` or `waiting`. A line that claims the state the session is in is no move. A stopping session, and a session that has ended, ignore what the engine still says. Any other claim (`stopped`, `failed`, `stopping`, `detected`, `ready`, `starting`, or a text that is not a state) is a fault, whatever the table of moves says: the session fails with `illegal_move`, the fault is logged with the session id and both states, and the process group is killed. A session ends only by the exit of its program, by the host's own stop, or by a fault, so no line can free a place while its process lives. An adapter that throws on a line is a fault too: the session fails with `adapter_error`, the id and the escaped message are logged, and the process group is killed.
- **A place is held while the process lives.** The cap, the pair rule, and the shared folder rule count a session until it has ended and its process has gone, so a session that a fault failed keeps its place until the kill has worked.
- **When the program ends.** While `starting`: `failed` with `start_failed`, with any code. While `running` or `waiting`: `stopped` for code 0 with no signal, and `failed` with `crashed` otherwise. While `stopping`: `stopped`, always. After the program has gone, whatever it left in its process group is killed.
- **What the log says.** A session that failed by an exit logs `the program ended with code <n> and no signal` (or the signal), and the last 2,048 characters of its standard error, escaped. A session that the host failed, killed, or stopped itself (a fault, a timeout, `killAll`) logs the end of its standard error too. The log is for the owner of the computer and is not part of any text a person approves. A program that is stopping and ends in a way a stop does not make (not code 0, and not SIGTERM or SIGKILL) stays `stopped` and logs the signal. A start that could not run logs the error code and message of the operating system. Every line of the log of a session goes through one sink that cuts out the values of the variables that the host gave the program (6 characters or more, and also their escaped form): a line about an adapter that threw, a claim that names a state, a start that failed, an illegal move, and the end of standard error, and also the report of a log that threw. The end of standard error is redacted before it is cut to 2,048 characters, so a value that crosses the cut leaves no part of itself: the host asks the launcher for `tailMargin` more characters (the longest value minus one, at most 65,536), redacts the whole buffer, and then cuts. A value of more than 65,537 characters is only partly covered. The values of the variables `HOME`, `PATH`, `PWD`, `TMPDIR`, `SHELL`, `USER`, `LANG`, and `LOGNAME` are not hidden, so a path in a crash stays readable. Redaction finds every place where any value occurs, merges the ranges that overlap, and replaces each merged range once, so two values where one ends inside the other leave no tail of either. It matches the value as it is (and its escaped form): no encoded form (base64, URL, a split value) and nothing under 6 characters. The values are forgotten when the program has gone. The log is the `log` option, and standard error by default. Standard error of an engine may hold anything the engine wrote, so a deployment that keeps logs must treat them as it treats that output.
- **A start timeout.** A session that is still `starting` after `startTimeoutMs` (30,000 by default, 1 to 600,000, timed by the injectable `schedule`) fails with `start_failed`, is logged, and its program is killed. The timer is cancelled when the session leaves `starting`, by a claim, an exit, a stop, or a fault.

### The plan of a start

`planStart(request)` plans from live state and changes nothing. The request has `engine`, `folder`, and optionally `model` and `variables`. Every field is read from own data properties, once. The checks run in this order, and the first that fails refuses:

1. The shape of the request (`ENGINE_REQUEST_INVALID` with the reason `engine`, `folder`, `model`, or `variables`).
2. The engine is held, and its program is on this computer (`ENGINE_NOT_FOUND`, with the reason `engine`, `program_missing`, or `program_not_executable`). A program that is there and cannot run is `program_not_executable` and never missing. A folder of PATH that cannot be searched is skipped, so it makes no program that is nowhere into one that cannot run; a given absolute path in a folder that cannot be searched is `program_not_executable`. A folder of PATH, and a working folder, that cannot be read for a reason other than that it is not there are logged with their error code, once for each folder and code on a host, so a Gauge that plans again and again cannot flood the log. A kill that the system refused is in the log of the host too (`the kill signal was refused; stop the session again`). A program whose real path holds a control or separator character is not offered, and reads as `program_missing`. While the host is shutting down (after `killAll`) no start is planned: the refusal is `ENGINE_START_FAILED` with the reason `shutting_down`.
3. The folder is a real folder (the reason `folder`). The variables the person allowed contain no refused name that the engine does not declare itself (the reason `variables`).
4. A model choice needs an engine with a delivery path (`MODEL_NOT_FOR_ENGINE`).
5. The engine has no session that has not ended in this folder (`ENGINE_PAIR_BUSY`).
6. The cap is not reached (`ENGINE_LIMIT`).

The plan holds `engine`, `title`, `program` (the real path), `folder` (the real folder, for display), `model`, `billing`, `variables` (those the engine declares and those the person allowed, sorted, with no repeat), and `sharedWith` (the engines that already run in the folder, sorted). The 32 names of the cap count this whole list, the engine's own names and the person's together, so no approved plan can fail to start for a count: a request that would give more than 32 is refused with the reason `variables`.

- **The cap** is 4 by default (`DEFAULT_SESSION_CAP`), a whole number from 1 to 64. It counts the sessions that have not ended. A stopped or failed session frees its place. A stopping session keeps its place, because its process may still run.
- **One session for each engine and folder pair.** A second start of the pair is `ENGINE_PAIR_BUSY`. This is checked before the cap.
- **A folder is named by its device and inode.** The folder text must be an absolute path that is already normal (no `..`, no `.`, no empty segment, no trailing slash), at most 1,024 characters, with no control, format, separator, unassigned, private-use, or surrogate character, and it is never the root. The host then takes its real path (`realpath`), which must be a directory, and its device and inode (`stat`). The pair rule and the shared folder rule compare the device and the inode, so a link, a different case on a volume that ignores case, a different normal form of a letter, and a firmlink all name one folder. The plan shows the real path, for display only. The key is read at plan time and again when the start begins. A project folder under iCloud Drive is not refused yet: it is not built.
- **A second engine in one folder.** `sharedWith` names the engines already there. `beginStart` refuses such a plan with `ENGINE_FOLDER_SHARED` unless the core says the person gave the second approval.
- **A model choice** is `null` (the engine's own default) or a provider and a model, each 1 to 128 characters of the plain charset `A-Z a-z 0-9 . _ : / @ + -`, starting with a letter or a digit, so a value cannot be taken for a flag or for anything a shell or a path means. The core never picks another model on its own, so a choice for an engine with no `modelArgs` is refused. It is never dropped. An engine with `modelArgs` gets the choice as the arguments that function gives, after the arguments of the spec. Slice two of the spec (a main model for a session) ships only where a delivery path is proved, so no real engine has one yet. The host does not check the choice against a catalog of providers: that is not built.
- **Billing.** The source comes from the engine spec: `engine-plan` or `local`. A caller cannot pick it. A spec with a provider key as its source is refused when the host is made, because the keys and the spend approval are not built.
- **Variables.** The request lists names. The values are never in a request, a plan, or a log: the host copies each value from its environment (`process.env` by default) when the program starts. A name is letters, digits, and underscores, not starting with a digit, at most 64 characters, at most 32 names, with no repeat. This is a denylist, in any case: names that start with `LD_` or `DYLD_`, and `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `PYTHONSTARTUP`, `PYTHONPATH`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `NODE_PATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and `PATH`. A caller may not ask for them. A denylist cannot name every variable that changes how a program starts, so it is a floor and not a guarantee, and the person reads every name in the plan before it applies. An engine may declare any of them except the loader names (`LD_*`, `DYLD_*`, `NODE_OPTIONS`), since an adapter is code of the app: an engine that declares `PATH` gets `PATH`, and a plan that lists it is planned again and accepted.

### Starting

`beginStart(plan, { sharedApproved })` plans again from live state. Only the value `true` is the second approval. The plan given must be the plan that comes out: a plan that no longer matches is a bug in the caller, and it throws. It then makes the session and asks the launcher to run the program, all before it returns, so a second call in the same tick sees the first. The session walks `detected`, `ready`, `starting`. `settled` resolves when the program has started, with the session in `starting` (it may have moved on), or with `ENGINE_START_FAILED` when it could not start. A start that fails still leaves a `failed` session, so the person can see it.

The program is started with the argument list, never through a shell, in the real folder, with a clean environment: exactly the variables of the plan that are set in the host's environment, and nothing else. The program is asked for before the launch is counted: a `modelArgs` that throws counts no launch. A launch that throws, or an error event, fails the session, logs the cause with the session id, kills a handle that was made before the throw, and gives the person `ENGINE_START_FAILED` with a reason from a closed set: `program_missing`, `not_executable`, `folder_unusable`, `shutting_down`, `timed_out`, or `other`. The reason comes from the error code of the operating system and says nothing else: `EACCES` is `folder_unusable` when the working folder cannot be searched and `not_executable` otherwise, `E2BIG`, `EMFILE`, `ENFILE`, `EAGAIN`, and `ENOMEM` are `resource_limit`, a `modelArgs` that throws is `adapter_error`, and any other code is `other`, which the log explains. The program is started from the plan that planning verified, and the host registers the exit listener before it can fire. A session whose program was made keeps its place until the exit is seen.

### When the start is over

`settled` resolves when the program has spawned (or could not). A program can spawn and then end before it says it runs, so `settled` alone does not say that the start worked. `started` resolves when the session has left `starting`, once, and keeps its answer: `ok` with the session `running` or `waiting`, or `ENGINE_START_FAILED` with a reason of its own. `exited`: the program ended before it said it runs. `timed_out`: the start timeout (30 s by default, timed by the injectable `schedule`) failed the session, so `started` is always bounded. `adapter_error`: the adapter threw. `illegal_claim`: the engine claimed a state that no line may claim. `stopped`: the person's stop or the end of the host cut the start short (this reason is the same for `settled` of a launch that failed while the session was stopping, in `started` only). A launch that failed gives its own reason in both. The session announces each change of state to the host at once (`createSession(id, log, onChange)`, whose listener never changes a state or an answer when it throws).

### Starting a group

A run of a job starts several sessions through one plan (`packages/jobs`). The host plans and begins them as one group.

- `planStartGroup(requests)` takes a plain list of 1 to `MAX_START_GROUP` (8) requests and gives one plan for each, or the first refusal with its `index`. It changes nothing. Each member is planned as if the members before it had started, so the cap, the pair rule, and the shared folder count the group as well as the live sessions: a group that is planned is a group that can begin. A member that shares a folder with an earlier member lists that engine in `sharedWith` (the first member of a folder lists none, since the members after it have not begun).
- `beginStartGroup(plans, { sharedApproved })` plans the group again from live state. A refusal (the state changed so that a member no longer fits) is given with its `index`. Plans that differ from what comes out, also in their order, are a bug of the caller and throw. A group with any member that shares a folder needs `sharedApproved: true`, and the refusal `ENGINE_FOLDER_SHARED` names the first such member. Then every member is made, and its program asked for, before the call returns, from the plans that the host checked itself: a member whose launch fails at once frees its place, and no later member plans again against that. Each member settles on its own (`members[i].settled`). If a step throws part way (a bad session id), the members that began are stopped, and stopped again with the kill signal when the first stop times out. Each is logged with its session id, a stop that throws is logged and never replaces the original error, and the member that threw made no session (the id and the environment are read before the session is recorded), so it holds no place. A plan of the caller is read once from own data properties, and anything that is not a start plan throws a `TypeError`.
- A list of another shape (not a plain list, a hole, an accessor, empty, or more than 8) is a bug of the caller and throws a `TypeError`.
- The host does not undo a group. A caller that sees one member fail stops the others (the Core API does this for a run).

### Stopping

`beginStop(id)` moves a `starting`, `running`, or `waiting` session to `stopping` and sends the stop signal (SIGTERM) to the program and everything it started. `settled` resolves when the program has gone, with the session `stopped`.

- **A stop that times out** leaves the session `stopping` and gives `ENGINE_STOP_TIMEOUT`. The wait is 5,000 ms by default (`DEFAULT_STOP_TIMEOUT_MS`), a whole number from 1 to 600,000. When the program goes later, the session becomes `stopped`.
- **A second stop** of a session that is `stopping` sends the kill signal (SIGKILL), which cannot be ignored. The spec does not say how a stuck session ends, and this is the decision of this ticket. The plan of that stop says so, with `force: true`.
- **A stop of a session that has ended but whose program has not gone** is the kill again, with `force: true`. A kill that the system refused (`EPERM`) leaves such a session holding its place, and this is the way to retry. The session keeps its state and its cause, and the place is free when the exit is seen. A session that has ended and whose program has gone is `ENGINE_SESSION_ENDED`. `Launched.signal` gives true when the signal was sent or the group is gone, and false when the system refused it.
- A session that is not there is `ENGINE_SESSION_UNKNOWN`. One that has ended is `ENGINE_SESSION_ENDED`. A session id that is not a short lower-case token is a malformed request (the reason `session`).
- `stop(id)` begins and waits. The app will use it for "Stop all". `killAll()` kills every program that is left, waits for it (`killWaitMs`, 5,000 by default), and gives the number of programs that were still alive after the wait, so a caller can tell that a kill did not work. A program that it ends is recorded as `stopped`, not `crashed`, and each session whose program was still alive after the wait is logged. It is for the end of the app and for the clean-up of a test.

### Reads

`list(engine?)` and `get(id)` give new frozen copies: `id`, `engine`, `folder`, `state`, `billing`, `model`, `failure`. They hold no output of the engine. The host keeps every live session and the newest 256 that have ended (`KEEP_ENDED_SESSIONS`), so a list holds at most `MAX_SESSIONS_LISTED` (320) sessions. The session that ended first is dropped first, whatever order the sessions began in. A session whose program has not been seen to go is never dropped. A dropped session reads `ENGINE_SESSION_UNKNOWN` once 256 newer sessions have ended. Reading output is a stream, and needs a permission of its own.

## The process launcher

`createProcessLauncher()` starts real programs. The host takes any `Launcher`, so a test can pass its own.

- An argument list, `shell: false`. A shell word in an argument is a plain word.
- The environment is exactly the one given.
- No standard input (`/dev/null`). The core never answers a permission prompt of the engine: the person answers it in the app. A pane that lets the person type is later work.
- The program leads its own process group. A signal reaches the program and everything it started in that group. When the program has gone, its group gets SIGKILL, so a helper that stayed in the group cannot outlive it. A signal sent after the group is gone is dropped. There is a short window in which an operating system could reuse the group id, since a group is named by the pid of its leader. The launcher kills at the moment of exit, to keep that window small.
- **When the core process ends.** The launcher keeps the process groups that are running. When this process exits, it kills each group with SIGKILL, with no asynchronous work. A group is known from the moment the program is made, not from the later spawn event. The state (the groups, the handlers, the exit hook) is kept in one slot of the global object, `Symbol.for('latebrake.engine-launcher')`, so two copies of this module share one cover. The exit hook and the handlers for SIGINT, SIGTERM, SIGHUP, and SIGQUIT are marked as the launcher's own, are installed again at every launch if they are missing, and are put first in the list of listeners.
- **A signal, and the app's own listener.** When the app has a listener of its own for a signal (also one registered with `once`), the signal is the app's: the launcher does nothing, the engines stay up, and the app is expected to shut them down itself (`killAll`). They are killed by the exit hook at the latest, when the process ends. When no listener but the launcher's is left, the launcher kills the groups, removes its handlers, and sends the signal again, so the process ends as it would have without it. `killLiveGroups()` kills the groups on demand. The app still has to ask the person before it quits with sessions running ("Stop all" or "Cancel quit"): that wiring is the app's job.
- **Known limits.** This is the part that no test can fully close. A helper that leaves the group of its engine (a daemon, `setsid`) is out of reach of every signal this launcher sends, and it survives a stop, an exit, and the core ending. A core that is killed with SIGKILL, or that crashes without running its handlers, leaves its engines running. An engine in its own group is killed when the core ends cleanly, and when its session stops or fails. Nothing else is promised. A test documents the escaped helper with a fake engine step.
- Standard output is read in lines of at most 4,096 characters. The rest of a longer line is dropped, and that is a known gap: a signal that an engine writes after such a long line is not read until the next line. Standard error is read so the pipe never fills, and only its end is kept for the log. A signal that fails for a reason other than a gone group (not `ESRCH`), and an error of a pipe or of the program, are logged with the session id and the pid (`label` of the launch), escaped (`log` option, standard error by default). A log that throws never escapes `signal`: the line goes to standard error. The group is marked gone as soon as it was killed at exit, so no later signal can reach a reused id.
- After the program has gone, the launcher waits up to 500 ms for its output to close, and then closes it, so a helper that kept the pipe cannot hold a session. The end of its standard error (2,048 characters) comes with the exit.

## Codes

All codes are in `packages/gauge-errors`.

| code | when | reason |
|---|---|---|
| `ENGINE_REQUEST_INVALID` | the request is malformed | `engine`, `folder`, `model`, `variables`, or `session` (always one) |
| `ENGINE_NOT_FOUND` | no such engine, or its program is not on this computer or cannot run | `engine`, `program_missing`, or `program_not_executable` (always one) |
| `MODEL_NOT_FOR_ENGINE` | a model choice for an engine that cannot take one | none |
| `ENGINE_PAIR_BUSY` | the engine has a session in this folder | none |
| `ENGINE_LIMIT` | the cap is reached | none |
| `ENGINE_FOLDER_SHARED` | another engine runs in the folder, and the second approval is missing | none |
| `ENGINE_START_FAILED` | the program could not start, or the host is shutting down | `program_missing`, `not_executable`, `folder_unusable`, `resource_limit`, `adapter_error`, `shutting_down`, `timed_out`, `exited`, `stopped`, `illegal_claim`, or `other` (always one; `other` means see the log) |
| `ENGINE_SESSION_UNKNOWN` | no session has the id, or none that the Gauge may use (the Core API says the same for both) | none |
| `ENGINE_SESSION_ENDED` | the session has stopped or failed already | none |
| `ENGINE_STOP_TIMEOUT` | the program did not go in time | none |

`ENGINE_LIMIT` and `ENGINE_STOP_TIMEOUT` are the names in the spec. The registry's naming rule now takes `ENGINE` as a second scope word beside `GAUGE`, so these names stand. The other names follow them.

## Not built

A plan that a Gauge reads and the plan that the person reads are one plan, so a Gauge with `sessions.start` sees the real path of the folder and `sharedWith` (the engines in it) in what it plans. The folder reasons are one reason already, so a Gauge learns nothing more from a refusal. Showing a Gauge less than the person is a design change of the Core API (two plans), and it is not built.

Real engine adapters, detection and the list of engines on the computer, the preview switch, `ENGINE_VERSION_UNKNOWN`, `ENGINE_PREVIEW_OFF`, `ENGINE_HARNESS_BLOCKED`, the iCloud Drive refusal, the model catalog and its checks, keys, `MODEL_SPEND_NOT_APPROVED`, the live message stream, attach and send, the terminal pane, "Stop all" on quit, Windows and Linux process handling, and a check of the engine version.

## The fake engine

`src/fake-engine-program.ts` is a scriptable engine that the process launcher starts as a child process: `node fake-engine-program.js --tag <tag> --script <json>`. The script is a list of steps: `say`, `sleep`, `exit`, `ignoreTerm`, `spawnChild`, `spawnEscaped`, `spawnEscapedHolding`, `printEnv`, `printArgs`, `printCwd`, `readStdin`, `hold`, `crash`, `stderr`, and `stderrBytes`. `src/fixtures.ts` has the types and `fakeEngine(...)`, which gives an `EngineSpec` for it. A line `state:<name>` claims that state. The fixtures are for tests, and `src/index.ts` does not export them.

The tag goes in the argument list of the engine and of every helper it starts. `test/leaks.ts` is the orphan detector: it lists the processes of the computer (`ps`) and finds each live one that holds the tag. Every test that starts an engine ends with `assertNoLeaks(tag)`, in a `finally` or an `after` hook, which fails the test and kills what it found. A test proves the detector itself with a fake engine that it leaves running on purpose, outside any host, and kills in a `finally`.

`liveDescendants(pid)` is a detector that needs no tag: it walks the parent links of the process table and finds every live descendant, so a leak is found even when a helper carries no tag. Every host test ends by checking both detectors, and checks before any kill that no process lives behind a session that has ended. A test proves the second detector on an untagged process that it leaks on purpose.

The detector reads `ps`, so the process tests run on macOS and Linux.

## Tests

`npm run test:engine-sessions`
