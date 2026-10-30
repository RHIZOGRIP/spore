# @rhizogrip/spore-plugin-whatsapp

A service that puts your spores on WhatsApp, through Meta's Cloud API: a person's chat with a
business number of yours reaches their spore. It runs on the machine the spores are on, once per
number, as a systemd user unit. It gives spores nothing, so it needs no `spore plugin allow`:
`spore service` offers it once it is installed.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```bash
npm i -g @rhizogrip/spore-plugin-whatsapp
cat >> ~/.config/spore/environment <<'ENV'
OPS_WHATSAPP_TOKEN=…     # a system user's access token; none of these reaches a spore
OPS_WHATSAPP_SECRET=…    # the Meta app's secret
OPS_WHATSAPP_VERIFY=…    # a string of your choosing, given to Meta as the verify token
ENV
mkdir -p ~/.config/spore/whatsapp
cat > ~/.config/spore/whatsapp/ops.json <<'JSON'
{ "number": "<phone number id>", "token": "${OPS_WHATSAPP_TOKEN}", "secret": "${OPS_WHATSAPP_SECRET}",
  "verify": "${OPS_WHATSAPP_VERIFY}", "listen": "127.0.0.1:3979", "people": {} }
JSON
spore service define whatsapp@ops && spore service start whatsapp@ops
```

## What Meta allows

Meta's WhatsApp Business terms forbid providers of AI when the AI is the primary functionality
made available, as Meta judges it, outside the countries where the law requires otherwise. A
business answering its own customers or staff, with an AI doing part of it, is the use Meta's
pricing pages describe as allowed; a general-purpose assistant offered on WhatsApp is the one
it forbids. Meta's Business Messaging Policy also asks for people's opt-in and a clear way to reach
a human. The plugin is software you run on your own WhatsApp Business Account: what you use it for
is yours to square with Meta's terms.

## The number

From a Meta developer account, at developers.facebook.com: an app with the WhatsApp use case
(*Connect with customers through WhatsApp*), in a business portfolio of yours. Its WhatsApp API
Setup page gives a test number — or add your own — and shows its **phone number id**, the bot
file's `number`: an id of digits, not the phone number. The app's settings give its **app secret**,
the bot file's `secret`, which signs every delivery.

The token is a system user's: in the business portfolio's settings, a system user with the app
and the WhatsApp Business Account assigned, and a token generated for it with
`whatsapp_business_messaging` and `whatsapp_business_management`. A token from the API Setup page
lasts a day. `spore service define` first runs the service's checks (`--check`), which ask Meta for
the number's verified name with the token: a wrong number or token is refused there, with exit
status 2.

Meta delivers to a public HTTPS address of yours, with a valid certificate, which your proxy
forwards to `listen` — `127.0.0.1:3979` when the file says none: the service never faces the
internet itself. With nginx:

```nginx
location = /ops/webhook { proxy_pass http://127.0.0.1:3979/webhook; }
```

In the app's WhatsApp configuration, the callback URL is that address and the verify token is the
value `verify` names; Meta checks the two at once, and the service logs `Meta checked the callback
URL`. Then subscribe the app to the `messages` field. An app has one callback URL, so a number is
an app: a second number is a second app and a second bot file.

Every delivery is checked before it is read: its `X-Hub-Signature-256` must be the app secret's
HMAC of the body, or it is answered 401 and logged. One for another number than the bot's is
dropped and logged.

## People

```json
{ "number": "…", "token": "${OPS_WHATSAPP_TOKEN}", "secret": "${OPS_WHATSAPP_SECRET}", "verify": "${OPS_WHATSAPP_VERIFY}",
  "people": { "US.13491208655302741918": "triage", "FR.88213490012771": { "spore": "ledger", "brief": true } } }
```

`people` is each person's chat with the number, by the business-scoped user id WhatsApp gives
them — their country, a period, and an id of this business's — and the spore it reaches. It is
not their phone number: a person who sets a WhatsApp username arrives without one, and the id is
the one thing every message carries. Someone not in the file gets silence, and the log gets the
line to add:

```
refused Alice Martin (US.13491208655302741918) — to allow them, add "US.13491208655302741918": "<a spore>" to the people of …/whatsapp/ops.json
```

which is how you learn the ids: start with `"people": {}` and write to the number. A person who
changes their number gets a new id, refused and logged the same way. The file is read on every
message, so a person is added by editing a line.

A bot that serves people who should see their answers and not the machinery takes `"brief": true`
beside `people`, and a person takes `"brief"` as well: each conversation is then told its spore's
state and its answers, and nothing of how it runs: `/status` says `working`, `idle`, `paused` or
how many messages wait, an answer comes without how the turn ended, and `/extend` is not offered.

## A turn

Anything written to the number reaches the spore; a person's message carries who wrote it, never
their clock, which WhatsApp does not say. WhatsApp lets a business neither edit nor delete what it
sent, so a turn shows itself without a `working…` message: the bot reacts 👨‍💻 to the message it
is answering and shows typing while the turn runs, and the reaction comes off once the answer is
posted — or turns 💔 when the turn ended without one. `"react": { "taken": …, "failed": … }` in
the bot file changes the two. The answer is a reply to the message it answers, in WhatsApp's
markup — bold, italic, strikethrough, code, quotes; a heading is a bold line, a table a monospace
block, a link its text and its address — cut into messages of 4,096 characters. What the turn left
in `data/out/` is sent as documents, up to 100 MB each.

A file sent to the number reaches the spore — a document, a picture, a voice note (`.ogg`), audio
or a video — fetched from Meta with the token, up to 100 MB or the bot file's `"files": "10MB"`
(`false` takes none). A location, a contact card, or anything else with neither text nor a file is
answered that nothing reached the spore. A person's reaction is not passed on; an edit or a
deletion of what they wrote is logged, and the spore keeps what was first said.

```
/status    what the spore is doing, its turns and what they cost, and the running turn's limits
/stop      end the turn it is running, and set aside what you sent that it had not read
/wrap [10m]        ask the running turn to wrap up, now or in a while
/extend wall 30m   give it more — wall, cost or rounds — up to the extend.<limit> its spore.cmk grants
/flush             start the conversation over from the next turn; nothing is forgotten
```

## The 24-hour window, and what an answer costs

A business may write to a person freely only within 24 hours of the person's last message; past
it, Meta takes only templates it approved. An answer that comes later — a long turn, or a schedule,
a job or a webhook whose turn answers to this number through the spore's `replyTo` — is refused
by Meta, and the service settles it refused and logs it with the turn. A message Meta accepted and
then could not deliver is logged as well, with Meta's reason.

Meta charges per message it delivers, past a monthly free tier, and delivers none past it without a
payment method on the account: an answer cut in three is three messages. Meta also limits a
business to about one message every six seconds to the same person; the service waits as Meta asks.

## Turns nobody on WhatsApp started

A schedule, a job or a webhook starts a turn no one on WhatsApp asked for. Its answer goes to the
spore's `replyTo` in `config.json`, `whatsapp:<bot>/<business-scoped user id>`, within the
24-hour window. A place this bot's file does not route to the spore is refused, and the log says
why. The answer opens with what started the turn — `schedule "digest"` — except in a brief
conversation.

## Approvals

An approval your program asks in a chat this bot reaches
([INTEGRATION §Asking a person to approve](../../INTEGRATION.md#asking-a-person-to-approve)) is
posted as its `default` text and facts in WhatsApp's markup, at most 1,024 characters, with a reply
button per option — or, past three options or for a label longer than 20 characters, a list of
them behind a `Choose` button, each label at most 24. One that fits neither is refused, and so is a
body of its own for `whatsapp`. WhatsApp shows no field to fill in: an approval with a required one
is refused, and one with optional fields is posted without them. A
press is the person's reply to the question, which reaches the service signed like any message; it
is taken only from someone the approval names, and answered with a reply — `Apply — recorded`, or
why it was not taken. WhatsApp cannot take buttons back, so the question is closed by a reply to
it: the body your hook answered, or who chose what; a later press is answered that it was answered
already.

## What it guarantees

- **A message reaches its spore once,** under `whatsapp:<message id>` as its `requestId`, and Meta's
  delivery is answered 200 only once the spore has every message in it: one Meta sends again — it
  does for up to seven days — is not said twice.
- **A finished turn reaches its chat at least once.** What it owes a chat is an entry in the
  spore's outbox, settled only once Meta took it; one the service was posting when it stopped is
  posted again opening with `(this may repeat an earlier message)`. One Meta refuses is settled
  refused with Meta's reason; a rate limit is waited out.

## Seeing what Meta sends

`"trace": true` in the bot file writes every delivery whose signature holds to the service's log,
as Meta sent it — names, ids and phone numbers included. It is read on every delivery, so it is
turned on and off by editing the file, with no restart; leave it off once you have seen what you
needed.

## Not yet

Groups, templates — so an answer past the 24-hour window waits for no one and is refused —
a delivery Meta reports failed after accepting it being tried again, and one service for every
number of an app.

## What it keeps

`$XDG_STATE_HOME/spore/whatsapp/<bot>/state.json`, mode 0600: where it stands in each spore, the
messages waiting for an answer, and each person's last message, which is what WhatsApp shows the
typing against.

It imports `@rhizogrip/spore`, declared as a peer.
