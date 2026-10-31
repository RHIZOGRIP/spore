# @rhizogrip/spore-plugin-console

A service that puts your spores behind a console: a chat whose other end is a program — a test
bench, a scripted check, an automation, a demo. A program says something as a person, reads that
person's conversation back as ordered events, and presses an approval's buttons as them, on the
same path a person in Teams or Slack takes: the same delivery, the same approvals, the same hook.
It runs on the machine the spores are on, once per console, as a systemd user unit, on a loopback
address by default. It gives spores nothing, so it needs no `spore plugin allow`: `spore service` offers it
once it is installed.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```bash
npm i -g @rhizogrip/spore-plugin-console
echo "LAB_CONSOLE_TOKEN=$(openssl rand -hex 32)" >> ~/.config/spore/environment
mkdir -p ~/.config/spore/console
cat > ~/.config/spore/console/lab.json <<'JSON'
{ "listen": "127.0.0.1:8790", "token": "${LAB_CONSOLE_TOKEN}", "people": { "tester-1": "scratch" } }
JSON
spore service define console@lab && spore service start console@lab
```

**Map only test people and their spores.** Whoever holds the token speaks and presses as anyone
the file maps — that is what the console is for — so a real person's spore never belongs in it.

## The console file

`console/<name>.json` beside `config.json`: `listen`, where it listens — `127.0.0.1:8790` when
unsaid, and an address beyond loopback is plain HTTP; the variable holding its token, set in
`environment` beside `config.json`; and its `people`, each person by an id you choose — letters, digits, `.`, `_`, `@` and `-` — against the spore they
reach: `"<spore>"`, or `{ "spore": "<name>", "details": true, "brief": true }`. `details` shows a
turn's calls rather than their kinds, `brief` keeps the conversation to the spore's state and its
answers. The file is read on every request, so a person is added, moved or removed by editing a
line. A person's conversation is the place `console:<name>/<person>`, where a spore's answers and
its approvals go.

## Saying something

```bash
curl -s -H "authorization: Bearer $LAB_CONSOLE_TOKEN" -H 'content-type: application/json' \
  -d '{ "person": "tester-1", "text": "what changed since Monday?", "id": "run-7-step-1" }' \
  'http://127.0.0.1:8790/messages?wait=120'
```

`POST /messages` takes `{ person, text, id, files }`: `id` is yours, and a message sent twice
under one id is said once — the second answer carries the first one's `seq` and `repeated: true`.
`files` are `[{ name, mime, data }]`, `data` in base64. A `traceparent` header is the trace the
turn answering it is parented on. `/status`, `/stop`, `/wrap [10m]`, `/extend wall 30m` and `/flush` work
as typed text. The answer is `{ seq, repeated }`, `seq` the message's place in the conversation.

With `?wait=<seconds>` (at most 900) it waits for the answer to that message and says what led to
it: `answer`, the `reply` or `question` event whose `answers` holds the message's `seq`, and
`events`, everything in the conversation from the message to the answer — the working messages,
files, cards. When the wait runs out first, `answer` is null and `events` is what came meanwhile.
The console shows a conversation, never a spore's records: what a turn did is read from the spore
itself, by whoever operates it (`spore sql`).

## Reading a conversation

`GET /conversations/<person>?after=<seq>&wait=<seconds>&limit=<n>` answers `{ events, next }`: the
person's events after `after`, at most `limit` (100, up to 1000), and `next`, the `seq` to ask after
next time. With none newer it waits up to `wait` seconds for one, and answers `{ events: [], next }`
when none came. `seq` is the console's, across all its people, so one person's numbers have gaps;
none is handed out twice, and every event of the person after `after` comes once, in order.

With `accept: text/event-stream` the same URL is a stream of server-sent events — `id` the `seq`,
`event` the type, `data` the event — which resumes from `Last-Event-ID`, with a comment every 15 s.

Every event carries `seq`, `at`, `person` and `type`:

| type | what happened | its fields |
|---|---|---|
| `message` | the person said something | `id`, `text`, `files` (`{ name, mime, bytes }`), `traceparent` |
| `working` | a working message posted, changed or taken away | `spore`, `text` and `for` (whose messages) when posted; `note`, the `seq` it was posted under, and `text` or `removed` after |
| `reply` | the answer to a turn | `spore`, `text`, `answers` (the `seq` of each message it answers), `turn` (`{ turnNo, stopReason }`), `origin` (what said it when nobody in the conversation did — `schedule "digest"`, `webhook "kpi"` — else null) |
| `question` | a turn that ended on a question | as `reply` |
| `notice` | what the console itself said: a command's answer, a file it could not take | `spore`, `text` |
| `file` | a file the turn left in `data/out/` | `spore`, `name` (its path in the spore's workspace), `mime`, `bytes` |
| `card` | an approval asked of the person | `approval`, `spore`, `body` (`{ console: … }` or `{ default: { text, facts } }`), `options` (each `{ id, label, style, skip }`, `skip` true on one taken without the fields), `fields`, `by`, `until` |
| `closed` | the approval ended | `approval`, `note` (the card's `seq`), `state` (`answered`, `expired`), `choice`, `by`, `outcome` (the hook's: `confirmed`, `failed`, or null), `reason`, and `body` (what the hook answered) or `closing` (the line a person would read) |
| `quiet` | a turn nobody in the conversation asked ended with nothing to say, in the spore's default conversation | `turn`, `origin` |

## Approvals

Your program asks an approval as for any place
([INTEGRATION §Asking a person to approve](../../INTEGRATION.md#asking-a-person-to-approve)), with
`to: console:<name>/<person>`; a body under `console` is any JSON object, handed on as it is. It
shows as a `card`, its `fields` each a text or a choice as the relay hands them on — a choice with
its `choices`, `least` and `most` to pick, the ids picked at first as `value`, and `look`, `list`
or `menu`, how to draw it (a list up to 20 choices, a menu up to 100). `POST
/approvals/<id>/answer { choice, by, inputs }` presses it as `by`, `inputs` a text by each text
field's id and an array of the ids picked by each choice's. It is taken only from someone the
approval names, a choice among its options, while it is open, with every required field filled in
and each choice picked within its bounds, unless the option says `skip` — `200 { taken: true, text }`; anything else is
`409 { taken: false, reason }` and reaches no hook. Then everything a press in Teams sets off
follows: your hook is called with the presser as `by`, the card is `closed`, and the spore is told,
once, in the same conversation. Both the card's person and `by` must be among the console's
people.

## What it guarantees

- **A message reaches its spore once,** under `console:<name>:<id>` as its `requestId`, and the
  request is answered only once the spore has it; one that failed on the way is delivered again when
  the same `id` is sent again.
- **A finished turn reaches its conversation at least once.** What it owes a conversation is an
  entry in the spore's outbox, settled only once the console wrote it; one the service was writing
  when it stopped is written again opening with `(this may repeat an earlier message)`.
- **The conversation outlives the service.** Its events are kept, so after a restart a reader carries
  on from the last `seq` it saw.
- **Nothing without the token.** A request without it gets `401` and nothing else; one from a web
  page (it carries `Origin`) gets `403`; a person the file does not map gets `403`, naming them.

## Seeing what a program sends

`"trace": true` in the console file writes every message and every press to the service's log, one
line each, as the program sent it. It is read on every delivery, so it is turned on and off by
editing the file, with no restart; leave it off once you have seen what you needed.

## What it keeps

`$XDG_STATE_HOME/spore/console/<name>/events.sqlite`, every event of every person, for as long as it
is there.

## Not yet

Conversations many people share, a retention bound on the events, a filter on their types, and a
list of the open approvals.
