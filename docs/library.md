# The library, export by export

Every export of `@rhizogrip/spore` (`packages/spore/src/index.js`): signature, return value,
errors. For a walkthrough, start with [INTEGRATION.md](../INTEGRATION.md).

Conventions that hold throughout:

- **A workspace is a path.** `send`, `watch`, `stateOf`, the readers and every other function
  that takes `ws` as its first argument want the workspace's **path**. Resolve a name with
  `workspaceFor(name).path`, and check `isWorkspace(path)` first. A function that takes `{ ws }`
  in an options object instead accepts a name (resolved under `home`) or a path, and with no `ws`
  the current directory; it throws `NOT_A_WORKSPACE` for a spore that is not there.
- **Load the environment first.** A program calls `loadEnvironment()` once at start, so provider
  keys and plugin settings the operator keeps reach the turns it starts.
- **Errors are `SporeError`**, branched on `err.type`, with `detail` saying what to do. A reader
  opening a workspace database for the first time in a process throws `SQLITE_TOO_OLD` when
  Node's SQLite is too old (`checkSqlite`).
- **`configFile`** is the host's `config.json` and defaults to `CONFIG_FILE` wherever it appears.
  **`roots`** is where plugins are looked for and defaults to `pluginRoots()`. **`env`** defaults
  to `process.env`.
- Money is in dollars unless a field ends in `Micros`; times are ISO 8601 strings unless a field
  ends in `Ms`.
- `SLOT_DIR` is not exported: it is the directory of this user's admission slots,
  `$XDG_STATE_HOME/spore/slots` (else `~/.local/state/spore/slots`).

## Groups

1. [Saying something and following it](#saying-something-and-following-it)
2. [Answers addressed elsewhere](#answers-addressed-elsewhere)
3. [Reading a spore](#reading-a-spore)
4. [Defining and changing spores](#defining-and-changing-spores)
5. [Stopping, pausing and running many](#stopping-pausing-and-running-many)
6. [Limits on a running turn](#limits-on-a-running-turn)
7. [The clock and held deliveries](#the-clock-and-held-deliveries)
8. [Host configuration](#host-configuration)
9. [Plugins and services](#plugins-and-services)
10. [Models and the machine](#models-and-the-machine)
11. [Definitions](#definitions)
12. [Low-level readers and helpers](#low-level-readers-and-helpers)
13. [Events, errors, tracing and logging](#events-errors-tracing-and-logging)

---

## Saying something and following it

The guide:
[INTEGRATION §Saying something and following it](../INTEGRATION.md#saying-something-and-following-it)
and [§A service in front of many spores](../INTEGRATION.md#a-service-in-front-of-many-spores).

### `send`

```
send(ws, text, { attach = [], requestId, replyTo, traceparent, start = true, env,
                 schedule, hook, unsafe = false, debug = false })
→ { ws, started, pid, inbox, repeated }
```

Adds a message to the spore's inbox and starts a turn when none is running; a running turn reads
it between rounds. It returns once the runner has started. `inbox` is the message's inbox
position, `started` says whether this call started a turn, `pid` is the runner's or `null`, and
`repeated` is true when `requestId` had been sent before.

- `attach`: `[{ name, mime, data }]`, `data` a Buffer, written under `inbox.d/`.
- `requestId`: the message is taken once
  ([INTEGRATION §Idempotency](../INTEGRATION.md#idempotency)).
- `replyTo`: where the answer goes
  ([§Delivering answers elsewhere](../INTEGRATION.md#delivering-answers-elsewhere)).
- `traceparent`: a W3C trace context the turn is traced under.
- `start: false`: says the message and starts nothing.
- `env`: the environment the runner starts with.
- `schedule` (`{ name, due }`) and `hook` (`{ name, delivery, event? }`): record the message as
  said by the clock or by a webhook, as `tick` and the webhook service do.
- `unsafe`: turns off all confinement for the turn — no Landlock, no namespaces of its own, no
  seccomp filter. For a host without Landlock; `spore send --unsafe` sets it. `debug`: starts
  the runner with debug output.

Throws `ADMISSION_FULL`, `SPEND_LIMIT`, `PAUSED` (each `retryable`; when the message was already
said, `detail` says so), `MESSAGE_EMPTY`, `REQUEST_ID_INVALID`, `TRACEPARENT_INVALID`,
`HOOK_INVALID`, `INBOX_UNWRITABLE`, and the refusals of a spore whose plugins cannot be
prepared, such as `PLUGIN_NOT_ALLOWED`, `PLUGIN_CHANGED`, `PLUGIN_NOT_INSTALLED`, `PLUGIN_CONFLICT`,
`PLUGIN_INVALID`, `PLUGIN_INCOMPATIBLE`.

### `lastEventSeq`

```
lastEventSeq(ws) → number
```

The `seq` of the last event the workspace ever had, `0` before any. Read it **before** `send` to
follow only what comes after. Pruning never lowers it.

### `watch`

```
watch(ws, { after = 0, tick = 1000, grace = 5000, signal }) → AsyncGenerator<event>
```

Yields every event after `after`, then each new one until the running turn ends. When no turn is
seen running within `grace` milliseconds, it ends with what was there. `tick` bounds how long it
waits between looks when no change is reported. Aborting `signal` stops the iterator, not the
turn. Events: [INTEGRATION §Events](../INTEGRATION.md#events).

### `readInbox`

```
readInbox(ws, { after = 0, upto = null }) → entry[]
```

The inbox entries with `inboxNo` in `(after, upto]`, every one past `after` when `upto` is null,
in order. An entry carries `inboxNo`, `at`, `text` or a `bodyPath` with `bodyBytes`, `bodyHead`
and `bodyTail`, `files`, `schedule`, `due`, `hook`, `hookEvent`, `hookDelivery`, `job`,
`jobEvent`, `jobRun`, `traceparent`, `requestId`, `replyTo`, and `consumed` (a finished turn has
read it).

### `turnOfMessage`

```
turnOfMessage(ws, { inboxNo, at }) → { turn, read } | null
```

The finished turn that ended an inbox entry: the one that read it (`read: true`), or else the
first turn started after it that read nothing (`read: false`, a runner that failed before
reading). `null` while neither has happened. `turn` is a turn record
([INTEGRATION §The turn record](../INTEGRATION.md#the-turn-record)).

### `outcome`

```
outcome(ws) → { stopReason, concluded, rounds, treeUsd, workUnits, produced, producedMore,
                endedAt } | null
```

How the spore's last finished turn ended, or `null` before any.

### `follow`

```
follow(ws, { lines = 0, out = process.stdout, err = process.stderr, tick = 150, grace = 5000 })
→ Promise<'ended' | 'detached'>
```

Writes the running turn's text output (`spore.out`, `spore.err`) to two streams until the turn
ends, as `spore send` does in a terminal. `lines` shows that many of the last lines already
written first. It resolves `'detached'` when SIGINT arrives; the turn goes on.

### `watchAll`

```
watchAll(spores, { cursors = {}, tick = 1000, signal })
→ AsyncGenerator<{ ws, cursor, event } | { ws, cursor, turn: { record, asked } }>
```

Follows many spores with one iterator. It never ends by itself; abort `signal` to stop it.
`spores` is a list of paths or a function returning one, read again on every wake. `cursor` is
`{ seq, turn, database }` and is what a caller saves and hands back in `cursors`, keyed by path.
Details:
[INTEGRATION §A service in front of many spores](../INTEGRATION.md#a-service-in-front-of-many-spores).

### `turnsSince`

```
turnsSince(ws, turnNo) → { turn, ended: [{ record, asked }] }
```

Every turn finished after `turnNo`: its record, and `asked`, the inbox entries it answered.
`turn` is the last `turnNo` returned, or `turnNo` when there is none.

---

## Answers addressed elsewhere

The guide:
[INTEGRATION §Delivering answers elsewhere](../INTEGRATION.md#delivering-answers-elsewhere).

### `outbox`

```
outbox(ws, { kind, state }) → [{ outboxNo, at, turnId, turnNo, recipient, answers, state,
                                 settledAt, reason }]
```

The outbox entries whose recipient is of `kind` (`'chat'` for `chat:…`) and in `state`
(`pending`, `delivered` or `refused`), oldest first. Omit `kind` or `state` to match any.

### `settleOutbox`

```
settleOutbox(ws, outboxNo, { refused }) → boolean
```

Marks a pending entry delivered, or refused with the reason given in `refused`. Returns `false`
when the entry was not pending.

---

## Reading a spore

Nothing here starts anything. The verbs taking `{ ws }` are what `spore ls`, `show`, `log` and
the others print. The guide:
[INTEGRATION §Reading what exists](../INTEGRATION.md#reading-what-exists).

### `list`

```
list({ where, disk = false, configFile })
→ { configured, file, home, asked, paused, spend, contain, missing, workspaces }
```

Every spore the configuration points at: those directly under `home` and those named in
`workspaces`, one level further down with `homeSplit`. `where` lists the spores directly under
that directory instead; `home` is then that
directory, and `asked` is true. Each row of
`workspaces` is `{ ws, from, writes, definitionError, …stateOf(ws) }`, with `bytes` when `disk` is
true (a walk of the whole tree). `missing` is `[{ path, why }]` for listed paths that are gone or
not a spore. `paused` is `paused()`, `spend` is `spendSoFar()`. Throws the `CONFIG_*` refusals of
`readConfig`.

### `show`

```
show({ ws, configFile }) → object
```

One spore in detail, read from its files: `ws`, the `stateOf` fields, `name`, `description`,
`sporangium`, `model`, `models`, `cellModels`, `billing`, `sources`, `scopes`, `tools`, `limits`,
`extend`, `turnLimits` (the running turn's limits, as `{ startedAt, limits }`), `memory`, `reads`,
`writes`, `messages` (transcript length), `waiting` (unread messages, a count), `paused`, `held`,
`cells` (of the last 24 hours), `jobs` (`{ grant, running }`), `endedAt`, `produced`,
`producedMore`, `workUnits`, `workUnitsOwn`, `workUnitsChildren`, `precursors`, `plugins`,
`differs` (root documents that differ from the installed ones), `disk`, `schedules` and
`scheduleBound` (the turns and nominal cost the schedule grant allows per day). Throws
`NOT_A_WORKSPACE`, `DEFINITION_INVALID`.

### `log`

```
log({ ws, configFile }) → { ws, turns, waiting, held }
```

One entry per finished turn, `{ endedAt, stopReason, concluded, rounds, treeUsd, workUnits,
error, detail, asked }`, where `asked` is the text each message it answered gave the turn
(`saidOf`). `waiting` is the unread inbox entries; `held` is the schedules `held` or `refused`.
Throws `NOT_A_WORKSPACE`, `DEFINITION_INVALID`.

### `usage`

```
usage({ ws, days, since, until, tz, configFile })
→ { ws, window, days, by, totals, unsettled, spend? }
```

What one spore, or every spore `list` finds when `ws` is left out (`ws: null` in the answer,
with `spend`), spent over local days in `tz` (default: the process's time zone): the last `days`
up to today (7 when neither is given), or `since` to `until` (`YYYY-MM-DD`, `until` defaulting to
today). `days` is one row per day; `by` has `spore`, `origin`, `model`, `outcome` and `precursor`,
each `[{ key, …counters }]`, most spent first; `unsettled` counts final turns no ledger settled.
Throws `USAGE_INVALID` (both `days` and `since`, or a bad window), `CONFIG_MISSING` (no
`config.json` when asking for every spore), `NOT_A_WORKSPACE`.

### `precursors`

```
precursors({ ws, configFile }) → { ws, precursors: string[] }
```

The names of the precursors in the spore's `precursors/`, sorted.

### `schedules`

```
schedules({ ws, configFile }) → { ws, schedules: row[] }
```

The spore's schedules and where each stands, as `survey` reads them, without their message.
Throws `NOT_A_WORKSPACE`, `DEFINITION_INVALID`.

### `jobs`

```
jobs({ ws, configFile }) → { ws, grant, jobs }
```

The spore's `jobs` grant and its jobs, each `{ jobNo, name, run, command, wallMs, pid, startedAt,
endedAt, status, exit, signal, progress }`, where `progress` is the last line a running job wrote
to its `progress` file, or `null`. Throws `NOT_A_WORKSPACE`, `DEFINITION_INVALID`.

### `sql`

```
sql({ ws, query = '.tables', json = false, configFile }) → { ws, lines: string[] }
```

A read-only query over the workspace database, as `spore sql`. `.tables` lists the views,
`.schema [name]` their definitions; any other query returns aligned rows, or one JSON object per
line with `json`. Throws `SQL_NO_DATABASE` (nothing recorded yet), `SQL_NO_SUCH_NAME`,
`NOT_A_WORKSPACE`; a query SQLite refuses throws SQLite's own error.

### `grantOf`

```
grantOf(ws) → { model, tools, limits, billing }
```

The model, tools and limits a turn starts with, and the model's `billing` (`billingFor`): what
`send` and `fork` print when a turn starts. Throws `DEFINITION_INVALID`.

### `stateOf`

```
stateOf(ws) → { state, lastTurnNo, treeUsd, last, pid?, startedAt?, draining?, dreaming? }
```

What the spore is doing now. `state` is `running`, `idle`, `waiting` (its last turn asked a
question), `wrapped`, `halted`, `cancelled`, `failed` or `crashed` (a runner died without
recording its turn). `last` is the last turn record; while `draining`, the turn has ended and its
record waits for model calls still in flight, and `last` is that pending record. While
`dreaming`, the lock is held by the spore's dream rather than a turn
([ARCHITECTURE §Dreams](../ARCHITECTURE.md#dreams)); `stateWord` says `dreaming` where `state`
says `running`. `treeUsd` is every finished turn's spend, cells included.

### `stateWord`

```
stateWord(state) → string
```

A `stateOf` result as a person reads it: `dreaming` while the spore dreams, its `state` otherwise.

### `RUNNING`

The string `'running'`: the `state` of `stateOf` while a turn runs.

### `readTurns`

```
readTurns(ws) → record[]
```

Every finished turn's record, in order
([INTEGRATION §The turn record](../INTEGRATION.md#the-turn-record)).

### `readTranscript`

```
readTranscript(ws) → message[]
```

The conversation as the model last saw it: each compaction replaces the messages it summarized.

### `textOf`

```
textOf(message) → string
```

A message's text: its `content` when that is a string, the joined `text` parts when it is a part
array, else `''`.

### `readEvents`

```
readEvents(ws, { after = 0, event = null, runIds = null, limit = -1 }) → event[]
```

The events past `after`, in order, without following: only of one name given `event`, only of
some runs given `runIds`, at most `limit` (`-1` for all).

### `isWorkspace`

```
isWorkspace(dir) → boolean
```

True when `dir` holds a `spore.cmk`.

### `workspacesIn`

```
workspacesIn(dir) → string[]
```

The spores directly inside `dir`, one level down, as absolute paths; `[]` when `dir` cannot be
read.

### `sporangia`

```
sporangia({ configFile }) → [{ name, description, error }]
```

Every sporangium a spore can be made from, the package's and the operator's, with the
`description` of its `spore.cmk`. One that cannot be read has `error` instead.

### `defaultModel`

```
defaultModel({ configFile }) → { path, model }
```

The model new spores get: the `model:` line of the operator's default sporangium at `path`, or
`model: null` when that file does not exist or names none. Throws `DEFINITION_INVALID`.

### `paused`

```
paused({ dir = SLOT_DIR }) → { at, why? } | null
```

The pause in force on this user's spores, or `null`
([docs/operating.md §Pausing every spore](operating.md#pausing-every-spore)).

### `spendSoFar`

```
spendSoFar({ dir = SLOT_DIR, config = readConfig() }) → { date, day, month, limits: { day, month } }
```

What this user's spores have settled today and this month, beside the `spendPerDay` and
`spendPerMonth` limits (`null` where none is set).

### `listHooks`

```
listHooks({ configFile, env, now = Date.now }) → { file, since, hooks }
```

The hooks in `hooks.json` and what each said to its spores over the last week: per hook `name`,
`path`, `verify`, `accept`, `maxBytes`, `perHour`, `maxWait`, `perDay` and `spores`, each spore
with its deliveries, held deliveries, router and triage cells. Throws `WEBHOOK_NO_HOOKS`,
`WEBHOOK_INVALID` ([docs/operating.md §Webhooks](operating.md#webhooks-hooksjson)).

### `showHook`

```
showHook(name, { configFile, env, now = Date.now, last = 20 }) → { file, since, …hook }
```

One hook as `listHooks` describes it, with its `last` deliveries and cells. Throws
`WEBHOOK_UNKNOWN`, `WEBHOOK_NO_HOOKS`, `WEBHOOK_INVALID`.

---

## Defining and changing spores

The guide: [INTEGRATION §Making and changing spores](../INTEGRATION.md#making-and-changing-spores).

### `define`

```
define({ ws, definition, from, sporangium, model, plugins = [], writes = [], configFile, roots })
→ { ws, file, definition, sporangium?, seeded, remembered, redefined, already, cloned? }
```

Makes a spore, or revises one's `spore.cmk`. A new spore comes from one place: `sporangium` (the
default sporangium when nothing is given), `definition` (a `.cmk` file) or `from` (another spore,
whose precursors and granted enzymes are carried over: `cloned`). `model`, `plugins` and `writes`
(`name=path` grants) fill in the new spore's `spore.cmk`. For an existing spore, `definition`
replaces its `spore.cmk` and keeps its conversation and `data/` (`redefined: { from, to }`);
nothing given answers `already: true`. A spore made outside `home` is added to `workspaces`
(`remembered`). `seeded` is the default sporangium's `spore.cmk` when this call created it.

Throws `DEFINE_AMBIGUOUS`, `DEFINE_FILLS_ONLY_NEW`, `WRITES_REFUSED` (a `writes` grant the runner would
refuse at every turn, with its reason as `detail`), `CLONE_SOURCE_MISSING`, `CLONE_INCOMPLETE`,
`WORKSPACE_REFUSED`, `DEFINITION_INVALID`, `MODEL_NOT_SET`, `SPORANGIUM_UNKNOWN`,
`SPORANGIUM_INVALID`, the `CONFIG_*` refusals of `workspaceFor`, and the plugin refusals of
`send`.

### `edit`

```
edit({ ws, open, again, configFile })
→ Promise<{ ws, edited: true, changes: string[], running }
          | { ws, edited: false, why: 'editor' | 'unchanged' | 'refused', status?, error? }>
```

Edits a spore's definition through the caller's editor. `open(path)` is given a copy and returns
the editor's exit status; a copy that does not parse goes to `async again(error)`, which says
whether to open it once more. A parsed copy replaces `spore.cmk`; `changes` says what changed,
one line each, and `running` whether a turn is running (it reads the new file next turn). Throws
`EDIT_CONFLICT` when `spore.cmk` changed meanwhile (the copy is kept, named in `detail`),
`NOT_A_WORKSPACE`.

### `switchModel`

```
switchModel({ ws, model, configFile }) → { ws, model, was }
```

Sets the model the spore runs on from its next turn, among those its definition offers (`model:`
and `models:`); the one it leaves stays offered. Throws `MODEL_NOT_OFFERED`,
`DEFINITION_INVALID`, `NOT_A_WORKSPACE`.

### `setDefaultModel`

```
setDefaultModel(model, { configFile }) → { path, model }
```

Writes the `model:` line of the operator's default sporangium, the model new spores get. It
does not check the model with mohdel (`modelReadiness` does). Throws `DEFINITION_INVALID`.

### `remake`

```
remake({ ws, configFile, roots }) → { ws, aside, sporangium, moved }
```

Makes the spore again in place from its sporangium. Its definition, `data/`, `home/`,
precursors and schedules are moved into the new one (`moved`); its database, trail and inbox
stay in `<ws>.before-remake` (`aside`) until its owner removes it. Throws `REMAKE_RUNNING`,
`REMAKE_ASIDE_EXISTS`, `WORKSPACE_REFUSED`, `SPORANGIUM_UNKNOWN`, `NOT_A_WORKSPACE`.

### `remove`

```
remove({ ws, yes = false, configFile }) → { ws, turns, treeUsd, bytes }
```

Removes the whole workspace under its lock. Throws `SPORE_HAS_TURNS` for a spore with recorded
turns unless `yes`, `SPORE_RUNNING`, `WORKSPACE_REFUSED`, `NOT_A_WORKSPACE`.

### `upgrade`

```
upgrade({ ws, all = false, configFile }) → { upgraded: [{ ws, replaced }] }
```

Replaces a spore's root documents (`reference.md`, `libraries.md`, `plugins/<name>.md`) that
differ from the installed ones; `all` does it for every spore `list` finds
([docs/operating.md §Root documents](operating.md#root-documents-and-spore-upgrade)).

### `differingDocs`

```
differingDocs(ws, { config = readConfig(), roots }) → [{ file, installed }]
```

The root documents of a spore that differ from the installed copy at `installed`: what `upgrade`
would replace.

### `setSchedule`

```
setSchedule({ ws, name, source, configFile }) → { ws, name, path }
```

Installs `schedules/<name>.cmk` from `source`, checked first against the grammar and the
definition's `schedules` grant ([docs/definition.md §A schedule](definition.md#a-schedule)).
Throws `SCHEDULE_REFUSED`, `DEFINITION_INVALID`, `NOT_A_WORKSPACE`.

### `removeSchedule`

```
removeSchedule({ ws, name, configFile }) → { ws, name, path }
```

Removes a schedule; what it fired stays in the inbox. Throws `SCHEDULE_MISSING`,
`SCHEDULE_REFUSED` (a name that cannot be a schedule's), `NOT_A_WORKSPACE`.

### `fork`

```
fork({ run, at, into, definition, replay = false, unsafe = false, debug = false, env })
→ { ws, from, at, runId, rounds, inboxTo, startedAt, cutAt, replay, definition, pid }
```

Makes `into` as the workspace `run` stood when the round of call `at` came back (`'0003'` for a
call of the last turn, `'<runId>/0003'` for another), and starts the turn going on from there,
under `definition` when given. `replay` cuts before the round's results, so its calls run again.
Returns once the runner has started, like `send`. Throws `FORK_REFUSED`, and `ADMISSION_FULL`,
`SPEND_LIMIT`, `PAUSED`
([docs/operating.md §Forking a turn](operating.md#forking-a-turn-spore-fork)).

### `forkWorkspace`

```
forkWorkspace({ run, at, into, definition, replay = false })
→ { ws, from, at, runId, rounds, inboxTo, startedAt, cutAt, replay, definition }
```

Makes the fork without starting it. Throws `FORK_REFUSED`.

### `readFork`

```
readFork(ws) → { from, at, runId, rounds, inboxTo, startedAt, cutAt, replay, definition }
```

What a fork was cut from, as `fork` recorded it in `fork.json`. Throws `FORK_REFUSED` when `ws`
is not a fork.

### `defaultSporangiumPath`

```
defaultSporangiumPath(configFile) → string
```

Where the operator's default sporangium `spore.cmk` is: `sporangia/default/spore.cmk` beside
`config.json`.

### `DEFAULT_SPORANGIUM`

The string `'default'`: the name of the sporangium applied to every new spore before the one it
names.

---

## Stopping, pausing and running many

### `stop`

```
stop(ws) → { stopped, pid }
```

Sends SIGTERM to the process holding the workspace lock; the turn is recorded `cancelled`.
`stopped: false` and `pid: null` when nothing is running.

### `pause`

```
pause({ why, configFile, stopTurn = stop, stopJob }) → { mark, already, turns, jobs }
```

Marks this user's spores paused, so no turn and no job starts and `send` refuses with `PAUSED`,
then stops every running turn and job of the spores `list` finds. `already` is true when a pause
was in force (its mark stands). `turns` and `jobs` name what was stopped. `stopTurn` and
`stopJob` replace how each is stopped
([docs/operating.md §Pausing every spore](operating.md#pausing-every-spore)).

### `unpause`

```
unpause() → { unpaused, mark }
```

Lifts the pause; `unpaused` is false when there was none. The next `tick` releases what was held
and due.

### `stopJob`

```
stopJob({ ws, name, configFile }) → { ws, name, run, pid }
```

Asks a running job's supervisor to stop it. Throws `JOB_NOT_RUNNING`, `JOB_GONE`,
`NOT_A_WORKSPACE`.

### `runBatch`

```
runBatch(errands, { atOnce = 4, deadline = Infinity, pollMs = 2000, report, env,
                    deliver = send, now = Date.now, wait })
→ Promise<{ stuck, ended: [{ errand, turns, crashed? }] }>
```

Runs many spores, at most `atOnce` at a time, each errand `{ ws, messages, label, id }` sent its
messages one after another under the request ids `errand:<id>:<i>`, and waits. `report` is
called with `{ event: 'started' | 'full' | 'ended', errand, … }`. `deliver`, `now` and `wait`
replace `send`, the clock and the pause between polls. Throws `BATCH_USAGE`, and any refusal of
`send` other than `ADMISSION_FULL`, which is tried again at the next poll
([INTEGRATION §Many spores at once](../INTEGRATION.md#many-spores-at-once)).

---

## Limits on a running turn

Each returns the change it recorded, `{ turnId, dimension, why, soft, hard, was: { soft, hard } }`,
or a refusal `{ refused, dimension, … }`: `idle` (nothing running), `unrecorded`, `ungranted` (no
`extend.<dimension>`), `ceiling` (with `ceiling`, `hard` and `room`) or `later` (it already wraps
sooner, with `soft`). Rounds are counts, cost dollars, wall milliseconds
([docs/definition.md §`extend.*`](definition.md#extend)).

### `extend`

```
extend({ ws, dimension, amount, configFile }) → change | refusal
```

Raises the running turn's soft and hard `dimension` (`rounds`, `cost` or `wall`) by `amount` as
written (`'20'`, `'1.50'`, `'30m'`), within the definition's `extend.*`. Throws `LIMIT_UNKNOWN`,
`LIMIT_AMOUNT`, `DEFINITION_INVALID`, `NOT_A_WORKSPACE`.

### `wrap`

```
wrap({ ws, wait, configFile }) → change | refusal
```

Brings the running turn's wrap-up to `wait` from now (`'10m'`), or to now when absent. Throws
`LIMIT_AMOUNT`, `NOT_A_WORKSPACE`.

### `extendTurn`

```
extendTurn(ws, dimension, amount) → change | refusal
```

`extend` on a workspace path. Throws `LIMIT_UNKNOWN`, `LIMIT_AMOUNT`, `DEFINITION_INVALID`.

### `wrapTurn`

```
wrapTurn(ws, wait) → change | refusal
```

`wrap` on a workspace path. Throws `LIMIT_AMOUNT`.

### `changeText`

```
changeText(answer) → string
```

A change or refusal said in words, as the command prints it.

### `runningLines`

```
runningLines({ startedAt, limits }, extend, now = Date.now()) → string[]
```

One line per limit of a running turn: when it wraps, when it stops and how far `extend` allows
raising it. Pass `show`'s `turnLimits` and `extend`.

---

## The clock and held deliveries

Schedules, and deliveries from webhooks and jobs that wait before they reach a spore
([docs/definition.md §A schedule](definition.md#a-schedule),
[docs/operating.md §Webhooks](operating.md#webhooks-hooksjson)).

### `tick`

```
tick({ now = Date.now(), configFile, lock = TICK_LOCK, env })
→ { ran, paused?, lines }
```

One pass over every spore `list` finds: records jobs whose supervisor is gone (`interrupted`),
releases held deliveries that are due, and sends each due schedule. `ran: false` when another
pass holds `lock`. While paused, `paused` carries the mark and nothing fires. Each line is
`{ ws, state, … }`, `state` being `fired`, `held`, `refused`, `stale`, `later`, `spent`, `failed`,
`released` or `interrupted`.

### `tickReport`

```
tickReport(result) → { lines: string[], exit: 0 | 1 }
```

A `tick` result as journal lines (JSON), leaving out `later` and `spent`; `exit` is 1 when a line
`failed`.

### `TICK_LOCK`

The path of the lock one `tick` pass holds: `tick.lock` in spore's state directory
(`$XDG_STATE_HOME/spore/`).

### `release`

```
release(ws, { now = Date.now(), env }) → { ws, released, started, pid? }
```

Moves the held deliveries that are due into the inbox, then starts a turn to read them or joins
the running one, as `send` does. While a turn runs, only deliveries past their deadline move,
into that turn. Throws `ADMISSION_FULL`, `SPEND_LIMIT`, `PAUSED` and the plugin refusals of `send`.

### `survey`

```
survey(ws, { spore, grant, now = Date.now() })
→ [{ name, when, tz, at, lastFired, state, why?, slot?, next?, message? }]
```

Where every schedule of a workspace stands, given `spore` (its `stateOf`) and `grant` (the
definition's `schedules`, `{ count, interval }`, or `null`): `refused`, `held`, `due`, `later`,
`stale` or `spent`.

### `parseSchedule`

```
parseSchedule(source) → schedule | { error }
```

A schedule file parsed: `when`, `tz`, `at`, `message` and its other fields, or the parser's
refusal.

### `SCHEDULE_DIR`

The string `'schedules'`: the directory of a workspace that holds its schedules.

### `heldIn`

```
heldIn(ws) → [{ heldNo, at, releaseAt, deadline, origin, summary, entry }]
```

The held deliveries, oldest first; `entry` is the inbox entry it becomes, as JSON text.

## Host configuration

The settings: [docs/operating.md §`config.json`](operating.md#configjson).

### `loadEnvironment`

```
loadEnvironment(file = CONFIG_FILE, env = process.env) → { path, loaded: string[] }
```

Loads the `environment` file beside `config.json` into `env`: `KEY=value` lines, as systemd's
`EnvironmentFile=` reads them. A variable already set wins; `loaded` names those set. A missing
file loads nothing. Throws `ENVIRONMENT_INVALID`.

### `readConfig`

```
readConfig(file = CONFIG_FILE) → { …settings, home, workspaces, file, exists }
```

The host's `config.json`, with `home` and `workspaces` expanded to absolute paths. A missing file
is `{ home: null, workspaces: [], file, exists: false }`. Throws `CONFIG_UNREADABLE`,
`CONFIG_INVALID`, and `CONFIG_HOME_LAID_OUT` when `home`'s layout record names another
`homeSplit` than the file.

### `settings`

```
settings(file = CONFIG_FILE) → [{ key, value, from }]
```

Every setting with the value in effect and where it comes from: `set`, `default` or `unset`,
then `plugins` and `replyTo` when set.

### `getKey`

```
getKey(key, file = CONFIG_FILE) → { [key]: value } | object
```

One setting as written, or the whole file as written when `key` is empty. Throws
`CONFIG_UNKNOWN_KEY`.

### `setKey`

```
setKey(key, value, file = CONFIG_FILE) → object
```

Writes one setting from its text, as `spore config set` does: a list as comma-separated paths, a
count or an amount as a number, `contain` as `on` or `off`. Returns the file as written. Throws
`CONFIG_UNKNOWN_KEY`, `CONFIG_INVALID`.

### `addTo`

```
addTo(key, value, file = CONFIG_FILE) → object
```

Adds a path to a list setting (`workspaces`). Throws `CONFIG_NOT_A_LIST`, `CONFIG_UNKNOWN_KEY`.

### `removeFrom`

```
removeFrom(key, value, file = CONFIG_FILE) → object
```

Removes a path from a list setting, or the whole setting when `value` is left out. Throws
`CONFIG_NOT_A_LIST`, `CONFIG_UNKNOWN_KEY`.

### `workspaceFor`

```
workspaceFor(asked, { config, cwd = process.cwd(), file = CONFIG_FILE }) → { path, named, home? }
```

What a spore argument names. A path-shaped argument (`NAMES_A_PATH`) is taken as written, a name
is the directory of that name under `home` (`named: true`), or under `home/<its last homeSplit
characters>` when `homeSplit` is set, and nothing is `cwd`. Throws
`CONFIG_BAD_NAME`, `CONFIG_NO_HOME`, `CONFIG_HOME_IS_A_WORKSPACE`, and the refusals of
`readConfig`.

### `recordLayout`

```
recordLayout(home, homeSplit) → undefined
```

Writes `home`'s layout record, `<home>/.spore-home`, saying `homeSplit` (null for flat), unless
one is already there. `define` calls it with a home's first spore; a program that makes spores
with its own code calls it itself, at every start, so the home is guarded from its first spore
on. It never compares: a record naming another value stays, and the next `readConfig` refuses
(`CONFIG_HOME_LAID_OUT`). `home` must exist; any other filesystem error is thrown.

### `existing`

```
existing(paths) → { live, missing }
```

`paths` split into those that exist and those that do not.

### `hereSnapshots`

```
hereSnapshots(config) → number
```

How many sessions `spore here` keeps a snapshot of per spore: the `hereSnapshots` setting of a
`readConfig` result, else 20.

### `CONFIG_DIR`

The directory of spore's host configuration: `$XDG_CONFIG_HOME/spore`, else `~/.config/spore`.

### `CONFIG_FILE`

`config.json` in `CONFIG_DIR`.

### `NAME`

The pattern a spore name matches: a letter or digit, then up to 63 letters, digits, `.`, `_` and
`-`.

### `NAMES_A_PATH`

The pattern of an argument taken as a path rather than a name: one starting with `.` or `~`, or
holding a `/`.

### `checkSqlite`

```
checkSqlite(version = <Node's SQLite version>) → string
```

The SQLite version inside this Node, when it is recent enough to read a workspace database.
Throws `SQLITE_TOO_OLD`.

---

## Plugins and services

The operator's side: [docs/operating.md §Plugins on the host](operating.md#plugins-on-the-host)
and [§Plugin services](operating.md#plugin-services).

### `listPlugins`

```
listPlugins({ configFile, roots }) → { roots, plugins, missing }
```

Every installed plugin, `{ name, package, version, dir, allowed, settings, problem }`, where
`problem` says why it cannot be used. `missing` names plugins allowed and not installed.

### `showPlugin`

```
showPlugin(name, { configFile, roots })
→ { name, package, version, dir, works, settings, programs, env, reference, modules, sources,
    secrets, precursors, reads, services, allowed, configured }
```

One plugin, checked: what its manifest declares, the environment variables its sources want
(`secrets`), and the host's settings for it (`configured`). Throws `PLUGIN_NOT_INSTALLED`,
`PLUGIN_AMBIGUOUS`, `PLUGIN_INVALID`, `PLUGIN_INCOMPATIBLE`, `PLUGIN_CHANGED`.

### `allowPlugin`

```
allowPlugin(name, pairs = [], { configFile, roots }) → { …showPlugin, allowed: true, configured }
```

Checks a plugin and records it as allowed, with the version and directory checked. `pairs` are
settings as typed, `'key=value'`, merged over those already recorded. Throws the refusals of
`showPlugin`, `PLUGIN_SETTING_UNKNOWN`, `PLUGIN_SETTING_MISSING`, `PLUGIN_SETTING_INVALID`.

### `disallowPlugin`

```
disallowPlugin(name, { configFile }) → { name, allowed: false }
```

Removes a plugin from what spores may use. Throws `PLUGIN_NOT_ALLOWED`.

### `pluginServices`

```
pluginServices(roots = pluginRoots()) → { services, problems }
```

Every service an installed plugin offers, allowed or not, each `{ name, what, program, instances,
check, plugin, package, version, dir }`. `problems` lists plugins that declare services and do not
check, `{ plugin, package, problem }`.

### `pluginRoots`

```
pluginRoots(root = <spore's package directory>) → string[]
```

The `node_modules` directories plugins are looked for in.

### `recordStarted`

```
recordStarted(name, { dir = SERVICE_STATE_DIR, root, pid = process.pid })
```

Writes `<dir>/<name>.json` with the spore version a long-running service started from and its
`pid`, so the command can tell it runs older code than is installed.

### `versionAt`

```
versionAt(root) → string
```

The `version` in `<root>/package.json`.

### `SERVICE_STATE_DIR`

Where services record what they started from: `services/` in spore's state directory.

---

## Models and the machine

The guide:
[INTEGRATION §Setting up models for your user](../INTEGRATION.md#setting-up-models-for-your-user).
Entries marked "From mohdel" throw mohdel's errors, not `SporeError`.

### `MO`

The path of the `mo` command spore is installed with, run as `node <MO> …` with
`process.execPath`. From mohdel (`CLI`).

### `loadMohdelEnvironment`

```
loadMohdelEnvironment()
```

Loads mohdel's `environment` file, where `mo onboard` writes keys, into `process.env`. A missing
file loads nothing. Call it before `providerReadiness`, `modelReadiness` or `modelsOf`. From
mohdel (`loadDefaultEnv`).

### `providerReadiness`

```
providerReadiness(provider) → Promise<{ provider, credential, models, ready, fix }>
```

Whether a provider can be called: its credential, how many catalog models it has, and `fix`, the
`mo` command closing the first thing missing (`null` for none). From mohdel.

### `modelsOf`

```
modelsOf(provider = null) → Promise<[{ model, billing, priced }]>
```

The catalog's models, or one provider's, deprecated ones left out. `priced` is `null` for a
model whose calls are not metered. From mohdel.

### `modelReadiness`

```
modelReadiness(model) → Promise<{ model, inCatalog, priced, billing, credential, ready, fix }>
```

Whether one model can run. A model with `priced: false` runs and its calls count as $0. From
mohdel.

### `upstream`

```
upstream(provider) → Promise<[{ id, label, inputPrice, outputPrice }] | null>
```

What the provider lists beyond the catalog, prices `null` where the listing has none; `null` when
mohdel cannot list the provider. From mohdel.

### `curate`

```
curate(provider, ids) → Promise<[{ model, priced }]>
```

Adds those ids of the provider's listing to the catalog. Throws a plain `Error` naming why when
one is not listed, already in the catalog, excluded, or not described well enough. From mohdel.

### `billingFor`

```
billingFor(model) → { kind, label?, usage? } | null
```

How the model's calls are paid for, as mohdel declares it (`kind` is `metered`, `plan` or
`capacity`), or `null` for a provider mohdel does not know.

### `unmetered`

```
unmetered(billing) → boolean
```

True when a `billingFor` answer carries no per-call price. The calls then record $0 spend, but
they are still paid for some other way.

### `doctor`

```
doctor({ configFile, env, abi, contain, root, slots = SLOT_DIR })
→ { findings: [{ area, subject, severity, problem, fix }], needsTick, replies }
```

What is wrong on this machine for spore, read and never repaired: the kernel's confinement, the
operator's files, each spore, the plugins, a pause or spend stop. `severity` is `problem` or
`note`. `needsTick` says why the tick timer is wanted; `replies` lists default reply-to places and
pending outbox entries. `abi`, `contain` and `root` override what `doctor` detects: the Landlock
ABI, whether namespaces work, and whether it runs as root.

### `modelFindings`

```
modelFindings({ configFile, readiness = modelReadiness }) → Promise<finding[]>
```

For each model a spore names (`model`, `models`, `cell-models`), a `problem` when a turn on it
cannot run and a `note` when it runs unpriced, each with the `mo` command that fixes it.

---

## Definitions

The format: [docs/definition.md](definition.md).

### `parseDefinition`

```
parseDefinition(source, { knownTools = [], cell = false, seed = false }) → definition | { error }
```

A `.cmk` file parsed by the same parser the runtime uses: a `spore.cmk` by default, a precursor
with `cell: true`, a sporangium's `spore.cmk` (which may leave `model` out) with `seed: true`.
Pass `TOOL_NAMES` as `knownTools`, as the runtime does. The answer has the fields the file
declares (`name`, `model`, `tools`, `limits`, `reads`, `writes`, `schedules`, `jobs`, `plugins`,
`identity`, …), or `error` with the refusal.

### `parseFrontmatter`

```
parseFrontmatter(head) → { fields } | { error }
```

The grammar alone, over the text between the `---` lines: each `key` to its scalar or list, with
no check of which keys are allowed.

### `TOOL_NAMES`

The seven built-in tools, frozen: `read`, `write`, `edit`, `exec`, `wsexec`, `ask`, `quiet`.

### `PRECURSOR_DIR`

The string `'precursors'`: the directory of a workspace that holds its precursors.

---

## Low-level readers and helpers

Lower-level pieces the functions above are built on. Most programs need none of them.

### `openWorkspace`

```
openWorkspace(dir, { cwd = process.cwd(), definition, allowGranted = false })
→ { ws, granting, model, reads, writes, sources, scopes, limits, identity, excludeTools, retain,
    history, memory, images, schedules, plugins, domainRules } | { error }
```

Prepares a workspace for a turn and says what the turn gets. It writes: it creates `data/`, links
`reads` and `writes` grants in, copies missing root documents and seeds precursors. `definition`
installs a `.cmk` into a directory that has none. It returns `error` rather than throwing.

### `definitionPath`

```
definitionPath(ws) → string
```

`<ws>/spore.cmk`.

### `databaseOf`

```
databaseOf(ws) → string | null
```

Which database the workspace has, as its creation time; `null` before it exists. It changes when
the spore is made again, which is how `watchAll` drops a stale cursor.

### `turnSummary`

```
turnSummary(ws) → { lastTurnNo, treeMicros, workUnits, inboxConsumed, last }
```

A status read without the history: how many turns finished, their spend in micro-dollars, how far
the inbox is read, and the last turn record.

### `saidOf`

```
saidOf(entry) → string
```

The text a turn reads for an inbox entry: who said it when no person did, the message or a pointer
to its file, and its attachments.

### `mimeOf`

```
mimeOf(absPath) → string
```

A file's media type, by extension, else by its first bytes for images, else
`application/octet-stream`.

### `cloneCapability`

```
cloneCapability(from, to) → { precursors: string[], programs: string[] }
```

Copies a spore's precursors and the programs they grant as enzymes into an existing directory not
yet opened, as `define({ from })` does. Throws `CLONE_INCOMPLETE`.

### `grantedPathContaining`

```
grantedPathContaining(target, extra = []) → string | null
```

The sandbox-granted path that contains `target`, or `null`. `define` refuses to make a spore
there. Throws a plain `Error` with `code` when `target` cannot be resolved.

### `durationText`

```
durationText(ms) → string
```

A duration as `45s`, `12m` or `1.5h`.

---

## Events, errors, tracing and logging

### `EVENT_SCHEMA`

The event schema version every event carries as `v`: `1`
([INTEGRATION §The envelope](../INTEGRATION.md#the-envelope)).

### `EVENTS`

Every event name the log holds: `round`, `tool_start`, `tool_end`, `tool_block`, `wrap`,
`interject`, `heartbeat`, `stream`, `usage`, `complete`, `produced`, `recall`, `compaction`,
`empty_completion`, `recovery` and `turn_end`.

### `PROMISED`

Names the schema reserves and nothing emits yet: `['mohdel_idle']`.

### `SporeError`

```
new SporeError(message, { type, detail, severity = 'error', retryable = false, retryAfterMs,
                          context, cause })
```

Spore's error class. Branch on `type`, never on `message`. `toJSON()` leaves out `context` and
returns `{ message, severity, retryable, detail?, type?, retryAfterMs? }`, and
`SporeError.fromJSON(data, context)` makes one back. The refusals:
[INTEGRATION §Refusals](../INTEGRATION.md#refusals).

### `SEVERITY_TAGS`

The values of `severity`: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

### `toWireError`

```
toWireError(err, span) → { message, severity, retryable, detail?, type?, retryAfterMs?, trace? }
```

Any error in the shape it takes on a wire. An error without `toJSON` becomes
`{ message: 'unexpected error', type: 'UNEXPECTED_ERROR', … }`, its own message hidden. `trace`
is the trace id of `span` when one is given.

### `formatTraceparent`

```
formatTraceparent(span) → string | null
```

A W3C `traceparent` made from an OpenTelemetry span, to pass to `send`; `null` for a missing or
invalid span ([INTEGRATION §Tracing](../INTEGRATION.md#tracing-across-the-boundary)).

### `parseTraceparent`

```
parseTraceparent(header) → span | null
```

A `traceparent` read into a non-recording OpenTelemetry span usable as a parent; `null` when it
is absent or malformed.

### `cliLogger`

```
cliLogger(debug = false) → logger
```

The command's logger: `warn`, `error` and `fatal` to stderr, `debug` and `info` too when `debug`,
`trace` never; `child()` returns itself.

### `silent`

A logger with the same methods that writes nothing.

### `version`

The installed package's version string.
