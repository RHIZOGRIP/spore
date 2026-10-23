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

All of it is done as a member of your Microsoft 365 tenant, with a Teams licence — Business Basic
serves — and the people who talk to the bot are members too. A personal Microsoft account, even
one invited into the tenant as its administrator, signs in to personal Teams (teams.live.com) and
cannot reach the Teams admin center. The sites: the Azure portal, portal.azure.com; the Teams
Developer Portal, dev.teams.microsoft.com; the Teams admin center, admin.teams.microsoft.com; and
Teams itself, teams.cloud.microsoft.

Teams reaches a bot through Azure: an **Azure Bot**, made in the Azure portal with *Single Tenant*
as its type and a new Microsoft App ID — Microsoft no longer makes multi-tenant bots, and the
service asks your tenant for its token. Its app registration in Entra ID gives the bot file its
`app` (the Microsoft App ID), its `tenant`, and a client secret — the secret's value, kept in
`environment` under the variable `secret` names. The Azure Bot's messaging endpoint is a public
HTTPS address of yours, which your proxy forwards to `listen` — a loopback address: the service
never faces the internet itself. With nginx, a path per bot:

```nginx
location = /ops/api/messages { proxy_pass http://127.0.0.1:3978/api/messages; }
```

Once the service runs, `curl -i -X POST -H 'content-type: application/json' -d '{}'
https://<your host>/ops/api/messages` is answered `401` and the service logs `refused an activity:
it carries no bearer token`: the proxy reaches it. Without a JSON body it is answered `400`, and
nothing is logged.

Turn on the Azure Bot's Microsoft Teams channel; until it is on, Teams shows the app as
`Invalid Bot: Please make sure the bot is registered and Teams channel is enabled`. Then a Teams
app for the bot, in the Teams Developer Portal: under App features, a bot with the Microsoft App
ID, in the personal and team scopes. A manifest of version 1.25 or later with the team scope must say
`"supportsChannelFeatures": "tier1"`, or Teams refuses the package; it lets the app into private
and shared channels too, which the service does not serve yet, so leave it out of those. Publish
it to your organization and approve it in the Teams admin center, under Manage apps: an app
uploaded for one person can stay blocked by the tenant's app policies. For files sent to it in a
personal chat, the bot's entry in the manifest's `bots` says `"supportsFiles": true`. A changed
manifest is published again under a new `version`, the app's own, which Teams refuses to reuse.
Adding `supportsFiles` to an app people already have waits for each one's consent; where Teams
offers no update, removing the app and adding it again installs the new version, and the chat
keeps its history.

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

A bot that serves people who should see their answers and not the machinery takes `"brief": true`
beside `people` and `channels`: each conversation is then told its spore's state and its answers,
and nothing of how it runs. `/status` says `working`, `idle`, `paused` or how many messages wait —
never the model, the spend, the turns or the limits; an answer comes without how the turn ended, a
turn with none says `no answer this time` and the log says why; a working turn shows the model's
note, the kind of the call it runs, how many and for how long, never how a call ended; a limit
reached shows as `wrapping up`; an answer to a turn nobody there started comes without the
schedule, webhook or job that started it, which the log names; and `/extend` is not offered, since
what a turn may spend is yours. A person or a channel takes `"brief"` as well, `false` to be told
everything in a brief bot; `details` is refused beside it.

Someone not in the file gets silence, and the log gets the line to add:

```
refused Alice Martin (3f2b…) — to allow them, add "3f2b…": "<a spore>" to the people of …/teams/ops.json
```

which is also how you learn object ids: start with `"people": {}` and write to the bot.

## A turn

In a personal chat, anything written reaches the spore. In a channel, a message reaches it when
it mentions the bot. A mention that opens the message is not part of what the spore is told, while
one inside the sentence stays as `@<bot>`; the spore is told who wrote and where, and when on their
clock, where their Teams says its time zone. The bot posts
`working…` and edits it as the turn goes: how many calls it has made and, once a minute has passed,
for how long; what the model last wrote before a call; and the kind of the call running. The answer
is a new message — in a channel, in the thread of the message it answers — and `working…` is then
removed, or marked `answered below` where Teams will not remove it; in a channel thread, Teams shows
`This message has been deleted.` where it was. The answer is sent in Teams' extended Markdown,
so tables and fenced code render; what the bot says itself — status, notices — is plain text,
line for line. What the turn left in `data/out/` is named, one line a file — except in a brief
conversation, where the log names it; the spore is told that files do not reach Teams.

A file sent in a personal chat reaches the spore, fetched from the sender's OneDrive by the link
Teams gives the bot, as does an image pasted there, which Teams serves the bot alone — up to 25 MB
each, or the bot file's `"files": "10MB"` (`false` takes none). A file attached in a channel, or a
picture pasted there, never reaches the bot: Teams sends it the message's text alone, with nothing
saying anything came with it, so neither the person nor the spore is told — send it in a personal
chat. A file that does not come is told, to the person and to the spore.

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
The answer opens with what started the turn — `schedule "digest"` — except in a brief conversation.

## Approvals

An approval your program asks in a personal chat or a channel this bot reaches
([INTEGRATION §Asking a person to approve](../../INTEGRATION.md#asking-a-person-to-approve)) is
posted as an Adaptive Card — the request's `teams` card, or its `default` text and facts drawn as
a `TextBlock` and a `FactSet` — with an `Input.Text` per field of the request under it and an
`Action.Execute` button per option, both added by the bot. A card of your own must be version 1.4
or later and carry no `Action.Submit`, `Action.Execute`, `refresh` or `Input.*` of its own;
`Action.OpenUrl` is fine. A press is Microsoft's signed `adaptiveCard/action` invoke, taken only
from someone the approval names with every required field filled in, and answered at once —
`Apply — recorded`, or why it was not taken; what the person filled in comes with it. The card is
then updated: replaced by the body your hook answered, or kept with its buttons and fields gone and
who chose what below.

## What it guarantees

- **A message reaches its spore once,** under `teams:<conversation id>:<activity id>` as its
  `requestId`, and Microsoft's delivery is answered only once the spore has it: one Microsoft sends
  again is not said twice.
- **A finished turn reaches its conversation at least once.** What it owes a conversation is an
  entry in the spore's outbox, settled only once Teams took it; one the service was posting when it
  stopped is posted again opening with `(this may repeat an earlier message)`. One Teams refuses is
  settled refused with Teams' reason; a rate limit is waited out, as long as Teams says.
- **An answer never waits behind progress.** Under a rate limit the `working…` edits are dropped.

## Seeing what Teams sends

`"trace": true` in the bot file writes every activity that holds to the service's log, one line
each, as Teams sent it — names, ids and download links included. It is read on every activity, so
it is turned on and off by editing the file, with no restart; leave it off once you have seen what
you needed.

## Not yet

Group chats (logged and left), private and shared channels, files and pictures in a channel, a spore's files
sent rather than named, and a bot serving tenants other than its own.

## What it keeps

`$XDG_STATE_HOME/spore/teams/<bot>/state.json`, mode 0600: where it stands in each spore, the
`working…` messages waiting for an answer, each person's chat with the bot and each channel's
service address, as Teams last gave them.

It imports `@rhizogrip/spore`, declared as a peer.
