# @rhizogrip/spore-plugin-discord

A service that puts your spores in Discord channels, beside the people who talk to them. One
channel holds many people and many spores; each spore has a role, so `@triage` reaches it the way
a person is reached, and each answers under its own name. It runs on the machine the spores are
on as a systemd user unit.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```bash
npm i -g @rhizogrip/spore-plugin-discord
spore plugin allow discord                                   # gives spores "$SPORE_DISCORD"
echo 'DISCORD_BOT_TOKEN=…' >> ~/.config/spore/environment    # from the Developer Portal; it never reaches a spore
mkdir -p ~/.config/spore/discord
cat > ~/.config/spore/discord/ops.json <<'JSON'
{
  "token": "${DISCORD_BOT_TOKEN}",
  "channels": {
    "1234567890": { "spores": ["triage", "ledger"], "people": ["111111111111", "role:222222222222"] }
  }
}
JSON
spore service define discord@ops && spore service start discord@ops
```

Each spore in a channel lists `discord` in the `plugins:` of its `spore.cmk`, which gives it
`$SPORE_DISCORD` to read what was said before it was addressed. The bot can see more channels than
the spore should read, so its `spore.cmk` names the channels whose history it reads, and a turn is
refused without them:

```
plugins: [discord]
sources: [discord]
discord.path: [<channel id>/messages]
```

## The bot

In the [Developer Portal](https://discord.com/developers/applications): a bot, its token in
`environment` as `DISCORD_BOT_TOKEN`, and the **Message Content** intent on — without it Discord
sends the bot every message empty except those that mention the bot itself, and a spore is
mentioned by its role. Invite it to the server with these permissions: View Channels, Send
Messages, Read Message History, Manage Webhooks and Manage Roles.

One bot per user: the source a spore reads history through takes `DISCORD_BOT_TOKEN`, from that user's `environment`.

## A channel

`channels` is the routing. The bot ignores every channel the file does not name. Each names:

- `spores` — who answers there. For each, the bot finds or makes a mentionable role of that name,
  below its own highest role. It never takes the role Discord gives the bot itself, which no one
  can make mentionable: a spore named as the bot gets a role of its own beside it.
- `people` — who may address them: user ids, `role:<id>` for everyone holding a role, and `"*"`
  for anyone in the channel. Someone else addressing a spore gets silence, and the log gets the
  line to add.
- `sporesTalk` — `true` lets a spore's post that mentions another spore's role reach it. False
  when left out: two spores that keep answering each other run until their limits stop them.
- `rolesOnly` — `true` makes a mention of the bot address no one in a channel with one spore, so
  only its role or a reply does. False when left out.
- `show` — how a turn shows itself there: `working` (the `working…` post, edited as the turn goes
  with how many calls it has made and for how long, the model's note before a call and the kind of
  the call running; the default), `react` (the bot's reaction on your message, and Discord's
  typing), or `both`.
- `details` — `true` shows the calls themselves in the `working…` post rather than their kinds.
- `brief` — `true` tells the channel its spores' state and their answers, and nothing of how they
  run: `status` says `working`, `idle`, `paused` or how many messages wait — never the model, the
  spend, the turns or the limits; an answer comes without how the turn ended, a turn with none says
  `no answer this time` and the log says why; a working turn shows the model's note, the kind of the
  call it runs, how many and for how long, never how a call ended; a limit reached shows as
  `wrapping up`; and `extend`
  is not offered, since what a turn may spend is yours. `"brief": true` beside `channels` makes
  every channel brief that does not say `false`. A channel cannot take `details` beside it.

Beside `channels`, `avatars` gives a spore a face: `"avatars": { "triage": "https://…/triage.png" }`.
Discord fetches the image from that address for every post, so it has to be public and https; a
spore without one shows Discord's default. `react` names the bot's reactions for `show: react`,
`{ "taken": "👨‍💻", "failed": "💔" }` when left out; any emoji Discord has, custom ones too.

The file is read on every message, so a channel, a spore or a person is added by editing a line.

## In a channel

Mention a spore's role, or reply to one of its posts, and the message goes to that spore; a
message addressing two goes to both. In a channel with one spore, mentioning the bot — the entry
Discord's picker tags APP — goes to that spore too, and it is told the mention as `@<spore>`; in a
channel with several, or one that says `rolesOnly`, it goes to none, and the log names the roles to
mention instead. A message addressing none goes to none. The spore posts
`@you ↪ "what you said…" working…`, and when the turn ends posts its answer under its own name,
opened with whom it answers — which pings them — and removes the `working…` post. Files the turn
left in `data/out/` follow as attachments, up to the 50 a turn hands back, then a line counting
the rest; one over 20 MB is named instead. Files attached to a message addressing a spore reach it,
fetched by the service as the message arrives — Discord's links expire — up to 25 MB each, or the
bot file's `"files": "10MB"` (`false` takes none); one that does not come is told, to whoever sent
it and to the spore.

`@triage status` says what it is doing; `@triage stop` ends the turn it is running and sets aside
what you sent that it had not read; `@triage wrap 10m` asks it to wrap up; `@triage extend wall
30m` gives it more, as far as its `spore.cmk` allows; `@triage flush` starts its conversation over
from the next turn, forgetting nothing. Stopping, wrapping, extending and flushing are for the
people the channel lists by id or role — not everyone `"*"` lets talk; anyone else is told so.

A spore is told who spoke and where, never the rest of the channel; it reads what came before
with `$SPORE_DISCORD` when the message points at it, as its `reference.md` teaches. What it reads
there is data: people who may not address it still write in the channel.

## Turns nobody in a channel started

A schedule, a job or a webhook starts a turn no one in a channel asked for. Its answer goes to
the spore's default place, `replyTo` in `config.json` — `"triage": "discord:ops/1234567890"`, this
bot, that channel — labelled with where it came from, and nowhere when the turn ended `quiet`. A
default naming a channel this bot's file does not give the spore is refused, and the log says why.

An approval asked in a Discord channel is refused for now, and the asker's hook is told: Discord
carries none yet.

## What it guarantees

- **A message reaches each spore it addresses once,** under `discord:<message>:<spore>` as its
  `requestId`, so a message Discord hands over again is not said twice.
- **A finished turn reaches its channel at least once.** What it owes a channel is an entry in
  the spore's outbox, settled only after Discord took it; a post the service was making when it
  stopped is posted again, opening with `(this may repeat an earlier message)`. One Discord will
  not take is settled refused, with Discord's reason.
- **An answer never waits behind progress.** Under a rate limit the `working…` edits and typing
  are dropped, never queued ahead of it.
- **Nothing a spore writes pings anyone but whom it answers.** Every post the service makes
  allows no mentions but those.

## Seeing what Discord sends

`"trace": true` in the bot file writes every message to the service's log, one line each, as
Discord sent it. It is read on every message, so it is turned on and off by editing the file, with
no restart; leave it off once you have seen what you needed.

## What it keeps

`$XDG_STATE_HOME/spore/discord/<bot>/state.json`, mode 0600: where it stands in each spore, the
`working…` posts waiting for an answer, each channel's webhook and its token, the spores' roles,
and how many messages each channel has had since each spore last posted there.
