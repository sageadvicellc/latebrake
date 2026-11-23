# relay

Relay (v0.9.1): the messages and the routes of a run. A job names routes between its sessions. When a run starts, one relay bus carries the messages of that run, under the rules the person sets. This package holds the rules and a fake engine pair (in `test/fixtures.ts`) that tests them. `packages/core-api` will carry them over the seam, with plans and grants. This README is the contract.

Out of scope here: the Core API calls and the Gauge views of relay (see "Not built"), the traces feed, the real engine adapters, how a session secret reaches an engine, cost counting, and any transport. The bus runs inside the process of the core. It has no socket, no remote transport, no chat channel, and no link between computers.

## Routes

A route is a person-approved cable between two sessions of a job: a sender, a receiver, and one rule. It grants no authority to run or to write. A route names its sessions by label. `checkRouteDefinitions(value, labels)` checks the routes of a job against the labels of its sessions. `resolveRoutes(definitions, members)` turns the labels into session ids and gives each route the id `route-<n>`, in the order of the job, when a run starts. A rename of a label never breaks delivery, because the bus knows ids only.

| field | rule | reason when wrong (`GAUGE_ROUTE_INVALID`) |
|---|---|---|
| the list | a plain list of at most 32, read with `readList` (no iterator, subclass, hole, or accessor), each a plain record. A list over 4,096 is not read at all and gives `request` | `request`, and `limit` for 33 to 4,096 |
| `from`, `to` | a label of the job; the two differ | `session`, `self` |
| the pair | at most one route for each sender and receiver; the opposite direction is a route of its own | `repeat` |
| `rule` | `accepted-output` or `auto`. A route with no `rule` is an `accepted-output` route, the safe default: the person approves each message | `rule` |
| `messageCap` | a whole number from 1 to 1,000. Default 50 | `cap` |
| `loopCap` | a whole number from 1 to 100. Default 6 | `cap` |
| an `auto` route | must be written out as `auto`, with both caps | `cap` |
| any other field | refused (a route cannot start, run, or grant anything) | `request` |

`accepted-output` is the default: the person approves each message. `auto` lets messages flow, and the core logs each one. A reason never holds a value that a caller sent. The first failure in the order of the list is the one that is told.

Routes live in a job. This ticket does not add them to the job definition, the job plan, or the Core API: see "Not built".

## The envelope

One JSON frame holds one message: `run`, `route`, `sender`, `receiver`, `body`, `time` (milliseconds since the epoch, from the clock of the core), and `key` (the idempotency key). Every address is a stable id. `checkEnvelope` reads a frame as a plain record of exactly those seven fields, and the bus builds every envelope through it. `frameOf` writes it as compact JSON, with the fields in a fixed order and no line break.

Ids, keys, secrets, receipts, and nonces are branded types (`RouteId`, `MessageId`, `IdempotencyKey`, `SessionSecret`, `Receipt`, `Nonce`): a plain string does not pass where one is wanted, and each is made by one guard that checks its shape.

- **The body** is text of 1 to 16,384 bytes of UTF-8. A body over the limit is refused first, as `GAUGE_MESSAGE_TOO_LARGE`, before it is read for anything else. A body may hold a line feed and a tab, and no other control, format, line-separator, or paragraph-separator character, no lone surrogate, no code point that has no assigned character or is for private use, no variation selector, and none of the fillers that draw as nothing (U+034F, U+115F, U+1160, U+2800, U+3164, U+FFA0), so no escape sequence reaches a terminal and no text is hidden from the person who approves it (a combining mark is allowed, and so is a character that the runtime knows). A character that is newer than the Unicode version of the runtime is refused (`GAUGE_MESSAGE_INVALID`, reason `body`). Larger content moves as a file path in a shared folder.
- **A secret in a body or a key** is refused as `GAUGE_MESSAGE_SECRET_FOUND`, with a reason that says which: `pattern` (the shape of a secret, by the scan of `gauge-manifest`: a private key header, an access key id, a token with a known prefix, a signed web token, and a run of 32 or more letters, digits, and `_ + = -` that mixes cases and digits, so a harmless identifier of that shape is a false alarm) or `relay_value` (a value that the relay hides: a session secret, and the receipt or fence nonce of a message that was given to an engine and is not delivered). A receiver that answers with a quote of the text it was given, receipt line included, is refused with `relay_value` and can tell why. A hidden value under 8 characters is not searched for. The scan is a floor and not a guarantee: a secret that is spaced, reversed, written in hex, or changed to upper case is not found.
- **The key** is 1 to 64 characters of letters, digits, and `. _ : -`, starting with a letter or a digit.

## The bus

`createRelay(options)` gives `{ write, control }`, both frozen and apart: `write` holds two functions and no reference to `control`, so an adapter is handed `relay.write` and nothing else. The options are `run`, `routes` (at most 32, already resolved), `members` (1 to 8 of `{ session, port }`), the limits `keepSettled`, `keepKeys`, `deliverTimeoutMs`, `abandonMs`, `runCap`, and `declineCap`, and the injectable `schedule`, `now`, `newId`, `newSecret`, `newNonce`, `newReceipt`, and `log`. A wrong option is a bug of the caller and throws (`TypeError`, or `RangeError` for a number out of range) before anything is made. The routes and the members are fixed when the relay is made: no call adds a route or a session, and no call reads the output of an engine. What an engine prints can start, add, or route nothing. The relay reads `state` and `deliver` of each port once, when it is made.

A `SessionPort` has `state()` (the session state of the Engine Host) and `deliver(delivery)`, which gives the text to the engine as its next input and answers with a fidelity: `exact`, `translated`, `weakened`, or `absent`. `delivery` holds the envelope, its frame, the text, and a `signal`. The adapter of an engine says how it takes a message while it runs, and the relay reports the word it gives. The Engine Host has no input path to a running engine yet, so no real port exists: see "Not built".

### The contract of an adapter

The relay cannot cancel a write that an adapter has begun, so the adapter keeps these rules, and the adapter ticket must test them:

1. **No write after the signal is aborted.** The core aborts `delivery.signal` when it gives up on the delivery: after the timeout, when a receipt comes while the engine is still taking the message, when the receiver ends, and when the relay closes (for each message that is being taken at that moment). A write that comes after it may land on a prompt of the engine, and a newline in the text then acts as Enter.
2. **One write.** The text is written as one bracketed paste, so a line feed inside it is not an Enter.
3. **The state is read again at the moment of the write.** The state that the relay read is old by then. An adapter that finds the engine waiting for the person writes nothing and rejects.
4. **Settle the promise.** A promise that never settles keeps the engine busy (see "One message at a time"). An adapter settles it, or rejects, when it stops.
5. **The session secret reaches the engine out of band**: an environment variable or a file descriptor that the tools of the model cannot print. It never appears in a prompt, in a tool list, or in a config that the model reads. The adapter ticket needs a leak test that tries to make a model print it. The relay hides the secret in its own log and refuses it in a body, and it cannot find a secret that an engine prints elsewhere.
6. **The Traces feed records the envelope** (and the frame), never `Delivery.text`, since the text holds the receipt.

### What an engine reaches: `write`

An engine reaches two calls, each with the secret of its own session, and nothing else (no approve, decline, resume, read, or close).

- `send({ session, secret, route, key, body })`.
- `confirm({ session, secret, id, receipt })`.

The core makes one secret for each live session (`control.issueSecret`), once, holds it in memory only, and forgets it when the session ends or the relay closes. A write without the right secret is refused with `GAUGE_RELAY_UNAUTHENTICATED`. A missing secret, a wrong one, the secret of another session, and an unknown session give one and the same answer. A session that ended and writes with its old secret gets its own answer, `GAUGE_RELAY_SESSION_ENDED`: the relay keeps the SHA-256 digest of that secret for this, and nothing else of it. The secret that was given is hashed once, and so is the live secret of the session (a dummy text when it has none), and the digests are compared with a constant-time compare. The digest of an ended session is stored, and is compared as it is. A refused write is logged for each session at counts 1, 2, 4, 8, and so on, with no value in the line, and every write that names no member shares one key.

`send` checks in this order, and the first failure is told:

1. The relay is closed: `GAUGE_RELAY_CLOSED` (also for a bad secret, since the state of the relay is no secret to a session of the run).
2. The request is a plain record of exactly the five fields: `GAUGE_MESSAGE_INVALID`, reason `request`.
3. The secret: `GAUGE_RELAY_UNAUTHENTICATED`, or `GAUGE_RELAY_SESSION_ENDED` for a session that ended (the state is read too, so a session that ended and was not yet told to the core gets it as well).
4. The route exists and the session is its sender: `GAUGE_ROUTE_UNKNOWN`. A route that does not exist and a route of another sender give one answer, so a session learns nothing of the routes of others.
5. The key (`GAUGE_MESSAGE_INVALID` reason `key`, or `GAUGE_MESSAGE_SECRET_FOUND`), then the body (`GAUGE_MESSAGE_TOO_LARGE`, `GAUGE_MESSAGE_INVALID` reason `body`, `GAUGE_MESSAGE_SECRET_FOUND`).
6. A repeat: the same route and key, with the same body, is dropped, and the reply is `{ ok: true, duplicate: true }` with the id, the state, and the failure reason of the first message (`evicted` for the state when the history dropped it). The same key with another body is refused (`GAUGE_MESSAGE_INVALID`, reason `key_reused`), so the second body is not lost without a word. A retry of a message that failed needs a new key.
7. A body that the person declined on this route, under any key: `GAUGE_MESSAGE_NOT_ACCEPTED`, reason `declined`.
8. The route is stopped: `GAUGE_RELAY_LOOP_CAP`, `GAUGE_RELAY_MESSAGE_CAP`, or `GAUGE_RELAY_ROUTE_PAUSED`, whichever stopped it.
9. The receiver has ended: `GAUGE_RELAY_RECEIVER_GONE`.
10. The engine of the receiver is stuck (an earlier delivery never settled): `GAUGE_RELAY_QUEUE_FULL` with the reason `receiver_stuck`. No message, no key, and no count is made, and the refusal is logged at counts 1, 2, 4, 8, and so on, so a sender that writes again and again cannot fill the ledger or the log.
11. The route holds 16 messages that wait: `GAUGE_RELAY_QUEUE_FULL`, with the reason `pending_approval` (they wait for the person) or `receiver_busy` (the receiver does not take them now: its engine is taking an earlier message, or the receiver does not run or its state cannot be read). The writer is not told which of the two causes of `receiver_busy` it is, since that would tell it that the receiver sits at a prompt. `control.routes()` shows the person the detail in `waitingOn`: `pending_approval`, `receiver_busy`, or `receiver_not_running`.

Then the message is made. The envelope takes the sender and the receiver from the route, and the time from the clock of the core, never from the request. On an `accepted-output` route the message is `pending`. On an `auto` route it is accepted at once (and counted against the caps), logged without its body, and given to the receiver when the receiver runs.

### The ledger of keys

The idempotency keys live in a ledger of their own: route and key to the hash of the body and the id of the message, at most `keepKeys` (4,096 by default, 16 to 65,536), the oldest first out. Dropping a message from the history does not touch the ledger, so a replay of a dropped message is still a repeat. A key that left the ledger is taken as new. The relay also remembers the ids of the messages that it dropped, with their receivers, up to the same room.

### Messages and states

`pending` (waits for the person) to `queued` (accepted, waits until the receiver runs) to `sending` (the engine is taking it) to `sent` (the engine took it) to `delivered` (the receiver sent back the receipt). A message also ends as `declined` (the person said no) or `failed`, with a reason from a closed set: `receiver_gone`, `closed`, `delivery_failed`, `delivery_timeout`, `no_delivery_path`, `not_prepared` (the core could not make the text: the body held every nonce or receipt it drew, or a maker or the schedule failed), or `receiver_stuck` (see below).

- **Receipts are honest.** A sender sees `sent` until the receiver confirms. The core never reports `delivered` without proof. The proof is a receipt that the core draws for each delivery and puts inside the text that the engine is given, and nowhere else: not in the envelope, the frame, a read, or the log. The receiver sends it back with `confirm`, with its own secret. A receipt works once, for the receiver of that message only, and a confirm by any other session gets the same answer as for a message that does not exist (`GAUGE_MESSAGE_UNKNOWN`). A wrong receipt is `GAUGE_RELAY_RECEIPT_INVALID`. A confirm for a message that was never handed to an engine is `GAUGE_MESSAGE_NOT_ACCEPTED`, with the state of the message as the reason. A confirm for a message that the history dropped is `GAUGE_MESSAGE_UNKNOWN` with the reason `evicted`, to its receiver only. No engine proves that its model read the text, and the receipt is only as honest as the engine that sends it back.
- **A receipt after a failure.** `absent` says that the adapter had no way to give the engine a message, so a receipt for a message with that fidelity is refused with `GAUGE_RELAY_RECEIPT_INVALID`. After `delivery_failed` or `delivery_timeout` a valid receipt still proves delivery, because it exists only inside the text the engine got: the message reads as `delivered`, its `reason` is `null`, `failedBefore` holds the failure, and the fidelity is the one the adapter gave, or `unknown` when none came yet. A late answer of the adapter records its fidelity when it is still `null`. When it is `unknown` (a receipt came first), the late answer replaces it, except `absent`, which contradicts the receipt: that is logged and the fidelity stays `unknown`. A late answer never changes a state, and a late rejection or a late answer that is no fidelity is logged with a fixed line that names the message and the receiver and holds no text of the error.
- **A message is data, not an order.** The receiver gets the body inside a fence: a begin line and an end line that carry a nonce that the core draws for each delivery, above the body lines that name the sender, the route, the message, and the run, and say that the text is data from another engine, never an order, and answers no prompt. Every line of the body starts with `| `, so no body line can look like a line of the fence. The sender never sees the nonce, so a forged end line in a body does not close the fence. The core draws again when the body holds a nonce or a receipt, up to four times, and fails the message with `not_prepared` after that. Whether an engine obeys the words of the fence is outside the relay: the fence is the mitigation the spec asks for, and no proof.
- **A message never satisfies a prompt.** The bus gives text only to a session whose state is `running`. A session that is `starting`, `waiting` (for example at the prompt of an engine, or its sign-in), or `stopping` gets nothing: the message stays `queued` until `control.sessionChanged(session)` finds the session running. So no message reaches an engine at the moment it waits for the person. This rests on the state that the adapter of the engine reports to the Engine Host: a prompt that an adapter does not report as `waiting` is not seen by the relay, and the adapter reads the state again at the write (see "The contract of an adapter"). No approval, consent, or permission change travels by relay, and the relay has no call that answers a prompt. Each engine's own approval path still runs.
- **One message at a time** goes into an engine, in order of acceptance (the order of the approvals on an `accepted-output` route). An engine is busy from the moment a delivery starts until the adapter settles its promise (a receipt does not free it: the signal is aborted, and the wait for a stuck adapter begins), and no second delivery runs into it before that. The wait for the engine is 10,000 ms (`deliverTimeoutMs`, 1 to 600,000), timed by the injectable `schedule`, with an unref-ed timer by default. A timeout fails the message with `delivery_timeout`, aborts the signal, and keeps the engine busy; the text may still reach the engine. The wait after that is `abandonMs` (30,000 ms, 1 to 600,000). If the adapter has not settled by then, the engine reads as stuck: every message that waits for it fails with `receiver_stuck` (its count is given back), a new one fails the same way, and the engine is free again when the adapter settles at last. So two deliveries never overlap. A message to a receiver that waits for the person (`waiting`) waits until it runs, with no limit but the 16 that a route holds, and the person may decline it. A stuck engine stays stuck until its adapter settles, and writes to it are refused meanwhile. A message that was `sent` to a receiver that then ended stays `sent` until the history drops it, and the sender cannot learn that its receipt will never come.

### Caps and the stop

Each route has a message cap, each pair of sessions has a loop cap, and the run has a run cap. The message cap and the loop cap count every message when it is accepted: on an `auto` route at the send, on an `accepted-output` route at the approval. The run cap counts the `auto` messages only. A window is the run until the person acts: there is no clock window.

- **Message cap.** A route accepts at most `messageCap` messages. The next one is refused with `GAUGE_RELAY_MESSAGE_CAP`, and the route reads as `stopped` with `stoppedBy: 'message_cap'`.
- **Loop cap.** Every message accepted between two sessions counts, in either direction, since the last act of the person on that pair (the approval of a message of its routes, or a resume of a route of the pair). Two messages in a row from one session count too, so no order of senders gets round it. The pair is held to the lower of the loop caps of its two routes. When a message would make the count higher than that cap, it is refused with `GAUGE_RELAY_LOOP_CAP`, and both routes of the pair read as stopped with `stoppedBy: 'loop_cap'`. With a loop cap of 3, three messages pass and the fourth is refused. `control.routes()` shows the count of the pair in `exchanged`.
- **Run cap.** A ring of three sessions or more (A to B to C to A) has no pair that grows fast, so the run has one count too: the `auto` messages accepted in the run since the last act of the person, at most `runCap` (200 by default, 1 to 10,000). The next one is refused with `GAUGE_RELAY_LOOP_CAP`, and every route of the run is stopped with `stoppedBy: 'loop_cap'`.
- **What is and is not caught.** A pair that trades messages, a sender that sends many, and a ring of `auto` routes are stopped. A loop that passes through an approval of the person is not: an approval is an act of the person on the pair of its route, and the count of that pair starts again, at that message. It touches no other pair and not the run count, and a refused approval changes no count. The message cap and the run cap bound the cost of a run only in messages, since the cost of a turn is not counted (see "Not built").
- **Declines.** Each message that the person declines counts against its route. At `declineCap` declines (8 by default, 1 to 100) the route is paused: `stoppedBy: 'declines'`, a new message and an approval are refused with `GAUGE_RELAY_ROUTE_PAUSED`. A declined body is remembered by route and hash (at most the decline cap and 16 more for each route, the oldest first out, so one route cannot push out what another declined), and the same body under another key is refused (`GAUGE_MESSAGE_NOT_ACCEPTED`, reason `declined`) until the person resumes the route.
- **The core reports the stop**: the refusal, the state of the route in `control.routes()` (with `stoppedBy` and `stoppedAt`), and one log line.
- **A stop is about new acceptances.** A message that was accepted within the cap goes on. A message that waits for the person stays `pending`, and its approval is refused with the same code until the person resumes the route. A message that an engine is taking is not recalled.
- **The core does not retry on its own.** `control.resume(route)` is the person's, and it works on any route: a message cap starts again from zero (a message that was counted before holds no place in the new count, so a few messages that waited can take the count over the cap by up to the size of the queue); a stop of a pair opens the routes of that pair and no other pair; a stop of the run cap opens every route that it stopped (and no route that a pair or a cap stopped before), and starts the run count again; a pause opens. On any route, stopped or open, it starts again the count of its own pair, and of each pair that it reopens, and it forgets the declines and the declined bodies of the route. It gives back `{ ok: true, reopened }`, the ids of the routes that it opened. A route that its own message cap stopped stays stopped when a loop is resumed.
- **A count is given back** for a message that failed before the engine was asked (the receiver ended, the relay closed, the person declined it, the engine was stuck, or the core could not make the text): the count of the route and the places in the counts of the loop caps go back, if no act of the person came in between. A message that the engine was asked to take is never given back, also when the engine refused it.

Not counted: the cost of a message that reaches an idle engine and starts a full-context turn (see "Not built").

### The person: `control`

`approve(id)` accepts a `pending` message: the core counts it against the caps and gives it to the receiver when the receiver runs. An approval is an act of the person on its own pair (see "Caps and the stop"). The reply says the state of the message after the call and its `reason` when it failed in the same call (a message that could not be made for the engine fails at once). The first reply of `send` says it too. `decline(id)` is final, for a message that is `pending` or `queued`. `resume(route)`, `sessionChanged(session)`, `close()`, `issueSecret(session)`, and the reads `messages()`, `message(id)`, `routes()`, and `sizes()`. A message that is not `pending` is refused with `GAUGE_MESSAGE_NOT_ACCEPTED` and its state. An approval applies only to the message it names, only while that message is `pending`, and never to a message that a close, the end of the receiver, or a decline ended. These calls are for the core and the person. The Core API will carry them behind its own plans and grants.

`issueSecret` throws a `TypeError` for a session that is not a member, one that has its secret already, one that ended, a secret that another session holds, and a relay that closed. `sessionChanged` of a closed relay, or of a value that is no member, returns without a word.

`close()` fails every message that has not reached an engine with `closed` (and a message that an engine is taking too: the text may have arrived), aborts the signal of every message that is being taken, cancels every timer, and forgets every secret. After a close every write and every control call is refused with `GAUGE_RELAY_CLOSED`, and the reads still answer. A session that ended can no longer write or confirm, and what waits for it fails with `receiver_gone`.

### The history is bounded

`messages()` lists the messages in the order they were sent (the order in which the relay made them), and they are given to an engine in the order they were accepted. It holds every live message (pending, queued, sending) and at most `keepSettled` (256 by default, 1 to 1,024) settled ones: sent, delivered, declined, or failed. A route holds at most 16 messages that wait, so live messages are bounded by 32 routes times 16. When the settled ones pass the room, the ones that ended go first (delivered, declined, failed), the one that ended first before the others, and then the ones that were sent and wait for a receipt, the one that was sent first first. A live message is never dropped. A message that was sent and is dropped is logged, since its receipt can no longer be taken. A dropped message takes its receipt with it. `sizes()` reports `messages` (the live ones and up to `keepSettled` settled ones), `keys` (the ledger, up to `keepKeys`), `secrets`, `inflight` (the engines that are busy), and `declined` (for each route at most its decline cap and 16 more).

### The log

One sink, `createLog`. Every line is cut of every hidden value (the session secrets, and the receipts and nonces of live messages), then every unsafe character is shown as an escape (`\u{a}`), then the line is cut at 1,024 characters. A reader of the hidden values that throws withholds the line and writes a fixed line in its place. Nothing derived from an engine or a program is printed raw: the one text of an engine that reaches the log is the message of an error from its port, and it goes through the same sink. The body of the message that the engine was taking is cut out of that error text only, so a body that holds a word of a fixed line (such as `session`) does not blank that word in the log of the operator. A body shorter than 6 characters is not cut. No line holds a secret, a receipt, or a nonce, and none holds a body except one that an adapter echoes in an error, which is cut. The log is the `log` option, standard error by default. A log that throws is reported on standard error with the same safe line, and a standard error that throws too is lost: neither changes what the relay does or answers, and no timer callback throws out of the timer. Hidden values under 6 characters are not cut, and a value that an engine encodes (base64, a split value) is not found.

## Codes

All codes are in `packages/gauge-errors`. The relay gives a code, and where it has one, a reason of a closed set.

| code | when | reason |
|---|---|---|
| `GAUGE_ROUTE_INVALID` | a route of a job is malformed | `request`, `session`, `self`, `repeat`, `rule`, `cap`, `limit` (always one) |
| `GAUGE_ROUTE_UNKNOWN` | no route has the id, or the session is not its sender | none |
| `GAUGE_MESSAGE_INVALID` | a message or an envelope is malformed | `request`, `run`, `route`, `session`, `time`, `key`, `body`, `key_reused` (always one) |
| `GAUGE_MESSAGE_TOO_LARGE` | a body over 16,384 bytes | none |
| `GAUGE_MESSAGE_SECRET_FOUND` | a secret in a body or a key | `pattern` or `relay_value` (always one) |
| `GAUGE_MESSAGE_UNKNOWN` | no message has the id, or none for this receiver | `evicted` when the history dropped it, to its receiver; else none |
| `GAUGE_MESSAGE_NOT_ACCEPTED` | the message is not in a state that allows the move, or its body was declined | the state of the message (always) |
| `GAUGE_RELAY_UNAUTHENTICATED` | a write without the right session secret | none |
| `GAUGE_RELAY_SESSION_ENDED` | a write from a session that ended | none |
| `GAUGE_RELAY_RECEIPT_INVALID` | the receipt does not match, or the message has the fidelity `absent` | none |
| `GAUGE_RELAY_LOOP_CAP` | the loop cap or the run cap stopped the routes | none |
| `GAUGE_RELAY_MESSAGE_CAP` | the message cap stopped the route | none |
| `GAUGE_RELAY_ROUTE_PAUSED` | the person declined too many messages of the route | none |
| `GAUGE_RELAY_QUEUE_FULL` | the route holds 16 messages that wait, or the engine of the receiver is stuck | `pending_approval`, `receiver_busy`, `receiver_stuck` (always one) |
| `GAUGE_RELAY_RECEIVER_GONE` | the receiver has ended | none |
| `GAUGE_RELAY_CLOSED` | the relay of the run has closed | none |

## The fake engine pair

`test/fixtures.ts` has `createFakeEngine(session)`, a scriptable engine that stands for an interactive engine in a terminal, and `parseFence`. It is for tests: it is not in the built source of the package, and `src/index.ts` does not export it. An engine takes the next input as a terminal does: while it waits at a prompt, any input is taken for the answer, and the engine records it in `promptAnswers`. A test checks that the list stays empty. The only way to answer on purpose is `answer`, which stands for the person. An engine can accept, reject, throw, hang (take the text and wait), write late (take the text only when it is released, and drop it when the signal is aborted, or not, as `honorsAbort` says), or answer with a word that is no fidelity. It counts the deliveries that run at once, and prints lines with `say`, which nothing reads. The tests drive two of them through one relay.

## Not built

- **The Core API.** Routes are not part of the job definition, the job plan text, or the replies of `jobs.read`. No Core API call reads relay state or messages, no permission names that read, and no Gauge view of a route, a message, or a session exists. A Gauge cannot read anything of relay from this ticket, so no side channel to an engine, a session, or a route that a Gauge may not read was added. When the Core API carries relay, a plan that shows a session or an engine needs a person view and a Gauge view built by an allow-list, as the start plan has, and routes change only through a job plan. The Core API does not start the relay of a run yet: `begin` of the run book makes no relay. A later ticket owns this.
- **Traces.** Messages are not recorded in traces yet: the Traces contract is the next ticket. `messages()` holds them in memory, bounded as above, and nothing is written to disk. The feed must record the envelope, never `Delivery.text`.
- **Delivery to a real engine.** The Engine Host starts programs with no standard input and has no live message stream, attach, or send. No real adapter, and no pane, takes a message while an engine runs. How a session secret reaches an engine, and how an engine calls `send` and `confirm`, is not built. The delivery facts per engine (Codex exact, Claude Code weakened, OpenCode queued) come from the live check of the spec and are not coded here.
- **Cost.** The cost cap of the spec and the count of the cost of a message that starts a full-context turn on an idle engine need usage figures from the adapters. Only message, loop, and run caps are built.
- **Persistence.** Nothing survives the end of the process: the messages, the counts, and the secrets live in memory.
- **A person's approval path in the app.** `approve`, `decline`, and `resume` are calls of the core. The pane that shows a message to the person is later work.

## Tests

`npm run test:relay`
