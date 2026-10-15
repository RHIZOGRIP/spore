# @rhizogrip/spore-plugin-telegram

A service that puts your spores in Telegram chats. It runs on the machine the spores are
on, once per bot, as a systemd user unit. It gives spores nothing, so it needs
no `spore plugin allow`: `spore service` offers it once it is installed.

```bash
npm i -g @rhizogrip/spore-plugin-telegram
echo 'TRIAGE_BOT_TOKEN=…' >> ~/.config/spore/environment     # from @BotFather; it never reaches a spore
mkdir -p ~/.config/spore/telegram
echo '{"token": "${TRIAGE_BOT_TOKEN}", "people": {"148392011": "triage"}}' > ~/.config/spore/telegram/triage.json
spore service define telegram@triage && spore service start telegram@triage
```

It refuses to start, with exit status 2 and the line to fix, without its bot file, without
the token the file names, without a Telegram that answers the token, with a state file it
cannot read, or while another process reads the same bot's updates.

## One bot per file

Each bot is a file, `~/.config/spore/telegram/<bot>.json`, and a service instance of its
own, `telegram@<bot>`: its name, its avatar, its token, its people and groups, and its state. A
spore that should have a face of its own on Telegram gets its own bot. One bot may still reach
several spores, and one spore may be reached through several bots. A chat of a bot is
`telegram:<bot>/<chat id>` wherever spore names a place an answer goes. No bot's token is
passed to a spore's runner.

## What it guarantees

- **A message reaches its spore once.** An update is confirmed to Telegram only after
  `send` has taken it, and it goes to `send` under `telegram:<bot>:<update_id>` as its
  `requestId`, so an update Telegram hands over again is not said twice, and two bots' updates
  are never taken for one another.
- **A finished turn reaches its chat at least once.** What it owes a chat is an entry in the
  spore's outbox, settled only after Telegram accepted it; a crash between the two repeats a
  message rather than losing one. One Telegram will not take is settled refused, with
  Telegram's reason, and one it still had not taken when its retries ran out is tried again
  after the spore's next turn or the service's next start.
- **A reply never mixes turns.** Each chat message gets the answer, the end state and the files
  of the turn that answered it.
- **A restart loses nothing.** A turn running when the service stopped is still answered, as a
  reply to the message it answers; a turn that ended while it was down is posted when it is back.
- **Nothing fails in silence.** A message a spore refuses is told to the chat; a message
  Telegram will not take is logged with its chat and turn.

## A turn in a chat

Write to the bot in private and the message goes to the spore your id is mapped to; in a group,
mention it or reply to it (below). The spore is told who wrote it and where — your name and
username, the private chat or the group. The bot posts
`working…` and shows which tools run as they run. When the turn ends, the answer arrives as a new
message replying to yours, so it notifies you however long the turn took, and `working…` is
removed; one Telegram will no longer let the bot remove, past 48 hours, says `answered below`. The
answer's Markdown is shown as Telegram formats it — bold, italic, code, code blocks, links, quotes;
a heading as a bold line, a table in a monospace block — and as plain text if Telegram refuses it. How
the turn ended is added only when it makes the answer partial — a wrap or a stop. A longer answer
than Telegram's 4096 continues in further messages. What the turn left in `data/out/` follows as
documents, up to the 50 a turn hands back, then a line counting the rest; a file over Telegram's
50 MB is named instead.

A message sent while a turn runs lands between its rounds, and its `working…` message says it
was heard. A turn ending in a question posts the
question, and the reply answers it. The conversation is the spore's transcript; the service
keeps none.

A turn that ends without reading your message — one that failed before it got there —
says so in your `working…` message, and the next turn answers it.

```
/status    what the spore is doing, its turns and what they cost, and the running turn's limits
/stop      end the turn it is running, and set aside what you sent that it had not read
/wrap [10m]        ask the running turn to wrap up, now or in a while
/extend wall 30m   give it more — wall, cost or rounds — up to the extend.<limit> its spore.cmk grants
```

Only text reaches a spore for now: a photo's or a document's caption goes to it, and you are told
the file did not; a message with nothing written in it is told only text reaches a spore.

## Turns nobody in a chat started

A schedule firing, a job or a webhook starts a turn no chat asked for. Its answer goes to the
spore's default place, `replyTo` in `config.json`:

```json
{ "replyTo": { "triage": "telegram:triage/148392011" } }
```

There it is told `schedule "digest"`, `webhook "forge"` or `job "scan"`, then the answer —
except when the turn ended `quiet`, which chose to say nothing. A turn that ended without an
answer any other way is told. A spore with no default tells no chat. A default naming a chat
that does not reach the spore through this bot is refused, and the log says why.

A turn started with `spore send` is shown only there; no chat is told.

## The allow-list is the routing

A bot's `people` say who may talk to it in private and which spore each reaches, as
`{ "<user id>": "<spore>" }` — a private chat's id is its person's. Its `groups` say which groups
it serves, each with its spore and who there may address it:

```json
{ "token": "${TRIAGE_BOT_TOKEN}",
  "people": { "148392011": "triage" },
  "groups": { "-1001234567": { "spores": ["triage"], "people": ["148392011", "*"] } } }
```

Both are read on every message and followed as they change, so a person or a group is added,
moved or removed by editing a line. The file lives beside `config.json` and `sources.json`. Spores
cannot read or change it.

While a turn works, its chat is shown what kind of call ran — `reading a file`, `running a
command`, `asking forgejo` by the source's name, a run of the same one counted, a slow one
timed, a command that exited non-zero given its exit code, a call that failed marked — and never what it was given: a Telegram message leaves the
machine, and a command line or a path is yours. A chat can ask for the calls themselves:

```json
{ "token": "${TRIAGE_BOT_TOKEN}", "people": { "148392011": { "spore": "triage", "details": true } } }
```

It is then shown `reading data/report.md`, `running git log --oneline -5`,
`source forgejo --path …` — the first line, cut short. Choose it for a chat you would let
read the commands; the others keep the kinds. A group takes `"details": true` the same way.

A chat can be shown a turn more quietly, which is what a group gets unless its entry says
otherwise: `"show": "react"` puts a 👨‍💻 on your message when the spore takes it and shows Telegram's
`typing…` while the turn runs, then takes the 👨‍💻 off when the answer arrives — or puts a 💔 there
when the turn ended without one. `"show": "working"` is the `working…` message, what a private
chat gets; `"show": "both"` is both. The bot's two emoji are its own to choose, from the ones
Telegram lets a bot react with (✅ and ❌ are not among them; the log lists them when one is refused):

```json
{ "token": "${OPS_BOT_TOKEN}", "react": { "taken": "👀", "failed": "🤷" },
  "people": { "148392011": { "spore": "triage", "show": "react" } } }
```

Two chats may point at one spore and then share its conversation. A reply goes to the
chat that asked; a turn nobody in a chat started goes to the spore's default.

A chat not in the file gets silence, and the log gets the line to add:

```
refused chat 148392011 (@alice) — to allow it, add "148392011": "<a spore>" to the people of …/telegram/triage.json
```

which is also how you learn your own user id: start with `"people": {}` and message the bot. A
group the file does not name is told nothing either, when someone there writes `/status@<the bot>`;
the log says the `groups` entry to add, its id negative. Where a spore's `replyTo` default is one of this
bot's chats, that chat is told the same line, once per chat the file does not name, so you hear of
someone trying the bot without reading its log.

## A group

A group has one spore — in a group the bot speaks as itself, so a second spore there is a second
bot — and `people`, who may address it: user ids, or `"*"` for everyone in the group, written out.
A message reaches the spore when it replies to one of the bot's messages, is a command for it —
`/status`, or `/status@triage_bot` where several bots share the group; a command naming another bot
is not seen — or mentions the bot (`@triage_bot what failed?`). Telegram hands a bot a mention only
with its privacy mode off — `/setprivacy` in @BotFather, then the bot added to the group again — or
as an admin of the group; with neither, the service says so for each of its groups when it starts.
Anything else said there is not for the spore, and the bot's mention is not part of what the spore
is told. Someone the entry does not list who addresses the bot gets silence, and the log gets the
line that would let them in.

`/status` is for anyone listed; `/stop`, `/wrap` and `/extend` are for the people the entry names
by id — not everyone `"*"` lets talk — and anyone else is told so.

A group can let its spore hear what is said there that is not to it:

```json
"groups": { "-1001234567": { "spores": ["triage"], "people": ["148392011", "209876543"], "overhear": true } }
```

What the people it lists say in the group then reaches the spore as overheard: no turn starts for
it and no answer is owed, and the next turn the spore runs reads it as what was said around it, the
latest 100 messages at a time. It is everything they say there, kept in the spore's records and
read by its next turn, so choose it for a group whose talk the spore should follow. It needs the
bot's privacy mode off, or the bot an admin of the group, as a mention does.

## What it keeps

`$XDG_STATE_HOME/spore/telegram/<bot>/state.json`, one per bot, mode 0600, written whole and
renamed into place: where it stands in each spore it follows, in that spore's database, and every
message a chat sent that no turn has answered yet, with its `working…` message. A spore added later is followed from its
latest turn; earlier answers are not posted. Nothing is kept in the repository or in the spores'
home.

## Busy

A turn that would start with no admission slot free is refused, and the chat is told it is
busy. The only limit is the machine's admission slots, which every other caller shares.

## Running it as a service

```bash
spore service define telegram@triage     # checks the bot file and its token, then writes the unit
spore service start telegram@triage      # now
spore service enable telegram@triage     # and at every login
spore service log telegram@triage -f
```

`define` first runs the service's start-up checks (`--check`) and refuses a missing bot file or
token. The unit it
writes is the template `~/.config/systemd/user/spore-telegram@.service`, marked as spore's, and
each bot is an instance of it; `spore service` never touches a unit it did not write. `spore
service rm telegram@<bot>` stops and disables one bot; `spore service rm telegram` stops them all
and removes the template — each given `--yes` when a bot it stops is running. `spore service ls` says where each service
stands, and whether lingering is on — without it, user services stop when you log out.

Restarting the service does not stop the turns it started (`KillMode=process`). The service
picks them up again from what it saved. After a refusal (exit 2), systemd does not restart it.

`~/.config/spore/environment` is what the service and every runner it starts need, since a
systemd user session starts with almost nothing: each bot's token, `PATH`, the provider
keys (`<PROVIDER>_API_SK`), `BRAVE_API_SK` if the spores search, and the secrets of the
sources they are granted. The service reads it itself, so the unit names no environment file:
its bot's token once, at start, and everything else again for every turn, so a key added or
changed reaches the next message without a restart. A variable already set in the service's
own environment wins. Plain `KEY=value` lines, as systemd's `EnvironmentFile=` would read them —
no `export`, nothing expanded. It holds keys, so keep it mode 0600. The token stays with the
service; the runners it starts are given the rest.

A running service keeps the code it started from. After installing another version of this
plugin, `spore service ls` says so — `running @rhizogrip/spore-plugin-telegram 0.1.0, 0.1.1 is
installed` — and `spore service restart --outdated` brings it up to date.

It imports `@rhizogrip/spore`, declared as a peer. Installed globally beside
`@rhizogrip/spore-cli`, it gets a copy of its own, which may be another version within the
range it declares; a workspace another version made is refused at open, never misread.
