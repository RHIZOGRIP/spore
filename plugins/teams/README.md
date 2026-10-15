# @rhizogrip/spore-plugin-teams

A service that puts your spores in Microsoft Teams: a person's personal chat with the bot reaches
their spore, and a channel reaches its spore when someone there mentions the bot. It runs on the
machine the spores are on, once per bot, as a systemd user unit. It gives spores nothing, so it
needs no `spore plugin allow`: `spore service` offers it once it is installed.

```bash
npm i -g @rhizogrip/spore-plugin-teams
echo 'OPS_TEAMS_SECRET=…' >> ~/.config/spore/environment     # the app registration's client secret; it never reaches a spore
mkdir -p ~/.config/spore/teams
cat > ~/.config/spore/teams/ops.json <<'JSON'
{ "app": "<app id>", "tenant": "<tenant id>", "secret": "${OPS_TEAMS_SECRET}",
  "listen": "127.0.0.1:3978", "people": {} }
JSON
spore service define teams@ops && spore service start teams@ops
```

## The bot

Teams reaches a bot through Azure: an **Azure Bot**, single-tenant, whose app registration in
Entra ID gives the bot file its `app` (the Microsoft App ID), its `tenant`, and a client secret,
kept in `environment` under the variable `secret` names. The Azure Bot's messaging endpoint is a
public HTTPS address of yours ending in `/api/messages`, which your proxy forwards to `listen` —
a loopback address: the service never faces the internet itself. Turn on the Azure Bot's Teams
channel, and install a Teams app for the bot in your tenant with the personal and team scopes.

Every activity is checked before it is read: a token Microsoft signed for this app id, with a key
it endorses for Teams, for the `serviceUrl` the activity names. One that fails is answered 401 and
logged with what failed. An activity from another tenant than the bot's is dropped and logged.

`spore service define` first runs the service's checks (`--check`), which ask Microsoft for the
bot's token: a wrong app id, tenant or secret is refused there, with exit status 2.

## People and channels

```json
{ "app": "…", "tenant": "…", "secret": "${OPS_TEAMS_SECRET}", "listen": "127.0.0.1:3978",
  "people": { "3f2b…-object-id": "triage", "8a41…-object-id": { "spore": "ledger", "details": true } },
  "channels": { "19:a1b2…@thread.tacv2": { "spores": ["triage"], "people": ["3f2b…-object-id", "*"] } } }
```

`people` is each person's personal chat with the bot, by their Entra object id, and the spore it
reaches. `channels` is each standard channel by its id — in the channel's link, `19:…@thread.tacv2`
— with its one spore and `people`, who may address it there: object ids, or `"*"` for everyone in
the channel, written out. A channel has one spore: the bot speaks there as itself, so a second spore
is a second bot. `details` shows the calls themselves in the `working…` message rather than their
kinds. The file is read on every message, so a person or a channel is added by editing a line.

Someone not in the file gets silence, and the log gets the line to add:

```
refused Alice Martin (3f2b…) — to allow them, add "3f2b…": "<a spore>" to the people of …/teams/ops.json
```

which is also how you learn object ids: start with `"people": {}` and write to the bot.

## A turn

In a personal chat, anything written reaches the spore. In a channel, a message reaches it when
it mentions the bot, and the mention is not part of what the spore is told; the spore is told who
wrote and where. The bot posts `working…` and shows what kind of call runs as it runs; the answer
is a new message — in a channel, in the thread of the message it answers — and `working…` is then
removed, or marked `answered below` where Teams will not remove it. The answer is sent as Teams
markdown. What the turn left in `data/out/` is named, one line a file: files do not cross yet,
either way.

```
/status    what the spore is doing, its turns and what they cost, and the running turn's limits
/stop      end the turn it is running, and set aside what you sent that it had not read
/wrap [10m]        ask the running turn to wrap up, now or in a while
/extend wall 30m   give it more — wall, cost or rounds — up to the extend.<limit> its spore.cmk grants
```

In a channel, after the mention; there `/stop`, `/wrap` and `/extend` are for the people the
channel lists by id, not everyone `"*"` lets talk.

## Turns nobody in Teams started

A schedule, a job or a webhook starts a turn no one in Teams asked for. Its answer goes to the
spore's `replyTo` in `config.json`: `teams:<bot>/<object id>` for a person — the bot opens a
personal chat with them if they never wrote to it — or `teams:<bot>/<channel id>`, a new post in
the channel. A place this bot's file does not route to the spore is refused, and the log says why.

## What it guarantees

- **A message reaches its spore once,** under `teams:<conversation id>:<activity id>` as its
  `requestId`, and Microsoft's delivery is answered only once the spore has it: one Microsoft sends
  again is not said twice.
- **A finished turn reaches its conversation at least once.** What it owes a conversation is an
  entry in the spore's outbox, settled only once Teams took it; one the service was posting when it
  stopped is posted again opening with `(this may repeat an earlier message)`. One Teams refuses is
  settled refused with Teams' reason; a rate limit is waited out, as long as Teams says.
- **An answer never waits behind progress.** Under a rate limit the `working…` edits are dropped.

## Not yet

Group chats (logged and left), private and shared channels, files in either direction, and a bot
serving tenants other than its own.

## What it keeps

`$XDG_STATE_HOME/spore/teams/<bot>/state.json`, mode 0600: where it stands in each spore, the
`working…` messages waiting for an answer, each person's chat with the bot and each channel's
service address, as Teams last gave them.

It imports `@rhizogrip/spore`, declared as a peer.
