# The relay — writing a chat connector

A chat connector puts spores in a messaging platform: people write to a bot, each conversation
reaches a spore, and the answers come back where they were asked. `@rhizogrip/spore/relay` is the
half every connector shares, so what a connector promises is kept once. A connector is a plugin
with a service ([plugins.md §Services](plugins.md#services)) whose program hands the relay an
**adapter**: the platform's transport, its API, and what it calls a conversation and a person.
`plugins/telegram/` and `plugins/discord/` are two.

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
  message with no text — is said.
- **The spore is told who wrote and where** (`send`'s `from`), never as words in the text.
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
- **The answer is formatted.** It goes to the adapter as Markdown, cut at a line under the platform's
  limit, a code block a piece ends inside closed and opened again in the next; what the relay says
  itself — status, notices — is plain.
- **Commands**: `status`, `stop`, `wrap [10m]`, `extend <dimension> <amount>`, and a help line for
  anything else. `stop` also sets aside what that conversation sent and no turn had read, once the
  stopped turn has ended, and says how many — with nothing running, what waited. In a conversation
  many people share, `stop`, `wrap` and `extend` are for someone its `people` name by id or role —
  not everyone `"*"` lets talk; anyone else is told so, and the log says the line to add.
- **Credentials stay with the service.** Every bot's credential variables are removed from the
  environment a turn's runner starts with, except one a source of the plugin's own needs.

## The bot file

One file per bot, `~/.config/spore/<kind>/<bot>.json`, read on every message: credentials as
`${VAR}`, held in `~/.config/spore/environment`, and the routing — which conversation reaches which
spore, and how each is shown a turn (`show`: `working`, `react` or `both`). Anything not named there
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
| `routes(raw, path)` | the routing read into a `Map` of conversation → `{ spores: [name], details, show, people, overhear }`, `show` null where the file names none, `people` null where it names no one, and `overhear` true where what is not said to the spores reaches them overheard — refusing what it cannot read |
| `stateFields` | the adapter's own fields in the state file, handed to its `restore` |
| `sourceVariables` | credential variables a source of the plugin needs in a turn's environment |
| `usage` | `{ help, extend }`: the commands as this platform types them |
| `limits` | `{ message, file, editEveryMs, typingEveryMs }`: the longest message, the largest upload, how often `working…` is edited, how often typing is renewed |
| `can` | `{ upload, remove, react, typing, reply }`: `reply` false where a post cannot reply to a message, and opens with whom it answers instead |
| `showShared` | how a turn shows itself in a conversation many people share when the routing says nothing: `react` or `working` |
| `reactions` | the emoji the platform lets a bot react with, or null for any |
| `refusals` | error types that mean the platform will not have this bot at all: the service exits 2 and is not restarted |
| `hint(err, { file, bot })` | the line to fix an error, or null |
| `refusal(message, botFile)` | the log line for a message from a conversation the routing does not name — or null where the platform shows the bot conversations that are none of its business: then nothing is logged, and the owner is not told |

The live part, made once the credentials are proved:

| member | does |
|---|---|
| `restore(state, save)` | where `stateFields` names any: the state holding them, and how to write it |
| `prepare(table, log)` | optional: what the platform readies, or checks, before anyone writes, for every conversation the routing names — Discord's roles and webhooks, Telegram's word that a group overhears while the bot hears only what is said to it |
| `listen({ onMessage, signal, log, sleep })` | the transport, until `signal` aborts; awaits `onMessage` before confirming a message to the platform; throws an error the platform gave for good |
| `aside(message, spore)` | optional: a line the spore is given after the text — Discord's pointer to the history it has not heard |
| `post(conversation, text, { answering, for, markdown, as })` | posts, as a reply to the platform's message `answering` when it is not null, and with `markdown` rendered in the platform's own formatting; answers the new message's id. `as` is the spore speaking, or null for the bot itself; `for` is `[{ person, said }]`, whom the post is about, which a platform that cannot reply shows instead — and pings when it is the answer |
| `edit(conversation, note, text, { for })` | edits a message the bot posted; an edit that changes nothing is not a failure |
| `remove(conversation, note)` | where `can.remove` |
| `upload(conversation, { path, mime }, caption, { as })` | where `can.upload` |
| `react(conversation, message, emoji, was)` | where `can.react`: the bot's reaction on a person's message moved from `was` to `emoji`, either of them null for none |
| `typing(conversation)` | where `can.typing`: the platform's typing indicator, which lasts a few seconds |

Every failure is a `SporeError` with `retryable` (a refusal is not) and `context.retryAfter` in
seconds when the platform said how long to wait. A platform that refuses the formatting of a
`markdown` post says so with `context.formatRefused`: the relay logs it and posts the same text plain.

What `onMessage` gets, the platform normalised:

| field | is |
|---|---|
| `id` | the message's identity, unique across every bot that can reach the spore: with the bot's name where the platform's id is per bot |
| `conversation`, `message` | where it was said, and the platform's id for it (what the answer replies to) |
| `person` | `{ id, name, groups }`: the platform's id, how the person shows, and the ids of the groups (Discord roles) a `role:<id>` in `people` matches |
| `spore` | the spore that wrote it, where the platform lets spores' posts reach each other; null for a person |
| `where` | the conversation as a person would name it (`a private chat on Telegram`) |
| `shared` | whether many people share the conversation |
| `text` | what was written, the platform's markup made plain; null when nothing was |
| `command` | `{ verb, args }` when the text is a command, else null |
| `addresses` | the spores the message names; `[]` for one that names none — in a conversation many people share, what was not said to a spore, which the relay drops or, where the routing says `overhear`, gives the spores as overheard; or null where it reaches the conversation's spores without naming them |
| `files` | how many files came with it |

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
as a person in a conversation; read what was posted, edited, removed and uploaded there; make a
call fail), documented at the top of the file. Its own cases — its transport's confirmations, its
errors — go in the callback the suite hands its context to. `telegram-service.test.js` is one.

## Rules a connector keeps

- Inbound authenticity is checked before anything is read: the connector's own connection, or the
  platform's signature on what it pushes.
- A listener binds loopback only; exposing it is the operator's proxy's job.
- In a conversation shared by many people, only a message that addresses a spore reaches it as
  said to it; the rest is `addresses: []`, never guessed at.
- Nothing a spore writes pings anyone but whom it answers.
- Nothing in a message is executed: it is text given to `send`.
