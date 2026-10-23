# @rhizogrip/spore-plugin-slack

A service that puts your spores in Slack: a person's direct message with the bot reaches their
spore, and a channel reaches its spore when someone there mentions the bot. It runs on the machine
the spores are on, once per bot, as a systemd user unit, and connects out to Slack over Socket
Mode — no public address, no proxy. It gives spores nothing, so it needs no `spore plugin allow`:
`spore service` offers it once it is installed.

```bash
npm i -g @rhizogrip/spore-plugin-slack
cat >> ~/.config/spore/environment <<'ENV'
OPS_SLACK_TOKEN=xoxb-…
OPS_SLACK_APP=xapp-…
ENV
mkdir -p ~/.config/spore/slack
cat > ~/.config/spore/slack/ops.json <<'JSON'
{ "token": "${OPS_SLACK_TOKEN}", "app": "${OPS_SLACK_APP}", "team": "<team id>", "people": {} }
JSON
spore service define slack@ops && spore service start slack@ops
```

## The app

At api.slack.com/apps, *Create New App*, *From a manifest*, in your workspace, with this — the
name and the bot's display name are yours:

```json
{
  "display_information": { "name": "Spores" },
  "features": {
    "bot_user": { "display_name": "spores", "always_online": true },
    "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "slash_commands": [{ "command": "/spore", "description": "What the spore is doing, and stopping or wrapping its turn", "usage_hint": "status | stop | wrap [10m] | extend wall 30m", "should_escape": false }]
  },
  "oauth_config": {
    "scopes": { "bot": ["app_mentions:read", "channels:read", "chat:write", "commands", "files:read", "groups:read", "im:history", "im:write", "users:read"] }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["app_mention", "message.im"] },
    "interactivity": { "is_enabled": true },
    "socket_mode_enabled": true
  }
}
```

Leave *Agents & AI Apps* off: it replaces the Messages tab people write to the bot in. Install the
app to the workspace; *OAuth & Permissions* then shows the bot token, `xoxb-…`. Under *Basic
Information*, *App-Level Tokens*, make one with the `connections:write` scope: the app token,
`xapp-…`. Both go in `environment`, under the variables `token` and `app` name; neither reaches a
spore. `team` is the workspace's id, `T…`.

A scope added to the manifest later — as a new version of the plugin may ask — takes a reinstall
of the app, under *Install App*; until then each call that needs it is refused with
`missing_scope` and the scope's name in the service's log.

`spore service define` first runs the service's checks (`--check`): Slack is asked who the bot
token is and for a Socket Mode connection under the app token. A refused token, or a bot token for
another workspace than `team`, is refused there, with exit status 2.

## People and channels

```json
{ "token": "${OPS_SLACK_TOKEN}", "app": "${OPS_SLACK_APP}", "team": "T0123ABCD",
  "people": { "U0123ALICE": "triage", "U0456BOB": { "spore": "ledger", "details": true } },
  "channels": { "C0789OPS": { "spores": ["triage"], "people": ["U0123ALICE", "*"] } } }
```

`people` is each person's direct message with the bot, by their member id — in their profile,
under ⋮, *Copy member ID* — and the spore it reaches. `channels` is each channel by its id — at the
bottom of the channel's details — with its one spore and `people`, who may address it there:
member ids, or `"*"` for everyone in the channel, written out. A channel has one spore: the bot
speaks there as itself, so a second spore is a second bot. The bot must be in the channel:
`/invite @<the bot>` there. `details` shows the calls themselves in the `working…` message rather
than their kinds. The file is read on every message, so a person or a channel is added by editing
a line.

A bot that serves people who should see their answers and not the machinery takes `"brief": true`
beside `people` and `channels`: each conversation is then told its spore's state and its answers,
and nothing of how it runs — no model, spend, turns or limits, no schedule, webhook or job that
started a turn, and no `extend`. A person or a
channel takes `"brief"` as well, `false` to be told everything in a brief bot; `details` is
refused beside it.

Someone not in the file gets silence, and the log gets the line to add:

```
refused Alice (U0123ALICE) — to allow them, add "U0123ALICE": "<a spore>" to the people of …/slack/ops.json
```

which is also how you learn member ids: start with `"people": {}` and write to the bot.

## A turn

In a direct message, anything written reaches the spore. In a channel, a message reaches it when
it mentions the bot. A mention that opens the message is not part of what the spore is told; the
spore is told who wrote and where, and when on their clock, by the time zone their Slack profile
sets. The bot posts `working…` and edits it as the turn goes — at most every 5 s, since Slack
allows an app about 50 edits a minute in a workspace — and the answer comes
as a new message: in a direct message, after the conversation as it stands; in a channel, in the
thread of the mention. `working…` is then removed.
The answer is sent as Markdown, so tables and fenced code render, with Slack's mentions in it
broken so it pings no one; what the bot says itself — status, notices — is plain text. What the
turn left in `data/out/` is named, one line a file — except in a brief conversation, where the log
names it; the spore is told that files do not reach Slack.

A file sent to the bot reaches the spore, fetched with the bot's token — up to 25 MB each, or the
bot file's `"files": "10MB"` (`false` takes none). A file shared in a Slack Connect channel comes
without its details, which the bot asks Slack for first. A file that does not come is told, to the
person and to the spore.

```
/spore status            what the spore is doing, its turns and what they cost, and the running turn's limits
/spore stop              end the turn it is running, and set aside what you sent that it had not read
/spore wrap [10m]        ask the running turn to wrap up, now or in a while
/spore extend wall 30m   give it more — wall, cost or rounds — up to the extend.<limit> its spore.cmk grants
```

Slack takes no app's slash command in a thread: there, mention the bot and write `/status`,
`/stop`, `/wrap` or `/extend`. In a channel, `stop`, `wrap` and `extend` are for the people the
channel lists by id, not everyone `"*"` lets talk.

## Turns nobody in Slack started

A schedule, a job or a webhook starts a turn no one in Slack asked for. Its answer goes to the
spore's `replyTo` in `config.json`: `slack:<bot>/<member id>` for a person — the bot opens a direct
message with them if they never wrote to it — or `slack:<bot>/<channel id>`, a new post in the
channel. A place this bot's file does not route to the spore is refused, and the log says why.
The answer opens with what started the turn — `schedule "digest"` — except in a brief conversation.

## Approvals

An approval your program asks in a direct message or a channel this bot reaches
([INTEGRATION §Asking a person to approve](../../INTEGRATION.md#asking-a-person-to-approve)) is
posted as blocks — the request's `slack` body, `{ "blocks": [ … ], "text": "<the notification>" }`,
or its `default` text and facts drawn as a `markdown` block and sections — with a button per option
in an actions block the bot adds. Blocks of your own are shown ones only — `section`, `header`,
`divider`, `context`, `image`, `markdown`, `rich_text`, `table` — and a section's accessory an
image: nothing in them may answer the bot by itself. A press is taken only from someone the
approval names, and answered at once with a line only they see — `Apply — recorded`, or why it was
not taken. The message is then updated: replaced by the body your hook answered, or kept with its
buttons gone and who chose what below. Slack shows no fields to fill in yet: an approval with a
required one is refused, saying so, and one whose fields are all optional is posted without them.

## What it guarantees

- **A message reaches its spore once,** under `slack:<team>/<channel>/<ts>` as its `requestId`,
  and Slack's envelope is acknowledged only once the spore has it: one Slack sends again is not
  said twice. A `/spore` command is acknowledged at once, Slack wanting an answer within 3 s.
- **A finished turn reaches its conversation at least once.** What it owes a conversation is an
  entry in the spore's outbox, settled only once Slack took it; one the service was posting when it
  stopped is posted again opening with `(this may repeat an earlier message)`. One Slack refuses is
  settled refused with Slack's reason; a rate limit is waited out, as long as Slack says.
- **An answer never waits behind progress.** Under a rate limit the `working…` edits are dropped.
- **A dead connection is noticed.** One with no ping, pong or message for 30 s is dropped and
  another opened; one Slack says it will close is replaced before it does.

## Seeing what Slack sends

`"trace": true` in the bot file writes every envelope to the service's log, one line each, as
Slack sent it — names, ids and file links included. It is read on every envelope, so it is turned
on and off by editing the file, with no restart; leave it off once you have seen what you needed.

## Not yet

Group direct messages, a spore's files sent rather than named, reactions, and Slack's events over
HTTP instead of Socket Mode.

## What it keeps

`$XDG_STATE_HOME/spore/slack/<bot>/state.json`, mode 0600: where it stands in each spore, the
`working…` messages waiting for an answer, and each person's direct message with the bot.

It imports `@rhizogrip/spore`, declared as a peer, and `ws`.
