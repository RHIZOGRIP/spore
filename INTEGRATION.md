# Driving spores from a program

Other docs: [README](packages/spore/README.md) (the command), [docs/operating.md](docs/operating.md)
(host setup), [docs/definition.md](docs/definition.md) (`spore.cmk`), [ARCHITECTURE.md](ARCHITECTURE.md)
(design).

## Choosing a way in

| | **The command** | **The library** | **The HTTP API** |
|---|---|---|---|
| Reach it with | `spore send … --json`, from any language, or over `ssh` | `import { send, watch } from '@rhizogrip/spore'` | `spore-api`, on a unix socket or a loopback port |
| Runs where | on the spores' host | in your Node process, on the spores' host | anywhere that can reach the socket or a proxy in front of it |
| Errors | an exit code, and the message on stderr | `SporeError`, branched on `err.type` | `{ "error": { "type", "message", "detail"? } }` and a status |
| Follows a turn with | JSON lines on stdout | an async iterator | NDJSON |
| Best for | scripts, CI, another machine over `ssh` | a long-lived service in front of many spores | a caller in a container or on another machine |

All three call the same functions: they refuse the same things, and a conversation started
through one continues through another.

- **A spore is its workspace.** A name like `triage` is a directory under the host's `home`
  (`spore config get home`). What the spore remembers, what it is doing and how its turns ended
  are read back from that directory.
- **Sending says something; a turn may or may not start.** A message is added to the spore's
  inbox. If no turn is running, one starts and reads it. If one is running, the message reaches it
  between rounds. The answer to send tells you which happened, and gives your message's inbox
  position (`inbox`). That position is how you find the turn that answered it.
- **A turn outlives its caller.** It runs detached. A caller that exits, crashes or loses its
  connection leaves the turn running, and follows it again from the event `seq` it last saw.

---

## The command

```bash
spore send triage "summarize the open tickets" --request-id job-41 --json
spore attach triage --json --after 1287
```

### `spore send … --json`

`--json` replaces the text with the event log, one JSON object per line ([Events](#events)). Two
lines are the command's own, and neither has a `seq`:

```
{"event":"sent","inbox":12,"started":true,"repeated":false}
…the turn's events, each with its seq…
{"event":"result","read":true,"turn":{"turnNo":7,"stopReason":"answer","concluded":true,"output":"…",…}}
```

- `sent` comes first. `inbox` is your message's inbox position. `started` is true when this
  command started a turn, and false when the message joined one already running or was a repeat.
  `repeated` is true when the request id had been sent before.
- `result` comes last. `turn` is the record of the finished turn that read your message, with its
  answer in `output` ([the turn record](#the-turn-record)). It is `null` and `read` is `false`
  while no turn has read the message.
- If the command is interrupted (SIGINT), the output ends without a `result` line.

The message is the arguments after the name. With no message argument, it is read from stdin:

```bash
printf '%s' "$BODY" | ssh host spore send triage --request-id job-41 --json
```

Over `ssh`, stdin is the only way a message reaches spore without the remote shell re-parsing it.
`--attach <file>` sends a file with the message and can be repeated.

### Exit codes

| exit | `spore send`, `spore fork`, `spore attach` |
|---|---|
| 0 | the turn concluded: an answer, a question (`ask`), or `quiet` |
| 1 | the turn ended without concluding (a hard limit, `cancelled`, an error), or, with `--json` or for a repeated request id while nothing runs, nothing has read the message yet |
| 2 | the command refused: an option or an argument it does not take, a spore that does not exist, or a refusal from `send` (below) |
| 3 | the follower was interrupted; the turn is still running |
| 4 | the turn answered at a soft limit. The answer says what remains and stderr names the limit. Send again to carry on |

With `--json`, or for a repeated request id while nothing runs, the code is that of the turn
that read your message. A plain `spore send`, `spore fork` and `spore attach`, and `spore attach
--json`, exit by the workspace's last turn once the turn they follow has ended. `spore stop
<name>` exits 0 once it has signalled the running turn, and 1 when nothing is running, as do
`spore wrap`, `spore extend` and `spore job stop`.

Every other verb exits with the same code with or without `--json`.

A refusal (exit 2) prints `spore: <message> — <detail>` on stderr. The error's `type` is not
printed. A program that has to branch on the type uses the library or the API.

### Retrying: `--request-id`

Under `--request-id <id>`, the message is taken once:

- Sent again while its turn runs, the command follows that turn.
- Sent again after a turn has read it, nothing runs. The command prints that turn's answer (with
  `--json`, the `sent` line with `repeated: true` and the `result` line), says on stderr that it
  was already sent, and exits as that turn did.

So a job that does not know whether its last attempt got through sends again with the same id. A
refusal after the message was said (see [`ADMISSION_FULL`](#refusals)) is also safe to retry this
way. The id is any non-empty string. It must be exactly the same on the retry.

### Carrying on: `spore attach --json --after <seq>`

`spore attach <name> --json` follows the running turn from now. `--after <seq>` starts from the
event after `seq` instead, and `--after 0` replays the whole log that retention kept. A caller
whose connection dropped keeps the last `seq` it saw and carries on from there:

```bash
spore attach triage --json --after 1287
```

If `send --json` ends with `read: false` (exit 1), the turn that was running ended before it read
your message. The spore reads it in its next turn. Follow that turn with `attach --json --after`
the last `seq` you saw.

### Talking to a running turn

`spore send` to a running spore puts the message in front of the agent between rounds; the
`sent` line says `started: false`. `spore send <name> stop` asks the agent to wrap up with what it
has. `spore wrap <name> [10m]` brings its wrap-up forward. `spore extend <name> wall 30m` raises a
limit, as far as the definition's `extend.*` allows. `spore stop <name>` ends the turn mid-round,
and the turn is recorded as `cancelled`.

The command takes no trace context. To trace across the boundary, use the library or the API
([Tracing](#tracing-across-the-boundary)).

---

## The library

```bash
npm install @rhizogrip/spore
```

Every function the command uses is exported from the package root; [docs/library.md](docs/library.md)
gives each one's signature, return value and errors.
A function that takes `{ ws }` accepts a name (resolved under `home`) or a path.
`send`, `watch`, `stateOf` and the other functions that take `ws` as their first argument want a
**path**: resolve a name with `workspaceFor(name).path`, and check `isWorkspace(path)` first, as
the command does.

Call `loadEnvironment()` once at start. It loads the `environment` file beside `config.json`
(`~/.config/spore/` unless `XDG_CONFIG_HOME` says otherwise) into `process.env` (a variable already
set wins), which is where the operator keeps provider keys and plugin settings. A turn started by
`send` inherits `process.env` unless you pass `env`.

A turn is always asynchronous: start it with `send`, `fork` or `runBatch`, then watch it or read
its record.

### Saying something and following it

| export | what it does |
|---|---|
| `send(ws, text, options)` | adds a message to the inbox, and starts a turn when none is running. Returns `{ ws, started, pid, inbox, repeated }` |
| `lastEventSeq(ws)` | the `seq` of the last event in the log. Read it **before** `send` to follow only what comes after |
| `watch(ws, { after, signal, grace, tick })` | an async iterator over the event log after `after`, ending when the turn ends. If no turn is seen running within `grace` (5000 ms), it ends with what was there |
| `readInbox(ws, { after, upto })` | the inbox entries with `inboxNo` in `(after, upto]` |
| `turnOfMessage(ws, entry)` | the finished turn that ended a message, `{ turn, read }`, or `null` while none has. `read: false` means a turn started after the message failed before reading anything |
| `outcome(ws)` | how the spore's last turn ended: `{ stopReason, concluded, rounds, treeUsd, workUnits, produced, producedMore, endedAt }`, or `null` |
| `follow(ws, { lines, out, err })` | writes the running turn's text output to two streams, as `spore send` does in a terminal. Returns `'ended'` or `'detached'` (on SIGINT) |

`send` options: `requestId` (taken once, see [Rules](#rules-an-integrator-keeps)); `attach`, a
list of `{ name, mime, data }` with `data` a Buffer; `replyTo`, where the answer goes
([Delivering answers](#delivering-answers-elsewhere)); `traceparent`; `env`, the environment the
turn's runner starts with; `start: false`, which says the message and starts nothing — a turn
running reads it at its next round, and with none running it waits for the next turn something
else starts.

```js
import { isWorkspace, lastEventSeq, loadEnvironment, readInbox, RUNNING, send, stateOf, turnOfMessage, watch, workspaceFor } from '@rhizogrip/spore'

loadEnvironment()
const ws = workspaceFor('triage').path
if (!isWorkspace(ws)) throw new Error('no spore called triage')

let seq = lastEventSeq(ws)
const { inbox } = send(ws, 'summarize the open tickets', { requestId: 'job-41' })

let found = null
while (!found) {
  for await (const event of watch(ws, { after: seq })) {
    seq = event.seq
    if (event.event === 'stream' && event.kind === 'message') process.stdout.write(event.delta)
  }
  const [entry] = readInbox(ws, { after: inbox - 1, upto: inbox })
  found = turnOfMessage(ws, entry)
  if (!found && stateOf(ws).state !== RUNNING) break
}
if (found?.read) console.log(found.turn.stopReason, found.turn.output)
```

The loop ends without a turn when the message was said and nothing running read it; the spore's
next turn reads it. `watch` reads the log, so several watchers each keep their own `seq` and do
not interfere. Pass an `AbortSignal` as `signal` to stop following; the turn is not affected.

### A service in front of many spores

A chat bot or an application serving many users follows all its spores with one iterator, and
saves one cursor per spore so that a restart repeats and misses nothing.

| export | what it does |
|---|---|
| `watchAll(spores, { cursors, signal, tick })` | follows every spore in `spores` (a list of paths, or a function returning one, read again on every wake). Yields `{ ws, event, cursor }` for each event and `{ ws, turn, cursor }` for each finished turn |
| `turnsSince(ws, turnNo)` | every turn finished after `turnNo`: `{ turn, ended: [{ record, asked }] }`, where `asked` is the inbox entries that turn answered |

`cursor` is `{ seq, turn, database }`: the last event and the last turn handled, and which
database they belong to. Save the whole object and pass it back in `cursors`, keyed by path. A
spore without a cursor starts where it is now. A cursor from another database (the spore was made
again) is dropped, and the spore is followed from its start.

```js
import { send, watchAll } from '@rhizogrip/spore'

const { inbox } = send(ws, 'where is order 4471?', { requestId: `chat-${messageId}` })

for await (const item of watchAll(() => mySpores(), { cursors: loadCursors(), signal })) {
  if (item.turn?.asked.some(entry => entry.inboxNo === inbox)) await reply(item.turn.record.output)
  saveCursor(item.ws, item.cursor)
}
```

Save a cursor only once what it covers has been handled: a cursor saved before a reply that then
fails moves past that turn, and a restart does not see it again. Saved after, a crash between the
two repeats the item, so make the reply safe to send twice — keyed by the turn's `turnId`, for
example — or deliver through the spore's outbox ([Delivering answers](#delivering-answers-elsewhere)).

Match a reply to what your user said through `inbox`: the turn that answered it is the one whose
`asked` holds it, which is the one with `inboxFrom < inbox <= inboxTo`. The inbox does not record
who said what; your service keeps that, keyed by `inbox`.

A service that starts turns is their parent process. Under systemd it runs with
`KillMode=process`, so a restart of the service does not kill the turns it started.

### Delivering answers elsewhere

A message may carry `replyTo`: `terminal`, or `<kind>:<place>` such as `chat:support-eu/42`. When
a turn is made final, one outbox entry is written per distinct `replyTo` among the messages it
read. A message with none uses the spore's default from `replyTo` in `config.json`
([docs/operating.md](docs/operating.md#replyto)). A `quiet` turn addresses nothing.

| export | what it does |
|---|---|
| `outbox(ws, { kind, state })` | outbox entries, oldest first: `{ outboxNo, at, turnId, turnNo, recipient, answers, state, settledAt, reason }`. `answers` is the inbox positions answered; `state` is `pending`, `delivered` or `refused` |
| `settleOutbox(ws, outboxNo, { refused })` | marks a pending entry delivered, or refused with the reason given. Returns false when it was not pending |
| `readTurns(ws)` | every finished turn's record, in order. The answer of an outbox entry is the `output` of the record with its `turnNo` |

An entry's content is the turn record; nothing is copied into the outbox. `terminal` entries are
written `delivered`. Every other entry stays `pending` until whoever serves its kind settles it,
once.

```js
for (const entry of outbox(ws, { kind: 'chat', state: 'pending' })) {
  const turn = readTurns(ws).find(t => t.turnNo === entry.turnNo)
  try {
    await postTo(entry.recipient, turn.output)
    settleOutbox(ws, entry.outboxNo)
  } catch (err) {
    settleOutbox(ws, entry.outboxNo, { refused: err.message })
  }
}
```

### Reading what exists

Nothing here starts anything. Most take `{ ws }` (a name or a path; omitted, the current
directory) and `configFile`, and throw `NOT_A_WORKSPACE` for a spore that is not there; the
signature of each, and every error it throws, is in [docs/library.md](docs/library.md).

| export | returns |
|---|---|
| `list({ where, disk })` | `{ home, paused, spend, workspaces: [{ ws, state, lastTurnNo, last, … }], missing }` — what `spore ls` prints |
| `show({ ws })` | one spore in detail: its state, definition, limits, how many messages are waiting, schedules, running jobs, last `produced` |
| `log({ ws })` | one entry per turn (`endedAt`, `stopReason`, `concluded`, `treeUsd`, `asked`), what is `waiting`, schedules `held` |
| `usage({ ws, days, since, until, tz })` | spend per local day and by origin, model, outcome and precursor. Without `ws`, every spore |
| `precursors({ ws })`, `schedules({ ws })`, `jobs({ ws })` | what it can delegate to, its schedules and where each stands, its jobs |
| `sql({ ws, query, json })` | a read-only query over the workspace's views, as `spore sql` |
| `grantOf(ws)` | the model, tools and limits a turn starts with |
| `stateOf(ws)` | `{ state, lastTurnNo, treeUsd, last, pid?, startedAt?, draining? }`; `state` is `running`, `idle`, `waiting`, `wrapped`, `halted`, `cancelled`, `failed` or `crashed` |
| `readTranscript(ws)`, `textOf(message)` | the conversation as the model last saw it, and a message's text |
| `readEvents(ws, { after, event, limit })` | events past `after` without following |
| `isWorkspace(dir)`, `workspacesIn(dir)`, `workspaceFor(name)` | finding spores |
| `readConfig()`, `settings()`, `getKey(key)` | the host's `config.json` |
| `sporangia()`, `defaultModel()` | what a spore can be made from, and the model new spores get |
| `paused()`, `spendSoFar()` | the pause in force (`{ at, why? }` or `null`); what was settled today and this month against the limits |

### Making and changing spores

| export | what it does |
|---|---|
| `define({ ws, sporangium, definition, from, model, plugins })` | makes a spore, or revises one's `spore.cmk`, keeping its conversation and `data/` |
| `remake({ ws })`, `remove({ ws, yes })` | made again from its sporangium; removed (refused while it runs, and without `yes` once it has turns) |
| `switchModel({ ws, model })`, `setDefaultModel(model)` | the model a spore runs on from its next turn, among those its definition offers; the model new spores get |
| `setSchedule({ ws, name, source })`, `removeSchedule({ ws, name })` | installs or removes `schedules/<name>.cmk`, checked first |
| `extend({ ws, dimension, amount })`, `wrap({ ws, wait })` | raises a running turn's `rounds`, `cost` or `wall`; brings its wrap-up forward. Each returns the change or `{ refused, … }`; `changeText(answer)` says it in words |
| `stop(ws)` | SIGTERM to the running turn, which records it as `cancelled`: `{ stopped, pid }` |
| `pause({ why })`, `unpause()` | stops every turn and job of the spores `list` finds and refuses new turns to all the user's spores; lifts that |
| `stopJob({ ws, name })`, `upgrade({ ws, all })` | stops a running job; replaces a spore's root documents with the installed ones |

### Forking a turn

`fork({ run, at, into, definition, replay })` makes `into` as `run` stood when the round of call
`at` came back, and carries the turn on from there. It returns once the runner has started, like
`send`. `forkWorkspace` makes the copy without starting it, and `readFork(ws)` reads what a fork
was cut from. It refuses with `FORK_REFUSED`
([docs/operating.md](docs/operating.md#forking-a-turn-spore-fork)).

### Many spores at once

`runBatch(errands, { atOnce, deadline, pollMs, report })` runs many spores, at most `atOnce` at a
time, and waits. An errand is `{ ws, messages, label, id }`: a workspace that already has its
definition, the messages to send one at a time, and an `id` you keep stable. Message *i* is sent
under the request id `errand:<id>:<i>`, so calling `runBatch` again with the same ids after an
interruption carries on and sends nothing twice. A start refused with `ADMISSION_FULL` is tried
again at the next poll.

```js
import { runBatch, stop } from '@rhizogrip/spore'

const { stuck, ended } = await runBatch([
  { ws: '/srv/spores/north', messages: ['summarize data/', 'now chart the totals'], label: 'north', id: 'q3-north' },
  { ws: '/srv/spores/south', messages: ['summarize data/', 'now chart the totals'], label: 'south', id: 'q3-south' }
], { atOnce: 4, deadline: Date.now() + 3_600_000 })

for (const errand of stuck) stop(errand.ws)
for (const { errand, turns, crashed } of ended) console.log(errand.label, crashed ?? turns.map(t => t.stopReason))
```

`turns[i]` is the record of the turn that answered message *i*, never whatever the spore did last.
`crashed: true` means a runner died while one of the errand's messages was outstanding.

### The machine

| export | what it does |
|---|---|
| `doctor()` | what is wrong on this machine for spore: `{ findings: [{ area, subject, severity, problem, fix }], needsTick, replies }` |
| `modelFindings()` | async: each model a spore names that cannot run, or runs unpriced, with the `mo` command that fixes it |
| `checkSqlite()` | Node's SQLite version, or `SQLITE_TOO_OLD` |
| `loadEnvironment()` | loads the `environment` file beside `config.json`: `{ path, loaded }`, or `ENVIRONMENT_INVALID` |

### Errors and tracing helpers

`SporeError` is the one error class: `type` (the tag to branch on), `message`, `detail`,
`severity`, `retryable`, and `retryAfterMs` when known. `toWireError(err)` serializes any error for
a wire, hiding the message of an untyped one. `formatTraceparent(span)` and
`parseTraceparent(header)` convert between an OpenTelemetry span and a W3C `traceparent`.
`cliLogger(debug)` and `silent` are the two loggers the command uses.

### A terminal for your application

`@rhizogrip/spore-cli` carries the terminal screen `spore tui` opens. It is reachable from an
application by its file path. It is not a declared entry point yet: the path and the options may
change in a release without notice.

```js
import { runTui } from '@rhizogrip/spore-cli/tui/index.js'

const code = await runTui({
  ws: '/srv/spores/triage',
  greeting: 'connected to triage',
  commands: [{
    name: 'ticket',
    description: 'attach the current ticket',
    argumentHint: '<id>',
    run: async (args, { ws, notice, send }) => notice(`sending ticket ${args[0]}`)
  }],
  renderTool: (tool, { expanded, width }) => null
})
```

`commands` are added to the built-in ones. Each `run(args, context)` gets `{ ws, notice, send,
outside, confirm, running }`: `notice(text)` shows a line, `send(text)` says something to the
spore, `outside(fn)` runs `fn` on the bare terminal (a pager, an editor) and comes back,
`confirm(title, text)` resolves true on Enter, and `running()` says whether a turn runs.
`renderTool(tool, { expanded, width })` gets `{ callId, name, args, done, durationMs, error }` and
returns lines, or `null` for the default. `runTui` resolves with an exit code.

The screen needs the package's optional dependency `@earendil-works/pi-tui`. An install made with
`--omit=optional` leaves it out, and the import then fails with `ERR_MODULE_NOT_FOUND`.

---

## The HTTP API

`spore-api` serves the library's verbs over HTTP to a caller elsewhere. Running it and writing
`api.json` (where it listens, each caller's token and the spores each caller reaches) is the
operator's: [docs/operating.md](docs/operating.md#the-http-api-service).

### Authentication

Every request, on the socket too, carries the caller's token:

```
Authorization: Bearer <token>
```

A missing or unknown token is `401 API_UNAUTHORIZED`. A spore outside the caller's names is
answered as one that does not exist, `404 NOT_A_WORKSPACE`.

### Routes

All under `/v1`, JSON in and out.

| route | body | answer |
|---|---|---|
| `POST /v1/spores/<name>/messages` | `{ "text", "requestId"?, "replyTo"?, "attach"?: [{ "name", "mime", "data": "<base64>" }] }` | `202 { "inbox", "started", "repeated" }` |
| `GET /v1/spores/<name>/events?after=<seq>` | — | `200`, `application/x-ndjson`: every event after `seq`, then each new one until the turn running (or about to start) ends |
| `GET /v1/spores/<name>/events?after=<seq>&follow=false` | — | the events after `seq` that exist now, then the stream ends |
| `GET /v1/spores/<name>` | — | `200`, what `show` returns |
| `GET /v1/spores` | — | `200 { "spores": [{ "name", "state", "turns" }] }`: the spores under `home` the caller reaches |
| `POST /v1/spores/<name>/stop` | — | `200 { "stopped", "pid" }` |
| `POST /v1/spores/<name>/wrap` | `{ "wait"? }`, as `"10m"`; none is now | `200`, the change or `{ "refused", … }` |
| `POST /v1/spores/<name>/extend` | `{ "dimension", "amount" }`, as `"wall"`, `"30m"` | `200`, the change or `{ "refused", … }` |

`text` is required and must not be blank. `after` is a whole number; `0` replays what retention
kept. A request body is at most 32 MiB.

### Sending and following a message

```bash
curl --unix-socket /run/spore/api.sock -H "Authorization: Bearer $T" \
  -H "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" \
  -d '{"text": "summarize today", "requestId": "job-41"}' \
  http://spore/v1/spores/support-eu/messages
# {"inbox":12,"started":true,"repeated":false}

curl --unix-socket /run/spore/api.sock -H "Authorization: Bearer $T" \
  "http://spore/v1/spores/support-eu/events?after=$LAST_SEQ"
```

1. Keep the last `seq` you have seen for the spore. With none, read once with `after=0` and
   `follow=false` to find where the log ends.
2. Send the message under a `requestId`. Keep `inbox` from the answer.
3. Open `events` after your last `seq`, and update it with each line. The turn that answered you
   is the one whose `turn_end` has `inboxFrom < inbox <= inboxTo`. Its answer is the `output` of
   the `complete` event with the same `turnId`, and also `last.output` in `GET /v1/spores/<name>`
   while that turn is the spore's last.
4. If the stream ends without that `turn_end`, open it again from your last `seq`: the spore reads
   your message in its next turn.

If the connection drops, open `events` again from the last `seq`. Sending again under the same
`requestId` answers the first message's `inbox` with `repeated: true`, and starts nothing if a
turn has already read it.

### Errors

An error is `{ "error": { "type", "message", "detail"? } }`.

| status | `type` |
|---|---|
| 400 | `API_BAD_REQUEST` (a body that is not a JSON object, a message without text, a malformed `attach` or `after`), and any other refusal from a verb, such as `LIMIT_UNKNOWN`, `LIMIT_AMOUNT`, `PLUGIN_NOT_ALLOWED`, `REQUEST_ID_INVALID` |
| 401 | `API_UNAUTHORIZED` |
| 404 | `NOT_A_WORKSPACE`, `API_NOT_FOUND` |
| 405 | `API_METHOD` |
| 413 | `API_TOO_LARGE` |
| 503 | `ADMISSION_FULL`, `PAUSED`, `SPEND_LIMIT` |
| 500 | anything else; `API_FAILED` when the error carried no type |

An error after the event stream has started ends the stream without an error object.

### `traceparent`

A `traceparent` header on a request is the parent of the request's span, `spore.api.<route>`. A
message is sent with that span's context, so the turn it starts is in your trace
([Tracing](#tracing-across-the-boundary)). JSON responses carry the span's `traceparent` when
there is one: when tracing is exported, or when the request carried one. The NDJSON event stream
does not carry it.

---

## Events

The command's `--json`, the library's `watch` and `watchAll`, and the API's `events` route all hand
out the same event objects.
Every consumer outside the turn's process follows a turn through this event log, including one that renders
an answer as it streams.

### The envelope

Every event carries `v` (the schema version, `1`, exported as `EVENT_SCHEMA`), `seq`, `at`,
`runId`, `turnId` and `event`, with its payload's fields beside them. `EVENTS` lists every name.

- **`seq`** is the workspace's count, and only increases. Resume from the last `seq` you handled.
  Retention (`retain` in the definition) drops old runs' events, and `seq` is never reused, so a
  cursor older than what is kept gets what is left.
- **Fields are only added, and names never change meaning.** Ignore an event or a field you do not
  know.
- `PROMISED` lists names the schema reserves and nothing emits yet (`mohdel_idle`).

### The event schema

All but `turn_end` are written by the agent's loop. `turn_end` is written by the supervisor.

| event | payload |
|---|---|
| `round` | `index` |
| `stream` | `kind`, `delta`. `kind` is the model library's delta type: `message` is the answer's text; other kinds carry other streamed parts. Lines are batched (up to 100 ms or 4096 characters per line), and their size is not a contract |
| `tool_start` | `name`, `args`, `callId` |
| `tool_end` | `name`, `callId`, `durationMs`, `error`, `outcome`, `result` (its first 200 characters) — `outcome` is `ok`; `exit` with `exit`, a command that ran to its end and exited non-zero; `killed` with `killed` (`deadline` or `idle`); `signal` with `signal`; `spawn`; or `refused` |
| `tool_block` | `name`, `reason` |
| `heartbeat` | `phase` (`answer` or `tool`), `elapsedMs`, `tool` |
| `usage` | one model call of the loop's own: `model`, `input`, `output`, `thinking`, `cacheWrite`, `cacheRead`, `cost` (as the provider priced it, unsettled), `elapsedMs` |
| `wrap` | `dimension`, the spend at that point, and for a stall `tool` and `because` |
| `interject` | `round`: a message reached the running turn |
| `complete` | `output`, `usage`, `rounds`, `stopReason`, `cancelled`, `terminal`, and `because` for a `quiet` turn |
| `produced` | `files`, each `{ path, bytes, mtime, mime, delivered }`, and `more` |
| `recall` | `hits`, `scores`, or `failed` |
| `compaction_started` | `messages` to summarize, `kept` word for word, `estimated`, `sent`, `budget`: the summary is asked for, before the turn's first round |
| `compaction` | `summaryChars`, `firstKeptIndex` |
| `compaction_failed` | `why`, `estimated`, `sent`, `budget`: the history was over its bound and was not summarized |
| `estimate_drift` | `round`, `model`, `estimated`, `sent`: once a turn, the provider counted far more than the estimate |
| `empty_completion`, `recovery` | what the loop did about a bad or failed model answer |
| `turn_end` | `turnNo`, `stopReason`, `concluded`, `error`, `rounds`, `ownUsd`, `treeUsd`, `workUnits`, `settled`, `inboxFrom`, `inboxTo` |

`tool_start` and `tool_end` carry the agent's arguments and the start of its results: paths,
queries, command lines. Filter them before sending them off the machine.

### `complete` and `turn_end`

Use `complete` to show an answer as soon as it exists. Use `turn_end` to bill, count, match a
sender's message, or close the turn.

| | `complete` | `turn_end` |
|---|---|---|
| written by | the agent | the supervisor |
| when | as the agent's loop ends, before the turn is final | in the same transaction that makes the turn final |
| carries | the answer, `output` | no answer; the final `stopReason`, `concluded`, `turnNo`, the inbox range |
| money | the loop's own `usage`: no cell's, and no call settled after it | `ownUsd` and `treeUsd` as settled; `settled` says whether a ledger counted them |
| how the turn ended | may differ from the record: a wall reached reads `cancelled` here and `hard:wall` in the record, and an agent killed after it is recorded by the runner | the record, and agrees with `readTurns` and the `turns` view |
| after a crash | can be in the log for a turn that is not final until the next runner starts | absent until the turn is final, on recovery if need be, with `settled` false |
| a turn that never started its agent | absent | present, with `error` (`START_FAILED`, `KILLED`, …) |

### `produced`

Written once per turn, before the turn is made final: the files this turn wrote under the
workspace's `data/` and `precursors/` that are still there, newest first, with those under
`data/out/` first and marked `delivered: true`. Files written in `home/`, `calls/`, `schedules/`
or a `writes` directory are not listed. At most 50 are listed; `more` counts the rest. `path` is relative to the workspace. The same list is on the
turn record as `produced` and `producedMore`.

### The turn record

Events are pruned with retention, and an event that fails to write is only logged. A finished
turn's facts are read from its **record**: `readTurns(ws)`, `turnOfMessage`, `watchAll`'s
`turn.record`, the `result` line of `spore send --json`. Its fields include `turnNo`, `turnId`,
`runId`, `startedAt`, `endedAt`, `stopReason`, `concluded`, `because`, `output` (the answer),
`error`, `detail`, `rounds`, `ownUsd`, `treeUsd`, `workUnits`, token counts, `inboxFrom`,
`inboxTo`, `settled`, `produced`, `producedMore`, `model` and `traceparent`.

`stopReason` is `answer`, `question` (the agent called `ask`; `output` is the question), `quiet`
(nothing to say; `output` is null, `because` says why), `soft:<dimension>` (answered at a soft
limit), `hard:<dimension>` (stopped at a hard limit, `spend` included), `cancelled` or `error`
(`error` names it). `concluded` is true when the turn left an `output` or ended `quiet`. See the
[README §How a turn ends](packages/spore/README.md#how-a-turn-ends).

---

## Tracing across the boundary

A caller that is tracing hands its context with the message, and the turn joins its trace.

- **Library:** `send(ws, text, { traceparent })`, a W3C `traceparent` string.
  `formatTraceparent(span)` makes one from an OpenTelemetry span of yours. A malformed one is
  refused with `TRACEPARENT_INVALID`.
- **HTTP API:** a `traceparent` request header. The message carries the context of the API's own
  span, which is its child.
- **The command:** none.

The context is kept on the inbox entry, never shown to the agent. The runner's `spore.turn` span
takes as parent the first message it answers that carries one, and links the other traced messages
it answers. A turn that answers no traced message is a trace of its own. Below `spore.turn` come
the agent's `spore.dispatch`, each cell's, and each model call.

Spans are exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the environment of the runner,
which is the `env` given to `send` (by default `process.env`); `OTEL_SERVICE_NAME` names the
service. Without it nothing is exported, and the context still passes through, so the agent is
traced under your span in your own exporter's view. Details:
[ARCHITECTURE §Tracing](ARCHITECTURE.md#tracing).

---

## Setting up models for your user

A spore runs on the model its definition names, through [`mohdel`](https://www.npmjs.com/package/mohdel).
To set up models for your user from your application, use these re-exports of mohdel's checks and
its `mo` command:

| export | what it does |
|---|---|
| `MO` | the path of the `mo` command spore is installed with, to run with `process.execPath` |
| `loadMohdelEnvironment()` | loads `~/.config/mohdel/environment`, where `mo onboard` writes keys. Call it before a reading |
| `providerReadiness(provider)` | async: `{ provider, credential, models, ready, fix }` |
| `modelsOf(provider)` | async: the catalog's models, or one provider's, each `{ model, billing, priced }` |
| `modelReadiness(model)` | async: `{ model, inCatalog, priced, billing, credential, ready, fix }` |
| `upstream(provider)` | async: what the provider lists beyond the catalog, each `{ id, label, inputPrice, outputPrice }`, or `null` when mohdel cannot list it |
| `curate(provider, ids)` | async: adds those ids to the catalog, each `{ model, priced }`. Throws a plain `Error` naming why when it cannot |

```js
import { spawnSync } from 'node:child_process'
import { loadMohdelEnvironment, MO, modelReadiness, modelsOf, setDefaultModel } from '@rhizogrip/spore'

spawnSync(process.execPath, [MO, 'onboard', 'openrouter'], { stdio: 'inherit' })
loadMohdelEnvironment()

const choices = await modelsOf('openrouter')
const picked = choices[0].model
const ready = await modelReadiness(picked)
if (!ready.ready) throw new Error(`not ready: ${ready.fix}`)
setDefaultModel(picked)
```

`modelsOf` is the list to offer your user. Instead of `setDefaultModel`, a single spore takes the
model at `define({ ws, model })`. `fix` is the `mo` command that closes the first thing missing.
A model with `priced: false` runs, and its calls count as $0, so `cost` and the host's spend
limits never stop it: offer `fix` before relying on them. `modelFindings()` checks every model the host's spores name. mohdel's own
INTEGRATION.md, §Setting up your user, has the rest.

---

## Rules an integrator keeps

### One runner per workspace

Never start a turn yourself, and never add a row to the inbox by hand. Always go through `send`: it
decides whether to start a turn or deliver to the one running.
([PRINCIPLES 16](PRINCIPLES.md#16-every-message-lands-in-the-same-inbox),
[18](PRINCIPLES.md#18-each-rule-is-written-once))

### The workspace is the state

Keep nothing about a spore that the workspace already holds. What is running is `stateOf`, what was
said is the inbox, how a turn ended is its record. Your service keeps a cursor per spore and the
inbox positions of its own messages, and nothing else.
([PRINCIPLES 15](PRINCIPLES.md#15-the-folder-is-the-spore),
[17](PRINCIPLES.md#17-spore-watches-it-runs-no-central-service))

### A turn outlives its caller

`send` returns once the runner has started. Exiting, crashing or aborting a `watch` does not stop
the turn; `stop(ws)` does. spore never retries a refused `send` or a failed turn; retrying is up to
you.

### Idempotency

Send every message that might be sent twice under a `requestId` (`--request-id`, `"requestId"`).
The inbox takes it once. A repeat returns the first message's `inbox` with `repeated: true`, and
starts nothing when a finished turn has already read it. A repeat of a message that was said and
never read starts a turn for it. `runBatch` does this for you, under `errand:<id>:<i>`.

### Refusals

Refusals are `SporeError`s. Branch on `err.type`, never on the message. These are the ones a
program driving spores meets most; every function's own list is in [docs/library.md](docs/library.md).

| `type` | from | meaning |
|---|---|---|
| `ADMISSION_FULL` | `send`, `fork` | every one of the user's turn slots is held. Nothing was said, unless the error's `detail` says the message is in the inbox (a running turn let go at that moment); the next turn reads it then. `retryable` |
| `SPEND_LIMIT` | `send`, `fork` | the user's spores reached `spendPerDay` or `spendPerMonth`. Clears when the day or month turns or the limit is raised |
| `PAUSED` | `send`, `fork` | `spore pause` is in force. Clears with `unpause` ([docs/operating.md](docs/operating.md#pausing-every-spore)) |
| `NOT_A_WORKSPACE` | the read verbs, the API | no spore by that name, or the caller does not reach it |
| `CONFIG_NO_HOME`, `CONFIG_BAD_NAME` | `workspaceFor` | a name with no `home` set; a name that is not one path segment |
| `PLUGIN_NOT_ALLOWED`, `PLUGIN_CHANGED` | `send` | the definition names a plugin the host has not allowed, or one that changed since it was |
| `MESSAGE_EMPTY` | `send` | no text and no file |
| `REQUEST_ID_INVALID`, `TRACEPARENT_INVALID` | `send` | a request id that is not a non-empty string; a malformed `traceparent` |
| `INBOX_UNWRITABLE` | `send` | the inbox could not be written |
| `DEFINITION_INVALID` | `show`, `log`, `grantOf`, `extend` | the spore's `spore.cmk` does not parse |
| `LIMIT_UNKNOWN`, `LIMIT_AMOUNT` | `extend`, `wrap` | not `rounds`, `cost` or `wall`; an amount or wait that does not read |
| `MODEL_NOT_OFFERED` | `switchModel` | the definition does not offer that model |
| `FORK_REFUSED` | `fork` | the cut cannot be made ([docs/operating.md](docs/operating.md#forking-a-turn-spore-fork)) |
| `BATCH_USAGE` | `runBatch` | an errand without an `id` or messages, or a bad `atOnce` |
| `SQLITE_TOO_OLD` | `checkSqlite` | Node's SQLite is older than spore needs |

`retryable` is true on `ADMISSION_FULL`, `SPEND_LIMIT` and `PAUSED`.

A turn that fails is not a thrown error. It is a record with `stopReason: 'error'` and `error`
naming why (`START_FAILED`, `DISK_FULL`, `CONTAIN_FAILED`, …), and its message waits unread for the
next turn. A turn stopped by a hard limit ends `hard:<dimension>`
([PRINCIPLES 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops)).
