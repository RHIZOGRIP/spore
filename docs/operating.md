# Operating spore

What a host's operator configures and runs: the files under `~/.config/spore/`, the host-wide
settings, plugins and their services, and the commands that look after spores. How it works is
[ARCHITECTURE.md](../ARCHITECTURE.md); what it commits to is [PRINCIPLES.md](../PRINCIPLES.md);
the commands a user types every day are in the [README](../packages/spore/README.md).
The fields of a `.cmk` — a spore's, a precursor's, a schedule's — are in [definition.md](definition.md).

## `~/.config/spore/` and its `environment`

What the operator authors, never granted to an agent:

| path | what it holds |
|---|---|
| `config.json` | where workspaces live and what the machine allows |
| `sporangia/<name>/` | your sporangia, each laid over the package's of that name |
| `sources.json` | what each source name means, with its credentials |
| `memory.json` | the vector store of `memory: vectors` |
| `hooks.json` | the webhook service's hooks |
| `api.json` | the HTTP API's socket, address and callers |
| `environment` | provider keys, `PATH`, the bots' tokens |
| `<dir>/<instance><ext>` | one file per instance of a plugin service, in the folder its manifest names, as `telegram/<bot>.json` |
| `ssh/` | the private keys the `ssh-agent` service loads |

**`environment`** is read by every spore command at start, in the format systemd's
`EnvironmentFile=` reads: one `KEY=value` per line, no `export`, no spaces around `=`; `#` and `;`
start a comment; a value may be quoted; nothing is expanded. A variable already set in the
command's own environment wins. A missing file is no environment; a malformed line refuses the
command with its line number (`ENVIRONMENT_INVALID`), and `spore doctor` reports it.

## `config.json`

`$XDG_CONFIG_HOME/spore/config.json`, else `~/.config/spore/config.json`. Read and written with
`spore config get [<key>]`, `set <key> <value>`, `add <key> <value>` and `rm <key> [<value>]` (a
list takes `add`, and `rm` with a value drops one entry); `spore config path` prints where it is.
The file is written whole and renamed into place.

```json
{
  "home": "~/.spore",
  "workspaces": ["~/tmp/bench/bench-12"],
  "turns": 8
}
```

| key | what it is | when unset |
|---|---|---|
| `home` | the one directory spores are made in, one per subdirectory; not itself a spore | a bare name cannot be resolved |
| `homeSplit` | how many of a spore's last characters name the directory it sits in under `home`, 1 to 8 | flat: every spore directly under `home` |
| `workspaces` | spores living outside `home`, as paths | none |
| `turns` | how many of your turns may run at once | 8 |
| `modelSessions` | how many model calls one running turn and its cells may have going at once | 8 |
| `gate` | the data socket of a mohdel gate every turn calls its models through | each turn starts its own model sessions |
| `largestFile` | the largest file a turn may write, as `1GB`, `512MB` or bytes | 1 GB |
| `freeFloor` | free disk below which a turn is refused | 2 GB |
| `spendPerDay`, `spendPerMonth` | dollars all your spores may spend per local day or month | no limit |
| `contain` | `on` or `off`: whether every turn, job, router and prepare step runs in namespaces of its own | on |
| `docs` | `follow` or `kept`: whether a runner's start replaces the root documents that differ from what is installed | kept |
| `hereSnapshots` | how many `spore here` session snapshots are kept per spore | 20 |
| `plugins` | the plugins allowed on this machine; written by `spore plugin allow`, not by `config set` | none |
| `replyTo` | per spore, where answers go when what a turn read asked from nowhere, as `{ "triage": "discord:ops/1234" }` | none |
| `approvals` | the hooks an approval may tell how it ended, each by its URL and the variable holding its secret | none |

A path starting with `~` is kept as written; a relative one is resolved when it is set.
`spore setup` offers `~/.spore` as the home. `~/.config/spore` holds your configuration and keys;
your spores live in `home`. A spore inside `~/.config/spore` is refused.

**Many spores.** With `homeSplit: 3`, a spore named `85266511-…-0f665bc95d21` lives at
`<home>/d21/85266511-…-0f665bc95d21`: the last characters, which are random in a uuid, a ULID or a
KSUID, spread spores evenly over at most 4,096 directories. Set it before the home's first spore.
The layout is recorded in `<home>/.spore-home` — by `define` with the home's first spore, or by a
program that makes spores itself calling `recordLayout` — and once that record exists, a different
`homeSplit`, by `config set` or by editing the file, is refused. Before it exists, nothing guards
the value. With it, a name's last characters must be letters, digits, `-` or `_`.
`spore config set model <provider>/<name>` is not a key: it writes the `model:` line of your
default sporangium, `~/.config/spore/sporangia/default/spore.cmk`. A spore of another sporangium
takes only that line from it; the rest is read when a spore is made from the default itself, and
`spore doctor` reports any sporangium of yours `define` would refuse.

**Naming a spore.** A bare name is the spore of that name in `home`; anything path-shaped — it
starts with `.` or `~`, or holds a `/` — is taken as written; `.` is the one you are standing in. A
name is letters, digits, `.`, `-` and `_`, starting with a letter or digit, at most 64 characters.
`spore define <path>` makes a spore there and adds it to `workspaces`. A listed workspace that is
gone, or holds no `spore.cmk`, is skipped by `spore ls` and reported by `spore doctor`; `spore
config rm workspaces <path>` drops it.

### What the host limits do when they bind

```bash
spore config                       # every setting, and whether it is set or the default
spore config set turns 4
spore config set largestFile 4GB
spore config rm spendPerDay        # back to unset
```

- **`turns`** — a start past it is refused, `ADMISSION_FULL`, and no message is recorded and no
  spore created.
  `spore send` and `spore fork` say so and stop; `spore tick` holds a due schedule for a later
  pass; the chat plugins answer busy; the HTTP API answers `503`.
- **`modelSessions`** — a model call that finds every session busy waits for one; the turn's
  `wall` bounds the wait.
- **`gate`** — a turn's model calls go to that gate under its spore's `auth`, and so do those of
  a triage cell started outside any turn; no model session is started and no provider key held. A spore with no `auth`, a gate that does
  not answer, or a gate whose catalog lacks the spore's `model` refuses the turn before it
  starts. An image the agent reads goes to the gate inline, so the gate need not share this
  machine's files. `modelSessions` no longer applies: the gate's pool bounds the calls.
- **`largestFile`** — a write past it fails with `EFBIG` ("File too large"), or the command
  writing it ends on `SIGXFSZ`; the call record shows which. It bounds each file, not a turn's
  total.
- **`freeFloor`** — the turn is recorded as an error, `DISK_FULL`, without starting, and its
  message waits unread for the next turn.
- **`spendPerDay`, `spendPerMonth`** — once what the user's spores have settled reaches one, no
  turn starts (`SPEND_LIMIT`, saying which window, how much, and when it turns) and no new model
  call is made: a running turn ends `hard:spend`. Calls already running finish and are paid.
  `spore ls` and `spore usage` show how far each window has gone; `spore doctor` notes one
  reached.

### `contain`

On unless set: every turn's agent, job command, router command, prepare step
and cell outside any turn starts in user, PID and mount namespaces of its own. On a host that
refuses unprivileged user namespaces, a turn is recorded as `CONTAIN_FAILED` with its message
left unread, and a job, router, prepare step or standalone cell is refused.

```bash
spore config set contain off    # only where no one else's spores run as this user
spore config set contain on
```

While it is off, `spore ls` and `spore doctor` say so. The setting is the host's alone; a
definition cannot change it.

### `replyTo`

```json
{ "replyTo": { "triage": "telegram:triage/148392011" } }
```

Maps a spore's name to the place its answers go when what a turn read carries no reply-to of its
own — a schedule's firing, a webhook, a job, or a message sent without one. A place is `terminal`
or `<kind>:<place>`: `<kind>` lowercase letters, digits and `-`, `<place>` non-empty with no
whitespace. Unset, such an answer is not delivered anywhere. A `quiet` turn is addressed nowhere
either way. Whoever serves the kind — the Telegram, Discord, Teams or Slack service — delivers it.

`spore send` gives its message the reply-to `terminal`, so its answer never goes here. To see a
spore's answer reach this place, have the clock say something: a schedule `when: at <instant>` a
minute ahead ([definition §A schedule](definition.md#a-schedule)).

### `approvals`

```json
{ "approvals": { "kpi": { "url": "https://app.example/approved", "secret": "${KPI_HOOK_SECRET}" } } }
```

Names each hook an approval may tell how it ended ([INTEGRATION §Asking a person to
approve](../INTEGRATION.md#asking-a-person-to-approve)): a name of letters, digits, `.`, `-` and
`_`, starting with a letter or digit, at most 64, an http or https `url`, and `secret`, the variable in `environment` holding the key its POSTs
are signed with. The chat service that posted the approval makes the call; no turn is given the
variable. Edited by hand, as `replyTo` is.

Approvals are asked and read from the host:

```bash
spore approval ask <spore> request.json   # or - for stdin; prints its id and until when it is open
spore approval ls <spore>                 # each one, and how it ended
```

Telegram and Teams carry them; an approval asked in a Discord channel is refused for now.

## `$XDG_STATE_HOME/spore/`

What the user's spores share while they run, under `$XDG_STATE_HOME/spore/`, else
`~/.local/state/spore/`. None of it is granted to an agent.

| path | what it is |
|---|---|
| `slots/` | the admission slots, `0` … `turns`−1; a running turn holds one's `flock` |
| `spend/<YYYY-MM-DD>` | dollars settled that local day, in micros; this month and the last are kept |
| `paused` | `{ at, why? }`, present while `spore pause` is in force; a file made by hand pauses as well |
| `tick.lock` | held by the pass that fires schedules |
| `jobs/<run>.lock` | held by a job's supervisor while the job runs |
| `services/<name>.json` | the plugin and spore versions each service started with, read by `spore service restart --outdated` |
| `cells/` | the workspaces of cells run outside any turn, such as a triage cell's, and of dreams |
| `telegram/<bot>/`, `discord/<bot>/` | each chat bot's position |

The spend ledger is written whether or not a limit is set, so a limit set at noon counts the
morning. It counts every spore of the user, including one no config lists and one since
removed, and puts each call on the day it settled; `spore usage` reads the workspaces instead
and puts each turn on the day it started.

## Models on the host

`spore setup` asks questions and refuses without a terminal, naming the commands its steps are:
`spore config set home <dir>`, `mo onboard <provider>`, `spore config set model <provider>/<name>`,
`spore config set spendPerDay <dollars>`, `spore doctor`.

`spore doctor`'s **models** area reads every model a spore names — `model`, `models` and the
`cell-models` values — once each: a problem when a turn on it cannot run, a note when it has no
prices in mohdel's catalog, its calls then counting as $0 against `cost` and the spend limits.
Each names the `mo` command that fixes it. On a host that names a `gate`, the gate's catalog
answers instead (`POST /v1/info`): a problem when the gate has no entry for a model or refuses its
lane, or when it does not answer at all. Its credentials are the gate's, and doctor does not see them.

A model the catalog lacks is added through `/curate [<provider>]` in `spore tui` — a picker over
what the provider lists beyond the catalog, with its prices, written by mohdel's `curate` — or
`mo curate <provider>`, which asks for what an entry is missing. That only adds it to the
catalog; a spore may use it once its `spore.cmk` names it in `model`, `models` or `cell-models`.

## Provider credentials and ChatGPT plans

The runner fills each model call's provider key the way `mo` finds one, under mohdel's variable
names: first its own environment — which holds `~/.config/spore/environment` — then
`~/.config/mohdel/environment`. A machine where `mo` works runs spores with no key copied. No key
reaches an agent.

A `chatgpt/<model>` call uses the ChatGPT account `mo chatgpt login` signed in and
`mo chatgpt select` made active, through an OAuth token mohdel's helper fetches. Its calls report
zero spend: a definition's `cost` limits and the host's `spendPerDay` and `spendPerMonth` never
stop a spore running on a ChatGPT plan, while `rounds` and `wall` still do. Wherever spend is
shown — the header `send` and `fork` print when a turn starts, `spore show`, `spore usage`,
Telegram's `/status` — such a model reads `not metered · <label>` instead of dollars, as does any
model mohdel declares billed by `plan` or `capacity`.

## Sources: `sources.json`

`~/.config/spore/sources.json`, beside `config.json`, maps each source name to what it means:

```json
{
  "pubmed": {
    "url": "https://search.example.org/v1/search",
    "query": { "db": "pubmed", "api_key": "${PUBMED_KEY}" },
    "requires": ["collection"]
  },
  "tracker": {
    "url": "https://tracker.example.org/api/v1/",
    "headers": { "Authorization": "token ${TRACKER_TOKEN}" },
    "methods": ["GET", "POST", "PATCH"],
    "paths": ["projects/web/**"]
  }
}
```

| field | |
|---|---|
| `url` | required; `http://` or `https://` |
| `socket` | an absolute path: the call goes to this unix socket instead of the url's host, the url still giving the `host` header, the path and the query; the url is then `http://` |
| `query` | parameters sent with every call, as a host default |
| `headers` | headers sent with every call; `{name}` in a value is the calling spore's name |
| `method` | the one method of a plain source; `GET` when absent |
| `methods` | with `paths`, the methods a call may name |
| `paths` | path patterns under `url` a call may name: `*` one segment, `**` one or more; `url` must then end in `/` |
| `requires` | parameters a definition granting the source must narrow with `<source>.<param>` |

`${VAR}` in `url`, `socket`, `query` and `headers` is filled from the runner's environment, which includes
`~/.config/spore/environment`; the agent never sees the value. A variable set to nothing is not set,
and refuses the source.

`{name}` in a header value is the calling spore's name, its workspace directory's name, filled
by the runner whoever started the turn; a cell sends its root's. One credential then serves
every spore granted the source, and the service behind it tells them apart:

```json
"headers": { "Authorization": "Bearer ${TRACKER_TOKEN}", "X-Spore": "{name}" }
```

The agent can neither set nor change it. The name is only as good as the credential beside it:
whoever holds the credential can send any name, so the service checks both. Without `methods` and `paths` a
source is one URL and one method, and the agent adds query parameters. With them it is an API:
a call names a method, a path matching a pattern, and a JSON body. Spore checks only the method
and path; give the token no more scope at the service than the agent should have.

Refused when a turn starts, before any call: a `${VAR}` that is not set
(`SOURCE_SECRET_MISSING`), a source the definition grants and this file does not describe, a
`requires` parameter the definition does not narrow, a `query` default outside the values
the definition allows, a field not in the table, a placeholder other than `{name}` in a header or
`{name}` in `url`, `socket` or `query` (`SOURCE_INVALID`), and a `socket` that is not an absolute
path or comes with an `https://` url. A socket that does not exist at call time fails that call
(`SOURCE_UNREACHABLE`), as an unreachable host does.

A socket mounted where a spore runs is one its agent's commands can connect to as well; the
credential in `headers` is what keeps them out, so the service behind it must refuse a call
without it. A response past 32 MB is refused, and a call times out after 30 s.

Source calls count toward no spend limit; cap a paid endpoint at its provider.

## Accounts held by more than one spore

An account — a source's token, a key the `ssh-agent` service holds — may be granted to several
spores, which then act on that platform as one user with separate memories. Spore does not
track who shares an account and cannot tell them: two entries of `sources.json` may hold the
same token under different names, and the `ssh-agent` socket is reachable by every spore of the
user, whether its definition names the ssh plugin or not.

When spores share an account, say so in each one's identity, along with which events each handles
and who answers what. Each should read the account's own history
on the platform before acting, since that is the one record every holder sees; a hook per spore
can send each only its events. Holders that do not know they share an account both answer the
same event. A fork holds every account of its origin and inherits its open commitments (a review
promised, a reply owed). Neither the fork nor its origin is told.

## Vector store: `memory.json`

`memory: vectors` keeps its index in a vector store the host describes in
`~/.config/spore/memory.json`, beside `config.json`. The runner reads it at the start of each
turn; the agent never sees it, its URL or its credential.

```json
{
  "url": "https://vectors.example",
  "headers": { "authorization": "Bearer ${SPORE_MEMORY_TOKEN}" },
  "paths": { "create": "/v1/collections", "query": "/v1/collections/{collection}/query" },
  "collectionField": "collection"
}
```

| key | | |
|---|---|---|
| `url` | required | the store, `http` or `https` |
| `socket` | optional | an absolute path: the store is reached on this unix socket instead of the url's host, the url then `http` |
| `headers` | optional | sent on every request; each `${VAR}` is filled from the runner's environment, and an unset or empty one is an error |
| `paths` | optional | where `ready`, `create`, `fetch`, `upsert` and `query` live, each starting with `/`; `fetch`, `upsert` and `query` must contain `{collection}`. Absent ones are the protocol's defaults |
| `collectionField` | optional | the field of a create's body that names the collection; `collection` when absent |

Any other key is refused. Put the token in `~/.config/spore/environment`, never in the file. A
store that differs from the protocol only in its paths or in the name of the create's id field is
set up with `paths` and `collectionField`; the protocol itself is ARCHITECTURE
§The vector store protocol.

A turn of a spore declaring `memory: vectors` is refused at its start (`START_FAILED`) when the
file is missing or unreadable, or when the store does not answer `ready`. Each workspace gets
one collection per embedding model, so changing `embedding` starts a new collection.

## Webhooks: `hooks.json`

```bash
spore service define webhook && spore service enable webhook && spore service start webhook
```

The webhook service (`bin/spore-webhook.js`) listens on `127.0.0.1:8742`, or on the
`<host>:<port>` that `SPORE_WEBHOOK_LISTEN` names in `~/.config/spore/environment`
([§Where a service listens](#where-a-service-listens)). Exposing it is a reverse proxy's job. Each hook is one URL, `POST /hook/<name>`, configured in
`~/.config/spore/hooks.json`. The service reads that file and `environment` again for every
request, so a change needs no restart. `--check` reads them and exits.

```json
{
  "forge": {
    "spore": ["triage", { "name": "release", "accept": { "header": "x-forgejo-event", "values": ["release"] } }],
    "verify": { "preset": "forgejo", "secret": "${FORGE_HOOK_SECRET}" },
    "accept": { "payload": { "properties": { "sender": { "not": { "properties": { "login": { "const": "spore-bot" } } } } } } },
    "maxWait": "30m"
  }
}
```

A hook name is letters, digits, `.`, `-` and `_`, starting with a letter or digit, at most 64.

| field | meaning | default |
|---|---|---|
| `spore` | the spore it reaches, by name, or a list of them. Each entry is a name, which takes every delivery, or `{ "name", "accept" }`, which takes only what its `accept` keeps. A name may appear once | required |
| `verify` | how a request proves it is the sender's (below) | required: a hook without it is refused |
| `accept` | which requests are kept: `{ "header", "values": [ … ] }` keeps a request whose header has one of the values; `{ "payload": <JSON Schema> }` keeps one whose JSON body matches; both may be given. One that keeps everything is refused | keep everything |
| `maxBytes` | the largest body, as `1MB` or `512KB`; past it, `413` | `1MB` |
| `perHour` | deliveries the hook may let start a turn in each spore an hour, counted from the spore's own records; past it a delivery is said and starts nothing | `30` |
| `maxWait` | the longest the spore's router or triage cell may keep a delivery waiting, as `30m` or `2h` | none: released as soon as it is timed |
| `perDay` | triage cells the hook may start in each spore a day; past it a delivery is said at once | `100` |

What a delivery goes through before a turn reads it is the spore's: the program its `spore.cmk`
binds to `hook:<name>` with `prepare:`, which attaches what it makes ([definition
§prepare](definition.md#prepare)), then its router or triage cell for the hook
([ARCHITECTURE §Deliveries nobody typed](../ARCHITECTURE.md#deliveries-nobody-typed)).
`hooks.json` names no code; a hook with a `router` is refused. A delivery past `perHour` is still
prepared, and said without starting a turn.

**`verify`** is one of:

- `{ "preset": "<name>", "secret": "${VAR}" }` — `github`, `forgejo`, `gitea` (HMAC SHA-256 of the
  body in the sender's signature header), `gitlab` (the `X-Gitlab-Token` header) or `stripe`
  (Stripe's timestamped signature, 300 s tolerance). A preset also names the headers carrying the
  event and the delivery id.
- `{ "hmac": "sha256" | "sha1", "header": "<header>", "secret": "${VAR}", "encoding": "hex" | "base64", "prefix": "<text>" }`
  — an HMAC of the raw body; `encoding` defaults to `hex`, `prefix` to none.
- `{ "header": "<header>", "token": "${VAR}" }` — the header must equal the token.
- `{ "token": "${VAR}" }` — the token is the last path segment: `POST /hook/<name>/<token>`.

A secret is always `${VAR}`, filled from the environment; a variable that is not set refuses the
hook. No variable a hook names is passed to a turn or a triage cell.

**Answers.** `202` once the message is held, also when no spore kept it (the journal says why); a
retried or replayed body is taken once per spore. `401` for a failed check, `404` for an unknown
hook, `413` past `maxBytes`, `503` while spores are paused, and `500` when a spore could not be
reached, so the sender's retry reaches that one.

## The HTTP API service

```bash
spore service define api && spore service enable api && spore service start api
node bin/spore-api.js --tick      # a container's one process; also fires schedules every minute
node bin/spore-api.js --check     # read api.json and the environment, print where it listens, exit
```

`~/.config/spore/api.json` says where it listens and who may call it:

```json
{
  "socket": "/run/spore/api.sock",
  "listen": "127.0.0.1:8787",
  "callers": {
    "app": { "token": "${SPORE_API_APP}", "spores": ["support-*"] },
    "pipeline": { "token": "${SPORE_API_PIPELINE}", "spores": ["report-*"], "maxWait": "30m" }
  }
}
```

- `listen` is `<host>:<port>` ([§Where a service listens](#where-a-service-listens)); there is no
  default port, since the file says `socket`, `listen` or both. `socket` is an absolute path; the service makes its directory `0700` and the socket
  `0600`, and refuses to start when something already answers on it.
- Each caller's name is letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most
  64: it is the origin `api:<caller>` a spore's `prepare:` and router name.
- Each caller's `token` is `${VAR}`, at least 32 characters once filled. The value goes in
  `~/.config/spore/environment` (`openssl rand -hex 32`), never in the file. `spores` lists names
  and patterns of letters, digits, `.`, `_`, `-` and `*`, where `*` matches within one name; a
  caller reaches only the spores under `home` that its patterns name.
- `maxWait` is the longest the spore's router or triage cell for `api:<caller>` may keep a
  delivery from the caller (`POST /v1/spores/<name>/deliveries`) waiting, as a hook's `maxWait`
  ([§Webhooks](#webhooks)); absent, it is released as soon as it is timed. What prepares it is
  the spore's `prepare:`, never `api.json`'s, and a caller with a `router` is refused.
- `perDay` is how many triage cells the caller's deliveries may start in each spore a day, as a
  hook's `perDay`; past it a delivery is delivered at once. Absent, `100`.
- `perHour` is how many of the caller's deliveries may start a turn in each spore an hour, as a
  hook's `perHour`; past it a delivery is said and starts nothing, and the next turn reads it.
  Absent, no bound.
- `--tick` runs the schedule pass (`spore tick`) every minute, for a container without a timer.
- Exit code 2 means the configuration was refused; the unit does not restart after it.

The routes, the token a request carries, the errors and `traceparent` are in
[INTEGRATION.md §The HTTP API](../INTEGRATION.md#the-http-api).

## Where a service listens

Every service that listens — the webhook, the API, each Teams bot, each console — takes its address
the same way: `<host>:<port>`, or `[<v6>]:<port>`, and `127.0.0.1` on its own port when it says
none (the webhook 8742, a Teams bot 3978, a console 8790). Any host is taken. None of them speaks
TLS, so `--check` and the line a service logs at start add `(plain HTTP, reachable beyond this
machine)` to an address beyond loopback: putting one there is for a network you trust, and a
reverse proxy holding the certificate is the usual way to reach one from elsewhere.

A request body past a service's bound is answered `413` and the connection closed.

## Services spore ships

`spore service define <svc>` writes these units under `~/.config/systemd/user/`, each marked
`X-Spore-Service=<name>`; spore never touches a unit it did not write.

| service | units | what it runs |
|---|---|---|
| `tick` | `spore-tick.service`, `spore-tick.timer` | `bin/spore-tick.js` every minute: fires every schedule that is due |
| `webhook` | `spore-webhook.service` | `bin/spore-webhook.js`: each hook in `hooks.json` a message to its spore |
| `api` | `spore-api.service` | `bin/spore-api.js`: the verbs over HTTP, as `api.json` says |
| `ssh-agent` | `spore-ssh-agent.service` | an `ssh-agent` on `$XDG_RUNTIME_DIR/spore-ssh-agent.socket`, loaded with every private key in `~/.config/spore/ssh/` |
| `sluice` | `spore-sluice.service` | a sluice broker serving each `~/.config/spore/sluice/<spore>.rules` on `$XDG_RUNTIME_DIR/sluice/spores/<spore>/sluice.sock` |

Adding or retiring an SSH key is putting it in `ssh/` or taking it out, then restarting
`ssh-agent`. Its socket is handed to a spore by the ssh plugin: `spore plugin allow ssh
socket=/run/user/<uid>/spore-ssh-agent.socket`.

`sluice` needs `sluice` 0.4 or later on `PATH` (or in `~/.cargo/bin`) and the folder
`~/.config/spore/sluice/`, one `<spore>.rules` per spore that may run host commands: what the
broker runs for that spore, on that spore's own socket. The comment lines above a rule are what its
agent reads the rule is for, with `--list`. A file added, changed or removed takes effect within a
second. The sluice plugin hands each spore its socket: `spore plugin allow sluice
dir=/run/user/<uid>/sluice`. A spore using it runs contained with the rest of that directory
hidden, so it reaches its own socket and none of its user's other sluice brokers; a spore that is
not contained is refused. `spore doctor` names a spore whose socket is not there.

## Plugin services

```bash
spore service ls                          # spore's own services and every installed plugin's
spore service define <svc>                # write its systemd user unit, checked first
spore service start|stop|restart <svc>    # now; enable|disable: at every login
spore service restart --outdated          # every service running older code than is installed
spore service show <svc>                  # its state and last lines
spore service log <svc> [-n <lines>] [-f] # its journal; -f follows it
spore service rm <svc> [--yes]            # remove it; --yes when that stops instances running
```

`spore service ls` offers the services of every installed plugin, allowed or not. Defining one
runs that plugin's program on the host, outside every sandbox. A service
name spore ships, or one two plugins claim, is given to neither plugin, and `spore service ls`
says why.

Spore writes the unit itself, under `~/.config/systemd/user/`: restarted on failure and not after
exit code 2 (`RestartPreventExitStatus=2`), with `KillMode=process`. A plugin service with
instances keeps one file per instance in a folder beside `config.json`, as
`telegram/<bot>.json`.

A running service records the plugin version it started with, and the spore version it loaded;
`spore service restart --outdated` restarts each one whose installed version has moved on — the
plugin's, or the spore the plugin loads, which a global install keeps inside the plugin and which
an upgrade moves while the plugin's own version stays.

## Plugins on the host

```bash
spore plugin ls                      # installed beside spore, and which are allowed
spore plugin allow <plugin> [k=v …]  # check it, then record it in config.json
spore plugin disallow <plugin>       # undo that
spore plugin show <plugin>           # settings, programs, env, docs, precursors
```

`allow` checks the manifest, the `works` range against the installed `@rhizogrip/spore`, every
program (executable, and inside the plugin or a package it depends on), every setting the manifest
declares (present, and a `port` or `text` as declared) and every precursor it carries, then
records the plugin under `plugins` in `config.json` with its version and the directory of the copy
it checked.

A plugin installed elsewhere grants the agent its own directory and each package it depends on
that is not inside it, one read path each. A turn whose commands would be handed more than 256
read paths in all — the system's, the definition's `reads` and `writes`, the plugins' — is refused
at its start (`START_FAILED`), naming the count and what made it. Installing plugins beside spore,
in one `npm install`, adds none.

A turn uses exactly that copy. After a plugin's version or directory changes, a turn of a spore
using it is refused with `PLUGIN_CHANGED` until `spore plugin allow` is run again. A definition
naming a plugin that is not allowed is refused at `spore send`, and `spore define` does not make
the spore. What a plugin's manifest may declare, and how one is written, is in
[plugins.md](plugins.md).

## Pausing every spore

```bash
spore pause [why]      # stop every running turn and job of your spores, and start none
spore unpause          # lift it; the next tick releases what was held and fires what is due
```

While paused:

- `spore send`, `spore fork` and a release are refused, `PAUSED`, and no message is recorded and no
  spore created. A person's message through a chat plugin is refused and they are told why.
- The webhook service answers `503` to every delivery without reading its body; nothing of it is
  kept, and whether it comes again is the sender's retry policy.
- A job's message stays held, a schedule keeps its due slot, and `spore tick` passes without
  firing. After `spore unpause`, each schedule fires at most one catch-up.
- `spore ls`, `spore show` and the Telegram plugin's `/status` say the spores are paused.

A stopped turn is not resumed: what it had not answered is read by the next turn in its spore.
A second `spore pause` keeps the first mark and stops whatever is running, which catches a turn
that started beside the first. Creating an empty `paused` file by hand also pauses, and deleting
it unpauses.

## Jobs: `jobs` and `spore job`

A spore may start jobs only when its `spore.cmk` grants them, with `jobs` and its `jobs.*` fields
([definition.md](definition.md#jobs)).

```bash
spore job ls [<spore>]          # a spore's jobs, newest first, with each running one's last progress line
spore job stop <spore> <job>    # ask the job's supervisor to stop it; how it ended is said to the spore
```

A running job also shows in `spore show`, with its last progress line.

## Dreams

A spore dreams only when its `spore.cmk` says so, with `dream` and its `dream.*` fields
([definition.md](definition.md#dreams)). The `tick` pass starts a dream that is due, as it fires a
schedule: it takes an admission slot, and waits while the spores are paused or a spend limit is
reached. While it runs, `spore ls`, `spore show` and the TUI say `dreaming`; `spore send` queues
the message and says so, and the turn after the dream reads it. `spore stop` stops a dream as it
stops a turn. Each dream is a row in the `cells` view with origin `dream`, what it cost, and what
it changed; its workspace is under `$XDG_STATE_HOME/spore/cells/<spore>/dream/`, and the runner's
`spore.err` says how it ended.

## Driving `spore` from a program

`spore send --json`, its exit codes, `--request-id` and `spore attach --json --after` are in
[INTEGRATION.md §The command](../INTEGRATION.md#the-command).

## Cloning a spore: `spore define --from`

```bash
spore define <new> --from <old>
```

Makes `<new>` with `<old>`'s `spore.cmk`, its `precursors/` and every program a precursor grants
in `enzymes`, each with the paths its `<enzyme>.with` declares, links carried as links. It leaves
behind the database, `calls/`, `inbox.d/`, `schedules/`, `home/` and the rest of `data/`,
`data/memory/` included. `<old>` may be running. `--from` refuses `--definition` and
`--sporangium` (`DEFINE_AMBIGUOUS`). The clone is refused (`CLONE_INCOMPLETE`) when a granted
program or a declared path is missing, lies outside the workspace, or is a link out of it, to the
whole workspace or to nothing.

## Forking a turn: `spore fork`

```bash
spore fork <name> --at <call> <new> [--definition <file>] [--replay]
```

Makes `<new>`, a name or a path, as `<name>` stood when the round of `<call>` came back, and carries
the turn on from there; the command follows it like `send`, with the same exit codes. `<call>` is
a call of the run's last turn, as `--at 0003`, or of another turn, as `--at <runId>/0003`.
`--definition` runs the fork under another `spore.cmk`. `--replay` cuts before the round's
results, so its calls run again under the runtime as it is now.

Refused (`FORK_REFUSED`): a spore still running, a `<new>` that exists, a definition that does not
parse, a file in `data/`, `calls/`, `precursors/` or `home/` changed after the cut — cut at a later
call — and a `--replay` of a round that called `ask`. The fork spends like any turn.

`scripts/try-definitions.js` in the package forks one cut many times under each definition and
says how often each delivered a file under `data/out/`, and how its turns ended:

```bash
node scripts/try-definitions.js --run <workspace> --at <call> --into <dir> [--times 20] [--at-once 4] [--replay] [other.cmk …]
```

## `spore here`

```bash
spore here [<dir>] [--sporangium <s>] [--model <m>] [--no-git]
```

Opens the spore that works in `<dir>` (the current directory by default), made the first time as
`<directory>-<6 hex>` in `home`, granted `writes: [here=<dir>]`. On a terminal a picker offers the
sporangia; without one `--sporangium` is required. Outside a git work tree it is refused unless
`--no-git`, and then nothing can be undone. Each session's snapshot is a ref under
`refs/spore/<spore>/` in that repository; the newest `hereSnapshots` (20 unless set) are kept.

## Root documents and `spore upgrade`

```bash
spore upgrade <name>     # replace this spore's root documents with the installed ones
spore upgrade --all      # the same for every spore `spore ls` finds
```

The root documents are `reference.md`, `libraries.md` and `plugins/<name>.md` for each plugin the
spore uses. They are copied into a workspace when absent and otherwise change only through
`spore upgrade`. `spore send` and `spore show` name each one that differs from the installed copy;
"differs" covers both a local edit and a newer package. `precursors/`, its `README.md` included,
is never touched by an upgrade.

A root document missing when a turn starts is laid again from what is installed. A program that
manages workspaces without the command can upgrade one by deleting those files while it holds the
workspace lock; the next turn writes the installed copies.

With `docs` set to `follow`, a runner's start does what `spore upgrade` does for that one spore,
before its agent starts, and `spore send` no longer names the documents that differ: a host whose spores nobody edits by hand keeps every spore that runs on
the installed documents, and leaves the ones that never run untouched.

```bash
spore config set docs follow
spore config set docs kept       # the default: only spore upgrade replaces them
```
