# The definition format

A `.cmk` file declares an agent. There are three kinds:

| file | what it declares |
|---|---|
| `spore.cmk`, at the workspace root | the spore: its identity, model, tools, limits and grants |
| `precursors/<name>.cmk` | a precursor, what a cell is made from when the spore spawns one |
| `schedules/<name>.cmk` | a schedule, a message the clock says to the spore |

The spore and a precursor share one grammar and one list of fields. Some fields are accepted
at one level and refused at the other. A schedule uses the same grammar with three fields of its
own (§[A schedule](#a-schedule)).

The parser is `rust/definition` (`src/lib.rs`, `src/schedule.rs`). The JavaScript runtime and the
Rust runner both call it, so one file always means one thing. Why the format is shaped this way is
in [ARCHITECTURE §Precursors](../ARCHITECTURE.md#format) and
[PRINCIPLES.md](../PRINCIPLES.md). This page states the rules.

A definition is parsed when it is written by `spore define --definition` or `spore edit`, when a
turn starts, when a precursor is listed or spawned, and wherever a plugin carrying precursors is
checked: when it is allowed, listed or shown, and at each turn start of a spore using it. `spore edit` installs a `spore.cmk` only once it parses. `spore schedule set` checks a
schedule before installing it, and `write` and `edit` check one the agent writes.

## The file

```
---
name: summarize
tools: [read]
rounds: [5, 7]
cost: [0.10, 0.15]
wall: [2m, 3m]
on-wrap: discard
---

You reduce a document to its essentials.
```

The file opens with a `---` line as its first bytes. The frontmatter follows, then another `---`
line, then the body. A file not opening this way is refused: *must open with a --- frontmatter
block*.

### Frontmatter

Each non-blank line is `key: value`. The line is split at its first colon, so a value may contain
colons (`when: at 2026-10-01T09:00:00+02:00`). Both key and value are trimmed. A line with no colon
is refused.

A value has one of two forms:

- **`key: [a, b]`, a list.** A value beginning with `[` must end with `]`. Items are split on
  commas and trimmed, and empty items are dropped, so `[]` is the empty list. There is no quoting
  or escaping, so an item cannot contain a comma.
- **`key: scalar`, anything else**, taken as written. Quotes are part of the value.

The grammar has nothing else: no nesting, no multi-line values, no defaults.

- **Comments.** A line whose first non-blank character is `#` is skipped. Only whole lines are
  comments. Text after a value belongs to the value, so `tools: [read]  # note` is refused as
  *list is not closed*.
- **A key written twice** is refused.
- **An unknown field** is refused, and the message lists every field. A dotted key `a.b` that is
  not one of the named fields is read as [`<enzyme>.with`](#enzymewith) when `a` is an enzyme
  the file grants. Otherwise it is read as [`<source>.<param>`](#sourceparam), and refused when
  `a` is not a source the file grants.
- **A list field written as a scalar** is refused (*"tools" must be a list, as tools: [a, b]*).
  This applies to `tools`, `enzymes`, `reads`, `writes`, `sources`, `plugins`, `models`,
  `cell-models` and `jobs.writes`. An empty `tools:` is a scalar. Write `tools: []`, or leave the
  line out.
- **A single-value field written as a list** is refused (*"retain" takes one value, not a list*).

### How values are read

| kind | syntax | used by |
|---|---|---|
| count | digits only: `40` | `rounds`, `extend.rounds` |
| amount | dollars as `<digits>` or `<digits>.<digits>`: `0.50`, `5`, `5.00`. Not `.5`, not `$0.50` | `cost`, `extend.cost` |
| duration | digits and one unit, `s`, `m` or `h`: `90s`, `10m`, `3h`. No days, fractions or combinations (`1h30m` is refused; write `90m`). A bare number is not a duration | `wall`, `extend.wall`, `schedules`, `jobs`, `jobs.maxWait`, a schedule's `late` |
| size | digits and an optional unit, `B`, `KB`, `MB` or `GB` in any case: `10MB`, `512kb`. Units are 1024-based, and a bare number is bytes | `images` |
| whole number | digits only, at least 1: `64000` — not `64k`, `6.4e4`, `+5` or `2.0` | `retain`, `history`, `push`, `pull`, the counts of `images`, `schedules` and `jobs`, `jobs.perDay` |
| name | a letter, then letters, digits, `-` and `_` | enzymes, `reads` and `writes` names, sources and their parameters, `cell-models` names, a precursor's `model` |
| model id | `<provider>/<name>` with no whitespace: `anthropic/claude-sonnet-5-5` | `model`, `models`, `cell-models`, `embedding` |

### Body

The body is the agent's **identity**: the whole of what the agent is told it is, written as
instruction rather than as a description of one. It is trimmed, and an empty identity is refused.
For a schedule, the body is the message instead (§[A schedule](#a-schedule)).

Two kinds of line in a `spore.cmk` or precursor body are block markers rather than text:
`:::enzyme <name>` opens a block, and `:::` alone on a line closes it. Blocks describe enzymes
(§[`:::enzyme` blocks](#enzyme-blocks)) and are cut out of the identity. A `spore.cmk` grants no
enzymes, so a block there is refused, and so is a `:::` line with no block open. Lines may end in LF or
CRLF.

## Every field

**spore.cmk** and **precursor** say whether the field is *required*, *optional* or *refused* at
that level. **Absent** says what leaving the field out means where it is accepted.

| field | value | spore.cmk | precursor | absent | meaning | mechanism |
|---|---|---|---|---|---|---|
| [`name`](#name) | scalar | required | required | — | the definition's name; a precursor's is its file name | [Format](../ARCHITECTURE.md#format) |
| [`description`](#description) | scalar | optional | optional | none | one line for a person; never told to the model | — |
| [`model`](#model) | model id / name | required¹ | optional | precursor: the spore's model | spore: what it runs on; precursor: a `cell-models` name | [Defining a spore](../ARCHITECTURE.md#defining-a-spore) |
| [`models`](#models) | list of model ids | optional | refused | only `model` | what a person may switch the spore to | [How a precursor actually runs](../ARCHITECTURE.md#how-a-precursor-actually-runs) |
| [`cell-models`](#cell-models) | list of `name=id` | optional | refused | cells run on the spore's model | the names a precursor's `model` may give | [How a precursor actually runs](../ARCHITECTURE.md#how-a-precursor-actually-runs) |
| [`tools`](#tools) | list | optional | optional | no tools | which of the seven built-ins are offered | [Grants, limits…](../ARCHITECTURE.md#grants-limits-and-how-a-turn-ends) |
| [`enzymes`](#enzymes) | list of `name=path` | refused | optional | none | programs of the spore a cell may run by name | [Format](../ARCHITECTURE.md#format) |
| [`<enzyme>.with`](#enzymewith) | list of paths | refused | optional | the program alone | files and directories an enzyme needs beside itself | [Format](../ARCHITECTURE.md#format) |
| [`rounds`](#rounds-cost-wall) | `[soft, hard]` counts | required | required | — | model rounds per turn | [Grants, limits…](../ARCHITECTURE.md#grants-limits-and-how-a-turn-ends) |
| [`cost`](#rounds-cost-wall) | `[soft, hard]` amounts | required | required | — | dollars per turn; the spore's covers its cells | [The model broker](../ARCHITECTURE.md#the-model-broker) |
| [`wall`](#rounds-cost-wall) | `[soft, hard]` durations | required | required | — | elapsed time per turn | [Grants, limits…](../ARCHITECTURE.md#grants-limits-and-how-a-turn-ends) |
| [`on-wrap`](#on-wrap) | `keep` or `discard` | refused | required | — | what a cell's wrapped answer is worth | [Format](../ARCHITECTURE.md#format) |
| [`extend.rounds`](#extend) | count | optional | refused | cannot be raised | ceiling for raising hard `rounds` mid-turn | [Changing a running turn's limits](../ARCHITECTURE.md#changing-a-running-turns-limits) |
| [`extend.cost`](#extend) | amount | optional | refused | cannot be raised | ceiling for raising hard `cost` mid-turn | same |
| [`extend.wall`](#extend) | duration | optional | refused | cannot be raised | ceiling for raising hard `wall` mid-turn | same |
| [`reads`](#reads) | list of `name=path` | optional | optional | none | corpora linked in, read-only | [Material it does not own](../ARCHITECTURE.md#material-it-does-not-own) |
| [`writes`](#writes) | list of `name=path` | optional | refused | none | directories linked in and changed in place | same |
| [`sources`](#sources) | list of names | optional | optional | none | endpoints called by name through the source broker | same |
| [`<source>.<param>`](#sourceparam) | list | optional | optional | parameter free | the values a source may be asked for | same |
| [`memory`](#memory) | `bm25` or `vectors` | optional | optional | no long-term memory | the recall backend | [Memory](../ARCHITECTURE.md#what-a-definition-declares) |
| [`push`](#push-and-pull) | whole number | with `memory` | with `memory` | — | chunks recalled unasked before each turn | same |
| [`pull`](#push-and-pull) | whole number | with `memory` | with `memory` | — | chunks `$SPORE_RECALL` retrieves | same |
| [`floor`](#floor) | number ≥ 0 | optional | optional | any score above zero | the score a hit must pass | same |
| [`embedding`](#embedding) | model id | with `vectors` | with `vectors` | — | the model that makes the vectors | same |
| [`retain`](#retain) | whole number | optional | refused | every turn's trail kept | turns of trail kept | [Retention](../ARCHITECTURE.md#retention) |
| [`history`](#history) | whole number | optional | refused | 256k tokens | tokens of earlier turns re-sent word for word | [Retention](../ARCHITECTURE.md#retention) |
| [`images`](#images) | `[count, size]` | optional | optional | cannot look at images | images `read` may show per turn | [Looking at a picture is a read](../ARCHITECTURE.md#looking-at-a-picture-is-a-read) |
| [`schedules`](#schedules) | `[count, interval]` | optional | refused | `schedules/` read-only to the agent | lets the agent write its own schedules, bounded | [Turns the clock starts](../ARCHITECTURE.md#turns-the-clock-starts) |
| [`jobs`](#jobs) | `[count, wall]` | optional | refused | no jobs | work a turn starts that outlives it | [Jobs](../ARCHITECTURE.md#jobs) |
| [`jobs.maxWait`](#jobsmaxwait) | duration | optional² | refused | delivered at once | longest a job's delivery may be held | [Deliveries nobody typed](../ARCHITECTURE.md#deliveries-nobody-typed) |
| [`jobs.perDay`](#jobsperday) | whole number | optional² | refused | 100 | triage cells a job's deliveries may start a day | same |
| [`jobs.writes`](#jobswrites) | list of `writes` names | optional² | refused | none | `writes` directories a job may write | [Jobs](../ARCHITECTURE.md#jobs) |
| [`plugins`](#plugins) | list of names | optional | refused | none | allowed plugins the spore uses | [Plugins](../ARCHITECTURE.md#plugins) |

¹ A sporangium's `spore.cmk`, the template spores are made from, may leave `model` out
(§[`model`](#model)).
² Only beside `jobs`. Declared without it, the file is refused.

## Identity and model

### `name`

```
name: summarize
```

Required at both levels: a non-empty scalar. A precursor's `name` must equal its file name
without `.cmk`. This is checked when the precursor is spawned and when a plugin carrying it is
allowed, and a mismatch is refused. A spore's `name` is free text; the spore itself is named by
its directory.

### `description`

```
description: Literature work over a local corpus and a search endpoint
```

Optional at both levels: one line, non-empty, for a person choosing among definitions. It is never
part of what the model is told. Written but empty, or written as a list, it is refused.

### `model`

In `spore.cmk`:

```
model: anthropic/claude-sonnet-5-5
```

In a precursor:

```
model: low
```

**In `spore.cmk`**, `model` is required: a single model id, `<provider>/<name>`, which is what the
spore runs on. Left out, the file is refused (*declares no model*). There is one exception. A
sporangium's `spore.cmk` is a template, not a spore, and may leave `model` out. A spore made from
it then runs on the model in the operator's default sporangium, which
`spore config set model <provider>/<name>` writes.

**In a precursor**, `model` is optional and is a **name** from the spore's
[`cell-models`](#cell-models), never a model id. It must be a name (letter first; letters,
digits, `-`, `_`), so `model: openai/gpt-6.1-sol` is refused. Left out, the cell runs on the
spore's model. When the spawn is planned, the name is resolved:

- If the spore declares `cell-models`, a name it does not have refuses the spawn.
- If the spore declares none, the name is ignored and the cell runs on the spore's model.

### `models`

```
models: [anthropic/claude-haiku-4-5]
```

`spore.cmk` only. These are the models a person may switch the spore to, beside `model`, through
`spore model` or `/model` in the terminal. Switching rewrites `model:` and keeps the model it
leaves in `models`. Each entry must be `<provider>/<name>` with no whitespace, and no entry may
appear twice.

### `cell-models`

```
cell-models: [low=anthropic/claude-haiku-4-5, strong=openai/gpt-6.1-sol]
```

`spore.cmk` only. Each entry is `<name>=<provider>/<model>`. The name follows the name rule and
the model must contain `/`. Names are unique. A precursor's `model:` gives one of these names.

The runner's model broker refuses a call to any model this file does not name, whether through
`model`, `models` or a `cell-models` value. Neither the agent nor a precursor it wrote can reach
another model ([How a precursor actually runs](../ARCHITECTURE.md#how-a-precursor-actually-runs)).
The `embedding` model is not held by this check.

## Tools and enzymes

### `tools`

```
tools: [read, write, edit, exec, wsexec, ask, quiet]
```

An allow-list over the seven built-in tools: `read`, `write`, `edit`, `exec`, `wsexec`, `ask`,
`quiet`. A tool not listed is not offered. Absent or `[]` means no tools, which suits a cell that
works from its prompt alone. Any other name is refused.

**A precursor may not grant `ask` or `quiet`.**

### `enzymes`

```
enzymes: [plot=data/tools/plot.py, data/tools/lint]
```

**Precursor only.** In `spore.cmk` it is refused. An enzyme is a program of the spore that a cell
may run by name. The cell never sees the program's path or file.

- **Entry form.** An entry is `name=path`, or a bare path named by its last segment. That segment
  must itself be a valid name, so a file with an extension needs `name=`: a bare
  `data/tools/plot.py` is refused because `plot.py` is not a name.
- **Names.** The name is what the cell calls, with `node "$SPORE_ENZYME" <name>`. Names are unique
  within the precursor, and a name may not also be one of the file's [`sources`](#sources).
- **Paths.** A path is relative to the spawning spore's workspace. When the spawn is planned, it
  must exist and be executable, or the spawn is refused.
- **Running them.** Granting enzymes requires `exec` or `wsexec` in `tools`.
- **Descriptions.** Every enzyme needs an [`:::enzyme` block](#enzyme-blocks) in the body.

When a cell starts, each enzyme is hashed, and a call is refused once the program changes
([Format](../ARCHITECTURE.md#format)).

### `:::enzyme` blocks

```
:::enzyme plot
plot — reads a CSV with a header row on stdin, writes a PNG on stdout.
Exit 0 on success; any other code means the CSV was malformed.
:::
```

A block describes one enzyme to the cell, and the description is all the cell is told about it.
Two precursors may grant one program under two names and frame it two ways.

- **Markers.** The opening line is `:::enzyme`, spaces or tabs, the enzyme's name, and nothing
  else. The closing line is `:::` alone. Trailing spaces or tabs are allowed on both.
- **Placement.** Blocks may sit anywhere in the body. They are removed from the identity, and
  their text is trimmed.
- **Matching blocks to grants.** Every enzyme in `enzymes` needs exactly one non-empty block, and
  every block must name an enzyme in `enzymes`.
- **Refused:** a block opened inside another, a block left open, a `:::` with nothing open, and a
  name described twice.

### `<enzyme>.with`

```
plot.with: [data/tools/palette.py, data/tools/templates/]
```

The files and directories an enzyme needs beside itself, such as a module it imports or a
template it reads. The key is an enzyme name from `enzymes` followed by `.with`. No other key
follows an enzyme's name: `plot.needs` is refused.

- **Value.** A non-empty list of paths, relative to the workspace like the enzyme's own path. A
  directory carries everything under it.
- **When the spawn is planned**, a listed path that does not exist refuses the spawn. The listed
  paths are hashed with the program.
- **Cloning.** `spore define --from` carries exactly the program and these paths
  ([Cutting a spore from another](../ARCHITECTURE.md#cutting-a-spore-from-another)).

## Limits

### `rounds`, `cost`, `wall`

```
rounds: [40, 45]
cost: [0.50, 0.75]
wall: [10m, 12m]
```

Required at both levels. Each is a two-item list `[soft, hard]`. Soft must be greater than zero,
and hard must be strictly greater than soft. A limit that is missing, a scalar, one item, three
items, unreadable or inverted is refused, and the message names it. There is no default in code
([principle 19](../PRINCIPLES.md#19-each-default-is-written-once)).

- **`rounds`**: two counts.
- **`cost`**: two amounts, in dollars.
- **`wall`**: two durations.

Crossing a **soft** limit tells the agent to answer with what it has and say what remains, and the
turn ends `soft:<dim>`. Crossing a **hard** limit stops the turn as `hard:<dim>` and writes a
continuation record ([README §How a turn ends](../packages/spore/README.md#how-a-turn-ends)).

`cost` at the spore level is one limit for the whole tree: the spore's own model calls and every
cell's. Once settled spend reaches the hard cost, the broker refuses new calls, and calls already
running finish and are paid. A precursor's `cost` sizes one cell
([Where the ceiling lives](../ARCHITECTURE.md#where-the-ceiling-lives)).

### `on-wrap`

```
on-wrap: discard
```

**Required in a precursor and refused in `spore.cmk`.** The value is `keep` or `discard`. It says
what a cell's answer is worth when the cell wrapped at a soft limit instead of finishing:

- `keep` writes that answer to `--answer`.
- `discard` throws it away and writes the continuation record instead.

Choose `discard` when a partial result cannot be told from a complete one by whatever reads it. At
the spore level, a wrapped answer goes to the user, who judges it.

### `extend.*`

```
extend.rounds: 100
extend.cost: 5.00
extend.wall: 3h
```

**`spore.cmk` only.** Each line is a single value, read as its limit is read: `extend.rounds` as a
count, `extend.cost` as an amount, `extend.wall` as a duration. Each must be strictly greater than
the matching hard limit. It is the highest that hard limit may be raised to while a turn runs,
through `spore extend`, the Telegram plugin or the HTTP API. A dimension with no `extend` line
cannot be raised. `spore wrap` only tightens, so it needs no grant
([Changing a running turn's limits](../ARCHITECTURE.md#changing-a-running-turns-limits)).

## Material

The material grants are `reads`, `writes` and `sources`. A name not granted is not reachable
([Material it does not own](../ARCHITECTURE.md#material-it-does-not-own)). What a source name
means is the host's, in [operating.md §Sources](operating.md#sources-sourcesjson).

### `reads`

```
reads: [papers=/srv/papers, ~/corpora/law]
```

Accepted at both levels. Each entry is a corpus, a directory linked into the workspace under its
name. The agent may read it and never write it.

- **Entry form.** An entry is `name=path`, or a bare path named by its last segment (a trailing
  `/` is ignored).
- **Names.** The name follows the name rule. It may not be one the workspace already uses:
  `data`, `home`, `calls`, `precursors`, `schedules`, `node_modules`, `lock`. Names are unique
  across `reads` and `writes` together, since both become links in one directory.
- **Paths.** Absolute, or from `~`, the home directory of the user spore runs as; a relative path is
  refused. A path is normalized lexically: `.` and `..` are resolved without touching the disk.
  Existence is not checked here.

In a precursor, `reads` is the cell's own kernel grant.

### `writes`

```
writes: [here=/home/me/proj]
```

**`spore.cmk` only.** In a precursor it is refused. Entries take the same form, name rules and path
reading as `reads`, in the same namespace.

A `writes` directory is linked in and changed in place. `write`, `edit` and `wsexec` reach it, and
`exec` still only reads it. When a turn starts, the runner refuses one that is not a directory, or
that overlaps the workspace, the runtime, `~/.config/spore/` or a `reads` path
([Material it does not own](../ARCHITECTURE.md#material-it-does-not-own)). `spore here` makes a spore granted
`writes: [here=<dir>]`.

### `sources`

```
sources: [pubmed, tracker]
```

Accepted at both levels. Each entry is the name of an endpoint the runner calls for the agent
through `$SPORE_SOURCE`. The agent never learns the URL or the credential.

- **Names.** Each follows the name rule, and none may appear twice. `extend` and `jobs` are refused
  as names. A source may not share a name with an enzyme of the same file.
- **What a name means** comes from `~/.config/spore/sources.json` or from a plugin's manifest
  ([operating.md §Sources](operating.md#sources-sourcesjson)). When a turn starts, a granted name
  the host does not describe is refused.
- **In a precursor**, `sources` is a view within the spore's grant: what the cell is shown. It is
  not a boundary of its own. A precursor naming a source the spore was not granted fails at spawn.

### `<source>.<param>`

```
pubmed.collection: [acme-2024, acme-archive]
```

Narrows what a granted source may be asked for. The key is a source the same file lists in
`sources`, a dot, and a parameter name; the parameter follows the name rule. The value is a
non-empty list. A plugin's source is narrowed the same way, once the file lists it in `sources`.

- For a parameter, membership is exact, with no patterns.
- `path` narrows a source's paths rather than a query parameter: each value is a path pattern
  (`*` one segment, `**` one or more) within the host's `paths`, and a call must match one. A
  pattern the host does not allow, or `path` on a source called at one address, is refused at
  start.
- A single value is filled in by the broker, and the agent need not pass it.
- A parameter the host marks `requires` must be narrowed, or the turn is refused at start.
- A key naming a source the file does not grant is refused: *narrows "…" without granting the
  source*.

## Memory

`memory`, `push`, `pull`, `floor` and `embedding` are accepted at both levels.
[ARCHITECTURE §Memory](../ARCHITECTURE.md#what-a-definition-declares) explains how recall uses
them. Declaring `push`, `pull`, `floor` or `embedding` without `memory` is refused.

```
memory: bm25
push: 5
pull: 20
floor: 0.371
```

### `memory`

`bm25` or `vectors`. Any other value is refused. Absent, a workspace keeps nothing beyond its
transcript.

`vectors` keeps its index in a vector store the host describes in `~/.config/spore/memory.json`.
A turn is refused at start when that file is missing or the store does not answer
([operating.md §Vector store](operating.md#vector-store-memoryjson)).

### `push` and `pull`

Both are required once `memory` is declared, and both are whole numbers. `push` is how many chunks
are recalled unasked before each turn, further capped at a thousand tokens of recall. `pull` is how
many chunks `$SPORE_RECALL` retrieves. Neither has a default.

### `floor`

Optional: a number, at least 0, decimals allowed. A hit must score past it to be surfaced. Absent,
any hit scoring above zero qualifies. BM25 and cosine scores are on different scales, so a floor
means something only for the backend it was tuned on.

### `embedding`

```
memory: vectors
push: 5
pull: 20
embedding: openai/text-embedding-3-small
```

A single model id with no whitespace. Required with `memory: vectors`, and refused with
`memory: bm25`. The parser does not consult the catalog. At run time, a model the catalog does not
know, or whose entry gives no `dimensions`, is refused when memory is first used. Each embedding
model has its own collection, so changing `embedding` starts a new one.

## Trail

### `retain`

```
retain: 10
```

**`spore.cmk` only.** A whole number: how many turns of trail survive, counting the current one.
Before each turn starts, the runner drops older runs' call records, events and `calls/<runId>/`
streams. The inbox, the turns and the transcript are never pruned. Absent, every turn's trail is
kept ([Retention](../ARCHITECTURE.md#retention)).

### `history`

```
history: 64000
```

**`spore.cmk` only.** A whole number of tokens: how much of the earlier turns each round re-sends
word for word. Past it, the oldest turns are summarized into a compaction entry, and the transcript
keeps them all. Absent, the runtime carries up to 256k tokens. Either way it is capped at half the
model's context window ([Retention](../ARCHITECTURE.md#retention)).

## Looking

### `images`

```
images: [4, 10MB]
```

Accepted at both levels. A two-item list: at most `count` images, together at most `size` bytes,
that `read` may show the model in one turn. `count` is a whole number, and `size` is a size of at
least one byte. This pair is intake per turn, not a soft/hard pair. Absent, `read` on an image is
refused with that reason. The grant is not checked against the model, so a text-only model granted
images fails at the provider
([Looking at a picture is a read](../ARCHITECTURE.md#looking-at-a-picture-is-a-read)).

## The clock and jobs

### `schedules`

```
schedules: [4, 1h]
```

**`spore.cmk` only.** A two-item list: `count`, a whole number, and `interval`, a duration of at
least `1m`. It makes `schedules/` writable by the agent, within these bounds:

- at most `count` schedule files that can still fire;
- no two consecutive slots of one schedule closer than `interval`;
- at most `count` firings within any `interval`, across all schedules.

`write` and `edit` refuse a schedule file that breaks these bounds, and the tick pass holds a
firing that would. Absent, `schedules/` is read-only to the agent: only its operator writes it, and
nothing is counted ([Turns the clock starts](../ARCHITECTURE.md#turns-the-clock-starts)). The
schedule files themselves are §[A schedule](#a-schedule).

### `jobs`

```
jobs: [2, 2h]
```

**`spore.cmk` only.** A two-item list: `count`, a whole number of jobs that may run at once, and
`wall`, a duration greater than zero after which each job is stopped. A job is started with
`node "$SPORE_JOB" start <name> -- <command>`. It writes only `data/jobs/<name>/`, and the `writes`
directories that `jobs.writes` names. Absent, the runner serves no job socket
([Jobs](../ARCHITECTURE.md#jobs), [operating.md §Jobs](operating.md#jobs-jobs-and-spore-job)).

### `jobs.maxWait`

```
jobs.maxWait: 30m
```

A single duration greater than zero: the longest a job's delivery may be held for the spore's
router or triage cell. Absent, a job's deliveries are said at once
([Deliveries nobody typed](../ARCHITECTURE.md#deliveries-nobody-typed)).

### `jobs.perDay`

```
jobs.perDay: 20
```

A single whole number: how many triage cells a job's deliveries may start in a day. Absent, the
runtime's default is 100.

### `jobs.writes`

```
jobs.writes: [here]
```

A list of names, each one a [`writes`](#writes) grant of the same file. A name `writes` does not
grant is refused. A job may write these directories as well as read them. Absent, a job reads the
`writes` directories and writes none of them.

`jobs.maxWait`, `jobs.perDay` and `jobs.writes` each require `jobs`. Declared without it, the file
is refused.

## `plugins`

```
plugins: [browser, ssh]
```

**`spore.cmk` only.** What a plugin offers is given to the spore alone. Each entry is a plugin's
name after `spore-plugin-`: lowercase letters, digits, `.`, `-` and `_`, starting with a letter or
digit. No entry may appear twice. A plugin must also be allowed on the machine
(`spore plugin allow <name>`), or `send` refuses the turn before anything is said
([Plugins](../ARCHITECTURE.md#plugins),
[operating.md §Plugins on the host](operating.md#plugins-on-the-host)).

## A schedule

```
---
when: 0 9 * * 1-5
tz: Europe/Paris
late: 3h
---

Check the sources in data/memory/watchlist.md for what changed since your last report.
If nothing did, end with quiet.
```

A schedule is `schedules/<name>.cmk` in a spore's workspace, where the file name is the schedule's
name. It is written by its operator (`spore schedule set <spore> <name> <file>`, or by hand), or by
the agent under a [`schedules`](#schedules) grant. It uses the same frontmatter grammar as a
definition, including whole-line `#` comments, and takes three fields. Any other field is refused.

| field | value | required | meaning |
|---|---|---|---|
| `when` | a cron expression, or `at <instant>` | yes | when it fires |
| `tz` | an IANA zone, as `Europe/Paris` | with a cron `when`; refused with `at` | the zone whose wall clock a cron expression is read on |
| `late` | duration | no | a firing more than this past its slot is skipped |

- **`when: <cron>`** is five fields: minute, hour, day of month, month, day of week. Seconds and
  years are not accepted. A cron `when` requires `tz`. Daylight saving follows the zone. A slot the
  clock skips runs right after the jump, and a slot the clock repeats runs on the first pass only.
- **`when: at <instant>`** fires once. The instant carries its own offset, as
  `at 2026-10-01T09:00:00+02:00` or `at 2026-10-01T07:00:00Z`, so `tz` is refused beside it. Once
  its time has passed it no longer counts against a `schedules` grant.
- **`late`** is a duration greater than zero. Absent, a firing runs however late it is.

**The body is the message**, said to the spore word for word when the schedule fires. It is
trimmed and must not be empty. It has no identity and no block syntax.

A schedule fires once for its latest slot, however many slots were missed. It does not fire for a
slot before the file's last change. It waits while the spore is running, has asked a question, or
failed its last turn ([README §Turns the clock starts](../packages/spore/README.md#turns-the-clock-starts),
[ARCHITECTURE §Turns the clock starts](../ARCHITECTURE.md#turns-the-clock-starts)).

## Checked after parsing

A file that parses can still be refused later, by code that knows things the parser does not.

**When a precursor is spawned:**

- its `name` differs from its file name;
- its `model` names a cell model the spore's `cell-models` lacks;
- an enzyme's path is missing or not executable, or a `<enzyme>.with` path is missing;
- it names a source outside the spore's grant.

**When a turn starts:**

- a `writes` path is not a directory, or overlaps what it must not;
- a source is not described by the host, a `requires` parameter is not narrowed, or a host default
  lies outside the narrowed values;
- a plugin is not allowed, or has changed since it was allowed;
- with `memory: vectors`, `memory.json` is missing or the store does not answer.

**On every model call:** the model broker refuses any model the spore's definition does not name.

**For a triage cell outside any turn:** a precursor named `route-<origin>.cmk` is also refused
`sources`, `enzymes` and `reads` when it runs
([A cell outside any turn](../ARCHITECTURE.md#a-cell-outside-any-turn)).

## Complete examples

### A spore

`spore.cmk`:

```
---
name: research
description: Literature work over a local corpus and a search endpoint
model: anthropic/claude-sonnet-5-5
models: [anthropic/claude-haiku-4-5]
cell-models: [low=anthropic/claude-haiku-4-5, strong=openai/gpt-6.1-sol]
tools: [read, write, edit, exec, wsexec, ask, quiet]
rounds: [40, 45]
cost: [0.50, 0.75]
wall: [10m, 12m]
extend.wall: 3h
extend.cost: 5.00
# the corpus is read-only; the review directory is worked in place
reads: [papers=/srv/papers]
writes: [here=~/projects/review]
sources: [pubmed]
pubmed.collection: [acme-2024, acme-archive]
memory: bm25
push: 5
pull: 20
retain: 10
history: 64000
images: [4, 10MB]
schedules: [4, 1h]
jobs: [2, 2h]
jobs.maxWait: 30m
jobs.writes: [here]
plugins: [browser]
---

You are a research assistant for one review, kept in here/.

The papers in papers/ are the corpus; search pubmed for what is not there. Write
findings into here/, and notes worth keeping into data/memory/.
```

### A precursor with an enzyme

`precursors/chart.cmk`, in the spore above:

```
---
name: chart
description: Turns one CSV table into a PNG chart
model: low
tools: [read, wsexec]
enzymes: [plot=data/tools/plot.py]
plot.with: [data/tools/palette.py]
rounds: [5, 7]
cost: [0.10, 0.15]
wall: [2m, 3m]
on-wrap: discard
---

You turn a table into a chart.

The table is data/table.csv in your workspace. Run plot on it, writing
data/chart.png, then reply with one line naming the chart's axes. If plot
refuses the table, reply with its diagnostic and stop.

:::enzyme plot
plot — reads a CSV with a header row on stdin, writes a PNG on stdout.
Exit 0 on success; any other code means the CSV was malformed, and stderr
says which row.
:::
```

The cell runs it as `node "$SPORE_ENZYME" plot < data/table.csv > data/chart.png` under `wsexec`.
For this spawn to be planned, `data/tools/plot.py` must be executable in the spore's workspace, and
`data/tools/palette.py` must exist.

### Two schedules

`schedules/digest.cmk`, every weekday at nine in Paris, skipped if it cannot start by noon:

```
---
when: 0 9 * * 1-5
tz: Europe/Paris
late: 3h
---

Check the sources in data/memory/watchlist.md for what changed since your last report.
If nothing did, end with quiet.
```

`schedules/deadline.cmk`, once:

```
---
when: at 2026-11-02T08:00:00+01:00
---

The review is due today. Say what is still open in here/.
```
