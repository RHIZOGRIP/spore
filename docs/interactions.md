# The interactions API

An **interaction** is something a spore asks for outside itself whose result comes back later, as a
message. The spore names a **handler** the operator described, gives it data, and ends its turn.
The handler does whatever it does: shows a page to a person, writes a file a cron job picks up, asks
another system. When it has a result it sends it back, and spore says it to the spore. The spore
never holds what produces the result: it cannot answer its own interaction.

This document is the protocol between spore and a handler, version `1`. What a handler is, how it
presents the data, who or what answers, and how it secures any of that are the handler's own; this
document says only what crosses between it and spore, and spore ships no handler. Why it is shaped
this way is in [ARCHITECTURE §Interactions](../ARCHITECTURE.md#interactions).

## Who does what

| party | does |
|---|---|
| the operator | describes each handler in `config.json`, gives a remote one a caller token in `api.json` |
| the spore's owner | grants interactions in `spore.cmk`, naming the handlers the spore may use |
| the agent | writes the data, asks for the interaction through `$SPORE_INTERACT` naming a handler, ends its turn, and reads the outcome when it arrives |
| the runner | freezes the data, stamps the origin and route, and launches its helper, which checks the grant, hashes the data, records the interaction, and hands it to the handler |
| `spore tick` | hands over any interaction the runner's helper could not |
| the handler | takes the request, produces a result its own way, and sends the outcome back |
| `spore-api`, `spore interaction outcome` | take the outcome, check it against spore's own record, and say it to the spore |

A handler is trusted because the operator described it, as an approval's hook is. Spore does not
verify it. It does verify that each outcome matches what spore itself asked.

## Configuration

### Handlers

`config.json` names each handler, under `interactions`:

```json
{
  "interactions": {
    "review-changes": { "url": "https://ask.example/", "secret": "${ASK_SECRET}", "what": "a person keeps or drops each proposed change" },
    "to-file": { "program": "/home/op/bin/ask-to-file", "what": "the request is written down; someone answers it later" }
  }
}
```

A name is letters, digits, `.`, `-` and `_`, starting with a letter or a digit, at most 64. Each
handler has `what`, one line the agent reads, and exactly one of:

- `url`, an http or https base, with `secret`, the variable in `environment` that signs spore's
  requests (§A handler at a URL);
- `program`, an absolute path to an executable (§A handler that is a program).

Nothing but `what` reaches a turn: the agent never learns a URL, a path or a secret.

### The grant

```
interactions: 2
interactions.handlers: [review-changes, to-file]
```

`interactions` is the most one turn may create, supersessions included; `interactions.handlers` the
handlers this spore may name. Both are `spore.cmk` only and each requires the other. A turn of a
spore granted a handler `config.json` does not describe is refused when it starts, as a granted
source the host does not describe is ([definition.md §`interactions`](definition.md#interactions)).

### Reaching the spore back

An outcome finds the spore by its name under `home`, so a spore that lives elsewhere (`workspaces`)
is refused at `create` with `INTERACTIONS_UNREACHABLE`.

A remote handler sends outcomes to `spore-api`, with a caller token `api.json` gives it, reaching the
spores it serves ([operating.md §The HTTP API service](operating.md#the-http-api-service)). A handler
on the host may run `spore interaction outcome` instead, and nothing needs to listen
(§Service → spore).

## The request

The same request goes to every handler, whatever the transport:

```json
{
  "v": 1,
  "id": "0b6f3f5c-…",
  "handler": "review-changes",
  "spore": "editor",
  "route": "telegram:main/42",
  "origin": { "turnId": "…", "inbox": [311, 314] },
  "askedAt": "2026-11-09T18:02:11Z",
  "expires": null,
  "supersedes": null,
  "dataHash": "<hex>",
  "files": [{ "path": "changes.json", "bytes": 912, "sha256": "<hex>", "data": "<base64>" }]
}
```

| field | meaning |
|---|---|
| `v` | the protocol version this interaction is created under. It stays the interaction's version for its whole life |
| `id` | assigned by the runner, a UUID. The handler keys everything on it |
| `handler` | the name the spore asked for |
| `spore` | the spore asking: its name under `home` |
| `route` | where the spore's answer to the outcome will go. For the handler to show or keep; it does not post to it |
| `origin` | the turn that asked, and the inbox entries it had read. For the record |
| `askedAt` | when the runner recorded it |
| `expires` | an instant, or `null` for never. There is no default: an interaction may be answered years later |
| `supersedes` | the `id` of an interaction this one replaces, or `null` |
| `dataHash` | §The data |
| `files` | every file of the data, sorted by path as UTF-8 bytes |

**Answers.** Every answer is a JSON object.

| answer | when |
|---|---|
| `{ "id", "state": "pending", "link"? }` | taken |
| what it answered the first time | this `id` again, with this `dataHash` |
| refused `INTERACTION_DATA` | the data breaks a rule of §The data, or its hash does not match; `detail` names it |
| refused `INTERACTION_VERSION` | `v` is not one the handler speaks |
| refused `INTERACTION_CONFLICT` | this `id` again, with another `dataHash` |
| refused `INTERACTION_ANSWERED` | `supersedes` names one already submitted, with its state |

`link` is optional: a place whoever must act can open, which the agent passes on in its answer. A
handler that has one makes it safe to post anywhere. Nothing a handler answers lets the caller
produce the outcome: no bearer link, no cookie, no token.

**State.** `{ v, id }` asks for `{ "id", "state", "link"?, "submittedAt"?, "outcome": "pending" | "accepted" | "ended" }`.
`state` is `pending`, `submitted`, `cancelled`, `expired` or `superseded`. `outcome` is how far the
handler got sending it back: `ended` means spore answered `NOT_A_WORKSPACE` (§Retries). Refused
`INTERACTION_UNKNOWN` for an id the handler does not hold. Asking the state changes nothing.

**Cancel.** `{ v, id }` asks for `{ "state": "cancelled" }`, also when it was already cancelled.
Refused `INTERACTION_ANSWERED` when it was submitted first, with its state. Submission, cancellation
and expiry are decided by the handler, whichever it records first winning.

**Superseding.** Changed data is a new interaction whose `supersedes` names the old one. The handler
marks the old one `superseded` when it takes the new one. A taken interaction is never changed.

### A handler at a URL

| request | route |
|---|---|
| create | `POST <url>v1/interactions`, the request as the body |
| state | `GET <url>v1/interactions/<id>` |
| cancel | `POST <url>v1/interactions/<id>/cancel`, `{ v, id }` as the body |

Every request spore sends carries:

```
x-spore-timestamp: <unix seconds>
x-spore-signature: sha256=<hex>
```

The signature is HMAC-SHA256, under the secret, of `<timestamp>.<METHOD> <path>.<body>`, where
`<path>` is the request's path from the first `/`, and `<body>` is the raw body (empty for a
`GET`). A handler refuses with `401` a request with no signature, a wrong one, or a timestamp more
than 300 s from its own clock. The method and path are signed so a signature taken from one route
cannot be replayed on another.

Taken is `201`, the first answer again `200`, `INTERACTION_DATA` and `INTERACTION_VERSION` are
`400`, `INTERACTION_CONFLICT` and `INTERACTION_ANSWERED` `409`, `INTERACTION_UNKNOWN` `404`, each
refusal as `{ "type", "message", "detail"? }`. A network failure or a `5xx` is not an answer: the
interaction stays `asked` and `spore tick` sends it again.

### A handler that is a program

The runner's helper starts the program once per request, outside the turn's confinement, as the
operator, in the operator's home directory and environment (`environment` beside `config.json`),
with no other argument than the verb:

```
<program> create    # the request on stdin
<program> state     # { v, id } on stdin
<program> cancel    # { v, id } on stdin
```

It prints its answer as one line of JSON on stdout and exits:

| exit | means |
|---|---|
| `0` | the line is the answer |
| `75` | not now: the interaction stays `asked` and `spore tick` runs it again |
| any other | refused: the line, if it is a refusal `{ "type", "message", "detail"? }`, else the last of stderr as `detail` |

A program still running after 60 s is stopped, with whatever it started, and counted as `75`. A
program need not handle `state` or `cancel`: refusing them is enough. Spore records a cancel either
way, unless the refusal is `INTERACTION_ANSWERED`, and refuses any later outcome of that interaction
with `INTERACTION_CLOSED`.

## The data

The agent writes a directory under `data/`. Every regular file in it is the data, whatever it holds:
JSON, text, images, code for the handler to run. Spore reads none of it. What the files mean, and
whether running any of them is safe, is between the agent's instructions and the handler.

**Rules.** The runner refuses, before anything is sent:

- a symbolic or hard link, a device, a socket, or anything but a regular file or a directory;
- a path that is absolute, contains `..`, is not valid UTF-8, or is over 255 bytes;
- two paths equal once case is folded;
- more than 1,000 files, or more than 16 MiB in all.

Each file is opened without following links, from a directory descriptor, and read once.

**The data hash** is the SHA-256, in lowercase hex, of the JSON Canonicalization Scheme
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) serialization of
`{ "handler", "files": [{ "path", "bytes", "sha256" }] }`, the files sorted as in the request. A
handler computes it again from what it received and refuses a mismatch.

The runner keeps the data as it was sent in the workspace at `interactions/<id>/`, read-only to the
agent, so what was asked survives whatever the agent later does to its directory.

## Service → spore: the outcome

```json
{
  "v": 1,
  "outcome": "submitted",
  "dataHash": "<hex>",
  "answer": { … },
  "attachments": [{ "name": "marks.png", "mime": "image/png", "sha256": "<hex>", "data": "<base64>" }],
  "responder": { … },
  "submittedAt": "2028-03-02T09:14:40Z",
  "receipt": "<hex>"
}
```

or, when the handler expired it, `{ "v": 1, "outcome": "expired", "dataHash", "at" }`.

`answer` is any JSON value, exactly as the handler produced it. `attachments` may be empty.
Attachment names are unique, at most 255 bytes, with no `/`, and none is `answer.json`. `responder`
is optional, any JSON object saying who or what answered, kept for the record and shown to the
agent. The body is at most 32 MiB.

**The receipt** is the SHA-256, in hex, of the RFC 8785 serialization of:

```json
{ "v", "id", "dataHash", "answer": "<sha256 of answer, RFC 8785>",
  "attachments": [{ "name", "sha256" }], "responder", "submittedAt" }
```

with `attachments` sorted by name as UTF-8 bytes and `responder` `null` when absent. It is a
checksum, not a signature: what makes an outcome trusted is how it arrived. Spore recomputes it and
refuses a mismatch.

It arrives one of two ways, with the same checks and the same answers:

- **`POST /v1/spores/<name>/interactions/<id>/outcome` on `spore-api`**, the outcome as the body,
  authenticated with the handler's caller token
  ([INTEGRATION §Authentication](../INTEGRATION.md#authentication));
- **`spore interaction outcome <spore> <id> [<file> | -]`** on the host, run as the operator, the
  outcome from the file or stdin. It prints the answer as one line of JSON. A turn cannot run it:
  the workspace's records are read-only to the agent.

**Spore checks**, in its own record:

- the interaction is this spore's, and was created under `v`;
- `dataHash` is the one it recorded;
- the receipt and every attachment hash recompute;
- it is still open: `asked` or `handed`. An `asked` one is accepted, since the handler may have it
  even though its acknowledgment was lost.

**Answers.**

| `spore-api` | command exit | when | body |
|---|---|---|---|
| `200` | `0` | said to the spore | `{ "inbox", "repeated": false }` |
| `200` | `0` | the same outcome again | `{ "inbox", "repeated": true }`: the first one's entry |
| `400 INTERACTION_OUTCOME` | `1` | a hash or the receipt does not match, or a field is malformed | `detail` names it |
| `404 INTERACTION_UNKNOWN` | `1` | the spore holds no such interaction | |
| `404 NOT_A_WORKSPACE` | `1` | the spore does not exist, or the token does not reach it | |
| `409 INTERACTION_ANSWERED` | `1` | it already has a different outcome | |
| `409 INTERACTION_CLOSED` | `1` | it was cancelled or superseded first | |
| `503 ADMISSION_FULL`, `503 PAUSED` | `75` | the outcome is written, and no turn can start to read it yet | |

Spore writes the outcome before it answers. Its inbox entry has the request id `interaction:<id>`,
so a repeat finds it. The entry carries the answer as `answer.json`, the attachments, and the frozen
data's path, and its `replyTo` is the route spore recorded at creation, never anything the handler
sends. It starts a turn like any message. A `503` or a `75` means the outcome is kept and no turn
could start; sending it again finds the same entry and starts the turn.

### Retries

The handler keeps the outcome before sending it, and sends it until spore answers. A network failure,
a `5xx`, a `503` or a `75` is tried again, with backoff, for as long as it takes. A `200` or a `0`
ends it. `NOT_A_WORKSPACE` ends it too: the handler records the outcome as `ended`, keeps the result,
and stops. Any other refusal is recorded with its error and not retried; it is a bug in one side.

The three stages are distinct, and each side reports its own: **submitted** (the handler's `state`),
**accepted** (spore's inbox entry exists: the handler's `outcome: accepted`), and **processed** (a
turn read it: spore's `status`).

## What a handler must do

A handler keeping this protocol:

- takes the same `id` twice and answers the same, since spore and `spore tick` may send it again;
- refuses data whose hash it cannot reproduce;
- at a URL, refuses every unsigned or stale request;
- never answers, logs or sends spore anything that lets the caller produce the outcome;
- changes nothing when asked the state;
- keeps an interaction it took, and its data, unchanged for as long as it is open;
- keeps an outcome before sending it, and sends it until spore answers.

Everything else, from who may answer to what runs where, is the handler's.

## The agent's side

The runner serves `$SPORE_INTERACT` only to a spore granted interactions. Each command prints one
line of JSON.

| command | answers |
|---|---|
| `handlers` | the handlers this spore may name, each with its `what` |
| `create <handler> <dir> [--route <r>] [--key <k>] [--supersedes <id>] [--expires <instant>]` | `{ "id", "dataHash", "state", "link"? }` |
| `status <id>` | spore's record, whether a turn has read the outcome, and as `said` what the handler answered to the state, its refusal or why it could not be reached |
| `ls` | this spore's interactions, open first |
| `cancel <id>` | spore's record, cancelled, with as `said` the refusal of a program that took no cancel |

**The route.** The candidates are the reply-tos of the inbox entries since the turn began, and
the spore's `replyTo` default.

| candidates | `create` |
|---|---|
| one | stamps it |
| several | needs `--route`, one of them; refused with `INTERACTION_ROUTES`, listing them, otherwise |
| none | refused with `INTERACTION_NO_ROUTE`, saying to set `replyTo` for this spore in `config.json` |

**The key.** `--key` makes a retry safe: the same key with the same data hash answers the
interaction already made; with another hash it is refused, `INTERACTION_KEY_REUSED`.

**When the handler cannot be reached**, answers `5xx` or exits `75`, the interaction is recorded
`asked` and `create` answers with that state and `unreachable` saying why; `spore tick` hands it over
later. The agent ends its turn either way.

| error | meaning |
|---|---|
| `INTERACTIONS_TURN_FULL` | this turn has created as many as the grant allows |
| `INTERACTION_HANDLER` | the spore is not granted that handler, or the host no longer describes it; `detail` lists those it may name |
| `INTERACTION_DATA` | the directory breaks a rule; `detail` names it |
| `INTERACTION_ROUTES`, `INTERACTION_NO_ROUTE` | the route table above |
| `INTERACTION_KEY_REUSED` | the key was used for other data |
| `INTERACTION_UNKNOWN` | `status`, `cancel` or `--supersedes` naming an id this spore does not hold |
| `INTERACTION_CLOSED` | `cancel` or `--supersedes` naming one that is no longer `asked` or `handed` |
| `INTERACTION_ANSWERED` | `cancel` of one submitted first |
| `INTERACTION_EXPIRES` | `--expires` is not an ISO 8601 instant still to come |
| `INTERACTIONS_UNREACHABLE` | an outcome could not reach this spore by its name under `home` |
| `INTERACTION_HANDLER_REFUSED` | the handler refused the request or answered what the protocol does not say; `detail` carries its answer |
