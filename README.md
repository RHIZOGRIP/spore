# spore

spore is a runtime for AI agents that you run on your own machines and build products on. An
agent — a *spore* — is a folder and a short text file that says what it is: its model, its tools,
its limits, what it may read and write. Your program sends it a message and follows what it does.
spore runs it in a sandbox the Linux kernel enforces, holds the API keys it never sees, stops it at
the limits you set, and keeps a record of everything it did.

## Why spore

- **An agent is a file, not code.** A spore is declared in a short `.cmk` file, checked strictly.
  Your program — or another agent — creates one by writing it, and a person reads, reviews and
  versions it like any text ([docs/definition.md](docs/definition.md)).
- **Made to sit behind a product.** Send a message, follow what happens, read the answer: from the
  `spore` command, the Node library or an HTTP API. A request id makes a retry safe, a trace id
  follows the message all the way to the model call, and a turn outlives the program that started
  it. One spore per customer, per ticket or per conversation is the usual shape
  ([INTEGRATION.md](INTEGRATION.md)).
- **Safe to run for other people.** Each turn is confined by the kernel and runs in namespaces of
  its own. It writes only the folders it was given, provider keys stay out of its reach, and spend
  stops at a per-turn limit and at a daily or monthly limit across all spores
  ([SECURITY.md](SECURITY.md)).
- **No server to run.** A spore is its folder: no daemon, no database server, no queue. Nothing
  runs while nothing is asked, so a million idle spores cost only the disk they take.
- **Works unattended.** A spore can be woken by a schedule, a webhook or the end of a long job it
  started, and can answer in Telegram or Discord.
- **Splits big work.** A spore writes a small specialist for one narrow job and runs fifty of them
  at once, each confined to a folder of its own, within one budget.
- **Any model.** Claude, GPT, Gemini, open models through OpenRouter, or a ChatGPT plan — anything
  [mohdel](https://www.npmjs.com/package/mohdel) supports, chosen per spore.

## Build on it

From Node, on the machine where the spores live:

```js
import { lastEventSeq, loadEnvironment, send, watch, workspaceFor } from '@rhizogrip/spore'

loadEnvironment()
const ws = workspaceFor('support-eu').path
const after = lastEventSeq(ws)
send(ws, 'Where is order 4471?', { requestId: 'ticket-4471' })
for await (const event of watch(ws, { after })) {
  if (event.event === 'complete') console.log(event.output)
}
```

From any language, through the HTTP API (`spore-api`, on a unix socket or a loopback port):

```bash
curl --unix-socket /run/spore/api.sock -H "Authorization: Bearer $TOKEN" \
  -d '{"text": "Where is order 4471?", "requestId": "ticket-4471"}' \
  http://spore/v1/spores/support-eu/messages
curl --unix-socket /run/spore/api.sock -H "Authorization: Bearer $TOKEN" \
  "http://spore/v1/spores/support-eu/events?after=0"
```

Or from a shell script: `spore send support-eu "…" --json` prints the turn's events and its
result, with an exit code that says how it ended. [INTEGRATION.md](INTEGRATION.md) covers all
three.

## Try it in a project

```bash
npm install -g @rhizogrip/spore-cli
spore setup          # checks this machine, sets up a model, makes a first spore
cd ~/code/my-app     # any git repository
spore here
```

`spore setup` walks you through the first run: it checks the machine, helps you connect a model —
a ChatGPT plan, OpenRouter, or another provider — and sets what new spores run on.

`spore here` opens a spore that works in the directory you are in. The first time, you pick what
kind of spore it is:

| | |
|---|---|
| `code` | software work: reads the code base, changes it in place, runs its tests and builds |
| `reviewer` | code review: reads a change or a repository and says what is wrong, and why |
| `security` | security review: finds vulnerabilities and says how to fix them |
| `commit` | writes the commit message for what is staged |
| `default` | general work: answers, files and shell commands |
| `perennial` | long-lived general work: remembers what it learns, follows up on its own, tidies itself while idle |

Then a terminal screen opens and you talk to it. It reads the project, edits files where they
are, and runs commands. Your message reaches it even while it works, between its steps. Close the
screen and come back later: `spore here` in the same directory opens the same spore, with the
conversation where you left it.

**Git is the undo.** Each session starts with a snapshot of the directory as it stands, untracked
files included, kept under its own git ref so your branch and staging area do not move. In the
screen:

```
/diff     what changed since this session opened, in git's pager
/undo     put the directory back as this session found it, after showing what that changes
```

`/diff` shows your own changes too, since the spore and you share the directory. Ignored files are
left alone either way. Outside a git repository `spore here` refuses, unless you pass `--no-git`
and accept that nothing can be undone.

## What it can and cannot do

- **It writes only where you let it**: the directory `spore here` gave it, and its own workspace.
  The commands it runs to look around cannot write at all. Besides those, it reads only the
  system's programs and libraries. The Linux kernel enforces this — not the agent's good will.
- **It can reach the internet**, as any program you run can. Restrict that on the machine if you
  need to.
- **It never holds your keys.** Calls to the model go through a part of spore it cannot reach,
  which holds the key and counts every cent.
- **It stops at its limits**: rounds, money and time for each turn, and if you set one, a daily
  or monthly limit on all your spores together.
- **Everything it did is on record**, in its workspace, and it cannot rewrite that record.

The details are in [SECURITY.md](SECURITY.md).

## What you need

- **Linux** (x64), kernel 5.13 or newer with Landlock enabled; 6.12 or newer is best. On macOS or
  Windows, run it in a Linux VM.
- **Unprivileged user namespaces**, so each turn runs shut off from your other processes. Most
  distributions allow them; Ubuntu restricts them through AppArmor, and `spore doctor` says how to
  allow them, or how to run without.
- **Node 24 or newer**, with a bundled SQLite of 3.51.3 or newer.
- **A model**: a ChatGPT plan, an OpenRouter key, or a key for any provider
  [mohdel](https://www.npmjs.com/package/mohdel) supports. `spore setup` connects one.

`spore doctor` says what is missing on a machine and how to fix it.

## Documentation

| | |
|---|---|
| [packages/spore/README.md](packages/spore/README.md) | the `spore` command, every verb |
| [PRINCIPLES.md](PRINCIPLES.md) | what spore promises, in plain words |
| [docs/definition.md](docs/definition.md) | the `.cmk` file that describes a spore or a helper |
| [INTEGRATION.md](INTEGRATION.md) | driving spores from a program: the command, the library, the HTTP API |
| [docs/library.md](docs/library.md) | every function of the library |
| [docs/operating.md](docs/operating.md) | running spore on a machine: configuration, limits, services |
| [docs/plugins.md](docs/plugins.md) | writing a plugin |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how it is built |
| [SECURITY.md](SECURITY.md) | what confines an agent, and how to report a problem |

## Packages

| package | | |
|---|---|---|
| [`@rhizogrip/spore`](packages/spore) | the runtime and the library | [README](packages/spore/README.md) |
| [`@rhizogrip/spore-cli`](packages/spore-cli) | the `spore` command and its terminal | [README](packages/spore-cli/README.md) |
| [`@rhizogrip/spore-plugin-brave`](plugins/brave) | web search, its key held by the runner | [README](plugins/brave/README.md) |
| [`@rhizogrip/spore-plugin-browser`](plugins/browser) | a browser for spores, over CDP | [README](plugins/browser/README.md) |
| [`@rhizogrip/spore-plugin-discord`](plugins/discord) | people and spores in one Discord channel, as a service | [README](plugins/discord/README.md) |
| [`@rhizogrip/spore-plugin-documents`](plugins/documents) | xlsx, docx, pptx, odt and PDF, for the programs an agent writes | [README](plugins/documents/README.md) |
| [`@rhizogrip/spore-plugin-images`](plugins/images) | `sharp`, for the programs an agent writes | [README](plugins/images/README.md) |
| [`@rhizogrip/spore-plugin-mcp`](plugins/mcp) | MCP servers' tools, as a program the agent runs | [README](plugins/mcp/README.md) |
| [`@rhizogrip/spore-plugin-sluice`](plugins/sluice) | host commands for spores, as a sluice broker's rules allow them | [README](plugins/sluice/README.md) |
| [`@rhizogrip/spore-plugin-ssh`](plugins/ssh) | SSH keys spores can use and never read | [README](plugins/ssh/README.md) |
| [`@rhizogrip/spore-plugin-teams`](plugins/teams) | your spores in Microsoft Teams personal chats and channels, as a service | [README](plugins/teams/README.md) |
| [`@rhizogrip/spore-plugin-telegram`](plugins/telegram) | your spores in Telegram chats, as a service | [README](plugins/telegram/README.md) |

## Working in this repository

npm workspaces, and one Cargo workspace for the Rust the runtime is built on (`rust/`).

```bash
npm install          # every workspace; builds the core's native code
npm test             # every package's suite
npm run test:rust    # the crates' own tests
```

Linux x64, Node 24 or newer, a C compiler and cargo.

## License

Apache-2.0 — [LICENSE](LICENSE).
