# relay

Relay (v0.9.1): the messages and the routes of a run. A job names routes between its sessions. When a run starts, one relay bus carries the messages of that run, under the rules the person sets. This package holds the rules and a fake engine pair that tests them. `packages/core-api` will carry them over the seam, with plans and grants. This README is the contract.

Out of scope here: the Core API calls and the Gauge views of relay (see "Not built"), the traces feed, the real engine adapters, how a session secret reaches an engine, cost counting, and any transport. The bus runs inside the process of the core. It has no socket, no remote transport, no chat channel, and no link between computers.

## Routes

A route is a person-approved cable between two sessions of a job: a sender, a receiver, and one rule. It grants no authority to run or to write. A route names its sessions by label. `checkRouteDefinitions(value, labels)` checks the routes of a job against the labels of its sessions. `resolveRoutes(definitions, members)` turns the labels into session ids and gives each route the id `route-<n>`, in the order of the job, when a run starts. A rename of a label never breaks delivery, because the bus knows ids only.

| field | rule | reason when wrong (`GAUGE_ROUTE_INVALID`) |
|---|---|---|
| the list | a plain list of at most 32, read with `readList` (no iterator, subclass, hole, or accessor), each a plain record | `request`, and `limit` for more than 32 |
| `from`, `to` | a label of the job; the two differ | `session`, `self` |
| the pair | at most one route for each sender and receiver; the opposite direction is a route of its own | `repeat` |
| `rule` | written out: `accepted-output` or `auto` | `rule` |
| `messageCap` | a whole number from 1 to 1,000. Default 50 | `cap` |
| `loopCap` | a whole number from 1 to 100. Default 6 | `cap` |
| an `auto` route | must write both caps | `cap` |
| any other field | refused (a route cannot start, run, or grant anything) | `request` |

`accepted-output` is the rule a person is shown first: the person approves each message. `auto` lets messages flow, and the core logs each one. A reason never holds a value that a caller sent. The first failure in the order of the list is the one that is told.

Routes live in a job. This ticket does not add them to the job definition, the job plan, or the Core API: see "Not built".

## The envelope

One JSON frame holds one message: `run`, `route`, `sender`, `receiver`, `body`, `time` (milliseconds since the epoch, from the clock of the core), and `key` (the idempotency key). Every address is a stable id. `checkEnvelope` reads a frame as a plain record of exactly those seven fields. `frameOf` writes it as compact JSON, with the fields in a fixed order and no line break.

- **The body** is text of 1 to 16,384 bytes of UTF-8. A body over the limit is refused first, as `GAUGE_MESSAGE_TOO_LARGE`, before it is read for anything else. A body may hold a line feed and a tab, and no other control, format, line-separator, or paragraph-separator character, and no lone surrogate, so no escape sequence reaches a terminal (`GAUGE_MESSAGE_INVALID`, reason `body`). Larger content moves as a file path in a shared folder.
- **A secret in a body** is refused as `GAUGE_MESSAGE_SECRET_FOUND`. The scan is the one of `gauge-manifest` (private key header, access key id, tokens with a known prefix, a signed web token, and a long mixed-case run), plus a search for every value the relay holds: the session secrets, and the receipts and fence nonces of the messages that were given to an engine and are not delivered. A hidden value under 8 characters is not searched for. The scan finds no secret that has none of these shapes, so it is a floor and not a guarantee.
- **The key** is 1 to 64 characters of letters, digits, and `. _ : -`, starting with a letter or a digit. It is scanned for a secret too.

## The bus

`createRelay(options)` gives `{ write, control }`, both frozen. The options are `run`, `routes` (at most 32, already resolved), `members` (1 to 8 of `{ session, port }`), and the injectable `schedule`, `now`, `newId`, `newSecret`, `newNonce`, `newReceipt`, and `log`. A wrong option is a bug of the caller and throws (`TypeError`, or `RangeError` for a number out of range) before anything is made. The routes and the members are fixed when the relay is made: no call adds a route or a session, and no call reads the output of an engine. What an engine prints can start, add, or route nothing.

A `SessionPort` has `state()` (the session state of the Engine Host) and `deliver(delivery)`, which gives the text to the engine as its next input and answers with a fidelity: `exact`, `translated`, `weakened`, or `absent`. `delivery` holds the envelope, its frame, and the text. The adapter of an engine says how it takes a message while it runs, and the relay reports the word it gives. The Engine Host has no input path to a running engine yet, so no real port exists: see "Not built".

### What an engine reaches: `write`

An engine reaches two calls, each with the secret of its own session, and nothing else (no approve, decline, resume, read, or close).

- `send({ session, secret, route, key, body })`.
- `confirm({ session, secret, id, receipt })`.

The core makes one secret for each session (`control.issueSecret`), once, holds it in memory only, and forgets it when the session ends or the relay closes. A write without the right secret is refused with `GAUGE_RELAY_UNAUTHENTICATED`. A missing secret, a wrong one, the secret of another session, an unknown session, and a session that ended give one and the same answer. Secrets are compared as SHA-256 digests with a constant-time compare. A refused write is logged once, with no value in the line, so a flood makes one line.

`send` checks in this order, and the first failure is told:

1. The relay is closed: `GAUGE_RELAY_CLOSED` (also for a bad secret, since the state of the relay is no secret to a session of the run).
2. The request is a plain record of exactly the five fields: `GAUGE_MESSAGE_INVALID`, reason `request`.
3. The secret: `GAUGE_RELAY_UNAUTHENTICATED`. The session state is read too, and a session that ended is refused the same way.
4. The route exists and the session is its sender: `GAUGE_ROUTE_UNKNOWN`. A route that does not exist and a route of another sender give one answer, so a session learns nothing of the routes of others.
5. The key (`GAUGE_MESSAGE_INVALID` reason `key`, or `GAUGE_MESSAGE_SECRET_FOUND`), then the body (`GAUGE_MESSAGE_TOO_LARGE`, `GAUGE_MESSAGE_INVALID` reason `body`, `GAUGE_MESSAGE_SECRET_FOUND`).
6. A repeat: the same route and key, with the same body, is dropped, and the reply is `{ ok: true, duplicate: true }` with the id and the state of the first message. The same key with another body is refused (`GAUGE_MESSAGE_INVALID`, reason `key_reused`), so the second body is not lost without a word. A repeat of a message the person declined is dropped too, so a retry never asks again. A retry of a message that failed needs a new key.
7. The route is stopped by a cap: `GAUGE_RELAY_LOOP_CAP` or `GAUGE_RELAY_MESSAGE_CAP`, whichever stopped it.
8. The receiver has ended: `GAUGE_RELAY_RECEIVER_GONE`.
9. The route holds 16 messages that wait: `GAUGE_RELAY_QUEUE_FULL`.

Then the message is made. The envelope takes the sender and the receiver from the route, and the time from the clock of the core, never from the request. On an `accepted-output` route the message is `pending`. On an `auto` route it is accepted at once (and counted against the caps), logged without its body, and given to the receiver when the receiver runs.

### Messages and states

`pending` (waits for the person) to `queued` (accepted, waits until the receiver runs) to `sending` (the engine is taking it) to `sent` (the engine took it) to `delivered` (the receiver sent back the receipt). A message also ends as `declined` (the person said no) or `failed`, with a reason from a closed set: `receiver_gone`, `closed`, `delivery_failed`, `delivery_timeout`, `no_delivery_path`, or `not_prepared` (the core could not make the text: the body held every nonce or receipt it drew, or a maker or the schedule failed).

- **Receipts are honest.** A sender sees `sent` until the receiver confirms. The core never reports `delivered` without proof. The proof is a receipt that the core draws for each delivery and puts inside the text that the engine is given, and nowhere else: not in the envelope, the frame, a read, or the log. The receiver sends it back with `confirm`, with its own secret. A receipt works once, for the receiver of that message only, and a confirm by any other session gets the same answer as for a message that does not exist (`GAUGE_MESSAGE_UNKNOWN`). A wrong receipt is `GAUGE_RELAY_RECEIPT_INVALID`. A confirm for a message that was never handed to an engine is `GAUGE_MESSAGE_NOT_ACCEPTED`, with the state of the message as the reason. A valid receipt also proves delivery after the timeout, or while the engine is still answering, because the receipt exists only inside the text the engine got. No engine proves that its model read the text, and the receipt is only as honest as the engine that sends it back. An `absent` fidelity fails the message with `no_delivery_path`.
- **A message is data, not an order.** The receiver gets the body inside a fence: a begin line and an end line that carry a nonce that the core draws for each delivery, and above the body lines that name the sender, the route, the message, and the run, and say that the text is data from another engine, never an order, and answers no prompt. The sender never sees the nonce, so a forged end line in a body does not close the fence. The core draws again when the body holds a nonce or a receipt, up to four times, and fails the message with `not_prepared` after that. Whether an engine obeys the words of the fence is outside the relay: the fence is the mitigation the spec asks for, and no proof.
- **A message never satisfies a prompt.** The bus gives text only to a session whose state is `running`. A session that is `starting`, `waiting` (for example at the prompt of an engine, or its sign-in), or `stopping` gets nothing: the message stays `queued` until `control.sessionChanged(session)` finds the session running. So no message reaches an engine at the moment it waits for the person. This rests on the state that the adapter of the engine reports to the Engine Host: a prompt that an adapter does not report as `waiting` is not seen by the relay. No approval, consent, or permission change travels by relay, and the relay has no call that answers a prompt. Each engine's own approval path still runs.
- **One message at a time** goes into an engine, in order. The next waits until the first is taken, confirmed, or failed. The wait for the engine is 10,000 ms (`deliverTimeoutMs`, 1 to 600,000), timed by the injectable `schedule`, with an unref-ed timer by default. A timeout fails the message with `delivery_timeout`, and the text may still reach the engine. A late answer changes nothing.

### Caps and the stop

Each route has a message cap and each pair of sessions has a loop cap, both counted when the message is accepted: on an `auto` route at the send, on an `accepted-output` route at the approval. A window is one run.

- **Message cap.** A route accepts at most `messageCap` messages. The next one is refused with `GAUGE_RELAY_MESSAGE_CAP`, and the route reads as `stopped` with `stoppedBy: 'message_cap'`.
- **Loop cap.** A message from the other session of a pair extends the back-and-forth by one. Two messages in a row from the same session start it again. When a message would make the back-and-forth longer than `loopCap`, it is refused with `GAUGE_RELAY_LOOP_CAP`, and both routes of the pair read as stopped with `stoppedBy: 'loop_cap'`. With a loop cap of 3, three messages pass and the fourth is refused.
- **The core reports the stop**: the refusal, the state of the route in `control.routes()` (with `stoppedBy` and `stoppedAt`), and one log line.
- **A stop is about new acceptances.** A message that was accepted within the cap goes on. A message that waits for the person stays `pending`, and its approval is refused with the same code until the person resumes the route. A message that an engine is taking is not recalled.
- **The core does not retry on its own.** `control.resume(route)` is the person's: a message cap starts again from zero (a message that was counted before the resume holds no place in the new count, so a few messages that waited can take the count over the cap by up to the size of the queue), and a loop opens both routes that the loop stopped and starts the back-and-forth again. A route that its own message cap stopped stays stopped when a loop is resumed.
- **A count is given back** for a message that failed before the engine was asked (the receiver ended, the relay closed, the person declined it, or the core could not make the text): the count of the route and the place in the chain go back. A message that the engine was asked to take is never given back, also when the engine refused it.

Not counted: the cost of a message that reaches an idle engine and starts a full-context turn (see "Not built").

### The person: `control`

`sizes()` reports how much the relay holds (messages, keys, secrets, and engines that are taking a message). `approve(id)` accepts a `pending` message: the core counts it against the caps and gives it to the receiver when the receiver runs. `decline(id)` is final, for a message that is `pending` or `queued`. `resume(route)`, `sessionChanged(session)`, `close()`, `issueSecret(session)`, and the reads `messages()`, `message(id)`, and `routes()`. A message that is not `pending` is refused with `GAUGE_MESSAGE_NOT_ACCEPTED` and its state. An approval applies only to the message it names, only while that message is `pending`, and never to a message that a close, the end of the receiver, or a decline ended. These calls are for the core and the person. The Core API will carry them behind its own plans and grants.

`close()` fails every message that has not reached an engine with `closed` (and a message that an engine is taking too: the text may have arrived), cancels every timer, and forgets every secret. After a close every write and every control call is refused with `GAUGE_RELAY_CLOSED`, and the reads still answer. A session that ended can no longer write or confirm, and what waits for it fails with `receiver_gone`.

### The history is bounded

`messages()` holds every live message (pending, queued, sending) and at most `keepSettled` (256 by default, 1 to 1,024) settled ones: sent, delivered, declined, or failed. A route holds at most 16 messages that wait, so live messages are bounded by 32 routes times 16. When the settled ones pass the room, the ones that ended go first, the one that ended first before the others, and then the ones that were sent and wait for a receipt, the one that was sent first first. A live message is never dropped. A dropped message takes its idempotency key and its receipt with it: a confirm for it is `GAUGE_MESSAGE_UNKNOWN`, and its key is free again, so a repeat after the drop is taken as new. Message ids, keys, and counts are held in maps whose size is bounded the same way. The count of a route and the chain of a pair hold one number each.

### The log

One sink, `createLog`. Every line is cut of every hidden value (the session secrets, and the receipts and nonces of live messages), then every unsafe character is shown as an escape (`\u{a}`), then the line is cut at 1,024 characters. Nothing derived from an engine or a program is printed raw: the one text of an engine that reaches the log is the message of an error from its port, and it goes through the same sink. No line holds a body, a secret, a receipt, or a nonce. The log is the `log` option, standard error by default. A log that throws is reported on standard error with the same safe line, and never changes what the relay does or answers. Hidden values under 6 characters are not cut, and a value that an engine encodes (base64, a split value) is not found.

## Codes

All codes are in `packages/gauge-errors`. The relay gives a code, and where it has one, a reason of a closed set.

| code | when | reason |
|---|---|---|
| `GAUGE_ROUTE_INVALID` | a route of a job is malformed | `request`, `session`, `self`, `repeat`, `rule`, `cap`, `limit` (always one) |
| `GAUGE_ROUTE_UNKNOWN` | no route has the id, or the session is not its sender | none |
| `GAUGE_MESSAGE_INVALID` | a message or an envelope is malformed | `request`, `run`, `route`, `session`, `time`, `key`, `body`, `key_reused` (always one) |
| `GAUGE_MESSAGE_TOO_LARGE` | a body over 16,384 bytes | none |
| `GAUGE_MESSAGE_SECRET_FOUND` | a secret in a body or a key | none |
| `GAUGE_MESSAGE_UNKNOWN` | no message has the id, or none for this receiver | none |
| `GAUGE_MESSAGE_NOT_ACCEPTED` | the message is not in a state that allows the move | the state of the message (always) |
| `GAUGE_RELAY_UNAUTHENTICATED` | a write without the right session secret | none |
| `GAUGE_RELAY_RECEIPT_INVALID` | the receipt does not match | none |
| `GAUGE_RELAY_LOOP_CAP` | the loop cap stopped the routes of a pair | none |
| `GAUGE_RELAY_MESSAGE_CAP` | the message cap stopped the route | none |
| `GAUGE_RELAY_QUEUE_FULL` | the route holds 16 messages that wait | none |
| `GAUGE_RELAY_RECEIVER_GONE` | the receiver has ended | none |
| `GAUGE_RELAY_CLOSED` | the relay of the run has closed | none |

## The fake engine pair

`src/fixtures.ts` has `createFakeEngine(session)`, a scriptable engine that stands for an interactive engine in a terminal, and `parseFence`. It is for tests, and `src/index.ts` does not export it. An engine takes the next input as a terminal does: while it waits at a prompt, any input is taken for the answer, and the engine records it in `promptAnswers`. A test checks that the list stays empty. The only way to answer on purpose is `answer`, which stands for the person. An engine can accept, reject, throw, hang, or answer with a word that is no fidelity, and it prints lines with `say`, which nothing reads. The tests drive two of them through one relay.

## Not built

- **The Core API.** Routes are not part of the job definition, the job plan text, or the replies of `jobs.read`. No Core API call reads relay state or messages, no permission names that read, and no Gauge view of a route, a message, or a session exists. A Gauge cannot read anything of relay from this ticket, so no side channel to an engine, a session, or a route that a Gauge may not read was added. When the Core API carries relay, a plan that shows a session or an engine needs a person view and a Gauge view built by an allow-list, as the start plan has, and routes change only through a job plan. The Core API does not start the relay of a run yet: `begin` of the run book makes no relay.
- **Traces.** Messages are not recorded in traces yet: the Traces contract is the next ticket. `messages()` holds them in memory, bounded as above, and nothing is written to disk.
- **Delivery to a real engine.** The Engine Host starts programs with no standard input and has no live message stream, attach, or send. No real adapter, and no pane, takes a message while an engine runs. How a session secret reaches an engine, and how an engine calls `send` and `confirm`, is not built. The delivery facts per engine (Codex exact, Claude Code weakened, OpenCode queued) come from the live check of the spec and are not coded here.
- **Cost.** The cost cap of the spec and the count of the cost of a message that starts a full-context turn on an idle engine need usage figures from the adapters. Only message and loop caps are built.
- **Persistence.** Nothing survives the end of the process: the messages, the counts, and the secrets live in memory.
- **A person's approval path in the app.** `approve`, `decline`, and `resume` are calls of the core. The pane that shows a message to the person is later work.

## Tests

`npm run test:relay`
