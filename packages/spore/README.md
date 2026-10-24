# spore

LLM agents for a server, each in a directory of its own.

Each agent is a **spore**. Its directory, the **workspace**, holds who it is, what it may
call and what it may spend. Send it a message and a turn starts: it reads, writes, runs
commands and answers, then exits. An idle spore runs nothing.

- **Confined by the kernel.** Landlock holds it, and every command it runs, to its workspace.
- **No keys inside.** Provider keys and credentials stay with the runner; the agent asks by name.
- **Bounded.** Soft and hard limits on rounds, spend and wall time: soft wraps up, hard stops.
- **On record.** Every turn, message and tool call lands in the workspace's database.
- **Reachable.** The command line, Telegram, webhooks and its own schedules all write to one inbox.

When the work has many similar parts it starts **sub-agents**, each confined to a directory
of its own.

Design and internals: [ARCHITECTURE.md](https://github.com/RHIZOGRIP/spore/blob/main/ARCHITECTURE.md).

## Install

```bash
npm install -g @rhizogrip/spore-cli    # the spore command, with the runtime under it
npm install @rhizogrip/spore           # the library alone, to embed
```

On a server nobody opens a terminal screen on, `npm install -g --omit=optional @rhizogrip/spore-cli`
leaves out the one `spore tui` and `spore here` open, and its dependencies; every other command,
`spore setup` included, works without it.

Node 24+ whose bundled SQLite is 3.51.3 or newer, on Linux x64, kernel 5.13+ (Landlock), glibc.
spore refuses an older SQLite (`SQLITE_TOO_OLD`); `node -p "new (require('node:sqlite').DatabaseSync)(':memory:').prepare('select sqlite_version() v').get().v"`
prints the one your Node carries. The native parts come prebuilt in the
package, so installing needs no compiler. Building from a checkout does: a C compiler and
cargo, which `npm install` runs through `prepare`.

### On macOS or Windows

spore runs on Linux only. Elsewhere, run it in a Linux VM. On macOS, with
[Lima](https://lima-vm.io):

```bash
limactl start --name spore template://ubuntu-lts
limactl shell spore
```

Then install Node 24+ in the VM, `npm install -g @rhizogrip/spore-cli` as above, and run
`spore doctor`, which reports a kernel without Landlock. Keep workspaces on the VM's own
filesystem, not on a directory shared from the host.

## Quick start

`spore setup` is the first run. It checks this machine — Node's SQLite, Landlock, whether turns
can be contained — asks where spores live, sets up a provider through mohdel's `mo onboard`
(ChatGPT, OpenRouter or another), sets the model new spores run on, offers the tick timer, runs `spore doctor` and makes a first spore, `main`. Each step looks first,
so running it again is a check. The same by hand:

```bash
# a provider key where mo finds it: the environment, or ~/.config/mohdel/environment
export ANTHROPIC_API_SK=...

spore config set home ~/.spore
spore config set model anthropic/claude-sonnet-5-5   # what new spores run on
spore define q3
spore send q3 "summarize the reports in data/"
```

The answer goes to stdout. Send again and the conversation continues — the transcript
is replayed as the opening history:

```bash
spore send q3 "now chart the totals"
spore send q3 "compare with last quarter" --attach q2-totals.csv
```

A program drives it the same way, from any language or over `ssh`, and
[INTEGRATION.md](https://github.com/RHIZOGRIP/spore/blob/main/INTEGRATION.md#the-command) says how: `--json`, `--request-id`, the exit
codes, and carrying on from the last event seen.

A turn runs in the background and `spore send` follows it. Ctrl-C walks away and leaves it
running; `spore attach q3` picks it up again, and `spore stop q3` ends it mid-round. You
can also talk to a turn while it runs — `spore send q3 "skip the appendices"` reaches the
agent between rounds, and `spore send q3 stop` asks it to wrap up with what it has.
`spore wrap q3` makes it wrap up as it would at its wall, and `spore extend q3 wall 30m`
gives a long turn more time, as far as its definition allows. `spore pause` stops every turn
and job of your spores and lets none start until `spore unpause`: a message or a webhook sent meanwhile is
refused, and schedules wait.

`spore define` says what a spore is —
and given `--definition` again, revises one, keeping its conversation and everything in
`data/`. `spore edit` opens its `spore.cmk` in your editor and saves it only once it parses.
`spore send` never makes a spore: a name that does not exist is an error. `spore ls` shows what you have, and `.` names the one you are
standing in. `spore rm` removes one. It refuses while the spore is running, and wants `--yes`
once the spore has turns: its conversation, its records and what it made. `spore remake`
makes one again from its sporangium, keeping `spore.cmk`, `data/`, `home/`, its precursors and
schedules, and setting its database, trail and inbox aside in `<name>.before-remake` — how a
spore made by another development version, whose database cannot be opened, is brought back.

A message sent to a spore that stopped on a question is the answer to that question.

The model is part of the definition — `model:` in `spore.cmk`, beside the tools and the limits. The
first `spore define` copies the default sporangium to `~/.config/spore/sporangia/default/spore.cmk`
and stops, asking for a model: `spore config set model <provider>/<name>` writes the `model:` line
into that file, and every spore after that runs on it unless its sporangium names another.
`spore define <name> --model <m> --plugin <p>` fills those two into a new spore's `spore.cmk`. To
change an existing spore, use `spore edit`.

A definition can offer more than one:

```yaml
model: anthropic/claude-sonnet-5-5
models: [anthropic/claude-haiku-4-5]
cell-models: [low=anthropic/claude-haiku-4-5, strong=openai/gpt-6.1-sol]
```

`models` is what `spore model`, or `/model` in the terminal, may switch to. A precursor then says
`model: low` or `model: strong`, never a model itself, and runs on yours
when it says nothing. The runner refuses a call to any model the definition does not name, so
neither the agent nor a precursor it wrote can choose another.

## The workspace

```
<ws>/spore.cmk        the agent's identity, its tool grant, its model, its limits
    /state.sqlite     everything said to it, the conversation, what each turn did and how it
                      ended, and what every tool call did
    /spore.out        the running turn's answer, as it appears
    /spore.err        the running turn's progress
    /reference.md     what the agent can read about its own runtime
    /libraries.md     one tested example per library its programs can import
    /lock             pid + startedAt, only while a run is live
    /calls/           any stream a tool call did not name
    /precursors/      sub-agent definitions
    /plugins/         the documentation of each plugin it uses
    /node_modules/    document, format and arithmetic libraries its programs can import
    /data/            everything the agent makes
    /home/            the agent's $HOME, for its programs' settings and caches
```

`spore sql <name>` lists the views of `state.sqlite`, and `spore sql <name> '<query>'` reads
them, as the agent does with `$SPORE_SQL`: `turns`, `inbox`, `transcript`, `events`, `calls`.
`spore sql <name> -` reads the query from stdin, so it reaches spore through no shell — over
`ssh`, which hands its arguments to the remote shell, that is the only way a query arrives intact.

`spore usage [<name>]` is what was spent, from the same records: per local day over the last 7
(`--days N`, or `--since <date> [--until <date>]`, `--tz <zone>`), then by origin — a person, a
Telegram chat, a schedule, a webhook, a job, an errand — by model, by how the turn ended and by
precursor; every spore `spore ls` finds when no name is given. Money is what the provider settled,
never an estimate: a turn on a subscription model counts as not metered, and a turn no ledger
settled is counted but not summed. `--by <axis>` prints one breakdown, `--json` the whole object,
which `usage()` returns to an embedder.

`spore define` makes a workspace from a sporangium: a spore's layout with nothing run yet. Every
spore is made the same way — the default sporangium, then the one named with `--sporangium` over it,
file by file — and each sporangium is the package's `sporangia/<name>/`, then yours in
`~/.config/spore/sporangia/<name>/`, yours winning. Your default sporangium is copied from the package's
on first use. Edit it freely: upgrades do not touch it. The package ships `default`, `perennial`, `code`, `reviewer`, `security` and `commit` — the last drafts
git commit messages: `spore define commit --sporangium commit`, then install the hook it carries,
`data/prepare-commit-msg`, in a repository's `.git/hooks/` or in `core.hooksPath`. `--definition <file>` gives a
`spore.cmk` directly. `reference.md`, which the agent reads to learn its runtime, also comes from
the sporangium. It is replaced only by `spore upgrade <name>`,
which `spore send` and `spore show` name when it differs from what is installed.

**The root is read-only to the agent.** It writes in `data/`, `precursors/` and `home/`,
its `$HOME`, and the runtime writes the streams of its calls in `calls/` from inside its process;
the runtime keeps the rest, so `spore.cmk`, `lock` and the transcript outlive the
agent — it can read all three and change none. The tool list is not a security boundary;
Landlock is.

## The call contract

- **A tool call names the file it is about.** `path` is the file a call acts on;
  `out` is where a *stream* goes — stdout from `exec` or `wsexec` — and never
  into the answer. `err` likewise, named automatically when omitted.
- **No stream ever enters context.** A short file comes back inline in the call
  record; a large one stays on disk for the next program to read.
- **Exit code is the only success signal.**
- Every call leaves a record under `calls/`. What the caller sees is a view of it;
  hashes, mtimes and timings stay on disk.

`read` is the exception: its record carries the file's text into the conversation, in `content`.

## Tools

| tool | what it is |
|---|---|
| `read` | the file's text, in its record — line or byte ranges, any encoding, lines numbered on request |
| `write` | content in, file at `path` |
| `edit` | unique-string replace; refuses when absent or repeated |
| `exec` | shell, **read-only**, several run at once |
| `wsexec` | shell that may write the workspace, serialised |
| `ask` | puts a question to the user and ends the turn |
| `quiet` | ends the turn with nothing to say; its reason goes to the record, not to anyone |

`exec` cannot write anything, so surveying (`find`, `grep`, `wc`, `git log`) is cheap and parallel;
producing a file needs `wsexec`. HTTP is `curl` under `exec`. Web search is a plugin,
`@rhizogrip/spore-plugin-brave`: a program over a source whose key the runner holds.

A tool the definition does not list is not offered at all.

## The definition

`spore.cmk` is frontmatter plus a body, and the body is the agent's identity —
written as instructions to it ("You are…"). Every field, for a spore and for a precursor,
and the schedule files, is in [docs/definition.md](https://github.com/RHIZOGRIP/spore/blob/main/docs/definition.md).

```
---
name: spore
model: anthropic/claude-sonnet-5-5
tools: [read, write, edit, exec, wsexec, ask, quiet]
rounds: [40, 45]
cost: [0.50, 0.75]
wall: [10m, 12m]
retain: 10
---

You are a general AI assistant...
```

Every limit is a required **soft/hard pair**, hard strictly past soft, and a running turn's limits
rise through `spore extend` only as far as the definition's `extend.*` fields allow.

## How a turn ends

`stopReason` names it:

| | |
|---|---|
| `answer` | it finished |
| `question` | it called `ask`; the question is the turn's output |
| `quiet` | it called `quiet`: done, with nothing to say; no output, and the reason in the turn record's `because` |
| `soft:<dim>` | it crossed a soft bound, was told to wrap up, and answered with what it had |
| `hard:<dim>` | it crossed a hard bound and was stopped — `rounds`, `cost` or `wall` |
| `cancelled` | it was stopped — `spore stop`, Ctrl-C twice in the terminal, a stop from the HTTP API |
| `error` | it could not run, or died: the turn record's `error` says why (`START_FAILED`, `DISK_FULL`, `CONTAIN_FAILED`, …) and its message waits unread |

Crossing a soft bound appends a message telling the agent
to answer now and say what is unfinished — you get a partial answer. Crossing a hard bound
writes a **continuation record** to `calls/<run>/continuation.md`, assembled from the trail,
the transcript and the files on disk with no model call.

A tool that fails five times running is `soft:progress`. The loop wraps and the
tool stays available.

However a turn ends, `spore send` again continues the conversation.

**What all your spores spend together** is not bounded by spore: `cost` bounds each turn. A
total over spores is for whatever runs them — each turn's settled spend is in its record, and
`spore pause` stops every turn and job.

## Turns the clock starts

A schedule is a file in the spore it talks to, and the clock says its body as a message:

```
<ws>/schedules/digest.cmk
---
when: 0 9 * * 1-5
tz: Europe/Paris
late: 3h
---

Check the sources in data/memory/watchlist.md for what changed since your last report.
If nothing did, end with quiet.
```

`when` is a five-field cron expression with its zone, or `at 2026-10-01T09:00:00+02:00`
for one firing. `late` skips a firing that could not start in time. Install one with
`spore schedule set <spore> digest digest.cmk`, which checks it first, or write the file by
hand; `spore schedule rm <spore> digest` removes it, and `spore schedule ls <spore>` says where
each stands.

`spore tick` fires every schedule that is due, across every spore `spore ls` finds, and
says what it did about each one. Run it every minute from one timer for all your spores:

```bash
spore service define tick && spore service enable tick && spore service start tick
```

That writes `spore-tick.service` and `spore-tick.timer` under `~/.config/systemd/user/`; the
service runs the package's `bin/spore-tick.js`, the same pass as `spore tick`. Like every spore
command, it reads `~/.config/spore/environment` itself, which is where
the runner finds the provider keys. The unit carries **`KillMode=process`**. If you
write your own unit, keep `KillMode=process`. Without it, systemd kills every turn the tick started
as soon as `spore tick` exits.

A slot fires once: a spore that could not be reached for three days gets one firing, for
today. It does not fire into a running turn, a question waiting for its answer, or a turn
that failed — it waits, and `spore show` says why. Whether the turn answers is up to it:
`quiet` ends a turn with nothing to say, and the firing is recorded either way.

A spore may write its own schedules when its `spore.cmk` grants
`schedules: [count, interval]` — at most `count` of them, none firing more often than
`interval`, and no more than `count` firings within any `interval` whatever the files become.
`write` and `edit` refuse a schedule that breaks that, the clock holds a firing past it, and `spore show` prints
how many turns the grant allows at most per day, and what they cost nominally — each turn at
its hard cost, which stops new model calls and pays for those already running. Give a recurring job a spore of its own, so its
conversation is only that job.

## Sub-agents

When a job has many similar parts, the agent gives each part a directory and runs
them in parallel. `spawn` is a binary its own programs call, so a fan-out is a
shell loop and the OS is the scheduler:

```
ls -d data/parts/*/ | xargs -P 8 -I{} "$SPORE_SPAWN" \
  --precursor summarize --ws {} --prompt in.md --answer data/out.json
```

A **precursor** is one file in `precursors/`, and it is what a sub-agent is:

```
---
name: summarize
tools: [read]
rounds: [5, 7]
cost: [0.10, 0.15]
wall: [2m, 3m]
on-wrap: discard
---

You reduce a document to its essentials...
```

`tools` is empty by default — a summarizer handed text needs nothing else.
`on-wrap` says what an unfinished answer is worth: `keep` writes it, `discard`
throws it away and writes the continuation record instead. Choose `discard`
whenever a partial result is indistinguishable from a complete one to whatever
reads it.

Each spawn prints one JSON line, so a fan-out leaves one log for a program to
reduce:

```json
{"precursor":"summarize","ws":"data/parts/7","answer":"data/out.json",
 "stopReason":"soft:rounds","continuation":null,"rounds":6,"cost":0.021,
 "elapsedMs":41230}
```

Put the instructions in the precursor and each part's material in its prompt file; one
precursor then serves every part.

**A sub-agent's world is its directory.** It cannot see its parent, its siblings,
or anything outside. So put everything it needs inside before starting — and give
`--answer` a path it can write, under its own `data/`. A cell cannot spawn. To run two
levels, flatten them into one.

## Plugins

What the runtime does not need ships separately, as a package named `spore-plugin-<name>`
installed where spore is, and a spore uses it once the machine has enabled it and its
definition names it:

```
npm i -g @rhizogrip/spore-plugin-browser
spore plugin allow browser cdp=9222
# in spore.cmk:  plugins: [browser]
```

A plugin can give programs and the variables that configure them, a reference the agent
reads at `plugins/<name>.md`, and precursors copied into `precursors/`. `spore plugin ls`
lists what is installed and what is wrong with each; `spore plugin show <name>` says what one
gives. The core ships no precursors; a plugin carries them.

## Confinement

Three layers:

- **`safe-path.js`** — canonical containment, gates the tools
- **Landlock** on the process — kernel-enforced filesystem confinement
- **`confine`** — applies Landlock and a syscall filter *then* execs, which is what makes `exec`
  read-only. Every turn, job, router and prepare step also starts through it in user, PID and mount namespaces of
  its own, so it sees only its own processes

Landlock does not gate unix-socket connect.

`--unsafe` skips it, and the namespaces with it: the turn runs with no confinement at all.

**A host that cannot give a turn its own namespaces runs no turn**, and says why. A default
Ubuntu 24.04 restricts unprivileged user namespaces, and Docker's default profiles refuse them.
Either allow them for spore's `confine` — an AppArmor profile for it on Ubuntu; in Docker,
`--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt
systempaths=unconfined` for the spore container, whose syscalls spore filters itself — or, when
no one else's spores run as your user, turn it off: `spore config set contain off`. `spore doctor`
says which applies.

**The network is open.** spore confines files and credentials, not network access:
an agent fetches pages, calls APIs, clones and installs with `curl`, `git` and `npm`, and the
runtime has no proxy and no list of allowed hosts. So an agent can send anything it can read
to anywhere. What bounds that is what it was given to read, and that it holds none of your
keys. A deployment that needs egress restricted does it on the host — a firewall rule for the
user its spores run as, a network namespace, a container — and lets the model providers and
your sources through, since the runner reaches them as that same user.

**Agent workspaces must live outside `/tmp` and outside the spore checkout.** `spore` and
`spawn` both refuse.

## Credentials

`spore` is two processes. The outer one reads the workspace, takes the lock, holds
the provider keys and hosts a **model broker**; the inner one is the agent and
holds neither — it reaches a model through a socket.

The runner counts every model call, out of the agent's reach, so `cost` in `spore.cmk` is one
limit for the whole tree — the agent's own calls and every sub-agent's, against
one number the agent cannot rewrite. Once the tree's settled spend reaches it, the broker refuses
every new model call; model calls already running finish and are paid, so a turn can end past it by
what was in flight. What a call costs is mohdel's catalog price for its model. A model the catalog
has no price for runs, and its calls count as $0, so `cost` never stops them;
`spore doctor` names each such model a spore uses, with the `mo` command that fills its prices, and
each model not ready to call at all.

A sub-agent's environment is built up by name rather than inherited: `PATH`,
`HOME`, `MODEL`, the socket, and no provider key at all, nor any source's: a source is the
runner's to call, and the agent is told only its name. A source's header may carry the calling
spore's name as `{name}`, which the runner fills and the agent can neither see nor set, so one
credential can serve many spores (docs/operating.md §Sources).

`memory: vectors` keeps long-term memory in a vector store the same way: the runner reads
`~/.config/spore/memory.json` — the store's `url`, `headers` with `${VAR}` filled from its own
environment, and, for a store whose API differs from the protocol's defaults, `paths` and
`collectionField` — and the agent reaches it only through the store socket
(ARCHITECTURE §The vector store protocol).

## Environment

| variable | |
|---|---|
| `MODEL` | what a spawned cell inherits when its precursor names no `model:` |
| `SPORE_CELL_MODELS` | set by the runner: the spore's `cell-models`, which a precursor's `model:` is read against |
| `<PROVIDER>_API_SK` | provider key, read by the runner as `mo` reads it, else from `~/.config/mohdel/environment` — never seen by the agent |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | enables span export; everything is a no-op without it |
| `LOG_FORMAT` | `json` forces structured logs; otherwise a tty gets the pretty one |
| `<BOT>_BOT_TOKEN` | the Telegram plugin's: a bot's token, named by its `telegram/<bot>.json`; never passed to a spore |

`TRACEPARENT`, `SPORE_CELL`, `SPORE_PLAN`, `SPORE_ENZYMES` and every `SPORE_*_SOCKET`
are internal: the runtime sets them for the processes it starts. So are `SPORE_SPAWN`,
`SPORE_FANOUT`, `SPORE_RECALL`, `SPORE_SOURCE` and `SPORE_ENZYME`, which name the programs an agent runs.

## The HTTP API

`spore-api` serves the library's verbs over HTTP, on a unix socket or a loopback port, to a caller
in a container or on another machine. Running it and writing its `api.json` are in
[docs/operating.md](https://github.com/RHIZOGRIP/spore/blob/main/docs/operating.md#the-http-api-service); calling it is in
[INTEGRATION.md](https://github.com/RHIZOGRIP/spore/blob/main/INTEGRATION.md#the-http-api).

## Library

A program on the spores' host can call the functions the command is made of: the same rules and
the same refusals, as typed errors rather than an exit code and prose. Follow a message from the
event after the last one there was:

```js
import { lastEventSeq, send, watch, workspaceFor } from '@rhizogrip/spore'

const ws = workspaceFor('triage').path
const seq = lastEventSeq(ws)
send(ws, 'summarize the open tickets', { requestId: 'job-41' })
for await (const event of watch(ws, { after: seq })) {
  if (event.event === 'stream' && event.kind === 'message') process.stdout.write(event.delta)
}
```

Every export, following many spores at once, delivering answers elsewhere, `runBatch` and what is
not exported are in [INTEGRATION.md §The library](https://github.com/RHIZOGRIP/spore/blob/main/INTEGRATION.md#the-library).

## A terminal

```bash
spore tui [<name>]      # one spore per screen; without a name, the last one opened
spore here [<dir>]      # the spore that works in that directory, in place
```

One spore per screen: its conversation, the running turn as it goes, a status line with its
model, state and limits, and a line to talk to it. Enter sends: to an idle spore it starts a
turn, to a running one it lands between its rounds.
Esc twice stops the running turn, Ctrl+P opens another spore, and the status line says when
another one answers or asks. `/` lists the commands; every key is in
[the screen's README](https://github.com/RHIZOGRIP/spore/blob/main/packages/spore-cli/tui/README.md).

It uses only the library's exports (`send`, `watchAll`, `list`, `show`, `stop`), so its source is
a worked example of driving a spore from code. An application
embeds the same screen with `runTui`
([INTEGRATION.md](https://github.com/RHIZOGRIP/spore/blob/main/INTEGRATION.md#a-terminal-for-your-application)).

## Testing

```bash
npm test          # vitest over test/
npx vitest run test/exec-readonly.test.js
```

## See also

- [ARCHITECTURE.md](https://github.com/RHIZOGRIP/spore/blob/main/ARCHITECTURE.md) — the call contract, confinement, spawn, the
  model broker, memory, tracing
- [conformance/README.md](conformance/README.md) — whether a model can drive this runtime,
  and what five of them did with it
- [`mohdel`](https://www.npmjs.com/package/mohdel) — the provider layer underneath
