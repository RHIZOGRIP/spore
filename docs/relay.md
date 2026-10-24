# The relay — writing a chat connector

A chat connector puts spores in a messaging platform: people write to a bot, each conversation
reaches a spore, and the answers come back where they were asked. `@rhizogrip/spore/relay` is the
half every connector shares, so what a connector promises is kept once. A connector is a plugin
with a service ([plugins.md §Services](plugins.md#services)) whose program hands the relay an
**adapter**: the platform's transport, its API, and what it calls a conversation and a person.
`plugins/telegram/`, `plugins/discord/`, `plugins/teams/`, `plugins/slack/` and `plugins/console/` are five.

```js
import { runService } from '@rhizogrip/spore/relay'
```

## What the relay keeps

- **A message reaches its spore once.** It goes to `send` under `<kind>:<id>` as its `requestId`,
  and the adapter confirms it to the platform only once the relay has taken it.
- **A finished turn reaches its conversation at least once.** What a turn owes a conversation is
  an outbox entry, settled after the platform took it; one the platform refuses is settled
  `refused` with its reason, one it still did not take is tried again after the next turn or start.
  An entry is marked before its first post, so one the service stopped while posting is posted
  again opening with `(this may repeat an earlier message)`.
- **A reply never mixes turns,** and **a restart loses nothing**: the cursors and the messages
  still waiting on an answer are kept in a state file, `$XDG_STATE_HOME/spore/<kind>/<bot>/state.json`,
  mode 0600.
- **Nothing fails in silence.** A refusal by the spore is told in the conversation, one by the
  platform is logged with its conversation and turn, and what cannot reach a spore — a file, a
  message with neither text nor a file — is said.
- **A file sent to a spore reaches it**, fetched by the relay with the bot's credential: at most 10
  a message, none larger than the platform lets a bot fetch or the bot file's `files` allows
  (`"10MB"`, or `false` for none), each kept under `inbox.d/` by its name — a second of the same
  name as `name-2` — through `send`'s `attach`. One that does not come is told to the person and
  kept on the entry with why, so the turn knows of it. A file said around a spore, overheard, is
  named and not fetched. A message that is only files reaches the spore with no text.
- **The spore is told who wrote and where** (`send`'s `from`), never as words in the text — the
  person's clock too, where the platform says it; and, where the platform gets no file from the
  bot (`can.upload` false), that the place gets none, so the answer is all its reader has.
- **Only whom the routing lets in reaches a spore.** Where a conversation lists its `people` — ids,
  `role:<id>`, `"*"` — anyone else is refused, and the log says the line to add; a spore's own post
  (`spore`) is never refused. What a message is to the spores is one decision: said to them,
  overheard, or dropped at a gate — not addressed (unlogged), or from someone not listed (logged).
- **What was not said to a spore can still reach it, overheard,** where the routing says
  `overhear`: from someone its `people` let in, written to the spore's inbox as `send`'s
  `overheard`, starting no turn and owed no answer, and read by the next turn as what was said
  around it. Nothing is posted for it.
- **The conversation is told what the turn does,** as its routing's `show` says. `working`: a
  `working…` message, then the kind of each call as it runs — `reading a file`, `running a command`,
  `asking <source>` — and the call itself only where the routing says `details`. `react`: the bot's
  `taken` reaction on the person's message, and the platform's typing while the turn runs. `both`.
  Where the routing names none, the platform's own for a conversation many people share
  (`showShared`: Telegram's groups react, Discord's channels show `working…` under the spore's name)
  and `working` in one with a single person. Under a rate limit, progress and typing are dropped, never queued ahead of
  an answer.
- **The answer is a new message replying to the question,** so it notifies however long the turn
  ran; `working…` is then removed, or marked `answered below` where the platform will not remove it,
  and `taken` comes off — replaced by the bot's `failed` reaction when the turn ended without an
  answer, as it is on a message the spore refused. A turn nobody in the conversation started goes to
  the spore's `replyTo` default, labelled with where it came from; a `quiet` turn tells no one.
- **What the turn left in `data/out/` follows the answer,** uploaded where `can.upload`, up to
  `limits.file`; a file that is not is named by its path in the workspace, which only the operator
  can reach.
- **The answer is formatted.** It goes to the adapter as Markdown, cut at a line under the platform's
  limit, a code block a piece ends inside closed and opened again in the next; what the relay says
  itself — status, notices — is plain.
- **Commands**: `status`, `stop`, `wrap [10m]`, `extend <dimension> <amount>`, and a help line for
  anything else. `stop` also sets aside what that conversation sent and no turn had read, once the
  stopped turn has ended, and says how many — with nothing running, what waited. In a conversation
  many people share, `stop`, `wrap` and `extend` are for someone its `people` name by id or role —
  not everyone `"*"` lets talk; anyone else is told so, and the log says the line to add.
- **A brief conversation is told what it asked and nothing of how the spore runs,** where the
  routing says `brief`: `status` is the spore's state — `working`, `idle`, `paused`, how many
  messages wait — without its model, spend, turns or limits; an answer is posted without how the
  turn ended, and a turn without one says `no answer this time`, the stop reason going to the log;
  a limit's wrap shows as `wrapping up`; `wrap` says when it wraps and not when it stops; `extend` is
  not offered, since what a turn may spend is the operator's; a refused message is `busy` or `not
  delivered`, its reason logged; the owner's hint for an unnamed conversation is not posted there;
  an answer to a turn nobody there started comes without what started it — a schedule, a webhook,
  a job — which goes to the log; and a file the turn handed back that is not uploaded is not named
  there, its path going to the log.
- **An approval counts only as a press of the relay's own button,** by someone it names
  ([ARCHITECTURE §Approvals](../ARCHITECTURE.md#approvals)). Each one the host asked in a
  conversation of this bot is posted with a button per option, carrying `ap:<id>:<option>`; a
  press is matched by that id, taken once, from someone in its `by`, before its deadline, and
  acknowledged at once; then the host's hook is told, the question closed and the spore told. One
  it cannot post is refused, the hook told. All of it is read from the spore's database each
  second, so a restart carries on.
- **Credentials stay with the service.** A turn's runner starts without any service's secrets —
  every bot's credential variables and the approval hooks' among them — except one a source it
  may fill names (ARCHITECTURE §Where workspaces live).

## The bot file

One file per bot, `~/.config/spore/<kind>/<bot>.json`, read on every message: credentials as
`${VAR}`, held in `~/.config/spore/environment`, and the routing — which conversation reaches which
spore, how each is shown a turn (`show`: `working`, `react` or `both`), and whether it is `brief`
— a bot's `"brief": true` is every conversation's that does not say otherwise, and a brief
conversation cannot also take `details`. Anything not named there
gets nothing, and the log says the line to add; so is the bot's owner, once per conversation while
the service runs, in each of this bot's conversations a spore's `replyTo` default names. A bot on a platform that reacts takes
`"react": { "taken": "👨‍💻", "failed": "💔" }`, those two when it is left out; an emoji the platform
does not take is refused with the list it does (`reactionsOf`).

## The adapter

The static part, which the relay reads before the service starts:

| member | is |
|---|---|
| `kind` | the place prefix (`<kind>:<bot>/<conversation>`), the outbox kind, the state directory, the bot files' folder, the prefix of error types (`CHAT_NO_BOT`) |
| `label`, `noun` | the platform's name and what it calls a conversation (`chat`, `channel`), for what people and the log are told |
| `fields`, `credentials`, `example` | the bot file's fields, those holding a `${VAR}`, and a first file to show |
| `conversations` | the sections of the bot file its routing is written in, by field: each `{ noun, id, says, fix, fields }` — what a conversation there is called (`person`, `channel`), the pattern its id matches, why one that does not is refused (`which is not a member id`) and how to find a right one, and the fields an entry takes; `not`, ids refused though they match, each `{ id, says, fix }`; `flags`, the platform's own true-or-false fields, carried into the routing. A section of conversations many people share has `people`, `{ id, says, example }`, who may be named there besides `*`, and `one` when a conversation there has one spore; its entry is `{ "spores": [...], "people": [...] }`. Any other section is people's own conversations, an entry the spore's name or `{ "spore": … }`, with `called`, how a person there is identified (`their member id`). `routesOf` reads them into a `Map` of conversation → `{ spores: [name], details, show, brief, overhear, people, …flags }`, `show` null where the file names none, `brief` null where the entry leaves it to the bot's, `people` null for a person's own |
| `check(raw, path)` | optional: refuses what the platform's own fields of the bot file hold (a workspace id, a listen address), before the routing is read |
| `stateFields` | the adapter's own fields in the state file, handed to its `restore` |
| `usage` | `{ help, briefHelp, extend }`: the commands as this platform types them — `briefHelp` without `extend`, for a brief conversation |
| `limits` | `{ message, file, fetch, editEveryMs, typingEveryMs }`: the longest message, the largest upload, the largest file the platform lets a bot fetch, how often `working…` is edited, how often typing is renewed |
| `can` | `{ upload, remove, react, typing, choose, fields }`: `choose` where it carries approvals, and beside it `fields`, true or false, whether it shows an approval's fields to fill in — where false, the relay refuses an approval with a required field and posts one without its optional ones |
| `showShared` | how a turn shows itself in a conversation many people share when the routing says nothing: `react` or `working` |
| `reactions` | the emoji the platform lets a bot react with, or null for any |
| `refusals` | error types that mean the platform will not have this bot at all: the service exits 2 and is not restarted |
| `hint(err, { file, bot })` | the line to fix an error, or null — for a bot file that is not there, the relay then says to make one as `example` |
| `refusal(message, botFile)` | the log line for a message from a conversation the routing does not name — or null where the platform shows the bot conversations that are none of its business: then nothing is logged, and the owner is not told |

The live part, made once the credentials are proved:

| member | does |
|---|---|
| `restore(state, save)` | where `stateFields` names any: the state holding them, and how to write it |
| `routeOf(conversation)` | optional: the routing key a conversation answers under, where they differ — a Teams channel thread routes by its channel; the conversation itself when it is left out |
| `prepare(table, log)` | optional: what the platform readies, or checks, before anyone writes, for every conversation the routing names — Discord's roles and webhooks, Telegram's word that a group overhears while the bot hears only what is said to it |
| `listen({ onMessage, onChoice, signal, log, sleep })` | the transport, until `signal` aborts; awaits `onMessage` before confirming a message to the platform, and `onChoice` before confirming a press; throws an error the platform gave for good |
| `aside(message, spore)` | optional: a line the spore is given after the text — Discord's pointer to the history it has not heard |
| `post(conversation, text, { answering, for, markdown, as, turn, origin })` | posts, as a reply to the platform's message `answering` when it is not null — or as a plain new message where a conversation with one person reads in order without one (Slack's direct messages) — and with `markdown` rendered in the platform's own formatting; answers the new message's id. `as` is the spore speaking, or null for the bot itself; `for` is `[{ person, said }]`, whom the post is about, which a platform that cannot reply shows instead — and pings when it is the answer. The first post of a turn's answer also carries `turn`, `{ turnNo, stopReason }`, and `origin`, what said it when nobody in the conversation did (`schedule "digest"`), else null — for a platform whose reader is a program; in a brief conversation too, where the text leaves them out |
| `edit(conversation, note, text, { for })` | edits a message the bot posted; an edit that changes nothing is not a failure |
| `remove(conversation, note)` | where `can.remove` |
| `upload(conversation, { path, mime }, caption, { as })` | where `can.upload` |
| `react(conversation, message, emoji, was)` | where `can.react`: the bot's reaction on a person's message moved from `was` to `emoji`, either of them null for none |
| `typing(conversation)` | where `can.typing`: the platform's typing indicator, which lasts a few seconds |
| `fetch(ref, { most })` | a file a person sent, by the `ref` its message listed: the Buffer, or `FILE_TOO_LARGE` past `most` bytes, reading no further. `download(url, { most, headers, fetchImpl })` from `@rhizogrip/spore/relay` is the capped fetch, and never names the URL in an error |
| `checkBody(native)` | where `can.choose`: why an approval's body for this platform cannot be shown — one not the platform's shape, or one that would answer the bot by itself or ask for input of its own — or null |
| `ask(conversation, { native, fallback }, choices, { as, fields, approval })` | where `can.choose`: the question posted — `native`, the body for this platform, or `fallback`, the default `{ text, facts }` drawn the platform's way — with a button per choice, `{ id, label, style, data }`, `data` what the press must carry back, and, where `can.fields`, a place to fill in each of `fields`, `{ id, label, value, required }`, whose text the press brings back under its `id` (`[]` where there are none); `approval` is `{ id, by, until }`, the approval, who may answer it and until when, for a platform that shows them; answers `{ note, shown }`, its id and the payload exactly as sent |
| `settle(conversation, note, replacement, { ended })` | where `can.choose`: the question closed, its buttons and fields gone — replaced by `{ native, fallback }`, or kept as `{ shown, outcome }`, the payload posted with how it ended below; `ended` is how it ended as data, `{ approval, state, choice, by, outcome, reason }` — `state` `answered` or `expired`, `by` `{ id, name }` or null, `outcome` the hook's (`confirmed`, `failed`) or null; answers the payload sent |
| `quiet(conversation, { turnNo, origin })` | optional: a turn nobody in a conversation asked — a schedule, a webhook, a job, `origin` saying which — that ended quiet, shown in the spore's default conversation (`replyTo` in `config.json`) where that is this bot's. The core owes no conversation anything for it, so without this member nothing reaches one; for a platform whose reader is a program |

Every failure is a `SporeError` with `retryable` (a refusal is not) and `context.retryAfter` in
seconds when the platform said how long to wait — `platformFailed(kind, what, { detail, retryable,
status, code, retryAfter, type })` from `@rhizogrip/spore/relay` makes one, `<KIND>_FAILED` unless
`type` says otherwise, and `retryAfterOf(response)` reads a `retry-after` header. A transport that
connects again waits as `backoff()` says: `after(err)`, 1 s doubled to a minute or the `retryAfter`
the error names, and `reset()` once connected. A platform that refuses the formatting of a
`markdown` post says so with `context.formatRefused`: the relay logs it and posts the same text plain.

What `onMessage` gets, the platform normalised:

| field | is |
|---|---|
| `id` | the message's identity, unique across every bot that can reach the spore: with the bot's name where the platform's id is per bot |
| `conversation`, `message` | where it was said, and the platform's id for it (what the answer replies to) |
| `person` | `{ id, name, groups, zone }`: the platform's id, how the person shows, the ids of the groups (Discord roles) a `role:<id>` in `people` matches, and the IANA zone of their clock where the platform says it — null or absent where it does not, and one Node does not know is logged and left out |
| `spore` | the spore that wrote it, where the platform lets spores' posts reach each other; null for a person |
| `where` | the conversation as a person would name it (`a private chat on Telegram`) |
| `shared` | whether many people share the conversation |
| `text` | what was written, the platform's markup made plain; null when nothing was |
| `command` | `{ verb, args }` when the text is a command, else null — `commandOf(text)` reads `/<verb> [args]`; `VERBS` are the ones the relay obeys, any other answered with the help. `escapeHtml(text)` escapes `&`, `<` and `>` for a platform whose posts take HTML or Slack's mrkdwn |
| `addresses` | the spores the message names; `[]` for one that names none — in a conversation many people share, what was not said to a spore, which the relay drops or, where the routing says `overhear`, gives the spores as overheard; or null where it reaches the conversation's spores without naming them |
| `traceparent` | optional: the W3C trace context the platform carried the message under, which the turn answering it is parented on |
| `files` | what came with it, `[{ name, mime, bytes, ref, why }]`: `mime` and `bytes` null where the platform does not say, `ref` the adapter's own handle for `fetch` — or null, with `why`, for one the platform will not hand the bot |

What `onChoice` gets for a press on one of the relay's buttons:

| field | is |
|---|---|
| `conversation` | where it was pressed, keyed as a message there would be |
| `data` | what the button carried, or null |
| `inputs` | what the person filled in of the approval's fields, `{ <field id>: <text> }`, where `can.fields`; else null. The relay checks it against the fields and answers a press that does not fit with why |
| `person` | `{ id, name, groups }`, as the platform vouches for them |
| `where` | the conversation as a person would name it |
| `acknowledge(text, how)` | answers the press on the platform at once — Telegram's notice, Teams' invoke response — with `text`, or nothing for null; `how` is `{ taken: true }` when the press was recorded as the approval's answer, and absent when it was not taken |

## The service

```js
#!/usr/bin/env node
import { runService } from '@rhizogrip/spore/relay'
import { createClient } from '../src/api.js'
import { SPEC, createAdapter } from '../src/adapter.js'

await runService({
  spec: SPEC,
  program: 'spore-chat',
  root: new URL('..', import.meta.url).pathname,
  open: async ({ bot, credentials }) => {
    const client = createClient(credentials.token)
    const me = await client.me()
    return { adapter: createAdapter({ client, bot }), who: me.name }
  }
})
```

`spore-chat <bot>` reads the bot file and its credentials, calls `open` to prove them against the
platform, and runs the relay until a signal; `--check` stops after the proof, which is what
`spore service define` runs. A refusal exits 2 with the line to fix.

## Testing

`packages/spore/test/fixtures/relay-conformance.js` is what every connector promises, as one suite
against real spores — runners, agents and records, the model's replies scripted. A connector's
service test runs it with a **harness**: its fake platform behind a small interface (say something
as a person in a conversation; read what was posted, edited, removed and uploaded there; press a
question's button, where the platform carries approvals; make a call fail), documented at the top
of the file. Its own cases — its transport's confirmations, its
errors — go in the callback the suite hands its context to. `telegram-service.test.js` is one.

## Rules a connector keeps

- Inbound authenticity is checked before anything is read: the connector's own connection, or the
  platform's signature on what it pushes.
- A listener takes its address with `listenOf(given, { port, refused })` from
  `@rhizogrip/spore/relay` — loopback on its own `port` when `given` is undefined, any address it
  is told, `shown` marking one beyond loopback as plain HTTP — and reads a body with
  `readBody(request, response, most)`, null past `most` bytes, answered 413 and the connection
  closed; exposing it is the operator's proxy's job.
- In a conversation shared by many people, only a message that addresses a spore reaches it as
  said to it; the rest is `addresses: []`, never guessed at.
- Nothing a spore writes pings anyone but whom it answers.
- Nothing in a message is executed: it is text given to `send`.
