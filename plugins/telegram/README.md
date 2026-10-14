# @rhizogrip/spore-plugin-telegram

A service that puts your spores in Telegram chats. It runs on the machine the spores are
on, once per bot, as a systemd user unit. It gives spores nothing, so it needs
no `spore plugin allow`: `spore service` offers it once it is installed.

```bash
npm i -g @rhizogrip/spore-plugin-telegram
echo 'TRIAGE_BOT_TOKEN=…' >> ~/.config/spore/environment     # from @BotFather; it never reaches a spore
mkdir -p ~/.config/spore/telegram
echo '{"token": "${TRIAGE_BOT_TOKEN}", "chats": {"148392011": "triage"}}' > ~/.config/spore/telegram/triage.json
spore service define telegram@triage && spore service start telegram@triage
```

It refuses to start, with exit status 2 and the line to fix, without its bot file, without
the token the file names, without a Telegram that answers the token, with a state file it
cannot read, or while another process reads the same bot's updates.

## One bot per file

Each bot is a file, `~/.config/spore/telegram/<bot>.json`, and a service instance of its
own, `telegram@<bot>`: its name, its avatar, its token, its chats and its state. A spore that
should have a face of its own on Telegram gets its own bot. One bot may still reach several
spores, and one spore may be reached through several bots. A chat of a bot is
`telegram:<bot>/<chat id>` wherever spore names a place an answer goes. No bot's token is
passed to a spore's runner.

## What it guarantees

- **A message reaches its spore once.** An update is confirmed to Telegram only after
  `send` has taken it, and it goes to `send` under `telegram:<update_id>` as its
  `requestId`, so an update Telegram hands over again is not said twice.
- **A finished turn reaches its chat at least once.** What it owes a chat is an entry in the
  spore's outbox, settled only after Telegram accepted it; a crash between the two repeats a
  message rather than losing one. One Telegram will not take is settled refused, with
  Telegram's reason, and one it still had not taken when its retries ran out is tried again
  after the spore's next turn or the service's next start.
- **A reply never mixes turns.** Each chat message gets the answer, the end state and the files
  of the turn that answered it.
- **A restart loses nothing.** A turn running when the service stopped finishes into the
  chat's `working…` message; a turn that ended while it was down is posted when it is back.
- **Nothing fails in silence.** A message a spore refuses is told to the chat; a message
  Telegram will not take is logged with its chat and turn.

## A turn in a chat

Write to the bot and the message goes to the spore the chat is mapped to. The bot posts
`working…`, shows which tools run as they run, and edits the answer into that message when
the turn ends. How the turn ended is added only when it makes the answer partial — a wrap
or a stop. A longer answer than Telegram's 4096 continues in further messages. What the
turn left in `data/out/` follows as documents, up to the 50 a turn hands back, then a line
counting the rest; a file over Telegram's 50 MB is named instead.

A message sent while a turn runs lands between its rounds, and its `working…` message says it
was heard. A turn ending in a question posts the
question, and the reply answers it. The conversation is the spore's transcript; the service
keeps none.

A turn that ends without reading your message — one that failed before it got there —
says so in your `working…` message, and the next turn answers it there.

```
/status    what the spore is doing, its turns and what they cost, and the running turn's limits
/stop      end the turn it is running
/wrap [10m]        ask the running turn to wrap up, now or in a while
/extend wall 30m   give it more — wall, cost or rounds — up to the extend.<limit> its spore.cmk grants
```

Only text reaches a spore for now.

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

A bot's `chats` say which chats may talk to it and which spore each reaches, as
`{ "<chat id>": "<spore>" }`. They are read on every message and followed as they change, so
a chat is added, moved or removed by editing a line. It lives beside `config.json` and
`sources.json`. Spores cannot read or change it.

While a turn works, its chat is shown what kind of call ran — `reading a file`, `running a
command`, `asking forgejo` by the source's name, a run of the same one counted, a slow one
timed, a command that exited non-zero given its exit code, a call that failed marked — and never what it was given: a Telegram message leaves the
machine, and a command line or a path is yours. A chat can ask for the calls themselves:

```json
{ "token": "${MAIN_BOT_TOKEN}", "chats": { "51168024": { "spore": "main", "details": true } } }
```

It is then shown `reading data/report.md`, `running git log --oneline -5`,
`source forgejo --path …` — the first line, cut short. Choose it for a chat you would let
read the commands; the others keep the kinds.

Two chats may point at one spore and then share its conversation. A reply goes to the
chat that asked; a turn nobody in a chat started goes to the spore's default.

A chat not in the file gets silence, and the log gets the line to add:

```
refused chat 148392011 (@alice) — to allow it, add "148392011": "<a spore>" to the chats of …/telegram/triage.json
```

which is also how you learn your own chat id: start with `"chats": {}` and message the bot. A
group's id is negative, and it is the group you add rather than the people in it.

## What it keeps

`$XDG_STATE_HOME/spore/telegram/<bot>/state.json`, one per bot, written whole and renamed into
place: where it stands in each spore it follows, in that spore's database, and every message a chat sent that no turn has answered
yet, with the `working…` message its answer goes into. A spore added later is followed from its
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
