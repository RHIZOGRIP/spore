# The `spore` command

Every verb of `spore`: what it does, what it takes and what it refuses. `spore` alone prints the
list, and `spore --help` the list with its common options.

Why each behaves as it does is in [ARCHITECTURE.md](../ARCHITECTURE.md). Driving the command from
a program (`--json`, `--request-id`, resuming from an event) is in
[INTEGRATION.md §The command](../INTEGRATION.md#the-command). The host's files and settings are in
[operating.md](operating.md), and the fields of a `.cmk` in [definition.md](definition.md).

## What every verb shares

- **`<name>`** is a spore in your home, or a path to one. `.` is the spore you are standing in,
  and `show`, `log` and `sql` take it when no name is given.
- **The message** of `send` is the words after the name, or stdin when there are none. `--` ends
  the options, for a message that starts with `-`.
- **`--json`** prints the result as JSON, with the same exit code. For `send` and `attach` it
  prints the turn's events, one JSON object a line.
- **`--debug`** logs verbosely on stderr.
- A verb refuses an option or a word it does not take, and exits 2. A refusal prints
  `spore: <message> — <detail>` on stderr.
- On a machine where `spore setup` made a Linux VM, every verb runs in it, with the same
  arguments, terminal and exit status. `spore vm start` and `spore vm stop` start and stop the
  VM, and nothing else starts it.

## Exit codes

`send`, `attach` and a `fork` at a call follow a turn, and exit by how it ended:

| exit | |
|---|---|
| 0 | the turn concluded: an answer, a question, or `quiet` |
| 1 | the turn ended without concluding: a hard limit, `cancelled`, an error |
| 2 | the command refused |
| 3 | you walked away with Ctrl-C; the turn is still running, and `spore attach` picks it up |
| 4 | the turn answered at a soft limit; its answer says what remains |

`stop`, `wrap`, `extend`, `annotate` and `job stop` exit 0 once done and 1 when nothing is
running. The full table, with `--json` and a repeated request id, is in
[INTEGRATION.md §Exit codes](../INTEGRATION.md#exit-codes).

## Making and changing a spore

### `spore setup`

```bash
spore setup            # the first run: this machine, your models, a first spore
spore setup model      # pick a recommended model for new spores
```

Checks the machine, asks where spores live, connects a provider through `mo onboard`, sets the
model new spores run on, offers the tick timer, runs `spore doctor` and makes a first spore,
`main`. Each step reads what is there first, so a second run asks nothing already answered and is
a check.

### `spore define`

```bash
spore define <name>
spore define <name> --model <m> --plugin <p>
spore define <name> --sporangium <s>
spore define <name> --definition <file.cmk>
spore define <new> --from <old>
```

Says what a spore is, and makes its workspace. `spore send` never makes one.

- With nothing else, the spore is made from your default sporangium.
- `--sporangium <s>` makes it from the default sporangium with `<s>` laid over it, file by file.
  A sporangium is the package's, then yours in `~/.config/spore/sporangia/<s>/`.
- `--model` and `--plugin` fill those into the `spore.cmk` of a new spore.
- `--definition <file>` makes it from that `.cmk`. Given for a spore that exists, it revises it:
  `spore.cmk` is replaced, and the conversation and `data/` are kept. The revision takes effect at
  the next turn.
- `--from <old>` cuts it from another spore ([below](#cloning-a-spore-spore-define---from)).

Without `--definition`, defining a spore that exists changes nothing and says so.

Refused:

- `--definition`, `--sporangium` and `--from` together (`DEFINE_AMBIGUOUS`);
- `--model`, `--plugin`, `--sporangium` or a `writes` grant for a spore that exists
  (`DEFINE_FILLS_ONLY_NEW`): change it with `spore edit`;
- a definition that does not parse, which leaves the one in place untouched;
- a `writes` grant the runner would refuse at every turn (`WRITES_REFUSED`);
- a workspace inside a path the sandbox grants;
- the first `define` on a machine whose default sporangium names no model: it copies the default
  sporangium to `~/.config/spore/sporangia/default/` and says to set one, with
  `spore config set model <provider>/<name>`.

### `spore edit`

```bash
spore edit <name>
```

Opens a copy of `spore.cmk` in `$VISUAL` or `$EDITOR`, and replaces `spore.cmk` with it once it
parses. One that does not parse is offered back with the parser's error. One left unchanged
replaces nothing. If `spore.cmk` changed meanwhile, it is left alone and the copy is kept
(`EDIT_CONFLICT`). The command says what changed; a running turn takes it from the next one.

### `spore model`

```bash
spore model [<name>]            # what it runs on and may switch to
spore model <name> <model>      # switch, from the next turn
```

A spore switches only to a model its `models` lists
([definition.md §Identity and model](definition.md#identity-and-model)).

### `spore remake`

```bash
spore remake <name>
```

Makes the spore again, in place, from the sporangium it was made from. It keeps `spore.cmk` as
edited, `data/`, `home/`, `precursors/` and `schedules/`. The database, the trail and the inbox
are set aside in `<name>.before-remake` beside it, until you remove that. Refused while the spore
runs. It is how a spore whose database another development version made is brought back.

### `spore upgrade`

```bash
spore upgrade <name>
spore upgrade --all
```

Replaces the spore's root documents with the installed ones
([operating.md §Root documents](operating.md#root-documents-and-spore-upgrade)).

### `spore rm`

```bash
spore rm <name> [--yes]
```

Deletes the workspace. Refused:

- a directory with no `spore.cmk`, or a path the sandbox grants, the checkout included;
- a running spore: stop it first;
- a spore that has finished a turn, without `--yes`. A turn is history: its conversation, its
  records and what it made.

Nothing outside the workspace is told. A chat route that still names the spore is the chat
service's to report.

### `spore here`

```bash
spore here [<dir>] [--sporangium <s>] [--model <m>] [--no-git]
```

Opens the spore that works in `<dir>` (the current directory by default), made the first time as
`<directory>-<6 hex>` in `home`, granted `writes: [here=<dir>]`. On a terminal a picker offers the
sporangia with their descriptions, under a header saying what is granted and the git state;
without a terminal `--sporangium` is required. Opened again, it refuses `--sporangium` and
`--model`: change it with `spore edit`.

Outside a git work tree it is refused unless `--no-git`, and then nothing can be undone. Each
session starts with a snapshot of the directory, tracked and untracked files, as a ref under
`refs/spore/<spore>/` in that repository; the newest three are kept. In the screen, `/diff` shows
what changed since the snapshot, through git's pager, and `/undo` restores what changed or went
and removes what was made, ignored files apart. Neither tells the spore's changes from yours.

## Talking to a spore

### `spore send`

```bash
spore send <name> <message>
spore send <name> <message> --attach <file>       # repeatable
spore send <name> <message> --request-id <id>
```

Starts a turn, or lands in the one running, where the agent reads it between rounds. The command
then follows the turn and prints the answer on stdout. Ctrl-C leaves the turn running.

- A message to a spore that stopped on a question is the answer to that question.
- `spore send <name> stop` asks the agent to wrap up with what it has. Nothing reads a message
  for a keyword: the agent decides what it means.
- `--attach` sends a file with the message; the agent reads it where it lands.
- `--request-id` makes the message taken once: sent again under the same id, the command follows
  or reports the turn that read the first.

Refused: a name that is no spore.

### `spore attach`

```bash
spore attach <name> [-n <lines>]
spore attach <name> --json --after <seq>
```

Follows the turn that is running, and exits as it ends. With no turn running, it prints the last
50 lines of the last one; `-n` sets how many.

### `spore stop`

```bash
spore stop <name>
```

Ends the running turn mid-round; it is recorded as `cancelled`. A model call already running
finishes and is billed to the turn. The next turn is told not to take the work up again, and what
the stopper had queued is set aside.

### `spore wrap` and `spore extend`

```bash
spore wrap <name> [10m]
spore extend <name> wall 30m
spore extend <name> cost 1.50
spore extend <name> rounds 20
```

`wrap` asks the running turn to wrap up as it would at its soft wall, now or in a while. A wrap
later than the turn already wraps is refused.

`extend` raises the soft and hard limit of one dimension together, up to the ceiling the
definition names in `extend.<limit>`. Past the ceiling it is refused, saying how much room is
left; a definition with no ceiling allows no extension.

Both are refused when nothing is running.

### `spore annotate`

```bash
spore annotate <name> <line>
spore annotate <name> --clear
```

Shows a line of yours under the running turn's header, wherever the turn is shown, until
`--clear` or the turn's end.

### `spore flush`

```bash
spore flush <name>
```

Starts the conversation over, between turns. The next turn replays none of what was said before,
only a note of who flushed it and what is still open. Nothing is forgotten: the transcript,
`data/` and recall keep all of it.

### `spore tui`

```bash
spore tui [<name>]
```

One spore per screen: its conversation, the running turn as it goes, a status line and a line to
talk to it. Without a name it opens the last one opened. The keys and commands are in
[the screen's README](../packages/spore-cli/tui/README.md).

## Reading a spore

These verbs run on the host, read the workspace's files and start nothing.

| verb | prints |
|---|---|
| `spore ls [<dir>]` | your spores and their state; `<dir>` lists the spores in that directory |
| `spore show [<name>]` | one spore in detail: what it is doing, what it is, what it has done, what is waiting |
| `spore log [<name>]` | one line per turn: when it ended, how, what it cost, and what was said to start it; then what is waiting |
| `spore sql [<name>]` | the views of its records: `turns`, `inbox`, `transcript`, `events`, `calls` |
| `spore sql <name> '<query>'` | a read-only query over those views; `-` reads the query from stdin |
| `spore usage [<name>]` | what it spent per day over the last 7, then by origin, model, outcome and precursor |

`spore log` does not print answers: they are in the transcript.

`spore usage` takes `--days <n>`, or `--since <date> [--until <date>]`, `--tz <zone>`, and
`--by day|spore|origin|model|outcome|precursor` for one breakdown. Without a name it covers every
spore `spore ls` finds. Money is what the provider settled, never an estimate.

## Copying a spore

### Forking a spore: `spore fork`

```bash
spore fork <name> <new> [--definition <file>]
spore fork <name> --at turn:<n> <new> [--definition <file>]
spore fork <name> --at <call> <new> [--definition <file>] [--replay]
```

Without `--at`, makes `<new>`, a name or a path, as `<name>` stands after its last turn: the
conversation and the turn records, the calls they made, the messages they read, and `data/` —
`data/memory/` included — `precursors/` and `home/` as they are. `--at turn:<n>` makes it as it
stood when turn n ended, its files as they were then. Nothing starts, and the command exits 0: the
copy's next message starts its first turn, which carries the conversation on as `<name>`'s next
turn would have. Its `schedules/` stay behind, so the clock does not wake two spores for one
schedule; write the copy its own. Messages not yet read, running jobs and answers waiting to be
posted stay behind too, and a connector reaches the copy only once its bot file names it. Its
`spore.cmk` is `<name>`'s, so it reads and writes the same directories `reads:` and `writes:` name.

With `--at <call>`, makes `<new>` as `<name>` stood when the round of `<call>` came back, and
carries the turn on from there; the command follows it like `send`, with the same exit codes.
`<call>` is a call of the run's last turn, as `--at 0003`, or of another turn, as
`--at <runId>/0003`. `--replay` cuts before the round's results, so its calls run again under the
runtime as it is now.

`--definition` runs the fork under another `spore.cmk`.

Refused (`FORK_REFUSED`): a spore running — between turns, one whose last turn is still being
written down too — a `<new>` that exists, a definition that does not parse, a spore that has
finished no turn (`spore define <new> --from <name>` copies what it can do), a turn or a call that
is not there, a file in `data/`, `calls/`, `precursors/` or `home/` changed after an earlier cut —
cut later — `--replay` without a call, and a `--replay` of a round that called `ask`. A fork at a
call spends like any turn; one between turns spends nothing until its next message.

`scripts/try-definitions.js` in the package forks one cut many times under each definition and
says how often each delivered a file under `data/out/`, and how its turns ended:

```bash
node scripts/try-definitions.js --run <workspace> --at <call> --into <dir> [--times 20] [--at-once 4] [--replay] [other.cmk …]
```

### Cloning a spore: `spore define --from`

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

The clone is not told it is one: the command reports the cut to you, not to the agent.

## The host

These verbs look after the machine and what all your spores share. Each is described with the
file or the service it works on.

| verb | what it does | described in |
|---|---|---|
| `spore config get\|set\|add\|rm\|path` | where workspaces live, and what your spores may use | [operating.md §`config.json`](operating.md#configjson) |
| `spore doctor [--report]` | what is wrong on this machine, and the command that fixes each | [operating.md §Models on the host](operating.md#models-on-the-host) |
| `spore plugin ls\|show\|allow\|disallow` | the plugins installed beside spore, and which are allowed | [operating.md §Plugins on the host](operating.md#plugins-on-the-host) |
| `spore service ls\|define\|start\|stop\|restart\|enable\|disable\|show\|log\|rm` | the services spore ships and its plugins offer, as systemd user units | [operating.md §Services spore ships](operating.md#services-spore-ships) |
| `spore hook ls\|show` | the hooks in `hooks.json`, and what each said to its spores | [operating.md §Webhooks](operating.md#webhooks-hooksjson) |
| `spore schedule set\|rm\|ls` | a spore's schedules, checked before they are installed | [definition.md §A schedule](definition.md#a-schedule) |
| `spore tick` | fires every schedule that is due; run by a timer | [definition.md §A schedule](definition.md#a-schedule) |
| `spore job ls\|stop` | a spore's jobs, running and ended | [operating.md §Jobs](operating.md#jobs-jobs-and-spore-job) |
| `spore pause [why]`, `spore unpause` | stops every turn and job of your spores and starts none, until unpaused | [operating.md §Pausing every spore](operating.md#pausing-every-spore) |
| `spore approval ask\|ls` | asks people to choose, and lists how each approval ended | [INTEGRATION.md §Asking a person to approve](../INTEGRATION.md#asking-a-person-to-approve) |
| `spore interaction outcome` | an interaction's outcome, from a handler on this host | [interactions.md](interactions.md) |
| `spore vm start\|stop` | the Linux VM spore runs in, where `spore setup` made one | [above](#what-every-verb-shares) |
