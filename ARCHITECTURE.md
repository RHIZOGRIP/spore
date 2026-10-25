# ARCHITECTURE

> Paths name files in `packages/spore/` unless they begin with `rust/` or `plugins/`, which sit
> at the repository root. What spore commits to is [PRINCIPLES.md](PRINCIPLES.md); this file is
> how it is built.

## Premise

The agent writes programs and the programs do the work
([principle 1](PRINCIPLES.md#1-a-spore-writes-programs-for-work-that-repeats)). The sandbox
is what makes that cheap: Landlock grants read and execute on the system's directories (`/usr`,
`/lib`, `/bin` and the rest, §Sandbox) and full access to the agent's write islands, so a program
compiles and runs in one call — measured: `gcc` 85ms, `ocamlopt` 111ms, `rustc` 573ms, well inside
the exec timeout. A package manager keeps its cache and settings in `home/`, the workspace's own
`$HOME`, and reaches its registry over the open network.

## Two levels

There are two levels
([principle 2](PRINCIPLES.md#2-one-general-assistant-which-creates-specialists)). The spore, defined by its workspace's `spore.cmk`, has the whole
suite and may spawn. A cell, grown from a precursor (§Precursors), has the tools its precursor
grants, may be granted enzymes, and cannot spawn.

The same artifact then has two surfaces:

| | sees | can |
|---|---|---|
| **the spore** (author) | a file | edit, run, test, iterate |
| **a cell** (caller) | a name and a spec | call it, nothing else |

A cell is never given a path to what it calls: it names an enzyme and the runtime runs it on the
cell's behalf, over the enzyme broker.

## Tools

A **tool** is one of the seven built-ins: a tool call the model makes, with a schema entry,
run as a function in the agent's process (`src/tools/make-tools.js`). An **enzyme** is a program
a precursor grants a cell: it has no schema entry — the cell runs `node "$SPORE_ENZYME" <name>`
from `exec` or `wsexec`, because its precursor told it to, and the program runs in a tree the
cell has no path to, reached over the enzyme broker. Each is a name the caller may invoke, never a
path, and what crosses an enzyme call is what a process has — arguments, stdin, stdout, stderr,
an exit code ([principle 3](PRINCIPLES.md#3-an-enzyme-is-used-by-its-name)).

**Enzymes exist only in a cell.** Every program the spore might use is in its own workspace and
runs under `exec` and `wsexec`, so what it can call is the built-ins and nothing else, and a root
definition declaring `enzymes` does not parse. An executable the agent wrote is a program it
runs, not an enzyme; it becomes one only when a precursor grants it to a cell (§Precursors).

### The suite

| tool | class | notes |
|---|---|---|
| `read` | reader | the one exception — its record carries the file's text, not a file |
| `write` | producer | content in, file at `path` |
| `edit` | producer | unique-string replace; refuses when absent or repeated |
| `exec` | workspace reader | **cannot write the workspace** but the turn's `tmp/`, runs under `confine`, parallel, outbound network |
| `wsexec` | mutator | read-write in the workspace, serialised |
| `ask` | terminal | ends the turn; its result is the question |
| `quiet` | terminal | ends the turn with nothing to say; its result is the reason, kept for the record |

Each built-in holds something the shell cannot
([principle 4](PRINCIPLES.md#4-only-seven-built-in-tools)): `read` the context
exception, `exec` the confinement, `ask` and `quiet` the turn boundary. Everything else is a
program under `exec`: searching is `find` and `grep`, HTTP is `curl`, and web search is a plugin's
program over a source whose key the runner holds (`plugins/brave`).

**The tool list is fixed for the run.** With prefix caching the request is ordered
`tools → system → messages`, and nothing mutates that prefix mid-run. Every call names its
workspace to the provider by a hash of its path, mohdel's `identifier`, which an OpenAI call
carries as `prompt_cache_key`: calls that share a prefix but no key are not routed to where it
is cached, and most of a long conversation is then billed as new input
(`src/infra/model-client.js`).

**A tool that cannot work is not offered**
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)): the suite's tools a definition
does not grant are taken off what the model is offered (`src/core/spore-run.js`). When
`build/Release/confine` is missing, `exec` is still offered and refuses, naming the binary and the
rebuild.

**Readers run together, mutators one at a time.** `tool-kernel.js` runs readers through
`Promise.all` and mutators serially. The split is about the workspace: `exec` is read-only on the
filesystem and unrestricted outbound (§Sandbox), so a "reader" can POST, and several go at once.
Nothing orders effects outside the workspace; an agent that needs one request to follow another
sequences it itself, in separate rounds or through `wsexec`, and `reference.md` tells it so.

## The call contract

The caller names paths at call time. There are no fixed filenames.

| | |
|---|---|
| `in` | optional, workspace path, redirected to stdin |
| `out` | optional workspace path, receives stdout |
| `err` | optional workspace path, receives stderr |
| `timeout` | optional seconds, default 30, ceiling 3600 — a fan-out declares its own |
| `idle` | optional seconds without output or CPU before the command is killed, default 120; past `timeout`, the timeout ends it first |

`out` and `err` are auto-named `calls/<runId>/<seq>/out` and `.../err` when the caller
omits them — extensionless. They sit beside the record: a stream the caller did not name is the
call's leftover, not a workspace product, so one directory is one call and dropping a run takes its
streams with it. Either is removed when it ends up empty. A path the caller named is kept even
when empty. Neither tool requires `out`: what a `wsexec` makes is the files its program writes,
not its stdout, and a required name left a file in `data/` for every call.

**No stream enters context directly**
([principle 5](PRINCIPLES.md#5-big-results-stay-in-files)): `out` is work product, in the
workspace, consumed by the next tool or program.

**The exit code is the only success signal** — nothing else asserts success.

**`path` and `out` are different questions.** `path` is the file a call acts on — `read` reads
it, `write` writes it, `edit` changes it in place; `out` is where a stream is sent, by `exec` and
`wsexec`. `test/write-edit-contract.test.js` holds that line: every tool that acts on a file takes
`path` and no `out`, every tool that redirects a stream takes `out` and no `path`. The record keeps
`files.out` for all of them: the argument says what the call is about, the record says what the
bytes did, and for a write those are the same file described from two directions.

### `read` is the one exception

```
read(path, offset?, length?, encoding?, unit?, numbered?) -> call record, the decoded text in content
```

No `out`: it is the only tool whose product is *context* rather than an effect. Its result is a
call record like every other tool's, and the slice of the file is its `content`, with `lines`
and `eof` saying how much of the file that was. As JSON the text is escaped, which is also what
keeps a `\r` or a trailing space visible to a model copying a line into an `edit`.

`numbered: true` starts each line of `content` with its number and `→` (`17→`), counted from
`offset`, and the record says `numbered: true`. A model counting lines in unnumbered text gets
them wrong, often by one, so the numbers are there for pointing at, citing or counting lines;
they are not part of the file, and `edit` matches the file. Off by default: an edit needs no
numbers, and every read would pay for them.

### Looking at a picture is a read

**`read` on a PNG, JPEG, WebP or GIF returns the picture.**

The format is decided by the first bytes and not the extension (`src/core/media.js`). RIFF is read
as the container it is: a `.wav` opens with the same four bytes as a WebP.

**An image is a message part, not an envelope field.** As a part it replays with the rest of the
transcript, and **compaction is the bound** — there is no second retention policy beside it.

The seam is the tool kernel. A tool returns a string, `{ content, images }`, or a call record
with images, `{ record, images }`; the text is still the result and what `readOutcome`, the loop
guard and session memory read, and the images become parts beside it. `content` stays a plain
string when there are none, so the common call is unchanged. Every consumer of a message's text
goes through `textOf()` (`src/core/message.js`), because a part array answers `.length` with a
part count, `.trim()` with a TypeError and `===` with reference identity.

**What may be looked at is the definition's `images: [count, size]`.** Absent means the spore
cannot look, and `read` says exactly that rather than failing as a decode error — a real answer
([principle 19](PRINCIPLES.md#19-each-default-is-written-once)). One field carries the grant and the
bound together. The pair is **intake per turn**, not a soft/hard pair; what bounds the accumulation
across a long conversation is compaction. A precursor may declare its own.

An image carries no characters and about a thousand tokens, so `estimateTokens` counts one
as 6000 characters (`src/resilience/context-guard.js`).

**The grant is not checked against the model.** A definition may name a text-only model and grant
images, and the refusal then comes from the provider mid-turn — the same bargain `tools` makes
with a model that has no tool support. Whether a given model can drive this runtime is the
conformance suite's question, answered per model.

### Two guards on an image path

A `file://` image is resolved on the supervisor's side, which holds the provider keys. An agent
naming `/etc/passwd`, or `model.key`, would be handing it to the model as a picture.

`safePath` refuses on the tool call, as it does for every other path. And the runner sets
`MOHDEL_MEDIA_ROOTS` to the workspace, its `reads` and its `writes` before it starts its model
sessions (`media_roots`, `rust/runner/src/main.rs`) — a cell outside any turn, to its own
workspace (`rust/runner/src/spawn.rs`) — so mohdel refuses independently of anything this code got
right. The second guard is required: a session takes each envelope off the wire,
where mohdel treats a `file://` read as untrusted, so the variable is what permits the read at
all, and unset it would refuse every local image. One runner serves one workspace, so the bound is
that workspace's own.

Where an image sits in the request is mohdel's business: inside the tool result on
Anthropic and OpenAI, hoisted into a user message after the tool results elsewhere, because
the rest take text-only tool results. **That stays invisible here** — the transcript
keeps the part form, so a conversation replays identically after a model switch.

## The call record

One row of the workspace's `calls` per call, by `runId` and `callNo`, and the streams it did
not name in `<workspace>/calls/<runId>/<seq>/` — written by the runtime, never by the tool;
the agent's runtime sends the record through its channel (§The model broker). The
run id is `Date.now()` in base 36 and the sequence is four digits from one, so a listing is
chronological without reading anything. An abandoned call keeps its number rather than
returning it.

The record carries only what the runtime observed (`src/core/call-record.js`):

- the tool, its arguments, start and duration
- for a command: exit code, signal, and whether it was killed at its deadline or as idle
- for each file a call redirected, wrote or read: path, size, mime, mtime, hash

What a program wrote without naming it is not in the call's record; when it is in `data/out/`, the
turn's `deliverables` lists it (§What a turn hands back).

Under synchronous execution the runtime records each
file the moment the tool exits, with no agent turn in between.

### Inline rule

A file record may carry its **content** when it is at most 4096 bytes and valid UTF-8 text
without control characters beyond tab, line feed and carriage return.

- **whole or not at all** ([principle 20](PRINCIPLES.md#20-complete-or-not-at-all)).
- one rule, applied to a *file record* rather than to a stream, so `out`, `err` and any
  artifact are covered by the same mechanism with no per-stream policy.
- conservative text detection — UTF-16 and embedded NULs are reported as mime and size, never
  inlined.
- **not back to the caller that supplied it.** `write` records the content and does not
  return it. `edit` is not the same case, because what the file became is not what the caller
  passed.

### What a turn hands back

An answer is prose, and bulk output never reaches it. Every turn record carries
`deliverables: [{path, bytes, mtime, mime}]`, the event log has it as a `deliverables`
event of its own after `complete`, and a consumer reads `{ output, deliverables }` instead of
parsing the answer for file names.

**What the agent *means* to hand back is `data/out/`**, on the same terms `data/memory/`
holds its notes: a conventional directory it writes and the runtime reads. The rest of `data/`
is working space and is not listed; it stays in the workspace for whoever looks. The reader of an
answer is not assumed to be one who looks: whatever the identity, the runtime's rules
(`rules`) tell the agent that its reader — in a chat, at a terminal or through the API —
gets the answer and `data/out/`, never the workspace, so a path into it is no answer; an identity
whose person works in the workspace says so. Where a chat gets no file from its bot, the relay's
`from` says so, and the answer is all the reader gets.

**Observed by walking `data/out/`, not reported by the agent**. `deliverablesIn()`
(`src/core/deliverables.js`) takes every file there whose mtime is at or after the turn's start
and which is still there at the end: a draft written and deleted was working, not a deliverable.
A program writes a report without any call naming it, so the trail cannot say what was handed
back. `DELIVERABLES_CAP` (50) bounds a turn's list, since each file is something a person
receives: past it the agent bundles them, and `deliverablesMore` counts the ones left out. A
spore that dreams also has everything under `data/` added up, `dataBytes` on the turn record —
at most once an hour, null on the turns between, since the walk stats every file the spore keeps
and a dream needs only how far `data/` grew. A spore that does not dream is never weighed.

Delivering those files is the **invoker's** problem. The workspace is the delivery
surface and already holds everything; a terminal lists it, a bot attaches it, a
relay serves it. `deliverables` carries paths and types, **never bytes**
([principle 5](PRINCIPLES.md#5-big-results-stay-in-files)).

`mimeOf()` is the one naming of what a file is: the extension for the formats a workspace
mostly holds, the first bytes when it does not. A chart the agent just rendered has
whatever name it was given, and a consumer deciding whether to show it or attach it has
only this to go on.

### Retention

`retain` in the root definition says how many turns of trail survive, this one included,
and the runner drops the rest before it starts a turn (`prune_trail`,
`rust/workspace/src/state.rs`): a run's call records and events, and its `calls/<runId>/`
directory — the streams first and the rows second, so an interrupted prune is finished by the
next. The inbox, the turns and
the transcript are never pruned.

Absent, every turn survives
([principle 19](PRINCIPLES.md#19-each-default-is-written-once)), and the shipped
definition declares `retain: 10`, so a seeded workspace tidies itself. A precursor may not
declare it.

**`history` bounds what a turn carries, not what is kept.** Every round of every turn re-sends
the earlier turns it carries word for word, so that working set is paid for on each round, and a
spore woken often by small events re-buys it every time. Past it, the oldest turns are summarized
into a compaction entry and the transcript keeps them all. The working set is the root
definition's `history` in tokens, or the runtime's 256k tokens when it is absent, capped either
way at half the model's window so a turn's own work fits (`src/resilience/compaction.js`). The
history is weighed by what the provider counted for the last call on the same model, cached tokens
included (`lastSent`), or by the estimate from the transcript when that is more; the estimate
alone cannot see what a provider's opaque parts, such as encrypted reasoning, weigh, so it
counts them by their size. Past it,
the summary takes all but the latest 24k tokens, or half the working set when that is less: cut
only to just under it, every later turn would summarize again, and the start of the history — the
prefix a provider caches — would change on every turn. Cut this far, it holds until the history
has grown back. A precursor may not declare it.

A bound checked against an estimate holds only as long as the estimate does, so nothing about it
is left silent. A history over its bound that is not summarized — the summary failed or came back
empty, or nothing could be cut — is a `compaction_failed` event and a warning, with why. Every
turn of the spore records `historySent`, what its first call sent as the provider counted it, and
`historyBound`, the bound it was held to; `spore show` prints the last of them with the share the
cache served, and `spore ls` marks a spore whose last turn went more than a tenth past its bound.
The loop compares its estimate with what the provider counted after each call, and says so once a
turn, `estimate_drift`, when the count is more than a quarter higher.

The trail never holds a copy of a workspace file beyond the short text the inline rule allows —
only paths and hashes. Work product lives in the workspace, the record in `calls`, and they have
different lifetimes, so pruning can never destroy anything but the record.

## Sandbox

Every turn's agent starts through `confine --no-landlock`, with `--contain` unless the host has
turned it off (its namespaces and syscall filter are §Spores of different people on one account),
and applies its own Landlock ruleset, `sandbox()` in `src/isolation/sandbox.js`, before its first
model call:

- **the agent process** reads the system's directories (`/usr`, `/lib`, `/lib64`, `/etc`,
  `/bin`, `/sbin`, `/proc`, `/dev`, `/run`), the directory of the `node` running spore, the
  runtime's own files, its workspace, its declared
  `reads` and its plugins' grants. It writes only its islands — `data/`, `calls/`, `precursors/`
  and `home/`, `schedules/` when its definition grants schedules, each directory its definition
  `writes`, and its broker socket directory. The workspace root is read-only to it
  ([principle 13](PRINCIPLES.md#13-a-spore-cannot-rewrite-its-own-history)).
- **a command under `exec`** runs through `confine` (below), which narrows it further: what the
  agent reads stays readable, and it writes only the turn's `tmp/`.
- **a command under `wsexec`** is a shell under the agent's own ruleset.
- `sandbox(ws, { writeDir })` implements the split root: Landlock resolves a path against its
  most nested matching rule, so a read-only workspace with a read-write subdirectory beneath it
  is exact, and each further island is granted back on top.
- a bad `writeDir` is refused loudly rather than silently widened, and confinement that was asked
  for and did not happen stops the process (`SANDBOX_FAILED`) rather than letting it run
  unconfined.

Landlock binds the calling process only, so a parent keeps its own ruleset when a child
narrows itself. Rules intersect; a child can never widen.

**Outbound network is open**
([principle 10](PRINCIPLES.md#10-passwords-never-reach-the-assistant-the-internet-is-open)):
the runtime has no fetch tool, no proxy and no list of allowed hosts. Where the kernel's Landlock
supports it (ABI 4), a TCP bind is refused, for the agent and every command it runs, so nothing an
agent runs listens on a TCP port; connect is left alone. Restricting egress is the host's
(`SECURITY.md`).

### `confine`

```
confine [--contain] [--scope-signals] --write-root DIR [--read PATH]... [--write PATH]... -- CMD [ARG]...
confine [--contain] --no-landlock -- CMD [ARG]...
confine --contain-check
```

A standalone binary (`src/isolation/confine.c`, built by node-gyp beside the sandbox binding)
that applies a Landlock ruleset and a syscall filter and then `execvp`s. It exists because Node
has no hook between fork and exec, so a child cannot be given *less* than the runtime holds
without one. `--no-landlock` is for a process that applies its own ruleset, as the agent does;
`--contain`, `--scope-signals`, `--contain-check` and the filter are §Spores of different people
on one account. It runs nothing as root.

What makes a read-only `exec` usable at all: **Landlock gates path resolution, not
writes to an open descriptor.** The runtime opens `out` and `err` before spawning, so a
child with no writable path still delivers its output: `find` and `grep -r` run normally while
every attempt to create a file fails with EACCES.

**cwd is the workspace.** A call that wants to work somewhere else says `cd` — or uses the flag the
command already has (`git -C`, `make -C`, `tar -C`)
([principle 4](PRINCIPLES.md#4-only-seven-built-in-tools)).

**`tmp/` is the turn's scratch.** At the root, a link the runtime points afresh each turn at
`calls/<runId>/tmp/`, before the sandbox goes up: a program written to be run once is written,
edited and run there, `exec`'s `--write-root` is that directory, and both `exec` and `wsexec`
have it as `TMPDIR`, so a program that spills (`sort` on a large input) works without touching
`data/`. It lives with the turn's calls and goes when `retain` drops the run, as an unnamed stream
does, and no grant may be named `tmp`. What is meant to last is written under `data/`.

Exit codes are `126` for a confinement failure and `127` for a failed exec; otherwise the
command's own.

The syscall boilerplate duplicates `sandbox.c`.

## Precursors

A **precursor is a definition, and a cell is what runs.** The file names an identity, the tools
that job needs, the limits it gets, and what an unfinished answer is worth. `spawn` grows a cell
from it in a directory of its own, and fifty spawns of one precursor are fifty agents that share
a definition and nothing else — separate workspaces, separate transcripts, no knowledge of
each other.

### Format

One file per precursor in `precursors/` at the top of the workspace, ChoirMark in style:
frontmatter for the machine-readable part, the body for the prose. The field reference
is `precursors/README.md`, seeded into every workspace beside the definitions, where the agent
reads it to write one.

The parser is `rust/definition`, reached from JavaScript through the addon `rust/node`
builds (`src/native.js`): one grammar and one set of refusals for the JavaScript runtime and the
Rust runner ([principle 18](PRINCIPLES.md#18-each-rule-is-written-once)). The grammar is
two forms — `key: scalar` and `key: [a, b]` — and nothing else. Unknown fields are refused rather
than ignored.

`tools` is an **allow-list over the built-in surface, empty by default**, decided per precursor.
A cell is given nothing unless the precursor says so: a precursor with no tools is a perfectly good
pure transformer.

`enzymes` names agent-authored programs. They are resolved relative to the top workspace and
checked when the spawn is planned, for existence and the execute bit, so a broken enzyme is
caught before a cell meets it. The cell reaches them through the broker by name, never by path.

**An enzyme does not describe itself. The precursor that grants it does**, in a
`:::enzyme <name>` block in the body. Two precursors can grant one executable under different
names and descriptions. A `spore.cmk` takes `:::call <name>` blocks the same way, for how its
calls are shown to a person ([§Describing a call](#describing-a-call)); a precursor's are refused.

A grant with no block does not parse, and neither does a block naming something the
precursor does not grant, nor a grant of enzymes without `exec` or `wsexec` to run them with.
There is no schema entry for them: `spawn` copies `enzyme.js` into the cell's workspace and sets
`SPORE_ENZYME` to it and `SPORE_ENZYMES` to the broker's socket, and the cell runs
`node "$SPORE_ENZYME" <name>`, which it only knows to do because it was told. The blocks become
the cell's `rules`, the slot that already means *what you can reach beyond your
built-ins*: the spore fills it with the precursor catalog, a cell with this.

**An enzyme is a filter.** The wire carries stdin, stdout, stderr and an exit code, and
nothing else — the same call contract everything obeys. It runs in the cell's workspace,
so a path it is handed means what the cell means by it, and a file it writes for itself
is a side effect: in the workspace, not in the record, exactly like one `wsexec make`
writes without naming it in `out`.

**Declaring an enzyme does not run it.** The checks are existence and the execute bit. Testing
belongs to the author, who wrote the program and has `wsexec`, and `precursors/README.md` says so.

**The program is frozen for the cell's life.** `spawn` hashes each granted enzyme at
cell start and the broker refuses a call once that hash stops matching
(`rust/runner/src/enzymes.rs`). The parent can still edit the file. A refusal is an ordinary failed call, so five in a row trip the loop guard into
`soft:progress` and the cell wraps up and reports rather than dying. The hashes go into the spawn
frame, so a run stays attributable to a program after the file has moved on. The next cell gets
the edited file. Nothing caches an enzyme's identity, so
nothing can go stale — what the author owes is keeping the description true.

**An enzyme is its program and what it declares it needs.** `<enzyme>.with: [paths]` beside the
grant names the files and directories a program needs beside itself — a sibling it imports, a
template it reads, a script it runs. The declaration is used three times. `spawn` refuses a path it
names that does not exist; the hash covers the whole bundle, labelled by position rather than
location, so an edited helper is a changed enzyme like an edited entry; and a clone carries exactly
the bundle, refusing one whose declared paths are missing (`CLONE_INCOMPLETE`). A helper left out of
`with` still works in the origin — its cells run the program from the origin's tree — and fails only
in a clone. A clone carries each path under the name it was declared by, the name the enzyme reaches
it by, and **a link as a link** — at the top, inside declared directories, partway along a declared
path, or among the precursors themselves — made relative, with what it points at carried where it
was, so it runs once the source is gone. What the target imports in turn is the declaration's to
name, as for any program. A link out of the workspace, to the whole workspace or to nothing, or a
declared path outside it, refuses the clone rather than being followed or left behind. A source and
an enzyme may not share a name, since `<name>.<field>` would mean either.

`rounds`, `cost` and `wall` are the limits, each a required soft/hard pair
([principle 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops)). A definition missing
one does not parse, and there is no default in the code: the shipped files are the defaults
([principle 19](PRINCIPLES.md#19-each-default-is-written-once)). `extend.rounds`,
`extend.cost` and `extend.wall` are the root definition's alone (§Changing a running turn's
limits): a cell's limits are its parent's to give.

`on-wrap` is required of a precursor and refused in the root definition. `keep` writes it, `discard`
throws it away and writes the continuation record instead
([principle 20](PRINCIPLES.md#20-complete-or-not-at-all)). A precursor's `tools` may not
include `ask` or `quiet`.

### Knowing they exist

The default sporangium ships no precursors, only their format, `precursors/README.md`. A
precursor someone else wrote arrives with the sporangium a spore is made from (`reviewer`,
`security` and `perennial` carry theirs) or from a plugin the spore uses (§Plugins), **copied into the
workspace** when absent and never overwritten.

The list reaches the agent through **`rules`** — each precursor's name, first line, the
tools it grants and its model. That slot is concatenated with the identity *inside* the cached
foundation block, so writing a precursor invalidates the cache once. Anything
that changes from turn to turn stays out of the system prompt: the `dynamic` tail is a constant
note, and the time is the `Now:` line in front of the turn's message (§The clock line stays out of
the prefix). A malformed one is
listed as unusable with its parse error rather than quietly omitted
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)).

Precursors are read at spawn time, so editing one changes later cells. Nothing freezes or
versions them.

## Plugins

What the runtime does not need ships as a plugin: an
npm package named `spore-plugin-<name>`, scoped or not, installed where spore is found — spore's
own `node_modules`, every `node_modules` it is installed under (inside `@rhizogrip/spore-cli`'s, and
the global one `npm i -g` puts a plugin in), or a checkout's. **The grant is the plugin, not the
directory it sits in**: an agent's sandbox reads each plugin its definition uses and every package
that plugin depends on, as Node resolves them from it, by their real directories — never the
`node_modules` they share with whatever else is installed. A directory inside one every sandbox
reads already — the `node_modules` spore is installed in — or inside another directory of the set
is left out, since its grant would add nothing: a plugin installed beside spore, its dependencies
hoisted with spore's, adds no path at all. A program outside that set is refused when the plugin
is checked, not at the agent's first call.

**A plugin is a manifest.** The `spore` field of its `package.json` says what it gives:
`works`, the `@rhizogrip/spore` versions it works with, which is required; and, each optional,
`settings` the host must supply, each a `port` or `text`; `programs`, a variable naming an
executable in the plugin or in a package it depends on, which the agent runs, and which a spore's
definition may also bind for the runtime to run on the deliveries of an origin (`prepare:`,
§Deliveries nobody typed); `describe`, how a call of each of its
programs is shown ([§Describing a call](#describing-a-call)); `env`, more variables from `{name}`,
`{ws}`, `{data}`, `{sockets}` and `{settings.<key>}`; `modules`, dependencies of the plugin an agent's own
programs may import, none of them a provisioned one; `sources`, endpoints described as the
host's `sources.json` describes them, held by the runner and granted with the plugin; a
`reference`, one markdown file; a directory of `precursors`; and `services`, below. The core reads
the manifest and runs none of the plugin's code of its own accord — there is no hook in `send`, the
runner or the agent, and no tool a plugin adds. What runs is what the agent calls, the program a
definition binds with `prepare:`, and the services the operator defines. Who runs a program is
the spore's choice, not the plugin's: `plugins:` gives a plugin's programs to the spore's turns,
`prepare:` one of them to a step on its deliveries, either without the other. A plugin is the unit
of that choice, so what a spore must be able to take apart ships as separate plugins. Every key, its shape and its refusals are in
[docs/plugins.md](docs/plugins.md), the guide for a plugin's author.

**Allowed on the machine, used by a spore.** Allowing a plugin checks it — the manifest, the
`works` range, every program executable and inside the grant, every setting declared and of its
kind, every precursor parsing and named as its file — and records it under `plugins` in
`config.json` with the version and the directory of the copy it checked. `send` holds a turn to
that copy: a plugin whose version or directory changed since is refused (`PLUGIN_CHANGED`) until it
is allowed again, so what a spore runs is what someone allowed. A definition says which of the
allowed ones it gives its turns, `plugins: [browser, ssh]`, and which prepare its deliveries,
`prepare:`; one naming a plugin that is not allowed, in either, is refused at `send`, before
anything is said. A cell's definition cannot name one: what a plugin
gives goes to the root spore alone, since `spore-spawn` builds a cell's environment from
`PASSED_THROUGH` and a plugin's variables are not in it.

**At each turn**, `send` checks each plugin again and then: fills the variables and hands them to
the runner in its environment, as a JSON object in `SPORE_PLUGIN_ENV`, which it adds to the agent's
environment before its own, with `SPORE_PLUGIN_READS` — the grant above, which the agent adds to its
sandbox and no plugin may set; copies the reference to `plugins/<name>.md` and each precursor to
`precursors/` when absent; and links each module into `<ws>/node_modules/` beside the provisioned
ones, removing a link no plugin it uses offers any more, so dropping a plugin takes its libraries
with it. A module is read through the plugin's grant, which already holds its dependencies. `define`
does the same for a spore it makes, so a new spore lists what its plugins give before its first
turn, and one naming a plugin that is not allowed is not made. A plugin may not set what the runtime
sets — anything in `RUNTIME_ENV` or `PASSED_THROUGH` (`rust/workspace`), and any `SPORE_*` but its
own `SPORE_<NAME>` and `SPORE_<NAME>_*` — and two plugins setting one variable are refused together.
`rules` names each used plugin's file with its first line, and only the ones the definition
names.

**A service is the one thing a plugin runs on the host.** `services` names each by `what` it
is and the Node `program` that starts it; `instances`, optionally, what one instance is called,
each an `<instance>.json` in the folder named after the service beside `config.json`; and `check`, the arguments that make the program test that it can
start, then exit. Plugin services are offered beside the ones spore ships, from every installed
plugin, allowed or not: allowing is what spores may use, and defining a service is the operator's
consent to run a program outside every sandbox. Spore writes the unit — the manifest names a
file, never a unit line — so a plugin's service has the shape of spore's own: restarted on
failure and not after a refusal (exit 2), `KillMode=process`. A name spore ships, or one two
plugins claim, goes to neither plugin. A service records the plugin's version and the spore's when it starts
(`recordStarted(name, { root })`), which is how an outdated one is found: either moving makes it
outdated, the spore found from the plugin's directory as node finds it. A service that imports
the library is the one place a plugin declares `@rhizogrip/spore` as a peer, and the copy it gets
in a global install is the cost: it may be another version within the range, and a workspace
another version made is refused at open. Telegram and Discord are such plugins (`plugins/telegram/`, `plugins/discord/`).

**What a plugin offers is not a boundary.** Its programs run under the agent's sandbox like
any other, and under a step's confinement where a definition binds one to deliveries; a plugin whose resource the sandbox cannot close — the browser's debugging port —
is shared on trust, and says so in its own README (`plugins/browser/README.md`).

### Documentation that moves

`reference.md`, `libraries.md` and `plugins/<name>.md` are copied when absent and then
**replaced only by `spore upgrade`**. A newer package does not change what a spore was told
without its operator knowing: `spore send` and `spore show` name each file that differs from the
installed one. They say "differs" and nothing more — a local edit and a newer package look the
same, and nothing here can tell which. Precursors, `precursors/README.md` included, are outside
it: the agent writes that directory, so a difference there is the agent's own and upgrade never
touches it.

**A root document missing at turn start is laid again** from what is installed: `reference.md`
and `libraries.md` from the package's own sporangium tree, and each used plugin's
`plugins/<name>.md` and precursors from that plugin. A
program that manages workspaces without `spore upgrade` upgrades one by deleting those files
while it holds the workspace lock, and the next turn lays the installed copies.

**A host may let them follow the package.** The host setting `docs: follow` makes a runner's start
(`startRunner`, whatever started it) upgrade that spore before the runner does anything:
for a host whose root documents nobody edits — a service holding a spore per conversation — every
spore that runs reads the installed documents, and the cost falls only on spores that run. A
runner that carries on to another turn does not upgrade again. Each
file is replaced by a rename, so a reader sees the old copy or the new one.

## The spore command

`spawn` is internal — the agent's own programs call it to start a cell. The user's entry is
`spore`: a message in, the answer on stdout, and everything else carried by the directory.

It is **three processes**, and only the middle one is the turn. `packages/spore-cli/bin/spore.js`
says what is wanted and then follows, holding nothing. The runner — `rust/runner`, built to
`native/spore-runner` — is spawned detached so the turn outlives the terminal that asked for it,
and holds the lock, the admission slot, the provider keys and the model broker.
`bin/spore-agent.js` is the confined half: it opens the same workspace through the same
`openWorkspace()` and reaches the model only through the broker's socket.

**A turn runs in the background and the command follows it.** `send()` spawns the runner
detached and unrefed, its stdout and stderr appended to `spore.out` and `spore.err` in the
workspace. `spore send` prints what appears in them until the turn ends, and `spore attach`
picks them up again later, replaying the last lines; Ctrl-C detaches the follower and kills
nothing. The follower's exit status says how the turn ended — answered, ended without an answer,
or answered at a soft limit, which says what remains rather than being the finished answer — and
walking away has a status of its own, since detaching is neither success nor failure
([INTEGRATION.md §Exit codes](INTEGRATION.md#exit-codes)).

**The command is the surface for a program in any language**, and for another machine through
`ssh host spore …`; the command itself listens on nothing, and the HTTP API serves the verbs to a caller that cannot
run it (§The HTTP API). A request id makes a message taken once: `send()` finds the inbox
entry already holding it and the command follows, or reports, the turn that read it instead of
appending again. `--json` hands a program the event log (§Watching a spore) in place of the text,
resumable from the last `seq` it saw.

### The inbox

**Everything said to a spore goes to its inbox first, and starting a runner is a separate act**
([principle 16](PRINCIPLES.md#16-every-message-lands-in-the-same-inbox)). One
`flock` on `lock` decides which: whoever takes it reads the inbox and takes what is there as the
turn's prompt, so there is no window between deciding and acting. `send` is one verb whose
meaning the lock settles: to an idle spore it starts a turn, to a running one it lands mid-turn.
`loop()` reads the inbox at the round boundary where it already checks the soft limits and
appends anything new as a `role: 'user'` message. It goes into the transcript, because a person
said it and a turn that changed course should show why.

**Nothing said is left unread at the end of a turn.** The loop reads the inbox only before a
model call, so a message can land during the final call, or between the agent's last read and
the runner letting go of the lock. The runner owns that moment: after a turn that answered, it
starts the agent again while anything in the inbox is unconsumed, keeping the lock, the slot and
the session, with a new key, new sockets and a fresh ledger, since the limits are per turn and a
cell the last turn detached must not reach this one (§Fan-out). With nothing unread it lets go,
looks once more, and takes the lock back if something landed in between. `send`, for its part,
looks at the lock again after appending and starts a runner itself if it was let go meanwhile.
Between the runner's look after release and `send`'s look after appending, every ordering is read
by someone. A turn that was stopped, walled, killed or errored does not carry on: what is pending
waits for the next `send`. The runner and the agent read the same `inbox` view, whose `consumed` is
the workspace's `inboxConsumed`, so they agree on what is unread.

**The agent never writes the inbox.** It lives in `state.sqlite` at the workspace root, which
is read-only to the agent ([principle 13](PRINCIPLES.md#13-a-spore-cannot-rewrite-its-own-history)).
An entry is never rewritten. How far a turn read is written into its turn record as `inboxTo`,
which the next turn starts from, and finalizing the turn moves `inboxConsumed` there. A crash
leaves `inboxConsumed` at the last finalized turn.

**What one place said can be set aside** (`setAside`, `t_set_aside`): marked beside the inbox, not
on it, so no turn reads it, starts for it or answers it — `readInboxFrom`, `unread` and `address`
all skip it, and a turn's `(inboxFrom, inboxTo]` means what it read less what was set aside. The
mark is made only while no runner holds the workspace, inside the write that checks it: what a
running turn has read is known when it ends, and a message it read is answered, never set aside. A
relay's `stop` is what sets aside, up to the last message of that conversation it passed.

**What was overheard asks nothing** (`overheard` on the entry, `send`'s `overheard: true`): a
message said where the spore is and not to it — in a group, around what is addressed to it. It is
written with who said it and where and no `replyTo`, the schema refusing either way round, and it
starts no turn and is owed no answer: `unread`, `address`, `readInboxFrom`'s `person`,
`turnsSince`'s `asked`, `log` and `show` all pass over it. The next turn that runs reads it as
context, a run of them one block in the runtime's voice, a line each with the name, the place and
the text quoted — said in a group by anyone its routing lets in, so nothing in it may pass for the
runtime or for someone addressing the spore. A read hands on the latest `OVERHEARD_KEPT` (100);
the rest stay in the inbox, marked, where `$SPORE_SQL` reads them. A flag on the entry, not a mark
beside it as set-aside is, since it is what the message was when it was said.

**Who said a message is data on its entry, never words in its text.** A relay that hears a
person passes `send`'s `from`, `{ name, id, where, zone? }`, and the entry keeps it as `fromName`,
`fromId` and `fromWhere`: all three or none, and never beside a `schedule`, `hook` or `job`, which
name what spoke when no person did — an entry has one speaker, and the schema's check and
`origin_of` both refuse two. `zone`, kept as `fromZone` and only beside them, is the IANA zone of
the person's clock where the platform says it (Teams on a message, Slack in a profile), since the
`Now:` line is UTC and a person reads times in their own. `saidOf` renders it as a line ahead of
the text, in the runtime's voice as it renders the clock's, with the name and the conversation
quoted — both are the person's to choose, and nothing in them may pass for the runtime speaking —
and, with a zone, the entry's `at` in that clock and its offset from UTC. The TUI and `spore log`
read the same fields and show a name.

**A file sent with a message, and a message too long to inline, land in `<ws>/inbox.d/`.** A
turn's prompt is every unanswered message joined, so a long paste would enter context whole
([principle 5](PRINCIPLES.md#5-big-results-stay-in-files)). A directory at the workspace root is
readable to the agent and unwritable by it with no confinement of its own. Each message that needs one gets a directory named from the clock and three
random bytes. An attachment's name is reduced to one path segment: it comes from outside and picks
the file it lands on.

**`send()` decides, on a threshold.** The threshold is a constant, `INLINE_MESSAGE_BYTES` (8192,
against the text's length, `src/core/spore-dir.js`), not a `.cmk` field. How much of a spilled
message reaches the model is not `send`'s concern: the agent reads the file with `read`, which has
slicing, a budget and a refusal.

A spilled entry carries `bodyPath`, `bodyBytes`, `bodyHead` and `bodyTail` — what is elided
between them is the difference — and the runtime composes what the turn sees from them. **Head
and tail, not head**: the two shapes a long message takes put the instruction at opposite ends —
`summarise this:` before twenty pages, and forty kilobytes of log before `why does this fail?`
— and which one it is cannot be known. `headAndTail()` in `src/core/preview.js` reports what it elides in bytes, the unit the
file is measured in, and does not cut between the halves of a surrogate pair: an orphan half is not
text the inbox can hold, and anything taking the text through a Buffer renders U+FFFD.

### Stopping

Nothing reads a message for a keyword: what it means is the spore's to decide. That gives
stopping two forms, mirroring the limits: `spore send <name> stop` asks the agent to wrap up and
answer with what it has, as a soft limit does, while `spore stop <name>` sends SIGTERM to the
lock's holder and aborts mid-round, as a hard limit does, and the turn ends `cancelled`. Neither
cuts a model call: one in flight runs to its end in the runner and is billed to the turn, which is
written down once it has
([principle 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops), §The model broker).

**The supervisor bounds the stop.** The runner passes SIGTERM to the agent and waits a grace of
5 s (`GRACE`, `rust/runner/src/supervise.rs`) for it to abort the turn, kill its tools' process
groups and leave its turn record; past that it kills the agent **with every process it started**
and releases the lock and the slot, because a turn that cannot stop must not hold them. The tools
sit in process groups of their own, and only an agent that can still run its abort handler stops
those, so the supervisor does not signal the agent's pid alone: it freezes the agent, then each
descendant as it walks the parent links in `/proc/*/stat` — a stopped process cannot fork, so the
walk ends with the whole tree — and kills them all.

**Nothing a turn started outlives its lock.** Every supervisor — the runner for a turn,
`spore-spawn` for a cell — adds a token of its own to `SPORE_OWNERS` in its child's environment,
which every process of the turn inherits: tools, their children, cells, and whatever was
re-parented to init when its parent went. When the child ends, however it ends, the supervisor
kills every process of its user still carrying the token, frozen first as it is found, and only
then lets go of the lock (`rust/workspace/src/owners.rs`). A cell's worker stops like the root's
agent — a signal is its turn's abort, so it stops its tools, writes its record and frame, and
exits — and the sweep covers a worker that could not. The runner lets go only once the turn's
model calls have finished as well: a call is not a process of the turn but the runner's. A job is
the one thing a turn starts that is meant to outlive it, and it runs outside the turn's token
(§Jobs). Out of reach is only a process that cleared its environment and left the tree as well.

**The hard wall is held from outside too.** At the definition's `wall` plus the grace, the runner
asks the agent to stop, then kills it; `spore-spawn` does the same for a cell with its
precursor's `wall`. The agent's own timer covers every `await` the turn's abort signal reaches,
recall's embeddings and store requests included, and the supervisor's covers the rest. A killed
agent leaves no turn record, so the runner writes it (§A turn that died still happened). The
vector store gives up on an attempt after 30 s (`rust/runner/src/vectors.rs`) rather than asking
a store that stopped answering again.

### What a workspace holds

The workspace is flat and undotted:

```
<ws>/spore.cmk        the agent's identity, its tool grant, its model, its limits
    /sporangium.json  the sporangium it was made from
    /state.sqlite     every record: the inbox, the turns, the transcript, the events and the
                      calls; the agent reads it and writes only through its channel
    /inbox.d/         files sent with a message, and any message too long to inline
    /spore.out        the running turn's answer, as it appears
    /spore.err        the running turn's progress
    /reference.md     the full account of the runtime, for the agent to read
    /libraries.md     one tested example per provisioned library
    /plugins/         one document per plugin the spore uses
    /model.key        this tree's key to its brokers
    /lock             pid + startedAt while a run is live
    /calls/           the streams each call did not name
    /tmp              this turn's scratch: a link to calls/<run>/tmp/
    /precursors/      sub-agent definitions
    /schedules/       what the clock says to it, and when; the agent's only when granted
    /node_modules/    the libraries an agent's programs may import, linked
    /data/            everything the agent makes
    /data/out/        the part of that it means to hand back
    /home/            the agent's $HOME: its programs' settings and caches
```

**`home/` is the agent's `$HOME`.** The host's home is not granted, so the runner and
`spore-spawn` set `HOME` to the workspace's own `home/`, a write island like `data/`: a program
that keeps its settings in `$HOME` — git's identity, npm's cache, pip's — has a place for them,
and the host's `HOME` never reaches an agent. It persists between turns, since a spore that
commits needs its identity next time too. It is not something a turn made, so a fan-out retry
does not carry it and a clone does not inherit it; a fork restores it as it stood at the cut,
like every island.

### Where workspaces live

`spore send` names one spore and `spore define` makes one. Which spores there are is answered by
a file, `config.json` in spore's configuration directory — `$XDG_CONFIG_HOME/spore/`, else
`~/.config/spore/` — which says where workspaces live and what the machine allows; its keys are
in [docs/operating.md](docs/operating.md).

**Three directories, three kinds of thing.** `~/.config/spore/` holds what the operator authors:
`config.json`, `sporangia/`, `sources.json`, `memory.json`, `hooks.json`, `api.json`,
`environment` (provider keys, `PATH`, the bots' tokens), a plugin service's instance files — the
Telegram plugin's `telegram/<bot>.json`, one per bot — and `ssh/`, the keys the `ssh-agent`
service holds for spores to sign with. Every spore command reads `environment` itself at start
(`loadEnvironment`), a variable already set winning; the library never does, since its callers
pass their own `env`. A runner, and a cell run outside any turn, start from that `env` whoever
starts them (`turnEnv`): `environment` read again for what it lacks, and none of the secrets the
host's services keep — every `${VAR}` in `hooks.json`, `api.json`, `config.json`'s `approvals` and a
plugin service's instance files — unless `sources.json`, `memory.json` or a granted plugin's
sources name it, since those are the runner's to fill. The home holds spores, one per subdirectory, and nothing else, so it can be
backed up, moved or wiped without taking configuration or credentials with it.
`$XDG_STATE_HOME/spore/` holds what the user's spores share while they run: the admission slots,
the pause mark, `tick.lock`, each job supervisor's lock, each service's start
record, the workspaces of cells run outside any turn, and each chat bot's position. None of the
three is granted to a confined agent, which reaches only its own workspace. A unix socket is
another matter: Landlock does not gate `connect()`, so every socket of the user — any broker's
included — is in a spore's reach, and a broker spores must not use runs as another user.

**`home` is a directory that contains workspaces**, one per subdirectory, and is not a
workspace itself. It is where a new spore is made. **`workspaces`
names individual workspaces living outside `home`** — a bench directory, a workspace sitting inside
a project checkout. It is the exception. `home` may not itself be a
workspace (`CONFIG_HOME_IS_A_WORKSPACE`): a spore made inside another sits within that agent's own
read-only root and is readable to it, which is the objection `grantedPathContaining` raises for
this repository and for `/tmp`.

**The search is one level deep** (`src/library/discover.js`). A spore is an immediate
subdirectory of its home and nothing below that is looked at. With **`homeSplit: N`**, a spore
lives at `<home>/<its name's last N characters>/<name>` instead, and that is the one level looked
at; `workspaceFor` is the one place a name becomes a path. The layout is recorded in
`<home>/.spore-home` — by `define` with a home's first spore, or by `recordLayout` from a program
that makes spores itself — and a configuration disagreeing with the record is refused, so a spore
is never looked for where it was not made. An application that nests workspaces inside a directory of its own lists them itself; they
are not reached this way.

That decides how a spore is named: a **bare name** is the one of that name in `home`, anything
path-shaped is taken as written, and `.` is the one you are standing in. A name is one path
segment of ordinary characters, starting alphanumeric (`NAME` in `src/library/config.js`),
because a leading `-` reads as a flag and a workspace is flat and undotted. `spore define <path>`
makes the spore where it was told and adds it to `workspaces`, since a spore outside home is
invisible to `spore ls` until something records where it is.

The file never records what is running, what anything cost or what anything is called: all of
that is read back from the directories
([principle 15](PRINCIPLES.md#15-the-folder-is-the-spore)). A listed workspace that is gone,
or that holds no `spore.cmk`, is reported and skipped rather than being an error. **It is host
side only**: `sandbox()` does not grant `~/.config`, so a spore cannot discover the workspaces
beside it.

### Defining a spore

**Defining a spore and sending to it are separate acts.** `spore define` says what a spore is;
`spore send` only reaches one that exists, so a mistyped name is an error rather than a second
spore beside an abandoned conversation. What a message means — the job, a continuation, the
answer to a question the spore asked — is the spore's to decide.

**Defining is also revising.** `--definition` given for a workspace that already has a
definition replaces `spore.cmk` and leaves `state.sqlite` and `data/` alone: the agent keeps what
it has done. `openWorkspace` re-parses the definition on every open, so the revision takes effect
at the next turn, as a hand edit does. The definition is parsed before it is written and
installed by rename, so one that does not parse, or a process killed mid-write, leaves the one in
place untouched. Without `--definition` the command is idempotent and says so rather than making
the spore again from its sporangium.

`spore edit <name>` is the same install, reached from `$VISUAL` or `$EDITOR`: the editor gets a
copy, and the copy replaces `spore.cmk` only once it parses, so a broken definition is caught when
it is written. One that does not parse is offered back with the parser's error; one that is
unchanged replaces nothing; a `spore.cmk` changed by someone else meanwhile is left alone and the
copy kept (`EDIT_CONFLICT`). It says what changed, and that a running turn takes it from the next
one.

**The model is part of the definition**
([principle 7](PRINCIPLES.md#7-a-spore-is-described-in-a-file-not-built-in-code)): `model: <provider>/<name>` sits
beside the tools and the limits, and a root definition naming none is refused the way one missing
a limit is. A precursor may leave it out and run on its parent's. The parent's model reaches the
cell as `$MODEL`: a spawning agent's environment carries its own model there, and the cell's
supervisor and worker take the precursor's model or else that variable (`rust/runner/src/spawn.rs`,
`bin/spawn-worker.js`). That is the only place `$MODEL` is read at runtime; elsewhere it is how
the conformance suite and the benchmarks pick what to write into the definitions they stage.

**A spore is made from a sporangium.** A sporangium is laid out as a spore is, with nothing run
yet: its `spore.cmk`, and any `precursors/`, `schedules/`, `data/`, `home/` and root documents.
Every spore is made the same way, whatever its sporangium: the default sporangium, then the one
named with `--sporangium` over it, file by file (`src/core/sporangia.js`). So a sporangium
carries only what it changes or adds, and the default sporangium holds what every spore starts
with: the general identity, `reference.md`, `libraries.md` and `precursors/README.md`. A
sporangium may still carry its own `reference.md`, and the repository's tests hold any shipped one
to every section and tool of the default's. A sporangium other than the default must carry a
`spore.cmk`.

Each sporangium is the package's (`sporangia/<name>/`), then the operator's (`sporangia/<name>/`
beside `config.json`), the later winning file by file. The operator's default sporangium is copied
from the package's once and is authoritative afterwards, so upgrading spore cannot quietly change
what your spores are. A workspace records the sporangium it was made from in `sporangium.json` — a
clone records its origin's — and that is what `spore upgrade` and the "differs from what is
installed" warning compare its root documents against. A workspace with no record, a cell's, is of
the default sporangium. `openWorkspace`, which runs confined, restores a missing root document from
the package's sporangia alone.

**No shipped sporangium names a model, and the first `define` copies the default sporangium and
then refuses**, saying to set one. A sporangium that names no model runs on the operator's default
sporangium's. What a spore runs on, what it may
call and what it may spend are all `.cmk` fields, changed by editing one. `--model` and `--plugin`
fill in the `spore.cmk` that `define` writes, a new file, and they, `--sporangium` and a `writes`
grant are refused for a spore that exists (`DEFINE_FILLS_ONLY_NEW`).

**`spore remake <spore>` makes a spore again, in place,** from the sporangium it was made from
(`remake` in `src/library/verbs.js`). It keeps what the spore can do and what it has made —
`spore.cmk` as edited, `data/`, `home/`, `precursors/` and `schedules/`, moved rather than copied
— and leaves what it did, the database, the trail and the inbox, in `<ws>.before-remake` beside it
until the owner removes that. With no definition left, that directory is not a spore. It is how a
spore whose database another development version made is brought back, since that database
cannot be opened (§The workspace database), and it is refused while the spore runs. A watcher's
position is tied to the database it was read from (`databaseOf`, its `createdAt`), so a service
following a remade spore starts the new database from its beginning.

**`openWorkspace` opens; it does not make.** A directory with no definition is refused rather
than seeded.

### Reading a spore

`spore log` is the turn-by-turn view: when each turn ended, how, what it cost, what it drew in
work units, and **what was said to start it** — which the turn records carry without storing it.
Each says which stretch of the inbox it read, `(inboxFrom, inboxTo]`, and those are exactly the
messages that turn answered; anything no turn has read is waiting. A running turn's record is
written when it ends, so how far it has read so far is its latest `inbox_read` event, logged as it
reads at its start and between rounds. That is also what `spore show` counts as `waiting`, and it
is the difference between a spore that is idle and one that has not started yet. The answers are not there: they are in the transcript.

Every verb names a spore the same way, so `spore show test` and `spore send test "…"` mean the
same one. `show` answers from the files alone — `stateOf()` for what it is doing, the parsed
definition for what it is, the transcript and the `turns` view for what it has done — and never
calls `openWorkspace`, which seeds files and links modules.

The management verbs — `ls`, `show`, `log`, `config` and the rest — run in the
command (`packages/spore-cli/src/dispatch.js`), on the host, and start nothing. They answer from
`src/library/verbs.js`, which is a library: an embedder asking the same questions needs no
command and gets no less.

### Changing a running turn's limits

`spore extend` raises the running turn's soft and hard limit of one dimension together;
`spore wrap` brings its soft wall to now, or to a while from now. The Telegram plugin and the HTTP
API offer both. Only the turn's owner can change its limits while it runs.

**Raising is a grant.** The definition names a ceiling per limit — `extend.wall: 3h` — and an
extension that would take the hard limit past it is refused, saying how much room is left. No
ceiling, no extension. Wrapping needs no grant; a wrap later than the turn already wraps is refused.

**A change is a row.** The runner writes the turn's limits as it starts them, one `start` row per
dimension in `t_limits`; `extend` and `wrap` add rows, in one transaction that finds the running
turn and checks against its latest row, so two changes never race (`change_limits`,
`rust/workspace/src/state.rs`). The latest row of a dimension is the limit. Nothing running, or a
running turn that recorded no limits, refuses the change. Wall values are milliseconds from the
turn's start; a wrap, a moment on the clock, is written that way and read back against the loop's
own start.

**Three enforcers, one source.** The hard wall is held three times — by the loop between rounds,
by the agent's timer through a tool that hangs, and by the runner past its grace — and hard cost
twice, by the loop and by the broker. The agent and the runner each read the rows every two
seconds and move their own bound, so a raised wall is in force before the old one would have
fired. When a limit the turn already wrapped on is raised, the model is told it may carry on; a
wrap its owner asked for is announced as that, not as a limit reached.

### Carrying a turn on from one of its rounds

`spore fork` (`src/core/fork.js`) makes a new workspace that is a run as it stood when one call's
round came back, and carries the turn on from the next model call. It exists to take one decision
again, many times, under a changed definition: a failure seen once in twenty full runs is reached
every time from a fork, so a rate needs forks, not reruns. `scripts/try-definitions.js` is the
loop around it — one cut, N forks per definition, and how often each delivered.

**The cut is a round boundary**, found through the turn record's times against each message's
`at`, and it takes every result of the round, since a model that asked for two calls has to be
shown both. A round boundary is quiescent — every tool has returned — which is what makes it a
place a turn can stop and start. A spore still running is refused.

**The islands are restored by birth time.** The trail records what a call redirected, not what a
program wrote, so `data/`, `calls/`, `precursors/` and `home/` are copied file by file: a file
born after the cut is left out, and one born before it and changed after **refuses the fork**,
because its content at the cut is gone ([principle 20](PRINCIPLES.md#20-complete-or-not-at-all)).
The run's `reference.md`, `libraries.md` and `plugins/` documents are copied too — they are part
of what that spore was told — and so is `inbox.d/`. The records go the same way: the finished
turns before the cut, the transcript to it, the inbox the turn had read, and every call record
that started before it, so the run numbers on from them and the streams restored beside them keep
the names the transcript gives them. A different definition given to the fork replaces the run's
`spore.cmk`, which is the point of most forks.

**The turn goes on in the same run.** `fork.json` carries the `runId`, the rounds taken and how
far the inbox was read (`inboxTo`). The runner's `--continue` has the agent pass that record to
`runSpore` as `resume`, which reads no new inbox, numbers calls on from the run's last
(`createCallTrail`'s `seq`), and runs `loop` `from` the round where the run left it, with no user
message appended, so the limits still count what was done. Spend is counted from the fork — the
runtime records cost when a turn completes, not per round.

**File times are compared with a margin.** They come from the kernel's coarse clock, which
advances a tick at a time, so a file can read a few milliseconds off the moment that made it — a
call's named output has been measured born 5 ms before the call's own `startedAt`. Each cut is
moved 20 ms (`CLOCK_SLACK_MS`) into the quiet between two rounds, where a model call sits for
seconds, so a file lands on the side of the round that made it.

**`--replay` cuts one step earlier**, before the round's results: the fork keeps the assistant
message that asked for the calls, and `loop` runs them again before its first model call, under
the runtime as it is then. That is how a change to what a tool returns is measured — the history
is the run's, only the result differs. The boundary is the round's first call's `startedAt`, not
the message's `at`, because a call can open its output before the transcript writes the message
down. A round that called `ask` cannot be replayed.

### Cutting a spore from another

**A clone inherits what a spore can do, not what it did**
([principle 6](PRINCIPLES.md#6-a-copy-of-a-spore-takes-its-skills-not-its-memories)).
`spore define <new> --from <old>` (`src/core/clone.js`) carries the capability and leaves the
conversation:

| carried | left behind |
|---|---|
| `spore.cmk` — identity, tools, limits, `reads`, `sources` | `state.sqlite` (the inbox, the turns, the transcript, the events, the calls), `calls/` |
| `precursors/` | `inbox.d/`, `schedules/`, `home/` |
| the programs a precursor grants, with what their `.with` declares | `data/memory/`, and the rest of `data/` |

`model.key`, `lock` and `node_modules/` are not copied — minted per turn, liveness, and linked by
`openWorkspace` for itself. The clone records its origin's sporangium.

**The unit is the precursors and the closure of what they grant.** What a program needs beside
itself is declared, not detected (§Precursors, `<enzyme>.with`), and a declared path that is missing
refuses the clone (`CLONE_INCOMPLETE`). There is no other channel: a program nothing grants is
working space. `data/bin/` is the conventional place for enzymes, taught in `reference.md` and read
by no code.

`define` says what a spore is: `--definition` says it with a file, `--sporangium` with a sporangium,
`--from` by reference to a sibling, and the three refuse each other (`DEFINE_AMBIGUOUS`). All make
the workspace through `openWorkspace`, and a target inside a sandbox-granted path is refused as for
any other definition. Cloning a running spore is fine — it reads the definition, the precursors and
their programs and takes no lock — and the worst case, a program copied mid-write, surfaces as a
broken enzyme at its first spawn.

**A clone is not told it is one.** Nothing in its prompt or its reference says it inherited
anything, so whether it finds and uses its precursors is a property of how its origin left them. The
command reports the cut to whoever ran it, not to the agent. An experiment's `origin.json` sits in
the clone's root, where the agent can read it.

### Removing a spore

`spore rm` (`remove` in `src/library/verbs.js`) deletes the workspace, and refuses where a bare
`rm -rf` would break something without a word. A directory without `spore.cmk` is not a spore,
and neither is a path the sandbox grants, the checkout included. A spore holding a finished turn
needs `--yes`, because a turn is history: its conversation, its records and what it made,
whatever it cost. It knows nothing of what an application built on spore made of a workspace:
keeping an experiment whole is that application's business.

It deletes under the workspace's own lock, so a turn cannot start inside a directory that is
going. A spore that holds the lock is running, and the refusal says to stop it first. Recorded
turns are checked before the lock is taken, because taking it writes over the pid a crashed
runner left, and that pid is how `stateOf` tells a crash; once the lock is held, the check is made
again, in case a turn finished in between. Nothing outside the workspace is told: a chat route
that still names the spore is the chat service's to report.

### A spore for the directory you are in

`spore here [dir]` opens the spore that works in a directory, in place, and makes it the first
time (`packages/spore-cli/tui/here.js`, `packages/spore-cli/src/here.js`). It is named
`<directory>-<6 hex of a hash of its real path>` in the spore home, so the same directory always
finds the same spore and nothing else keys it, and it is granted `writes: [here=<dir>]` — the
directory given, not its repository's root. `define` refuses a grant the runner would refuse at
every turn (`WRITES_REFUSED`, with the reason): a directory overlapping the runtime, the
workspace, `~/.config/spore` or a sandbox grant. Made, it does nothing on its own: a picker lists the
sporangia with their `description`, its header saying what is granted and the git state, and
without a terminal the sporangium must be named. Later it reopens that spore, refusing
`--sporangium` and `--model`, and changing it is `spore edit`, as for any.

**Git is the undo**, so outside a work tree it is refused unless told to work without git. Each
session starts with a commit of the directory as it stands — tracked and untracked, `.gitignore`
respected — under `refs/spore/<spore>/<session>`, written through an index of its own, so neither
the work tree nor the person's index moves. Only the newest three are kept per spore, the older
refs dropped as a session opens: a snapshot holds untracked files, so one kept forever would keep a
deleted file — or a `.env` nobody ignored — in `.git`, where a mirror push or a backup of every ref
would carry it. A session reads only its own; three leave room for another session of the spore
still open. `/diff` shows what changed
since, through git's pager, and cannot tell the spore's changes from the person's; `/undo` restores
what changed or went and removes what was made, ignored files apart. Both are commands `spore here`
adds to the terminal (`runTui`'s `commands`).

### The first run

`spore setup` (`packages/spore-cli/src/setup.js`) is a path through what other commands do,
keeping no state of its own: each step reads what is there first and says so, so a second run
asks nothing already answered and is a check. The models step is mohdel's own setup, run from the
`mo` installed with spore (`MO`); its readiness is read again afterwards rather than its exit
code taken, since a user can finish the catalog after it exits. `spore doctor`'s models area is
the same reading for every model the spores name. The catalog is mohdel's alone: adding a model
to it offers it to no spore, which stays `models:` in that spore's `spore.cmk`.

### Material it does not own

A definition may name material outside the workspace, and each kind is a grant: what is not
named is not reachable. The fields are in [docs/definition.md](docs/definition.md#material), `sources.json` in
`docs/operating.md`.

**`reads: [papers=/srv/pubmed]`** is a corpus on disk. One field feeds the three layers that
already exist — `sandbox()` adds the target to its read paths, `confine` gets a `--read` so
`exec` can grep it, and `safePath` (`safe_path`, `rust/workspace`) resolves into it. It is staged
as a symlink under the name the definition gave it (`linkGrants`, `src/core/workspace.js`), the
way `provisionModules()` links libraries into `node_modules/`, so the agent works in
workspace-relative paths and no identity carries a host layout. Opening a spore drops the links
of grants its definition no longer declares, and of one whose directory is gone: a name for a
directory the agent cannot open reads as material it was given.

Writing to it fails twice: the islands check refuses it before a syscall
(`src/tools/make-tools.js`), and Landlock refuses it at the kernel. `grantedPathContaining()`
counts declared reads, so a cell cannot be staged inside a corpus — a child confined under a
directory its parent's ruleset opens would be isolated from nothing.

**`writes: [here=/home/me/proj]`** is a directory the spore works in, in place — a repository,
a site, a data directory. It is staged the same way, under a name `reads` and `writes` share,
and differs in what the layers do: `sandbox()` adds it to the write paths, so `write`, `edit`
and `wsexec` write there; `confine` gets it as a `--read`, so `exec` stays read-only; the
islands check accepts it. A job reads it and writes only its own directory, unless
`jobs.writes` names it (§Jobs). It is a root definition's only: a cell works in its own
directory, and its parent brings what it made into the one it writes.

The runner refuses the turn when a `writes` path is not a directory, or overlaps the spore's
workspace, the runtime, `~/.config/spore` or a `reads` path, or lies inside a path every sandbox
is granted (`writes_refusal`, `rust/workspace`). Overlap either way matters because Landlock
adds rights up along a path: a write grant holding a corpus would make the corpus writable, and
one holding the workspace would make its root writable. Staging replaces only a link, never
what the workspace holds under that name, and the parser refuses the names the workspace uses
(`data`, `home`, `calls`, `precursors`, `schedules`, `node_modules`, `lock`) for either kind.

`confine` takes at most 256 paths to read (`CONFINE_MAX_PATHS`, `rust/workspace`), and runs
nothing past it. Every command `exec` runs is handed the system's and the runtime's read paths,
node's directory, each `reads` and `writes` path, the plugins' reads and the workspace, so the
runner counts them when a turn starts and refuses one past the limit with the count and what made
it (`read_paths_refusal`), and `spore-spawn` refuses a precursor the same way — once, rather than
every command failing with exit 126.
What changed in the directory is not part of `deliverables` — git, not a walk, says what a turn did
there.

**`sources: [pubmed]`** is an endpoint. The network is already open to the agent, so a source
is about the credential
([principle 10](PRINCIPLES.md#10-passwords-never-reach-the-assistant-the-internet-is-open)):
`wsexec` hands the environment to every command, and a key in a call record is a key in the
transcript. So the definition grants a *name*, `sources.json` beside `config.json` says what
the name means, and the runner's source broker (`rust/runner/src/source.rs`) resolves `${VAR}`
from its own environment and makes the call over http or https — rustls with Mozilla's roots,
fixed in the binary. The runner reads the file through `--sources`, which `send` and `fork`
pass.

The agent calls a source by running a program, `node "$SPORE_SOURCE" <name> …`
(`bin/source.js`). The response goes to a file, the exit code is the signal, and the agent never
learns the URL. The broker hands the response's bytes over unchanged, base64 in its JSON answer, so
the file is what the endpoint sent: an image or a PDF as much as a JSON page. The broker measures the response itself rather than trusting `content-length`, and
refuses one past 32 MB (`MAX_RESPONSE_BYTES`), because a workspace filled by an endpoint is a turn
nobody can finish.

A definition narrows what it may ask for with `<source>.<param>: [values]`, a grant one level
below `sources`. Membership is exact; a single allowed value is filled by the broker, so the
one-tenant case needs nothing from the agent. `<source>.path` narrows an API source's paths the
same way, as patterns a call must match within the host's. What a host could get wrong is refused **when the
runner starts**, before a socket exists, rather than at the first call: a `${VAR}` that is not
set, a parameter the host marks `requires` that the definition does not narrow, a host default
outside the grant, a granted name the host does not describe, and a field an entry should not
carry.

**A header may carry the calling spore's name.** `{name}` in a header value is the spore's name,
its workspace directory's name, filled by the runner when it reads the source; a cell calls
through its root's runner, so it sends the root's name. One host credential then serves many
spores, and the service behind the source tells them apart by the name, as a bot's file and
`replyTo` already do. Only a header takes it: the agent's call carries no header of its own,
while a query value is a default its parameters replace. Any other placeholder in a header, and
`{name}` in the url, socket or query, is refused when the runner starts (`SOURCE_INVALID`).

**A source may be reached on a unix socket.** A host entry naming `socket` is called on that
socket instead of the url's host, the url still giving the `host` header, the path and the
query, in plain http. It is for a service a container reaches only through a socket mounted into
it, where opening a TCP path through the container's firewall would undo the rule that it
reaches nothing local. The socket is the host's to name: a plugin's source naming one is refused.
Landlock does not gate a connect to a socket the agent can name, so the agent's own commands can
reach it too. The credential is what keeps them out: a service behind a socket source refuses a
call without it, and the credential reaches only the broker. A socket missing at call time is
an unreachable source, as a host down is, since the service may start after the runner.

**A source is an address or an API.** By default the agent adds query parameters to one URL
and one method. A host entry that lists `methods` and `paths` makes it an API: a call names a
method from the list, a path under the URL matching one of the patterns, and a JSON body, and a
path's segments can only go deeper. `--list` shows such a source's base path and nothing else;
the host and the credential stay with the runner. The lists bound what the agent may call; the
credential's own scopes, at the service, bound what those calls may do.

**A cell sees the tree's sources through a view.** Its precursor's `sources` and
`<source>.<param>` name what the cell is shown: `spore-spawn` passes them as `SPORE_SOURCES`,
`bin/source.js` sends them with every request, and the broker answers within them — `--list`
shows only the view, a single value the view narrows to is filled, and a value outside it is
refused. The view keeps a cell's context to what its work needs; it is not a boundary
([principle 11](PRINCIPLES.md#11-spore-trusts-the-person-running-it-not-other-spores)),
so a cell that sends no view is answered within the root's grant. A view wider than the root's
grant is refused, and `spore-spawn` asks for the view once before the cell starts, so a
precursor naming a source the tree was not granted — or any source, under a root granted
none — fails at spawn.

Three choices are left narrow
([principle 22](PRINCIPLES.md#22-when-in-doubt-start-narrow)):
membership is exact, with no patterns; sources are outside the budget, which counts model spend
alone, so an endpoint that costs money is bounded by its host; and `reads` and `sources` stay
two fields.

### Who a spore is to others

Three things make up who a spore is, and each lives in a different place.

- **Its identity** is the body of its `.cmk`: who it is told it is. `define --from` copies it.
- **Its persona** is who it is to others: the code host's user it comments as, the key it signs
  with, any name a platform knows it by. Each of those is an **account**, one credential on one
  platform, and a spore reaches one only through a grant by name: a source, whose entry in
  `sources.json` holds the token, or a key the `ssh-agent` service holds. The credential is the
  host's, never the spore's.
- **Its memory** is its workspace: the transcript, `data/memory/`, the notes it keeps. It is
  the spore's alone. `define --from` carries none of it; `fork` carries it up to the cut, and
  the two diverge after.

Accounts and spores are many-to-many. One spore may hold several accounts: a definition grants
several sources, and each call names the one it speaks as. One account may be granted to
several spores, which then act as one user with separate memories.

**The runtime does not know who shares an account, and cannot.** Another holder may be another
spore, another agent system, a script or a person logged in as the same user. Two entries in
`sources.json` may carry the same token under different names, and the `ssh-agent` socket is
reachable by every spore of the user, whether its definition names the ssh plugin or not. A
spore has no way to address another, and a fork or a clone is not told what it is (§Cutting a
spore from another), though a fork inherits, as its origin does, the commitments made before the
cut. So holders of one account act in concert only through what the operator writes into their
identities and through the account's own history on the platform, the one record every holder
sees (`docs/operating.md` §Accounts held by more than one spore).

### What an agent's programs may import

The answer to "read this spreadsheet" is a program the agent writes
([principle 1](PRINCIPLES.md#1-a-spore-writes-programs-for-work-that-repeats)), and a
program that has to reimplement xlsx first is one it will not write. So the package depends on
nine libraries for the agent's sake alone — nothing in `src/` imports them — declared as
`PROVISIONED_MODULES` in `rust/workspace` and read by `src/delegation/agent-env.js`: the formats
work arrives in (`csv-parse`/`csv-stringify`, `fast-xml-parser`, `yaml`, `cheerio`, `fflate`),
and the three places hand-rolled code is wrong while looking right — `decimal.js` for money,
`luxon` for time zones, `ajv` for checking generated JSON against a schema. Documents and
images are plugins', offered as `modules`: `plugins/documents` (`exceljs`, `mammoth`,
`officeparser`, `pdf-parse`) and `plugins/images` (`sharp`).

What earns a place is **a format or an arithmetic that is unreasonable to redo and easy to get
subtly wrong**, not "might this be handy". What the machine already does stays a command:
`/usr/bin/tar` creates, lists, extracts and writes a single member to stdout under confinement,
`--zstd --xz --bzip2` included, so there is no tar package, and `libraries.md` says so under
`fflate`.

**Each library has a worked example.** A model's guess at an API is drawn from whichever
version it was trained on, so `libraries.md`, seeded
beside `reference.md`, carries one worked example per library — the call and the output it
produces — and each plugin offering modules does the same in its own `reference.md`. The test
suite runs those examples **out of the file the agent reads** (`test/libraries-examples.test.js`,
and each such plugin's `test/reference.test.js`), with no generation step, so an example cannot
drift from what it claims and a library that changes its API fails a test instead of misleading
an agent. The documents plugin's examples read files built rather than committed, by its
`test/fixtures/make-documents.mjs`.

**`provisionModules()` links one entry per declared library into `<ws>/node_modules/`**, at
both levels: `openWorkspace()` for the spore, `rust/runner/src/spawn.rs` for a cell. Node
resolves a bare import by walking up from the importing file, and an agent's program lives in
`<ws>/data/`, which never reaches the package.

- **Links, not copies**, and **one per library, not the directory**: what is offered is what
  was declared.
- **Reachable to import, not to read.** `safePath` canonicalises through the link and refuses,
  `PATH_ESCAPE`.
- **Declared and not installed is refused**, `PROVISION_INCOMPLETE`, naming every missing one,
  before a single link is made.

`reference.md` lists them too.

### One reading of what a call did

**`readOutcome()` (`src/core/call-record.js`) is the single reading of a tool result**, used by
the loop guard, the `tool_end` event and session memory, so none of them can disagree about
whether a call worked. It reads marks, never text. `tool_end` also carries how a call that did
not work ended — `exit`, a command that ran to its end and exited non-zero, which may be its "no"
(`grep` finding nothing), apart from `killed`, `signal`, `spawn` and `refused`, calls that did not
finish or never ran — so a console marks the first with its exit code and only the others as
failures.

**A refusal is a value** (`src/core/refusal.js`). A tool that will not run returns
`refuse(reason)`; the kernel shows the model `error: <reason>` and marks the tool message
`refused`.

**A call record is a value too** (`recorded`, `src/core/call-record.js`). The five tools that
produce one — `read`, `write`, `edit`, `exec`, `wsexec` — return the record; the kernel shows
the model its JSON and marks the message `record`, and `readOutcome` reads an exit code only
from a message so marked, where the text is known to be the runtime's own. Anything else a tool
returns is text and worked by getting that far — `ask` and `quiet` return what the model wrote,
which may begin with `error:` or be JSON with an `exit` in it. Both marks are persisted beside
the message in the transcript, so a replay reads them the same way.

**Every call leaves a record, refusals included.** `recordRefusals()`
(`src/tools/make-tools.js`) wraps every tool: a refusal, returned or thrown by `safePath`,
becomes a refusal record in the trail, and the model is told the refusal's detail — what to do —
rather than the rule it broke
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)). Every tool validates before
`trail.begin`, and the budget paths `abandon` the call before returning, so a refusal always
means nothing was written down.

### One budget, on what the model actually receives

`read` measures what it will return — the whole serialized record, not the bytes it sliced —
before the call is written down (`trail.preview`), and refuses with the real figures when it
will not fit. The transcript sanitiser (`src/resilience/transcript.js`) is the backstop for
anything that did not budget itself: when it has to cut a record it keeps the shape and drops
the largest field rather than slicing the JSON, so the agent still sees which file and how big.

### Nothing in the runtime refuses a command

No pattern gates `exec` or `wsexec`, and no call is refused for repeating another
([principle 9](PRINCIPLES.md#9-spore-only-blocks-what-it-can-truly-stop)). What a
command can do is bounded where it is enforced: `exec` runs read-only under `confine`, `wsexec`
under the agent's own ruleset, both with `NO_NEW_PRIVS` set. A command the system will not carry
out is refused by the command — `rm -rf /` reaches GNU `rm`, which refuses and says why — and
recorded with its exit code.

The loop guard (`src/resilience/loop-guard.js`) observes and never refuses. It has two signals:
one tool failing five times running, and the same tool returning the same result to the same
arguments five times running. It compares the result as well as the arguments because a
workspace is mutable — cells write into it while the agent watches, so the same `wc -l` twice
is how an arrival is seen, and it is the wait-loop `reference.md` teaches for a detached
fan-out. Either signal wraps the turn as `soft:progress`.

### The reference

`reference.md` is the agent's account of the runtime: what each file is, what each command
accepts, and, last, what the runtime will refuse. It comes from the spore's sporangium, beside
`spore.cmk`, and is replaced only by `spore upgrade` (§Plugins, Documentation that moves). The
split with the identity is by cost: the identity is the cached prefix, paid on every round of
every turn, so it carries the ordinary path and one line pointing here, while the reference —
about 30 KB — costs nothing until the agent reads the part it needs.

**The runtime names it in `rules`** (`src/core/workspace.js`), together with
`libraries.md`, whenever they are seeded: `--definition` replaces the identity wholesale, so a
custom identity may carry no pointer, and `rules` already means *what you can reach
here*.

**Only the spore gets one.** `openWorkspace()` seeds it; a cell reaches `runSpore` through
`bin/spawn-worker.js` and is seeded no reference.

### One runner per workspace

The lock is `flock(2)` on the `lock` file's descriptor, taken before anything is written to it
(`acquire_lock`, `rust/workspace`).

**The kernel releases it when the holder dies**, however it dies, so liveness is never a pid to
interpret ([principle 15](PRINCIPLES.md#15-the-folder-is-the-spore)): a `SIGKILL`, a power
cut and a clean exit all leave a workspace that can be started again, and a pid reused by an
unrelated program does not read as running.

**It acts on a descriptor, not a path.** Under a Landlock ruleset, writing `lock` by path,
reopening it read-write and unlinking it are all EACCES (measured, ABI 6), so release truncates
the file — a reader with only the file sees nobody home — and closes the descriptor, which drops
the lock (`release_lock`). Acquiring happens before confinement, in the two supervisors: the
runner for a turn, `spore-spawn` for a cell.

**The file's content is a separate fact from the lock**: the pid and `startedAt` of whoever
claimed the workspace. `stateOf()` (`src/core/state.js`) reads running from the holder of the
`flock` (`lock_holder`), and a pid left in a file nobody holds as a crash, since a clean release
truncates. The next runner takes the lock with nothing to clean up.

### Turns of one user

A workspace lock bounds one spore to one turn; nothing in it bounds all of a user's spores.
That bound is **admission slots** (`take_slot`, `rust/workspace`), per user as everything under
`$XDG_STATE_HOME` is: `turns` files in `$XDG_STATE_HOME/spore/slots` (falling back to
`~/.local/state/spore/slots`), `turns` being the host setting
([principle 14](PRINCIPLES.md#14-the-computers-limits-belong-to-its-owner); `docs/operating.md`
§`config.json`). A turn holds one slot's `flock` from before its message is said until its runner exits.

**Taken by the caller, held by the runner.** `send` and `fork` take a slot before they write
anything, and with none free they are refused — `ADMISSION_FULL`, retryable, nothing said or
made. The slot goes to the detached runner as fd 3, and the caller closes its own copy. A runner
refuses before it opens anything unless `/proc/self/fd/3` is the `--slot` path it was given, and
it marks the descriptor close-on-exec (`check_slot`, `rust/runner/src/main.rs`), so neither the
agent nor anything it runs holds the slot, and a process a tool leaves behind cannot keep one.
A message to a turn already running takes no slot: it joins that turn through the inbox.

**Refusing is spore's, waiting is the caller's.** Nothing queues inside spore. `runBatch` tries
a refused start again on its next poll; `spore tick` holds a due schedule for a later pass;
`spore send` and `spore fork` say so and stop; the chat plugins tell the chat it is busy; the
HTTP API answers `503`.

**The directory is outside every sandbox grant.** `flock` needs only a readable descriptor, so
a slot a confined agent could open is a slot it could hold.

**A pause is a mark beside the slots**, `$XDG_STATE_HOME/spore/paused`, holding when it was
made and why, if said (`pause`, `rust/workspace`). `spore pause` writes it first and then stops
every running turn and every running job of the user's spores, so nothing starts behind the
stops. It is read where a slot is given: while it is there `take_slot` refuses `PAUSED`, so
`send`, `fork` and a release are refused as with every slot taken, nothing said or made. A cell
outside any turn takes no slot and checks the mark itself.

**Paused spores take nothing new from outside**: a person's message is refused and they are told
why, and the webhook service answers `503` before it reads a body, checks a sender or runs a
router — a pause is often called because of what is arriving, so nothing of a delivery is kept,
and whether it comes again is its sender's retry policy. What the spores themselves owe waits:
a job's message stays held, a schedule keeps its due slot, and `spore tick` passes without
firing. Once the mark is gone, the next pass releases what was held and fires what is due, one
catch-up slot per schedule. A stopped turn is not resumed; what it had not answered stays unread
for the next turn in its spore. A second pause keeps the first mark and stops whatever runs. The
file is the pause: one made by hand, empty, pauses as well.

### Grants, limits and how a turn ends

**Tools are exactly what the frontmatter lists**, in a root definition and a precursor alike,
and a definition listing none grants none. The default sporangium is laid down as every
sporangium is, so the identity and tool grant are always read from a parsed `spore.cmk`
([principle 19](PRINCIPLES.md#19-each-default-is-written-once)). The shipped default lists all seven. The seeded copy is the spore's own
to edit and is not overwritten once present, so the default is a starting point rather than a
policy. A narrower list shapes what the agent reaches for and bounds nothing
([principle 8](PRINCIPLES.md#8-protection-comes-from-the-computer-not-from-good-behaviour)):
`spawn` is `$SPORE_SPAWN`, run through `wsexec`, a shell with the whole environment.

**Every limit is required** — `rounds`, `cost` and `wall`, each a soft/hard pair — and a
definition missing one does not parse; `loop()` throws rather than supplying a round count.
`spore send` and `spore fork` print the model, the tools granted and the limits of a turn they
start (`renderHeader`, `packages/spore-cli/src/dispatch.js`).

**`stopReason` names how a turn ended** (README §How a turn ends): `answer`; `question`, the
agent calling `ask`; `quiet`, the agent calling `quiet`; `soft:<dim>` and `hard:<dim>` at a
limit ([principle 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops)); `cancelled`,
a turn stopped from outside; `error`, a turn that failed or died (§A turn that died still
happened). `ask` and `quiet` are the only tools that end a turn. A soft limit wraps, telling the
agent to answer with what it has and say what is unfinished; a hard one stops it, and
`buildContinuation()` assembles a record from the trail, the transcript and the files — no model
call, since the model is what was stopped. Every ending leaves the same directory behind, so
every one is continued the same way: `spore send` again, with the reply, the correction, or
nothing new at all.

### The transcript

**Only the spore is resumable.** Sending again to the same workspace continues it, because the
transcript is replayed as the opening history; the directory's state is the whole of it. A cell
has no transcript to replay and needs none.

`runSpore` writes the transcript itself, in `state.sqlite`, so the command and any library embedder
read and write the same transcript. `openWorkspace()` is what the entry points have in common:
it resolves the directory, refuses a granted path, installs a `--definition` given for a
workspace that has none, reads the definition, stages its grants, seeds the root documents and
the precursor catalog, and returns the identity, grants and domain rules. What differs between
entry points is presentation, not state, so a conversation started in the console continues
under `spore` and back again.

**An entry is `{ at, kind, role, message, marks }`, `kind` a message or a compaction.**
`message` is exactly mohdel's wire `Message` — what is replayed is what a model can be sent,
and the gate refuses a field its `Message` does not define. Spore's own facts sit beside it:
`at`, and `marks` for what the message is to spore. In memory the marks live in a side table
keyed by the message object (`src/core/marks.js`): `wrap` for the notice a soft limit adds,
`compacted` for the summary that replaces a compacted head, `context-notice` for recovery's note
after a drop, and `refused` and `record` (§One reading of what a call did).

**The transcript is replayed; the trail is not.** The agent reads both and can rewrite neither
([principle 13](PRINCIPLES.md#13-a-spore-cannot-rewrite-its-own-history)).

### Disk on one machine

A spore's records stay small — about 22 MB for ten thousand turns, measured — and `retain`
bounds its trail. What can hurt is one turn writing without end: a `wsexec` may run an hour,
which at disk speed is the whole disk, and a full disk fails every spore's writes and everything
else on the host. Two bounds hold it, both host settings beside `turns` with their defaults in
`rust/workspace` ([principle 14](PRINCIPLES.md#14-the-computers-limits-belong-to-its-owner);
`docs/operating.md` §`config.json`).

- **`largestFile`**: the runner sets `RLIMIT_FSIZE` on the agent, soft and hard alike
  (`limit_file_size`), so everything below it — `exec`, `wsexec`, the agent's own `write`,
  every cell — inherits it and cannot raise it. A write past it fails with `EFBIG`, or ends a
  command that has not ignored `SIGXFSZ`; the call record says which. The default is 1 GB. It
  bounds each file, not a turn's total.
- **`freeFloor`**: before each turn the runner checks the workspace's filesystem (`statvfs`),
  and below the floor records the turn as an error, `DISK_FULL`, without starting the agent;
  its message stays unread for the next. That covers what the cap does not — many files each
  under it — at the next turn rather than inside this one.

`diskUsage()` (`src/core/spore-dir.js`) measures a workspace by what holds it — `data/`, the
records, the call streams, what was sent, the rest — without following links, so a corpus and
the provisioned modules are not counted. `spore show` reports it and `spore ls` each total; only
`ls` walks every workspace, and the TUI and `spore tick`, which list on every tick, leave sizes
off.

### What a user's spores spend

Spore bounds a turn — `cost` for its tree, held by the model broker on settled spend — and how many
turns run at once, the slots; it does not bound what all of a user's spores spend together. That
total is the operator's, or an orchestrator's: every turn record carries its settled `ownMicros`
and `treeMicros`, `watchAll` and the `turn_end` event hand them over as turns end, `spore usage`
sums them, and `spore pause` stops every turn and job and starts none. A turn running when such a
total is reached is bounded by its own `cost.hard`.

### CPU and memory on one machine

**A turn stands back from the host** (`yield_to_host`, `rust/workspace`). The runner starts the
agent at nice 10 and `oom_score_adj` 500, and everything below it — every command, every cell —
inherits both; each is only raised, never lowered, so a runner already standing further back
stays there. They are constants rather than settings.

**CPU is not capped.** It is bounded three ways — admission slots for how many turns, `wall` for how
long, each command's timeout.

**Model calls in a tree go as wide as `modelSessions`**, a host setting. A turn and every cell
under it call the model through its runner's socket, and a mohdel session serves one call at a
time, so the runner starts one session with the turn and another each time every one is busy,
up to that count, and stops none before the turn ends. A turn without cells keeps its one; a
fan-out gets the width it asked for, at about 56 MB a session. A call that finds all of them
busy waits for one with no bound of its own, since the turn's wall bounds the whole tree. Under
a shared gate the runner hosts no sessions and the gate's pool is what is sized.

**Memory is not capped, only ranked.** Running out of it is what takes a machine down, and the
kernel chooses what to kill by size — a browser before a small runaway. With the score raised,
a spore's command goes first; the agent sees a command killed by `SIGKILL` and the turn carries
on.

## Turns the clock starts

A schedule is a message said by the clock, and it goes through `send()`: the inbox, the lock race
and admission, as any other message does
([principle 16](PRINCIPLES.md#16-every-message-lands-in-the-same-inbox)). Nothing
in the runner, the loop or the brokers knows a turn was scheduled; the agent learns it from the
message.

**The declaration is a file**, `schedules/<name>.cmk` in a root workspace, in the precursor's
shape: `when`, `tz`, an optional `late`, and a body that is the message (the README's §Turns the
clock starts). `when` is a five-field cron expression read on the wall clock of `tz` — required — or
`at <instant>` for one firing, whose offset is part of it. `rust/definition/src/schedule.rs`
parses it and computes when it is due, with croner on jiff, so the pass, `spore show`, `write`
and `edit` apply one rule ([principle 18](PRINCIPLES.md#18-each-rule-is-written-once)).
Daylight saving is croner's: a fixed-time slot the clock skips runs right after the jump, and
one the clock repeats runs on the first pass only.

**The inbox entry is the record of a firing**: its `schedule` and `due` beside `at` and `text`.
What fired last is read back from it ([principle 15](PRINCIPLES.md#15-the-folder-is-the-spore)).
`saidOf` renders it as a line ahead of the text — which schedule, which slot, and that no one sent
it just now — because nobody is there to answer a question about it, and a slot hours old is
something the agent should see.

**One pass fires what is due**, `tick()` (`src/core/tick.js`). It takes `tick.lock` beside the
admission slots, walks the workspaces `spore ls` finds, and for each schedule takes the latest
slot at or before now that is after both the slot it last fired for and the file's last change —
a changed schedule means from now. That is one firing however many slots were missed, and none
for a slot older than `late`. It fires only into a spore that is `idle`, `wrapped`, `halted` or
`cancelled`, the rule the runner applies to carrying on. A held slot fires once released, for its
latest slot. One firing per spore per pass. `ADMISSION_FULL` leaves it due: the
pass is the caller, and waiting is the caller's
([principle 14](PRINCIPLES.md#14-the-computers-limits-belong-to-its-owner)). It never waits on a
turn — `send` starts the runner detached — so the lock is held for as long as reading the
directories takes, and a pass that dies loses nothing. After the schedules it starts a spore's
dream when one is due (§Dreams). The same pass releases what routers held
(§Deliveries nobody typed) and reports a job whose supervisor is gone (§Jobs).

Nothing idle is resident, so the host runs the pass: one timer per machine, not one per
schedule. `spore tick` runs it by hand, the `tick` service's timer every minute
(`bin/spore-tick.js`), and `spore-api --tick` in a container that has no timer; the lock makes any
two of them fire each slot once. Its environment is the one `spore send` needs, since the runner
takes the provider keys from it.

**The spore's agent may write its own schedules** only under `schedules: [count, interval]` in
the root definition, which makes `schedules/` a write island and bounds it: at most `count` files
that can still fire, and no two consecutive slots of one closer than `interval`, measured on the
slots over the coming year — `*/5 9 * * *` fires in one hour of the day and is five minutes
apart. `write` and `edit` check the file as it would be against the directory as it would stand,
and refuse in the call that made the mistake. `wsexec` and a hand edit go around them, so the
pass checks again and holds what breaks the grant, saying which file and why; nothing fires in
its place. **The grant is also counted on what fired**: across every schedule, at most `count`
firings within any `interval`, read from the inbox, which holds every firing. A slot past the window
is held, saying so, and fires once the window allows. Without the line, `schedules/` is a read path
to the agent and its operator's to write, and nothing is counted. `fork` and `--from` carry no
schedules.

The bound makes what the clock may start arithmetic over declared limits:
`count × ceil(day / interval)` turns a day, a true maximum, which `spore show` prints beside their
nominal cost — each turn at `cost.hard`, which a turn can end past by what was in flight
([principle 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops), §The model broker). It
is not a forecast of any turn.

**A turn may end with nothing to say.** `quiet` ends the turn with stop reason `quiet`, `output`
null, and its `because` kept in the turn record and the `complete` event, where no consumer
mistakes it for an answer. The turn records `concluded: true` — it ended on its own terms, having
dealt with what it was sent — so `stateOf` reads it `idle`, the runner carries on to anything
unread, and the command exits 0. An empty reply stays a glitch the loop nudges, and a failure is
never quiet, so silence, a glitch and a failure never look alike
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)). A reply that only told the
person what the model is about to do (mohdel's `commentaryParts`, no answer and no call) is none of
them: it goes back into the transcript as said, its phase kept, and the loop calls again, within the
bound an empty reply has.

**Quiet is for a turn no person spoke in.** When the turn holds a message someone wrote — one with
no schedule, hook or job as its origin (`origin_of`, `rust/workspace`), whether it started the
turn or arrived mid-turn — `quiet` is refused, and the refusal quotes that message.

**Delivery is a consumer's.** A scheduled turn ends like any other, in the `turns` view and the
event log, and its answer is addressed to the spore's default reply-to (§The workspace database);
whoever serves that place delivers it. A `quiet` one is addressed nowhere, and one that ended
without an answer is addressed like an answer (`plugins/telegram/README.md`).

## The HTTP API

`bin/spore-api.js` (`api/`) is the library's verbs over HTTP, for a caller elsewhere — another
machine, or an application in a container of its own beside a spore container joining no network —
on the library as the webhook service is ([principle 17](PRINCIPLES.md#17-spore-watches-it-runs-no-central-service)).
It runs as a service (`spore service define api`) or as a container's one long-lived process, and
adds nothing a verb does not do: no `define`, no `rm`, no scheduling between callers. Its
configuration is `api.json`
([docs/operating.md §The HTTP API service](docs/operating.md#the-http-api-service)).

**Where and who.** It listens on a unix socket, an address — loopback unless told another — or
both; exposure is a reverse proxy the operator chooses. Each caller is a token, named as `${VAR}` and read from
`environment` so the file holds no secret, with the spore names it reaches. Every request carries
its token, on the socket too, since every agent can `connect()` to a socket it sees
(`SECURITY.md`); tokens are kept as digests and compared in constant time, and a spore outside a
caller's names is answered as one that does not exist. A name is resolved under `home`, so
`GET /v1/spores` lists the caller's spores under `home`, and a spore that `workspaces` lists
outside it is neither listed nor reachable by name. A turn the API starts is given the service's
environment without the tokens.

Each route is a verb, under `/v1`, JSON in and out, errors typed as the library's; the routes are
in [INTEGRATION.md §The HTTP API](INTEGRATION.md#the-http-api).

**One trace end to end.** A request's `traceparent` is the parent of its span
(`spore.api.<route>`); a message is sent with that span's context, which its inbox entry keeps,
so the runner's `spore.turn` is its child and the rest follows as it always does — the agent's
`spore.dispatch`, each cell's, each model call's `traceparent` in mohdel's envelope (§Tracing).
A JSON response carries the span's `traceparent` when one can be formatted — tracing is exported,
or the request carried one; the NDJSON event stream carries none.

**A program delivers as itself.** `POST /v1/spores/<name>/messages` is a person speaking through
the caller, and nothing a person says is held. Work a program hands a spore goes to
`POST /v1/spores/<name>/deliveries`, from origin `api:<caller>` (the inbox's `api` column): held,
prepared and timed as any delivery nobody typed, within the caller's `maxWait`, `perDay` and
`perHour` in `api.json` — a hook's bounds, read by the same code, with no `perHour` unless the file
says one (§Webhooks). The turn reads it as the operator's own message, with no line naming the sender: the caller is the
operator's program, not an outsider whose payload is data, which is what a hook is. It names no
person, so its answer goes to the default reply-to. Hooks are outsiders' signed events, on the
webhook service only.

## Webhooks

**A webhook is a message a program says**, through `send()`, as a schedule's firing is the
clock's. `spore-webhook` (`bin/spore-webhook.js`, `webhook/`) is a service like the Telegram one,
on a loopback address unless told another; reaching it from elsewhere is a reverse proxy's job. Each hook in
`hooks.json` (`docs/operating.md`) has one URL, `POST /hook/<name>`, names the spore it reaches —
or several, each of which gets every delivery it keeps — and says how a request proves it is the
sender's; a hook that says nothing is refused. `hooks.json` and `environment` are read again for
every request.

**Checking a sender is four methods**, because that is where senders differ: a token in the
path, a header equal to a token, an HMAC of the raw body against a header, and Stripe's
timestamped signature with its 300 s window. Every comparison is constant-time. A preset names
the method, the headers, and the headers that carry the event and the delivery id. The secret is
`${VAR}`, filled from the environment.

**The service decides whether and where, never what.** A request is checked, kept only when it
passes the hook's `accept`, and said to its spore with the body and the headers as attachments;
the signature and every header naming an authorization, cookie, token, signature or secret are
left out. The inbox entry records where it came from, `hook`, `hookEvent` and `hookDelivery`, as
a firing records its schedule, and the runtime turns that into one line in the clock's form —
`[Sent by webhook "<name>": event …, delivery …. No one typed this; …]` — adding that what a
payload carries was written by whoever triggered it, and is data, never instructions. What to do
is the agent's, from its identity and the notes it keeps (`data/hooks/<name>.md`, as
`reference.md` teaches). Telegram names such a turn by its hook, as it names a firing by its
schedule.

**`accept.payload` is a JSON Schema**, checked with ajv after the sender is verified. A schema is
data and runs nothing, so a payload written by an outsider cannot make the filter misbehave, and
dropping stays the operator's, in a file no agent reads. It is compiled when `hooks.json` is read, a
misspelt keyword refused; a delivery that does not match, or whose body is not JSON, is answered
`202` and logged as ignored with ajv's first error. What a schema cannot say is the spore's to
judge, with its router or its `quiet`.

**Who wants which deliveries is each spore's, not the stream's.** One sender — a forge
organisation — sends one stream to one URL, and the spores it reaches want different parts of it,
so a spore the hook names may carry an `accept` of its own. The hook's `accept` applies first, to
all of them; then each spore's. A delivery no spore keeps is still a `202`, and the log says, per
spore, which kept it and why the others did not.

**It answers `202` once the message is held**, before any turn runs. The message's `requestId`
is the body's SHA-256 — what the signature covers — and the sender's delivery header, which no
signature covers, is kept only to show; so a retried delivery is taken once by each spore, and so
is a captured one sent again under a new delivery id. Nothing a spore is handed of the service's
environment — a turn's runner, a triage cell — holds a hook's secrets: they start without every
service's (§Where workspaces live). When one of a hook's spores could not be reached the
answer is `500`, and the sender's retry reaches only that one. `perHour` bounds the deliveries of
a hook let start a turn in each spore an hour, as an API caller's does (§The HTTP API), counted
from the spore's inbox and held deliveries, so a restart of the service forgets none. Past it a
delivery is said with `startsTurn` false on its entry: nothing starts a turn for it — not the
pass releasing it, not a runner carrying on after a turn — and the next turn reads it.
Otherwise a delivery goes the way every message nobody typed goes (§Deliveries nobody typed):
prepared and timed as its spore says, within the hook's `maxWait`, and held for the pass when no
slot is free. A body past `maxBytes` is `413`, a bad check `401`, an unknown hook `404`,
and every request while spores are paused `503` (§Turns of one user).

## Deliveries nobody typed

A webhook's delivery, what a job says (§Jobs) and what a program delivers through the API (§The
HTTP API) are messages no person typed, and all arrive one way, `deliver` in `src/core/route.js`: held first, prepared and timed when its spore says so,
released by the caller at once or by the pass — the one retry when no admission slot is free. A
release into a running turn looks at the lock again after, as `send` does, so a runner letting
go in between leaves nothing unread. A delivery reaching a running turn joins it and interrupts
whatever that turn was doing, so each is routed by its **origin** — `hook:forge`, `job:scan`,
`api:pipeline` — whoever said it.

**Two steps, in order, each optional.** A delivery is first *prepared*: the program the spore's
definition binds to its origin (`prepare:`) runs on it and attaches what it makes (below). It is
then *timed*: the spore's router or triage cell for the origin answers how long it may wait. Both
may apply to one delivery, and the second sees what the first attached. With neither, a delivery
is said at once.

**The bound is the owner's, the judgment the spore's.** A spore may keep a **router** for an
origin at `data/routes/<origin>.route` (or `.route.js`; `hook-forge.route`, `job-scan.route`,
`api-pipeline.route`), a program the spore wrote or its owner put there, asked how long each
delivery may wait. It answers with a wait, a one-line summary, and whether the delivery replaces
what is still held from that origin; its contract is in `reference.md` §Webhooks. It runs whenever
it exists. The owner caps the wait — a hook's `maxWait` in `hooks.json`, a caller's in `api.json`,
`jobs.maxWait` in `spore.cmk` — and without a cap a delivery waits for nothing: it is released as
soon as it is timed, its summary and `replaces` still taken.

- **It can only delay.** The router is code the agent may have written while reading text an
  attacker wrote, so it never delays by more than the bound, and never drops — dropping stays a
  hook's `accept` ([principle 9](PRINCIPLES.md#9-spore-only-blocks-what-it-can-truly-stop)).
- **It runs confined**, through `confine` as `exec` does: the workspace readable, nothing
  writable but a scratch directory, and an environment of `PATH`, `HOME` and `TMPDIR` — the
  service holds every hook's secrets in its own.
- **Failure delivers.** The delivery is held before the router is asked, until its 10 s timeout
  on top of what its prepare step may take; a router that exits non-zero, runs out its time or
  prints something else, or a process that dies meanwhile, lets it go at once or at that timeout
  ([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)).
- **A held delivery is not in the inbox** (`t_held`, the `held` view, keyed by origin), so it
  blocks nothing: the inbox is still read in order, and its order is the order of release.
  `wait: "0"` releases it into the inbox at once, joining a running turn as any delivery does.
  Otherwise `spore tick` releases it: once due, only while the spore is idle — every due delivery
  together, one turn for all of them — and past its bound even into a running turn.
- **The summary** becomes the entry's text, the payload still attached, so a turn reads one line
  per event rather than its body.
- **`replaces`** drops every delivery still held from the same origin: a CI hook going running →
  running → passed, or a job saying where it is again, leaves one.

**What a program cannot judge, a cell can.** A spore may also keep `precursors/route-<origin>.cmk`
(`route-hook-forge`, `route-job-scan`): run when it keeps no router for that origin, or when its
router answers `{ "ask": true }`, as a cell outside any turn (§A cell outside any turn) asked for
by that origin about that delivery. It finds the payload, the headers, what was prepared for the
delivery under `prepared/`, and a briefing in its directory and answers as a router does, under the same bound and the same failure rule; the held
delivery is kept for as long as the cell's hard wall allows. Such a cell is refused `enzymes` and
`reads`, as it is refused `sources`: under a turn a cell's supervisor sits inside its agent's
confinement, so what those grant stays inside it too, but outside one the supervisor is a host
process — an enzyme would run unconfined in its broker, and a read would be the cell's own grant
over whatever the host can read, from a precursor the agent wrote. `perDay` bounds the cells an
origin starts in a spore a day — a hook's `perDay`, a caller's in `api.json`, a job's
`jobs.perDay`, 100 when unsaid —
counted from the `cells` view; past it a delivery that would have asked one is delivered now, and
the log says why.

**What a prepare step attaches is data.** A spore's definition binds one of a plugin's `programs`
to an origin, by its variable, root only: `prepare: [hook:scans=pdf-pages/SPORE_PDF_PAGES]`, the
plugin allowed on the machine, with one `prepare.timeout` and one `prepare.attach` for every step
(at most 60 s, 100 files, 256 MB). The binding grants that program to the step alone: the spore's
turns get nothing of the plugin unless `plugins:` names it too, though what the plugin hides
(`contain`) is hidden from every process of the spore. The agent can write neither the definition nor the plugin. The step does
work no turn should spend a round on, before any turn reads the delivery. It runs as the router
does (`runStep`): the payload on its stdin, the same first four arguments, confined, in a scratch
directory holding `out/`. Where the router prints its answer, the step's is the files it writes to
`out/`, attached to the delivery under `inbox.d/<delivery>/<program>/`, of the same standing as the
payload. It never delays. It reads the plugin, the delivery's files and the spore's `reads:` grants
— exactly what its agent may read, never its `writes:` or the workspace. The delivery is held
carrying a line that the step did not answer, until its timeout, and its answer replaces that line
with what it attached, or with why it attached nothing (`attachHeld`) — so a step that fails, or a
service that stops while it runs, still releases the delivery, and the turn reads that nothing was
prepared rather than an empty set. A step that wrote past its bounds attaches nothing: a partial
result is not handed on as a whole one. A spore's own router does not attach: it may have been
written while reading attacker text.

## Approvals

**An approval is a choice the host asks named people to make, which no spore can make or fake.**
A "yes" that reaches a spore as text is one the spore could have written, and the spore is the
party an approval must not depend on. So an approval is asked by the host — `requestApproval`,
`spore approval ask`, `POST /v1/spores/<name>/approvals`, none of which an agent reaches: it can
write neither `state.sqlite` nor the API's tokens — in a conversation the spore is reached in,
of the people it names (`by`, their ids as the bot file writes them), with fixed options. It
counts only as a press of a button the relay posted, by one of them, as the platform vouches for
them: Telegram's callback query, Teams' signed `adaptiveCard/action` invoke. `answerApproval`
takes a press only from someone the approval names, on one of its options, with what was filled
in fitting its fields, whoever calls it; what only an adapter can know, that the platform vouched
for the person, is the caller's. The first such press wins — `answer_approval` is one update on
`state = 'posted'`, so a second press, a repeat of the first or a press past `until` changes
nothing — and a press is matched to its approval by the id its button carries, never as whichever
is pending.

**Flow and presentation are separate.** The flow is spore's and the same on every platform: who
may answer, the options, the first press, the deadline, the hook, closing the question, telling
the spore, and `shown`, the payload exactly as posted with its buttons, which the hook receives —
what the person saw. The presentation is the host's: `body` holds one entry per platform kind —
an Adaptive Card for `teams`, `{ html }` for `telegram` — or `default`, text and label/value
facts each adapter draws in its platform's own way. The relay owns the buttons whatever the body,
so a body may carry nothing that answers back to the bot (`checkBody`; in Teams no
`Action.Submit`, `Action.Execute` or `refresh`, wherever it sits): a button of the host's would
bypass `by` and the first press. **What a person fills in is the flow's too**: the request's
`fields`, `{ id, label, value?, required? }` beside the options, which the relay draws with the
buttons where the adapter shows fields (`can.fields`; Teams as `Input.Text`, so a host's own
`Input.*` is refused like its own button). A press is taken only with what it fills in fitting
the declaration — declared ids, text within the limit, every required one filled in
(`inputsProblem`) — and answered with why otherwise; what it held goes with it, as `inputs`, to
the hook — the spore learns what the hook's `tell` says. Where an adapter shows no fields, the
relay decides once for every platform: a required field refuses the approval there, an optional
one is left out and the hook gets no `inputs`.

**`t_approvals` is the record, and the relay works from it.** `state` goes `asked` → `posted` →
`answered` or `expired`, or `asked` → `refused` when the relay will not post it: the conversation
does not reach that spore through the bot, the platform carries no approvals (`can.choose`),
there is nothing to show there, a required field cannot be shown there, or the platform refuses
it. Every second the relay reads each
followed spore's open approvals and starts what each still needs, one at a time per approval, so
a restart carries on from the database and never from memory: the host's hook told how it ended;
the question closed — replaced by the body the hook answered, or kept with its buttons gone and how
it ended below; `settle_approval` writing the hook's `outcome` (`confirmed`, or `failed` with its
`reason`), what `replaced` the question and the hook's `tell`; then the spore told. A hook can
therefore be told twice of one approval, and keys on its id.

**The hook** is named in `config.json`'s `approvals` by its URL and the `${VAR}` holding its secret,
which reaches no turn. It is a POST signed with HMAC-SHA256 over `<timestamp>.<body>`, tried again
for about a minute on a network failure or a 5xx; its answer `{ body?, tell? }` closes the
question and is told to the spore. Without one, the choice is still written down, the question
closed and the spore told.

**The spore is told by a message in the conversation**, under the request id `approval:<id>` so
it is said once, carrying `approval` on its inbox entry and, for a press, the person as its
`from`. `saidOf` reads it as recorded from the platform's buttons and typed by no one. It starts
a turn answered in that conversation, so the conversation goes on from it. An expired approval is
told as nobody answering; a refused one was never shown, and only the hook is told.

**The deadline is `within`**: a duration (`2h`), or working days on a `calendar` (`2wd`: the same
wall-clock time on the second working day after the day it is asked, in the calendar's zone,
skipping the weekdays it does not work and its holidays) — `deadline()` in `rust/definition`,
computed once when it is asked and kept as `until`.

## Jobs

**A job is work a turn starts that outlives it**: an hour-long scan, a download, a build, waiting
on a remote system. Everything else a turn starts carries its owner token and is swept when the
turn ends (§The spore command) — no orphans, nothing writing `data/` under the next turn, nothing
unaccounted — so a job is started explicitly, bounded, and its end is a message, not something
polled.

- **Granted by the owner**, `jobs: [count, wall]` in `spore.cmk` — how many at once, the hard
  wall of each — with `jobs.maxWait` and `jobs.perDay` bounding how its messages are timed; root
  only, as the agent cannot write it. Without it the runner serves no job socket.
- **Started through the runner.** `node "$SPORE_JOB" start <name> -- <command>` (`bin/job.js`)
  asks the turn's job socket, keyed as every broker is; the runner launches `bin/spore-job.js`
  detached — its own session, no owner token — so ending the turn leaves it, and the supervisor
  is outside the agent's confinement. Its environment is named, not inherited: paths, locale,
  tracing, no credential; it reads the operator's `environment` only when it releases something
  the job said or asks a triage cell, as the services do, so a key set only in a shell never
  reaches a turn a job started. It answers one line: the job begun, or refused (`JOB_RUNNING`
  under a name already running, `JOBS_FULL` past the count).
- **The supervisor** holds a lock in host state (`$XDG_STATE_HOME/spore/jobs/<run>.lock`, naming
  its pid) for as long as the job runs, records the run in `t_jobs` (the `jobs` view), and runs
  the command under `confine`, as `exec` runs one: the workspace readable, **writable only
  `data/jobs/<name>/`**, which it pins by descriptor before granting so a link cannot widen the
  grant — and the `writes` directories `jobs.writes: [<name>, …]` names, for a build or a test
  run that writes its outputs into the tree it works on. That is the definition's to grant, since
  it reaches only the spore's own `writes`, and it is the operator accepting what it costs: a job
  changes that directory after the turn has ended, beside whatever the next turn edits, and
  outside the turns `spore here` snapshots. Its own files there — `out`, `err`, `status.json`,
  `supervisor.log` — are made anew for each run, never through a link, and written through
  descriptors it keeps, so what the job does to the names reaches only itself; `t_jobs` is the
  record. The job gets an environment of `PATH`, `HOME`, `TMPDIR` and its own token, the
  largest-file cap and the host's standing. No model socket, no source socket, and
  `spore-spawn --standalone` refuses under its token.
- **Stopped at its wall**, or by `spore job stop`, which signals the supervisor through the lock;
  what it started is swept by its token when it ends.
- **Its end is a delivery** from origin `job:<name>`, event `ended`, `walled` or `stopped`, with
  `job.json` attached — prepared and timed as above, within `jobs.maxWait`, and kept for the
  pass when no slot is free. The entry records `job`, `jobEvent` and `jobRun`, and the
  agent reads `[Sent by job "<name>": ended, run …]`.
- **Progress is state, not an event**: the job writes `data/jobs/<name>/progress`, and the last
  line written this run shows in `spore show`, `spore job ls` and Telegram's `/status`.
- **`say` is an event**: `node "$SPORE_JOB" say <text>` from inside the job writes its `say`
  file, which the supervisor claims every 2 s — renamed first, read without following a link — as
  a `said` delivery, routed the same way. It is not claimed while what the job said before is
  held or unread, and a newer one replaces it meanwhile, so a job in a loop cannot start turn
  after turn. No socket, no key: the file is the channel.
- **Interrupted is reported.** A job recorded running whose lock nobody holds lost its
  supervisor — a reboot, a kill; the next pass ends it `interrupted` and says so, once.

## The workspace database

`<ws>/state.sqlite` holds every record a turn and its senders make: the inbox, the turns, the
transcript, the events and the call records. There is one per workspace, root or cell, with no
central store and nothing resident, so disk is still the truth. Kernel locks and admission slots
are not in it: a row says what was last recorded, never whether a process is alive.

| a row | a file |
|---|---|
| inbox entries, and how far the turns have read | long inbox bodies and attachments, in `inbox.d/` |
| transcript entries, their marks, compaction entries | definitions, precursors, schedules, `reference.md`, `libraries.md` |
| a turn's lifecycle, its outcome and settled usage | programs and artifacts in `data/`, memory notes |
| events, numbered | a call's unnamed streams, in `calls/<runId>/<callNo>/` |
| call records | a running turn's `spore.out` and `spore.err` |
| the workspace's totals and counters | provisioned modules |
| outbox entries, and whether each was delivered | |
| approvals the host asked, and how each ended | |

**One way to read.** The views are the contract: `turns` (final turns only, `ownUsd` and
`treeUsd` beside the micros), `inbox` (with `consumed`), `transcript`, `events`, `calls`,
`limits`, `held`, `cells`, `jobs`, `outbox` and `approvals`. A program reads them through the library, whose
records are the views' rows with JSON columns parsed and flags as booleans; a person with
`spore sql`, and the agent with `$SPORE_SQL` or `node:sqlite` in its own programs. Both commands
are one function (`src/library/sql.js`), which opens the file read-only. The `t_` tables behind the views are storage and free to change; a view selects and filters
and never renames. `reference.md` documents the views for the agent.

**Names.** Columns are camelCase, as JavaScript names fields. Money is stored as integer
micro-dollars (`…Micros`) and shown as dollars at full precision (`…Usd`), never rounded to cents,
since a turn can cost a fraction of one. A moment is `at`; a span is `startedAt` and `endedAt`.
JSON is stored as text only for what nobody queries field by field. Positions are counters that
pruning never reuses — `inboxNo`, `entryNo`, `seq`, `turnNo`, and `callNo` within a `runId` —
and the counters live in `t_workspace`.

**Who writes.** Only trusted code. The host side (`send`, `define`, schedule firing, the copies a
fork makes) writes through the addon, one short connection per write. During a turn the runner or
`spore-spawn` holds the turn's one writer connection and serves the agent's writes over its
channel (§The model broker). The agent never opens a writer: Landlock keeps the root, the
database and its sidecars readable and never writable to it
([principle 13](PRINCIPLES.md#13-a-spore-cannot-rewrite-its-own-history)), and `readOnly` on a
reader states intent rather than enforcing it. Nothing writable is handed into the confined
process, because Landlock does not revoke access through a descriptor already open. A message's
attachments are written to `inbox.d/` before the row that names them commits, so a crash between
the two leaves a file nothing names; nothing reclaims those.

**Where an answer goes.** A message may carry a `replyTo` — `terminal`, or `<kind>:<place>` such
as `telegram:main/42`, checked by `check_reply_to` in `rust/workspace` — and a spore may have one
default, `replyTo` in `config.json` by spore name (`docs/operating.md`), which `startRunner`
passes the runner and `begin_turn` records on the turn (`replyDefault`); a cell has none. When a
turn is made final, its answer is addressed in the same transaction: one `outbox` entry per
distinct reply-to among the messages it read, and the turn's default for those that carry none —
not when it ended `quiet`, which says nothing to anyone who did not ask. A turn that read nothing,
and a history a fork copies, addresses nothing. An entry names its `recipient` and the `inboxNo`s
it `answers`; its content is the turn's record, never copied. `terminal` is written `delivered`,
since the terminal that asked follows the turn; every other entry is `pending` until whoever
serves its kind settles it through `settleOutbox`, delivered or refused with a `reason`, once.
Whoever posts it marks it first (`attemptOutbox`, `attemptedAt`): a post the platform took just
before the poster stopped is never settled, so an entry found marked may have arrived already, and
it is posted again saying it may repeat. Dropping it instead would lose every answer whose post
did not arrive. A held delivery carries no reply-to: nobody typed it.

**What serves a chat's answers is a connector on the relay.** `@rhizogrip/spore/relay`
(`src/relay/`) is the half every chat connector shares, so its promises are kept once: a bot file
per bot, read on every message; the path from a message to `send` with its `from`; the `working…`
message and the calls at work, or a reaction and the platform's typing; the answer as a new
message replying to the question; commands;
the outbox drained and settled; approvals posted and seen through (§Approvals); the files a person
sends fetched with the bot's credential, capped by the platform and the bot file, and kept through
`send`'s `attach` — one that does not come kept on the entry with why, so a turn never answers as
if it had it; a restart from saved cursors. What a message is to the spores is
one decision, `admission`: said to them, overheard by them where the routing overhears, or dropped
at a named gate — not addressed, or from someone the routing's `people` do not name, which is
logged with the line to add. In a conversation many people share, stopping, wrapping or extending
a turn is for those its `people` name, not everyone `"*"` lets talk. A conversation the routing
makes `brief` — each one a bot's `"brief": true` covers unless it says otherwise — is told its
spore's state and its answers and nothing of how it runs: no model, spend, limits or stop reason,
no schedule, webhook or job that started a turn, and no path in the workspace — which go to the
service's log — and no `extend`, since what a turn may spend is the operator's. A
connector is its adapter —
the transport, the platform's API, what it calls a conversation and a person, and whether a
message addresses a spore — and passes the conformance suite (`test/fixtures/relay-conformance.js`)
against its fake platform (`docs/relay.md`). Telegram's is `plugins/telegram/src/adapter.js`:
private chats under `people`, groups under `groups` with one spore each, since a bot speaks in a
group as itself, reached by a reply to it, a command, or a mention of the bot (which Telegram
hands over only with the bot's privacy mode off, or to an admin), and overhearing the
rest where the group says so. Discord's is `plugins/discord/src/adapter.js`: several spores to a
channel, each reached when addressed and speaking under its own name through the channel's
webhook, which cannot reply — so an answer opens with whom it answers; it overhears nothing, since
its spores read a channel's history themselves. Teams' is `plugins/teams/src/adapter.js`: a
listener on loopback behind the operator's proxy, each activity's Microsoft-signed token checked
before it is read; a person's personal chat keyed by their Entra object id, a channel message's
conversation its thread, which routes by its channel (`routeOf`), so an answer goes back into the
thread while the routing names channels. Slack's is `plugins/slack/src/adapter.js`: a Socket Mode
connection the service opens, so nothing listens; a person's direct message keyed by their member
id, a mention in a channel its thread, routed by the channel as Teams' is; an answer in a direct
message is a plain new message, since one person's conversation reads in order without a reply.
The console's is `plugins/console/src/adapter.js`: its other end is a program, over HTTP on
loopback, so what the relay does in a person's conversation is written to the console's own event
log, numbered by a `seq` that never repeats, and the program reads it back from the last `seq` it
saw; a message is said under the program's own id, so one sent twice is said once. It has no
conversation many people share.

**Journal mode.** A file is in WAL mode while a writer holds it and in rollback mode when none
does, with `synchronous=FULL`, foreign keys on every connection, and a 5 s busy timeout on
writers. SQLite runs no busy handler for a change of journal mode, so a writer opening an idle
workspace while another process holds it — two senders at once, or a sender and a runner closing
— retries its switch into WAL itself, for the same 5 s, rather than failing at once. An idle
workspace has to be a plain file, because opening a WAL database needs its `-shm`, and a confined
reader can create nothing in the root. So the last writer to close switches back
(`PRAGMA journal_mode = DELETE`), which checkpoints the WAL and removes the sidecars. The switch
needs every other connection closed, readers included, and a reader never makes it, so a
supervisor's last act on its workspace is `leave_wal`, which retries the switch for up to 2 s
while readers let go, and says so in `spore.err` when a connection outlasts that; that connection
is a new turn's writer, and the switch is then its to make. Checkpoints are otherwise SQLite's
own, on the writer, at its default threshold.

A confined reader meets four cases, each run from a real confined workspace by
`test/sqlite-confined.test.js`: its own database during its turn, and a running cell's (a writer
holds them, so the sidecars exist); one nobody holds (a plain file); and one a killed writer left
mid-write (stale sidecars, from which what was committed still reads).

**Followers wake on `state.sqlite`, `-wal` and `-journal`, never on `-shm`.** A reader that opens
a WAL database as its only connection rebuilds the index in `-shm`, so a follower woken by `-shm`
wakes itself on every read and spins.

**Two SQLite builds meet on one file**: the Rust writer's bundled one (`rusqlite` 0.40.2) and the
one inside the Node that runs the agent. Both need the WAL-reset fix, so the Rust build is held to
3.51.3 or later, and the Node side's `sqlite_version()` is checked against the same minimum the
first time a process reads a workspace (`src/core/sqlite.js`). A live database is never opened
with `immutable=1`.

**Within one process the two builds never hold the file at once.** A host process — the CLI, the
TUI, the Telegram service — writes through the addon and reads through `node:sqlite`, and file
locks belong to the process: neither build sees the other's, and closing any descriptor on the
file drops both builds' locks. What keeps that safe is that every read and every host write is
one synchronous call that opens its connection and closes it before returning. A connection held
open across calls in such a process — a reader kept for speed — would let the other build write
under it. It is also why a test holding the database against the addon has to hold it from
another process (`test/busy-database.test.js`).

**The schema has a version**, `schemaVersion` in `t_workspace`, and one schema: the runtime
creates it whole. A database an older spore made moves forward the first time a writer opens it —
one additive migration per version (`MIGRATIONS` in `rust/workspace`), under the write lock and
looked at again there, so two writers migrate it once, leaving it as a fresh one at that version
would be (`migrates_a_workspace_an_older_spore_made_into_what_a_fresh_one_is`). A reader in the
library has it brought there too: the first read of a workspace in a process asks the addon
(`migrateState`), which looks at the version with a read-only connection and opens a writer only
when it is behind, so every read sees the views as this runtime defines them. An agent never
migrates: its runner did before it started. A database a newer spore made is refused, naming both
versions, by a reader as by a writer — `remake`, which exists for such a database, asks only the
lock whether a turn runs.

**A busy database is a failure, not a wait.** A writer still blocked after its 5 s timeout fails.
`send` refuses with `INBOX_UNWRITABLE` and writes nothing. A turn that can record nothing says so
in `spore.err`, adds nothing to the `turns` view, and is written down by the next runner as an
error, its message still unread (`test/busy-database.test.js`). A full disk and an I/O error take
the same paths and are not exercised.

**Copying a workspace.** Between turns, with no runner holding the lock, `state.sqlite` is one
file and the directory copies as it stands. A copy taken while a turn runs needs SQLite's backup
API for the database, never the main file alone, which lacks what is still in `-wal`; even then
`data/` is copied at another moment, since SQLite makes the database consistent and not the
workspace. `fork` copies records through the storage API rather than the file, and
`define --from` starts a fresh database.

## Watching a spore

A local TUI, a remote chat client and a service with its own pipeline all watch a spore work and
say something to it, and one shape serves all three: **two append-only logs and a cursor**
([principle 17](PRINCIPLES.md#17-spore-watches-it-runs-no-central-service)).

- **read** — everything after sequence *N* of the workspace's `events`
- **write** — a message added to its inbox, through `send()`

One number is the only state a consumer keeps: a `seq` for the event log, an `inboxNo` for the
inbox, which a turn already records. A client that disconnects asks again from where it stopped,
a late one reads the turn from the beginning, several watchers each keep a cursor and coordinate
with nobody, and a reader dying loses nothing because it held nothing.

**Sending goes through `send()`,** never a row added to the inbox by hand, so the lock race that
decides *start a turn* or *join the one running* is solved once; a consumer that writes the inbox
and spawns its own runner is how two runners happen. **Reading is `watch(ws, { after })`**, an
async iterator over the log, resumable on `seq`, ending when the turn does; `follow()` is the
terminal-shaped one `spore send` and `spore attach` use. The CLI's `tui/` and the Telegram plugin
are applications against the package that know nothing it does not export.

**A service in front of many spores is its own relay**: a chat bot or an application serving
many users is a long-lived process on the spores' host that calls the library, and its users'
protocol — the Bot API, an HTTP API of its own — is the transport. What it uses — the `inbox`
position `send` answers, `requestId`, and `watchAll` with its saved cursors
(`{ seq, turn, database }`) — is in
[INTEGRATION.md §A service in front of many spores](INTEGRATION.md#a-service-in-front-of-many-spores).

**Following wakes on change.** `watch` and `watchAll` sleep until the workspace's database
changes, with a 1 s bound for a change the kernel's queue dropped, and read the events past the
last sequence they handled — a query, not a reread of the log. A notice comes when a commit
writes the WAL, before SQLite makes it visible in its shared-memory index, which no notice
reports; read then, the commit is missed until the next one. So a notice is read again 10, 50
and 250 ms later. A follower catching
up reads 500 events at a time, each batch its own short read.

**The log is written by every turn** through its channel, as the transcript is, and numbered by
the supervisor: `seq` is the workspace's count, kept beside the events so pruning never hands a
number out twice. It listens on an emitter of its own and forwards to the caller's, so an
embedder keeps whatever shape it passed, and the record is written whether or not anyone asked
for it, because what a turn did belongs to the workspace.

### The event schema is a contract

Every event carries `v` (the schema, at 1), `seq`, `at`, `runId`, `turnId` and `event`, its
payload's fields beside them. Every name is in `EVENTS` in `src/observability/event-log.js`, and
all but `turn_end` cross from the agent. [INTEGRATION.md §Events](INTEGRATION.md#events) is the
canonical schema: every event and its payload.

Three rules, because consumers outside this repository read it: names never change meaning,
fields are only added, and a consumer ignores an event it does not know.

**`complete` and `turn_end` are two facts, and a consumer picks by what it needs.** `complete`
is written by the agent as its loop ends, at once — measured 14–27 ms before the turn is final,
or the whole drain when model calls are still in flight — and carries the answer and the loop's
own spend, and may be wrong about how the turn ended. `turn_end` is written by the supervisor in
the transaction that makes the turn final, carries the settled money and no answer, and is the
record. Where else they differ — a crash, a turn the agent never started — is tabled in
[INTEGRATION.md §`complete` and `turn_end`](INTEGRATION.md#complete-and-turn_end).

So: **render a reply from `stream` and `complete`; bill, count, match a sender's message or close
a turn from `turn_end`** — or from the `turns` view, which is the same fact. The answer is on the
record too, as `output`, written with the turn's outcome in one transaction. Retention prunes a
run's events with its trail, and an event that fails to write is only logged, so a finished
turn's answer is read from its record and `complete` is for showing it as it lands. A history a
fork copies in is not turns ending, and writes no `turn_end`.

**`stream` is the model's output as it is produced**, carried across the broker (§The model broker)
and emitted by `loop` one chunk at a time, its `kind` the provider's delta type as mohdel reports
it — `message` for the answer's text, `function_call` for a call's arguments, `commentary` for what
the model writes for the person while it works, `reasoning_summary` and `reasoning` (raw) when the
definition's `reasoning` asks for them — at mohdel's granularity, which
the loop sets with `bufferOpts` to at most 50 characters or half a second. `mohdel_idle` is named by
the schema and **not produced** (`PROMISED`): mohdel's factory never calls an idle handler, so
there is nothing to carry. It joins `EVENTS` when mohdel emits it, and every consumer has it
without changing.

**The stream and the log are two layers.** The transport delivers every chunk to the turn's emitter,
and anything listening there hears each one. The log is one listener among them and batches its own
lines — one per burst of a kind, cut when the kind changes (reasoning to the answer's `message`),
when any other event arrives so the log stays in order, after 100 ms, or at 4096 characters — and
`runSpore` flushes it when the turn ends, however it ends. **The log is how a reply is followed
live**: every consumer outside the process reads it, one rendering an answer as it streams included,
so the window is short enough for that. Its granularity is
spore's to tune, not a contract: a consumer reads `stream` lines of whatever size they come in.

**`loop` asks for deltas only when something listens for them** — `emitter.has('stream')`, not
the emitter existing. Since the log listens, that is every turn.

**The log keeps what `tool_start` and `tool_end` carry** — arguments, and the start of a result —
because it is the workspace's own record and the agent could read its own call records anyway.
What leaves the machine is a relay's decision, not the log's.

**The bound is `retain`**, the same one that bounds the trail: `prune_trail` drops the events of
any run whose records it dropped. `seq` keeps climbing through that, so a cursor that has been
pruned gets what is left rather than somebody else's event.

### Describing a call

**A call is described once, when it starts, and the description is stored on its `tool_start`**
— `title`, `category`, `detail` — so every surface shows the same words, and a turn read later
keeps the words it had. `title` is what a person is shown; `category` is one of `read`, `edit`,
`delete`, `move`, `search`, `execute`, `fetch`, `delegate`, `ask` and `other` (the Agent Client
Protocol's tool kinds, with `delegate` for sub-agents and `ask` for a question), for a surface
choosing an icon or a grouping; `detail` is the path or the command line, for a conversation that
asked for details.

**Three tables, the first match winning**: the spore's `:::call` blocks in its `spore.cmk`, in the
order written; its plugins' `describe`; then the runtime's (`rust/definition/src/call.rs`), which
names every tool and every program the runtime gives an agent, so every call matches something. A
row names its tools and, for `exec` and `wsexec`, a regexp over the command's first line,
whitespace collapsed — Rust's `regex` syntax, without look-around or back-references, matched in
time linear in a command the model wrote. Its captures fill the title and the detail as `$1`…`$9`, cut short in a
title and shown as plain text, never as markup, so a title carries only what its row captures —
the runtime's capture a source's name and nothing else — and a conversation shown titles alone
never sees a path or a command. A tool no row names, one the model made up, is shown by its name.

```
:::call search
tool: [exec, wsexec]
program: ^node "?\$SPORE_DA"? search (.+)$
title: searching for $1
category: search
:::
```

**The rows are data, not code**, because the description is made in the confined agent: it reads
its own `spore.cmk`, and is handed its plugins' rows in `SPORE_PLUGIN_CALLS` the way it is handed
their read paths. An embedder takes part through the `spore.cmk` of the sporangium it makes its
spores from. The rows, their checks and the match are `rust/definition`'s, one implementation for
the definition, the plugin check and the agent. A turn its spore was upgraded under wrote
`tool_start` without a description; `live` describes such a call from the runtime's rows.

### What a running turn shows

**One value, folded from the turn's events, which every surface renders**: `live`
(`src/library/live.js` — `createLive`, `applyEvent`, `liveOf`), so a chat, `spore send`, the API and
the terminal show one account of a turn rather than each reading the events its own way. It carries
every fact a surface may want — the rounds, the calls with their descriptions and how each ended,
the text being written, the notes (a wrap and its lifting, a message heard mid-turn, compaction),
the spend and the context of the last model call — and its `headline`, the model's own words on
what it is doing, from its latest round: what it wrote for the person (`commentary`), else the last
paragraph of its reasoning summary (`reasoning_summary`, when the definition's `reasoning` asks for
summaries), else the text it wrote before its latest call. Raw reasoning is never shown.

**The default rendering** (`renderLive`) is what a surface without a layout of its own shows, in a
few plain lines: `working…` with how many calls ran and, once a minute has passed, for how long; the
headline, one line cut short; the call running now by its title; and why the turn is wrapping up.
`plain` adds how that call ended — slow, an exit code, failed; `details` shows its detail, the path
or the command; `brief` drops how it ended and which limit was reached. It never shows a bound, a
count against a total or spend: a bound reads as a promise, and a count as progress the work may not
make. The terminal keeps its own layout, with the limits beside the turn, and an embedder may show
more; both start from the same value.

**An embedder adds a line of its own** (`annotate`, `spore annotate`, the API's `annotate`): an
estimate it computed, a place in its queue — whatever it knows that spore does not. It is an
`annotation` event written from outside the turn, in the transaction that finds the turn running,
so it reaches every surface as the turn's own events do, and goes with the turn: a new one replaces
it, `null` takes it away, and the next turn starts without. Spore shows it under the header and
never reads it; what it says, and when it changes, is the embedder's.

Where it is shown, all from `liveIn(ws)` — the running turn folded from its events since the last
turn ended, timed from the turn's own start, which a runner carrying on into a second turn does not
share:
- **a chat relay** repaints its `working…` message only when the rendering changes, at most once per
  the platform's edit interval — a call starting, one ending slow or failed, a wrap, or the minute
  turning, which the turn's 10-second heartbeats bring to it between calls;
- **`spore send` and `spore attach`** draw it on one line of stderr while stderr is a terminal, at
  `details`, cleared before anything else is written there and when the turn ends; `attach` to a
  running turn starts there rather than replaying the tail of earlier turns;
- **the API** answers `GET /v1/spores/<name>/live` with the value, its rendering at the level asked,
  and the `seq` to follow on from;
- **the terminal** keeps its own layout over the same value: every call with its arguments, the
  notes, the answer as it streams, the limits in its status line.

## Spawn

A cell is started by a **binary the agent's own programs call**, `$SPORE_SPAWN`
(`native/spore-spawn`), not by a tool, so a fan-out is a shell loop and the OS is the scheduler
([principle 4](PRINCIPLES.md#4-only-seven-built-in-tools)). Its flags are in
`reference.md` §Sub-agents and `precursors/README.md`.

`--prompt` and `--answer` are relative to `--ws`, which makes "inside the workspace" structural
rather than validated. `in`/`out` are the shell contract (stdin, stdout), `prompt`/`answer` the
agent contract: `spawn` runs under `wsexec`, whose own `out` carries the binary's progress and
cost — a different file from the cell's answer.

**The precursor carries the instruction, the prompt file carries the material.** That is why a
file-only prompt is enough, and why fan-out works: the instruction is fixed across fifty items,
only the material varies.

**`--answer` is the cell's terminal output, not its artifacts.** Anything else it produced is in
its workspace, for the parent to collect afterwards. It names a path the cell can write, which
means one of its islands and in practice `data/`: the worker writes that file from inside the
cell's confinement, where its workspace root is a read path exactly as the parent's is to the
parent, so `plan_spawn` (`rust/runner/src/plan.rs`) refuses `--answer out.json` when the spawn is
planned rather than after the inference is paid for. The prompt file is the asymmetric case: the
*parent* writes it, from outside, and the cell only reads it, so it may sit anywhere in the
cell's tree.

**What comes back is one JSON line per cell** — the spawn frame, its shape in the README's
§Sub-agents — on `spawn`'s stdout, which `wsexec`'s `out` collects: for a fan-out, fifty lines in
one file for the parent's reducer to read. The same line is written to `<ws>/spawn.json`, because
detached there is no stdout to write to and the turn record carries how the turn ended rather
than what the spawn produced. That file opens the moment the worker starts, holding
`{precursor, ws, startedAt, running: true}` until the result replaces it — which is also what
marks the workspace spent.

`ws` is what makes the line attributable: `answer` is relative to the cell, so fifty cells all
report the same one. `stopReason` is the spore's taxonomy, so a reducer can tell a finished cell
from one that ran out of rounds without opening anything. A cell that produced no answer names a
`continuation` instead: the record `buildContinuation()` writes for the spore, assembled from the
trail with no model call, saying what the cell did and what remains. Its advice differs by level,
because a cell cannot be resumed — the parent spawns a fresh one rather than continuing this.

### The child's world is the subdirectory

The parent names a subdirectory and the cell lives entirely inside it: safe-path root, Landlock
read set and write islands are all within that one directory. There is no case where the kernel
permits what the tools forbid, or where `exec` reaches what `read` cannot. The rulesets stack
rather than replace, so the cell's own layer is what makes its root read-only even though that
root sits inside the parent's `data/` island — and the supervisor, outside the cell's layer, can
still stage files there.

With the parent's tree unreadable, the call trail and the enzymes' sources are unreachable from
the cell, through `read` and `exec cat` alike
([principle 2](PRINCIPLES.md#2-one-general-assistant-which-creates-specialists)).

**This holds only if the workspace sits outside every path the sandbox grants.** `sandbox()`
grants read on the system paths and on **the runtime** — `bin/`, `src/`, `build/`, `native/`,
`package.json` and the dependencies, since a cell's worker is a node process that loads spore's
own modules, and `sporangia/`, from which opening a cell's workspace restores its root documents.
**`/tmp` is not granted**: an agent writes its islands, the directories its definition `writes`,
and its spore's socket directory, nothing else. A workspace under `/tmp` is still refused, since
every spore's sockets live there. A cell confined beneath a granted path could read and write its
parent's whole tree, so agent workspaces belong somewhere granted to nobody, which is what
`spore config set home` names.

The runtime is granted and the checkout is not. The checkout also holds the tests, the
conformance graders, the plans and the benchmark fixtures. The checkout is still refused as a place
for a workspace, as a whole: it is the runtime's tree, and `sporangia/` in it holds what every spore
is made from. Sporangia live in `sporangia/` rather than at the root so that the checkout does not
itself read as a workspace.

`granted_path_containing` in `rust/workspace` owns the
list — `sandbox.js` reaches it through the addon — and `plan_spawn` refuses a workspace inside any
of it.

Staging needs no machinery. The parent writes inputs into the subdirectory with the tools it
already has and reads results back out of it.

**A cell's workspace is used once.** If the directory already contains `spawn.json`, spawn
refuses. The **worker** writes that file before anything else runs, not when it finishes, which
puts the marker exactly where the meaning is: a spawn that failed before its worker ran releases
the directory again, so a mistyped flag does not spend the name. A cell that died is re-spawned, not
resumed: its precursor and its prompt file are both still there, so re-running it costs a directory
name and nothing else.

### What the orchestration verbs become

| classical | here |
|---|---|
| `spawn_task` | a process |
| `list_tasks` | the output directory, or `ps` |
| `wait_for_event` | process exit — `xargs` returning *is* the join |
| `get_task_result` | the answer file |
| `cancel_task` | `kill`, or `timeout 300 spawn …` |
| `update_plan` | a file the agent writes |
| `get_run_status` | the call trail |

```
ls -d data/parts/*/ | xargs -P 8 -I{} "$SPORE_SPAWN" --precursor summarize --ws {} --prompt in.md --answer data/out.json
```

Eight at a time, scheduled by the OS.

### Fan-out

`bin/fanout.js`, reached as `$SPORE_FANOUT`, runs one precursor over many part directories: it
starts them at a given width, waits, reports one JSON line, and **is safe to run again**. A part
that answered is left alone; a part whose workspace was started and did not finish is retried in
a fresh `<part>--2` beside it, because a workspace holding `spawn.json` is refused a second run.
Resuming a fan-out that was cut short is repeating the command. Planning is
`src/delegation/fanout.js`, where the tests are.

**It is a program, not a tool**
([principle 4](PRINCIPLES.md#4-only-seven-built-in-tools)): nothing of it
reaches the model's schema, the agent runs it under `wsexec`, and the `xargs` form still works
unchanged. Sizing the timeout, waiting in one call, stopping early and knowing where the answer
lands are its code rather than instructions in the identity
([principle 1](PRINCIPLES.md#1-a-spore-writes-programs-for-work-that-repeats)). Two
decisions inside it: the deadline is the precursor's own hard wall times the number of waves, so
the number nobody could size by hand is derived from one already declared; and the **spawn frame
decides whether a part answered**, not the turn record, because under `on-wrap: discard` the loop
answers and the spawn throws it away, leaving nothing to reduce.

### `--detach`

**With `--detach`, `spawn` returns once the cell is running**, printing where it is and the supervisor's pid; its `spawn.json` holds the result frame
once it ends, and its own `turns` view how it ended. Nothing new reaches the agent's tool
surface — liveness is `kill -0` or the cell's `lock`, progress is its `calls/` filling, results
are the answer files, cancel is `kill`. The join becomes the agent's to write, and one shell loop
with a `sleep` costs the same single round the blocking form does while allowing what it cannot:
reading the records that have arrived, and killing forty-seven cells when the first three failed
the same way. It is not the default.

**A detached cell ends with its parent's turn.** It escapes the process group its
`wsexec` created, so the parent's abort no longer reaches it — but it carries the turn's token in
`SPORE_OWNERS`, and when the turn ends the runner stops everything that does (§The spore
command). Before that, it reaches a model only through the socket its parent's supervisor hosts.
A runner that carries on to another turn gives every turn its own key and its own model, store
and source sockets over the one session pool: at the end of a turn they are stopped — a model
call in flight finishes in the runner and is counted in the turn that made it (§The model broker)
— and the next turn is served on new ones, under a key the detached cell does not hold. A
detached cell cannot outlive its parent by more than one call, and cannot start one after it.
A fan-out that should outlive the turn needs something longer-lived holding the broker — a spore of
its own, started with `send`.

Detached, the pid a caller holds is the **supervisor's**, not the worker's — the supervisor hosts
the enzyme broker, so it takes SIGTERM and passes it to the cell rather than dying and leaving the
agent running with its broker pulled away.

### A cell outside any turn

Some hosts are not turns — a webhook's triage, a schedule that wants one judgment, a command — and
still want a precursor's work: `runCell` (`src/core/cell.js`) runs one. It gives the cell a
directory of its own under `$XDG_STATE_HOME/spore/cells/<spore>/<origin>/`, holding the files the
caller names and its briefing as the prompt, on the precursor's model or the spore's, and starts it
with `spore-spawn --standalone`.

- **It has no parent to borrow a model from**, so `--standalone` starts its own session as a
  runner does, under a key of its own and the precursor's hard cost, and records the settled spend
  on the cell's own turn. On a host that names a gate it reaches that gate instead, under its
  spore's `auth`, and is refused when the spore names none. It reaches no source — sources are served by a turn — and runs in the
  foreground, for whoever waits on its answer.
- **It is refused under a turn** (its owner token is in the environment): a turn's cells go
  through the turn's socket, where they are counted. That is a guard; the boundary is a turn
  holding no credential a session could start with.
- **Every run is recorded by the capability, not its caller**: a row in `t_cells` (the `cells`
  view) naming the precursor, the `origin` that asked (`hook:forge`), its `ref` (what for), the
  cell's directory, its answer or why there is none, its cost and duration. Whatever asks for one,
  the spend is the spore's and is counted; `spore show` adds up the last day by origin.
- **What a caller keeps is its policy**: which precursor, how often, what it is told, what its
  answer means.

### Dreams

**A dream is a super cell: a turn's reach and lock, a cell's fresh context.** A spore that declares
`dream` ([definition.md](docs/definition.md#dreams)) is, while idle, handed to a precursor it names,
which puts its workspace in order — writes down what the transcript says that its memory notes do
not hold, removes what can be made again and serves nothing, groups the rest — and leaves the
conversation a note. The runtime never deletes anything in `data/`: it cannot tell what a file is
for, and the agent can.

- **When.** Two quantities rise. Pressure is the turns since the last dream, weighed by how much
  `data/` grew, over `dream.turns`; quiet is the time since the last turn ended, over
  `dream.quiet`, and every turn sets it back to nothing. A dream is due when their product
  reaches 1, each at least a quarter: the more a spore did, the sooner it dreams once left alone,
  never in the middle of a conversation and never on too little. It is due only in a state a
  schedule fires into, with nothing unread and no held delivery released before its hard wall
  would end. `dreamDue()` (`src/core/dream.js`) reads it from the records alone — `dataBytes` of
  the last turn that weighed `data/`, the last dream's row in `t_cells` — because the `tick` pass
  asks every spore every minute.
- **Under the lock.** The pass starts `spore-runner --dream` as `send` starts a runner, through
  an admission slot. The runner takes the lock, writes `dream: true` into it, and runs
  `bin/spore-dream.js` where a turn runs the agent; that looks again under the lock, since a
  message may have landed in between, and runs the dream. What is said meanwhile waits in the
  inbox: a spore dreaming does not act. Once it ends, anything said is read by a turn under the
  same lock, and the runner lets go and looks again as after a turn. `stateOf` reports a lock
  that says `dream` as running and `dreaming`; `spore stop` stops it as it stops a turn.
- **A super cell is the root, one notch lower.** It reaches what the spore's root agent
  reaches, except that the root's `writes` grants and its precursors are read and never written:
  it sees the spore at `spore/`, the directories its grants link included, and writes `data/` and
  `home/`, and `schedules/` when the root may write its own. One rule, computed from the root's
  own reach (`super_reach`, `rust/runner/src/plan.rs`), not a list. What a turn serves — sources,
  recall, spawn, jobs — is not reach, and a super cell has none of it. Super is the runtime's to
  grant: `spore-spawn --super` runs only the precursor `dream.precursor` names, under the lower of
  its own limits and `dream.cost` / `dream.wall`, since the agent writes its precursors and could
  make its dream ask for more.
- **Its own context.** It runs as a standalone cell (§A cell outside any turn), so the
  conversation's history and the cached prefix behind it are untouched. It is handed
  `transcript.md`, what was said since the last dream as compaction formats it, and `facts.json`,
  what the directories it writes hold: sizes, files untouched for 30 days, empty files, the memory
  notes.
- **Observed, not reported.** The directories it writes are walked before and after it, and the
  difference — a directory removed whole as one line — is recorded on its `t_cells` row with the
  turn it ran after and the bytes its `data/` came to, the base the next growth is weighed from.
- **The note.** Its answer and the observed changes are appended to the transcript as a message
  marked `dreamt`, at the end, where the next turn reads it with its own message and no prefix
  moves. A dream that said and changed nothing leaves the conversation alone.

### Reaching spawn

`spawn` is a binary, not a tool, so it appears in no schema. `exec` and `wsexec` export
**`SPORE_SPAWN`** with its absolute path, which is what lets the identity teach it: a prompt sits
in the cached prefix and must be byte-stable, so it cannot interpolate a repository location, but
it can name an environment variable.

### How a precursor actually runs

`spawn` is two processes, because a broker inside the confinement could not reach the enzymes it
serves.

- **the supervisor** (`native/spore-spawn`, the runner crate's second binary,
  `rust/runner/src/spawn.rs`) stays outside. It plans, stages `enzyme.js` into the cell's
  workspace — which it can write and the cell cannot — binds an enzyme broker when the precursor
  declares `enzymes`, starts the worker, and closes the broker when it exits. It is run directly,
  `"$SPORE_SPAWN" …`: a binary, so not through `node`. The socket goes in the spore's own socket
  directory, `$SPORE_SOCKET_DIR`, the one place under `/tmp` the parent's ruleset may write.
- **the worker** (`bin/spawn-worker.js`) applies the sandbox and runs the cell. Its plan arrives
  as `SPORE_PLAN`, the client's path as `SPORE_ENZYME` and the broker's socket as `SPORE_ENZYMES`.

**The model is configuration, and `spawn` has no flag for it**
([principle 7](PRINCIPLES.md#7-a-spore-is-described-in-a-file-not-built-in-code)). A precursor's `model:` is a name the
plan reads against the map the runner hands down as `SPORE_CELL_MODELS`, at any depth; a
precursor naming none runs on its parent's, which arrives as `$MODEL` since `exec` and `wsexec`
export it, and `bin/spawn-worker.js` reads `plan.precursor.model || process.env.MODEL`. A spore
with no `cell-models` runs every cell on its parent's model and drops the name, so a precursor
from a plugin or a sporangium still runs; one with some refuses a name it lacks. Passing `-m`
fails with *the model comes from $MODEL, never from a flag* rather than being quietly ignored.

**The root definition says which models the spore runs on**: `model:` is what the root runs on,
`models:` what a person may switch it to (`switchModel`, which rewrites `model:` and keeps the
model it leaves in `models:`), and `cell-models:` the names a precursor's `model:` may give.
A turn runs on `model:` alone: a used-up quota (`RATE_LIMIT_TIER`) is retried on it and then fails
the turn, and nothing but a person's switch moves the spore to another model.
**The model broker holds it:** its route policy (`DefinedModels`, `rust/runner/src/model.rs`)
refuses a call to any model the definition does not name (`ROUTE_REJECTED`), before a key is
filled, so neither a precursor nor `$MODEL` — both the agent's to set — reaches another.
Embeddings do not pass through mohdel's route, so the `embedding:` model is not held there.

The base-tool allow-list needs no new machinery: it is passed to `runSpore` as `excludeTools` —
the complement of what the precursor granted — so one filter serves both directions.

`enzyme.js` is **copied** into the cell rather than granted a path. The client is generic, so a
cell reading it learns nothing, and a copy needs no hole in the ruleset. It imports only `node:`
builtins for the same reason; a relative import would break at the far end.

The enzyme broker is on the runner's HTTP stack like every other socket
(`rust/runner/src/enzymes.rs`): `POST /run?enzyme=<name>&arg=…` with the tree key, the request
body streamed to the enzyme's stdin, and the response an NDJSON stream of `stdout` and `stderr`
chunks (base64, since an enzyme's output may be a picture) ending in one `exit`. A refusal — an
ungranted name, an enzyme that changed or vanished since the cell started, too many arguments — is
mohdel's typed error, and `enzyme.js` exits 127 on it. `enzyme.js` sets the enzyme's exit code
and lets its output drain rather than exiting on the `exit` event, so a slow pipe reader does not
lose the tail of what the enzyme wrote while the call reports success. It also stops reading from
the broker while its own stdout is full, so a slow reader slows the enzyme instead of growing a
queue.

End to end, a confined cell runs an enzyme that lives in the parent's tree, **cannot read that
enzyme**, is refused a name the precursor did not grant, and gets the enzyme's exit code intact.

### Where the ceiling lives

The ceiling lives at the **model broker** (§The model broker), and a cell is given an environment
built up by name
([principle 10](PRINCIPLES.md#10-passwords-never-reach-the-assistant-the-internet-is-open)).

It holds at both levels, because both are confined halves of a supervisor that keeps the keys. A
sandboxed process gets EACCES reading a less-confined parent's `/proc/<pid>/environ`, because
Landlock restricts ptrace across domains — measured with `yama ptrace_scope` at 0, so Landlock is
what does it.

Depth is bounded structurally rather than by a number: `spawn` sets `SPORE_CELL` for the cell it
starts, `wsexec` passes it to everything that cell runs, and `spawn` refuses to run when it is
set. One level of fan-out is the whole design, and a parent wanting two flattens them. Like every
other grant it is a rail against accident, not against an agent that means otherwise
([principle 8](PRINCIPLES.md#8-protection-comes-from-the-computer-not-from-good-behaviour)).

## The model broker

The agent's model access is on the far side of a socket, and the socket speaks **mohdel's
call protocol**. The runner serves it (`rust/runner/src/model.rs`): `POST /v1/call` and
`POST /v1/embed` go to thin-gate's public `handle_call` and `dispatch_embed` over an embedded
pool of mohdel sessions — one started alongside the agent, another each time every one is busy,
up to `modelSessions` (§CPU and memory on one machine) — and two routes are spore's own,
`POST /spore/info` (a model's catalog entry, answered by a session) and `GET /spore/spend`. What
spore adds around mohdel's protocol is the tree key, the ledger and the hard stop, and a route
policy that refuses a call to any model the definition does not name (§How a precursor actually
runs).

The provider key is filled per call by thin-gate's `LocalAuth`, which looks where `mo` does and
under the same names — the runner's environment, then `~/.config/mohdel/environment` — so the
envelope never carries one. A `chatgpt/` call is the exception: thin-gate's `ChatGptAuth`,
wrapped around `LocalAuth`, gets an OAuth access token for the ChatGPT account mohdel has made
active, through mohdel's own helper, which `send` passes the runner as `--chatgpt-helper`. Such a
call reports zero spend, so a definition's `cost` limits never stop a spore running on a ChatGPT
plan; `rounds` and `wall` still do. How a model's calls are paid for is mohdel's to declare
(`billingOf`, `src/core/billing.js`): for a `plan` or `capacity` model, spend is shown as
`not metered · <label>` in place of dollars.

**On a host that names a gate** (`gate` in `config.json`, passed to the runner as `--gate`), the
runner starts no pool. It forwards `/v1/call` and `/v1/embed` to that mohdel gate through mohdel's
Rust client, with the spore's `auth` as every envelope's `authId` whatever the agent wrote, and
answers `/spore/info` from the gate's `POST /v1/info`; the tree key, the ledger, the hard stop
and the route policy stay the runner's, checked before a call leaves. Keys and quotas are the
gate's, by `authId`. A `file://` image part goes to the gate as a `data:` URI, read by the runner
from the workspace or a granted directory — the roots `MOHDEL_MEDIA_ROOTS` holds on the pool —
since the gate need not share this machine's files. The ceiling aborts a call at the gate that
streams it (its `mohdel-gate`). A turn whose spore names no `auth`, or whose gate does not
answer for its `model`, is refused before it starts; the runner never falls back to a pool. The
gate checks no caller, and an agent can connect to a gate socket mounted where it runs, so a
gate shared between tenants is only as separate as its socket's reach.

`runSpore` hosts nothing (§The supervisor builds, the worker runs): the confined half is handed a
socket and a ledger as parameters. A runner started with `SPORE_MODEL_SOCKET` — a test, or an
embedder that keeps its own keys — serves no model socket and passes that one on; its key is the
supplier's, read from `model.key` or minted once there, and not turned over between turns.

**A cell's environment is assembled by name** — `PATH`, `HOME`, `MODEL`, `TRACEPARENT`, the
`SPORE_*` it needs (`PASSED_THROUGH`, `rust/workspace`) — and holds no provider key
([principle 10](PRINCIPLES.md#10-passwords-never-reach-the-assistant-the-internet-is-open)): the
list that is kept is what may cross, not which names to strip. Landlock does not gate unix-socket
connect, which is what lets a confined agent reach the socket at all. `bin/spore-agent.js` and
`bin/spawn-worker.js` each build their `mo` as a client of the tree's socket
(`src/infra/model-client.js`): it builds a `CallEnvelope` from spore's wire-form messages, streams
through `mohdel/client`'s `call` and `coalesce`, and returns the `done` result, or throws an
`error` event as a typed error. `info()` stays synchronous — the loop asks for context limits
that way — by fetching each model's entry once, when the client is made.

The **ledger** is one object shared by the broker and the loop: `own` is what the agent
spent, `children` is everything else drawn on the same allowance. The loop's cost
dimension reads the sum, so a cell's spend comes out of its parent's — the spore's ceiling is a
bound on the whole tree rather than on one loop. The runner adds each call's cost as its
`done` event passes through, and an agent that can spawn reads the tree's total from
`/spore/spend` after each answer, subtracting its own calls to learn its cells'.

**The limits are stops on what was spent, never a forecast**
([principle 12](PRINCIPLES.md#12-a-soft-limit-asks-to-wrap-up-a-hard-limit-stops)). Crossing the soft
`cost` bound wraps the turn; reaching the hard one stops it — the loop ends, and the broker
refuses every model call from the tree once settled spend has reached it. A model call already in
flight when the limit is reached finishes and is billed, so the tree can end past its hard bound
by what its calls in flight cost.

**Spore never cuts a model call; a stop waits for it.** Once the gate has dispatched a call, it
runs on a task of the runner's own, which reads it to its `done` and counts it; the connection
that asked gets a copy while it is there to take one. On a stop or the hard wall the agent stops
waiting — its model client leaves the call unread and throws, which is how the loop records
`cancelled` — and exits on the usual schedule, its tools and cells with it. A call still waiting
for a session when the turn ends has not started, and is dropped with its connection.

**A stop also reaches the tool calls a round asked for.** The tool kernel starts no call once
the turn is stopped: a later call in the batch is answered `not run`, the way calls after a
terminal tool are, so the transcript stays whole and nothing writes after the stop. The loop
checks the stop before it looks for a terminal tool, since readers run before mutators and a
`quiet` or `ask` in the batch may already have returned. The turn is `cancelled`, or
`hard:wall` when the wall stopped it, never the terminal tool's stop reason.

**A turn's records go through a channel to its supervisor** (§The workspace database). Before
starting the agent, the runner — or `spore-spawn` for a cell — begins the turn as a `running` row
under a `turnId` it mints, makes a Unix socket pair, and hands one end to the agent as fd 3, named
in `SPORE_STATE_FD`; nothing else can reach it, since it is no path, and the agent marks it
close-on-exec at once so no tool or cell inherits it. On the other end the supervisor holds the
turn's only writer connection and answers four operations, each one transaction:
`transcript.append`, `events.append` (numbered by the supervisor), `call.record`, and
`turn.outcome` — how the turn ended as the agent saw it, which makes the turn `pending` and
settles nothing. The agent waits for each answer before the next request, so the order written
is the order committed and a refusal reaches it as a failed write. A frame is one JSON line, at
most `MAX_FRAME` (32 MiB). Host-side writes (a fork's cut, a dream's note) send the same
requests through the addon, so there is one implementation of what each means. Spore's own
tests run the confined half in their process on a turn begun through the addon (`hostState`),
the one hook kept for them and refused unless `SPORE_TEST_HOST_TURNS=1`.

**The runner writes every turn record, after the calls have finished.** When the agent has
gone, the runner closes the channel, stops the turn's sockets, which take no new model call,
waits until nothing is in flight, then settles the turn from its ledger — `treeMicros` the whole
turn, `ownMicros` and `workUnits` the root agent's share — and makes it final. A turn whose
agent never said how it ended is told by the runner (`KILLED`, `AGENT_EXITED`) and goes the
same way. While it waits the lock is held and the workspace is **draining**: `stateOf` says
`running` with `draining: true` and the pending record as `last`, so `send` queues as it does
behind a running turn and `fork` may cut from it. A record is read only when final, so a
consumer that bills on a turn ending bills what the turn cost. A cell's supervisor finalizes its
cell's turn as the worker left it, or tells it when the worker could not; the cell's calls went
to its root's runner, which counts them in the root turn's `tree`.

**Making a turn final is safe to repeat** (`finalize_turn`, `rust/workspace`). It is one
transaction: settled, given the next `turnNo`, the stretch of the inbox it answered, and added
to the workspace's totals — and a turn already final is left as it is. Every runner starts by
finalizing whatever a predecessor left (`recover`): a `pending` turn as its agent left it, what
its calls came to having died with that runner's ledger, and a `running` one as a turn that
ended in error, `SUPERVISOR_DIED`, since nobody is left to say more. A turn records which it
was: `settled` is 1 when its money is what its supervisor's ledger counted, and 0 when it is
what the agent reported — a recovered turn's, or a cell's, whose calls are settled in its
root's turn instead. A field the table does not have, a string that is not well-formed Unicode
or holds a NUL, or money that is not whole micro-dollars is refused and written nowhere, so a
bad record is seen rather than stored as something else; the agent writes its strings
well-formed for that reason. JSON columns are stored as the text they were written as.
`test/crash-recovery.test.js` kills a real runner just before and just after the final commit,
and drops the channel's answer to a committed outcome, through `SPORE_CRASH_AT` — a fault named
in `rust/workspace` and read only at those steps: each ends in one final turn, one `turn_end`,
and the inbox where it should be.

**The root agent's share is counted where the calls go.** The agent's model client marks its
own calls (`x-spore-caller: root`) and a cell's mark its precursor (`precursor:<name>`), and the
runner keeps each beside the tree's total; `/spore/spend` returns the tree and the root's share,
and the agent's `ledger.children` is the difference. Settling writes each precursor's spend and
rounds into the turn as `byPrecursor`; what no call named — a program of the agent's own using
the socket, an embedding for memory — stays in the tree and in nobody's share. The marks are
self-reported, which is right for accounting inside one tree and would not be for a limit.

**Only the operator cuts a model call**: `MODEL_CALL_CEILING` (`model.rs`), an hour from its
start, above the longest healthy call measured (44 min). Past it the runner aborts the call on the
session pool by the id the client repeats in `x-spore-model-call`; the call ends on an aborted
`done` carrying what the provider had reported, which is counted, and the turn's record carries
`cut: n`. That turn's `ownMicros` and `treeMicros` are lower bounds, and the loss is the
operator's by design. A stall before the provider answers at all is mohdel's 60 s headers
timeout.

**An embedding is a model call.** `/v1/embed` goes to thin-gate's `dispatch_embed` behind the
same key and the same stop, and by a call's rules: until it has a session it belongs to its
connection and a turn ending drops it unstarted; once dispatched, the exchange mohdel hands
back is awaited on a task of the runner's, and its cost is added to the ledger — spend, not a
round. `MODEL_CALL_CEILING` does not reach it: a one-shot exchange has no abort, and what bounds
an embedding is the session's own request timeouts. Embeddings do not pass through the route
policy.

The ledger carries a second pair beside the money. `ownRounds` is what this agent asked the
model, `childRounds` what its cells did, and **work units** weigh them 2:1 (`work_units`,
`rust/workspace`) — an agent's own round costs double a specialist's, pricing delegation below
reasoning it through alone. The count is kept at the socket because a round is a model call,
every model call crosses it, and a retry is another call; an agent cannot reach the counter, so
the number never depends on its own account of its work. Embeddings are not rounds. Work units
count rounds, not cost, tokens or time.

Each turn records its own increment as `workUnits`, `workUnitsOwn` and `workUnitsChildren`, and
finalizing it adds `workUnits` to the workspace's total. Turns are never pruned, so the sum stays
complete, and it sits at the read-only root — an agent can read what its own work has cost through
`$SPORE_SQL`.

A precursor's `cost` is the agent's knob for sizing the work it hands out — `precursors/` is a
write island so that it can turn it — and `spore.cmk`'s is the ceiling the broker holds, at the
read-only root ([principle 8](PRINCIPLES.md#8-protection-comes-from-the-computer-not-from-good-behaviour)).

### Who the broker serves

A request presents the tree's key in the `x-spore-key` header or it is refused — a header,
because mohdel's client opens a connection per request and the envelope is mohdel's contract.
The socket cannot make this distinction itself: it lives in the spore's own socket directory,
which no other spore's agent may write — so none can remove it or bind in its place — but
Landlock does not gate unix-socket connect, and a 0700 directory does not separate two agents
running as the same user. Without a key, another spore of the user could connect and spend
against a ledger that is not its own.

The key is 32 random bytes, minted for each turn by the runner (`write_model_key`,
`rust/workspace`) into `<ws>/model.key`, a root that is a read path to the agent. A turn's key
and sockets are its own: when the turn ends they are stopped, so a cell it detached fails its
next call rather than spending the next turn's allowance. `spawn` stages the key into each cell's
workspace the way it stages `enzyme.js`, which reads it from beside itself; a cell outside any
turn is its own tree and mints its own.

**Every socket takes it.** The runner's model, store, source and job sockets and the cell
supervisor's enzyme socket are all served by `broker::serve` (`rust/runner/src/broker.rs`), which
checks the key before routing. The enzyme broker runs an enzyme with the *supervisor's*
privileges in the caller's working directory, so a caller without the key that knew the socket
and an enzyme name could read whatever that program reaches — another cell's `model.key`
included, which would open the model broker as well. What an *authorised* enzyme can reach is
still the precursor author's choice, outside the cell's own confinement; the key governs
invocation, not reach.

What it does not do:

- **It does not bound an agent against itself.** The agent can read its own key — its
  workspace root is a read path — which only lets it spend its own budget, as it already can
  by calling the socket the key protects
  ([principle 8](PRINCIPLES.md#8-protection-comes-from-the-computer-not-from-good-behaviour)).
- **It authenticates the tree, not the cell.** Every cell carries its parent's key, so one cell
  could spend as another; a precursor's `cost` sizes work and is not a boundary between cells.
  The same holds on every socket the runner serves: a cell reaches the tree's sources at the
  root's grant and the tree's store, and a precursor's `sources` is a view, not a grant
  (§Material it does not own;
  [principle 11](PRINCIPLES.md#11-spore-trusts-the-person-running-it-not-other-spores)).
- **It does not protect against an unconfined process of the same user**, which can read the
  key file.

One broker serves one tree. A supervisor handed a socket from outside — an embedder holding its
own keys — mints nothing and presents nothing; whoever owns that socket owns the question of who
may use it.

**Streaming is mohdel's.** The call's response is its NDJSON event stream, passed through the
router unchanged; the client merges deltas with `coalesce` under the loop's `bufferOpts` and
hands each to the handler. An option the envelope does not carry is refused
(`BROKER_BAD_OPTION`), `idleHandler` among them: mohdel's `idle` events exist on this path
(`idleHeartbeatMs`), and asking for them is a change to the event log's schema still to make.

A plugin's source carries no credential across either. The brave plugin describes its endpoint in
its manifest's `sources`, `send` hands that to the runner (`--plugin-sources`) and never to the
agent, and the runner resolves `BRAVE_API_SK` from its own environment and makes the call over
https. A spore using a plugin is granted the sources it describes; a name a plugin and the host's
`sources.json` both describe is refused.

## Prompt caching

A turn re-sends everything it has already sent: the tool schemas, the system prompt and the whole
conversation go up again on every round, and again on the next turn. A provider caches a
*prefix*, matched byte for byte, so the request is ordered by how often each part changes —
tool schemas, fixed for a grant (§The suite); the system blocks, identity and domain rules first;
then the conversation, stable behind its growing end — and **nothing volatile goes ahead of what
is cacheable**: a value that changes in the system prompt would invalidate the whole conversation
behind it on every turn.

Spore's signal is a `cache: '5m' | '1h'` marker, `runSpore`'s `cacheTtl` (`5m` unless given).
`composeSystem` (`src/core/system-prompt.js`) puts it on the system blocks, which go out as the
first message, `role: 'system'`, one text part per block with its marker. `loop.js` marks the
conversation's last message **on a copy** (`markConversationForCaching`,
`src/core/prompt-cache.js`): the marker turns a string `content` into an array of blocks, and
`estimateTokens` measures `content.length`, so a marked message in the live transcript would
weigh one token instead of its own size and every budget downstream would be computed against
that. A conversation of a single message is not marked. mohdel translates the marker and places the
breakpoints itself; a provider that caches a repeated prefix on its own ignores it.

Anthropic caches no prefix below 1,024 tokens, or 2,048 on Haiku, and says nothing. Spore's fixed
prefix is about 2,695 tokens, 1,245 of them tool schemas, so a cell granted few tools can fall
under Haiku's floor, and its system prompt then stops caching without a sign.

### The clock line stays out of the prefix

The `Now:` line, the minute a turn started, is shown in front of the turn's message the way
recall is, and not written to the transcript: the system prompt stays byte for byte the same from
turn to turn, and `test/transcript-persistence.test.js` fails the day it does not.

## Memory

A workspace remembers in two tiers. **Short-term memory is the transcript**: in context, bounded
by the window, and meant to be small. **Long-term memory is the store**: on disk, unbounded, and
never in context. What crosses from the store is a *view* — a few lines chosen for the turn in
front of the model — while the store grows without limit behind it
(`src/memory/`).

### What is in it

Two sources, one index each per unit:

- **`data/memory/`** — what the agent chose to keep. It writes markdown there with the tools it
  already has; there is no interface for remembering. `data/` outside that directory is scratch
  and is not indexed.
- **the transcript** — what was actually said, so a fact the agent neglected to write down is
  still reachable in the record.

They share one index and one score, and nothing arbitrates between a note and the exchange it
came from: BM25 divides by length, so a one-line curated fact outranks the sixty-word turn it was
distilled from. Provenance rides on the anchor.

Tool messages are excluded.

### When a turn enters it

**When it leaves the context, and not before.**

A store is opened per turn with a horizon: the count of messages that have left the live
history, a compaction summary not counting as one. A turn evicted mid-loop therefore becomes
reachable at the **next** turn. Nothing queries the store again inside a turn — push runs once,
before the loop, and not at all for a turn carried on by `spore fork` — and `dropOldestTurnGroup`
protects `messages[0]` and drops from index 1, so what leaves mid-loop is not a prefix a horizon
could describe. Deliberate recall opens its own store over the whole record and is unaffected.

The horizon decides which messages become chunks; it does not make indexing incremental. BM25
rebuilds from the eligible history each time a store is opened.

**The record is append-only.** Bounding what replays is a compaction entry, which leaves every
message readable; a transcript is never shortened, because the store reads what the context no
longer holds.

### Getting things out

**Push** is the runtime's. Before a turn is read, the store is queried with the incoming text
and the hits are placed in front of it, unasked. Sentence-sized and bounded: at most `push` hits
and at most a thousand tokens of them (`RECALL_BUDGET_TOKENS`), anything longer cut with its
anchor left to lead back. A hit qualifies by scoring above the definition's `floor` — zero when
it declares none — so without one, a single shared uncommon word admits a line. It goes beside
the turn that triggered it, which is both the most attended part of the prompt and behind every
cache breakpoint. It is shown to the model and never written to the transcript.

What it says is `[Recalled — from earlier, not said now.]` and nothing else
(`src/memory/recall.js`): recall sits exactly where the user's own words sit, and without the
label a recalled line is indistinguishable from something they just said. It does not hedge
about relevance; the agent reference says that some recall will not fit.

**Pull** is the agent's, and is a program rather than a tool
([principle 4](PRINCIPLES.md#4-only-seven-built-in-tools)):

```
node "$SPORE_RECALL" the camera gear they mentioned
```

Turn-sized, retrieved wide and widened again through the anchors — each hit comes back as the
section around it — and bounded at four times push's budget.

An **anchor** is a path and a position, one shape for both sources: `data/memory/person.md:12`
and `transcript:47`, the entry's `entryNo`, which no compaction renumbers. It is provenance, and
it is the way down — expansion means the markdown section for a note and the neighbouring
messages for a transcript.

### Scoring

The default backend is BM25 (`src/memory/bm25.js`): it needs no model call, so it costs nothing,
adds nothing to a turn's latency, and leaves no sidecar to drift out of step with the notes. A
backend joins behind one interface — `build(documents) -> { size, async query(text) -> number[] }`,
scores positional and `> 0` meaning a hit — which is why `query` is async though BM25's need not
be, and why the contract names no file format.

`vectors` is the second backend (`src/memory/vectors.js`), and it keeps its index in a vector
store rather than rebuilding one. Each chunk's record id is a hash of its unit, anchor and text,
so an unchanged chunk is already stored and costs no embedding; only the gap between what the
collection holds and what is on disk is embedded. A workspace is one collection, with the two
units kept apart by a filter.

**It does not talk to that store itself.** The **store** socket is the runner's, on the model
socket's terms: the same HTTP stack, the same `model.key`, in the spore's socket directory, named to
the agent as `SPORE_STORE_SOCKET` (`rust/runner/src/store.rs`). The confined side embeds its chunks
on the model socket's `/v1/embed` with the model `embedding:` names, sends the store vectors, and
gets record ids and distances back; it never holds the URL or the token. The store pins the
collection — the workspace, the embedding model and its width, so a changed model gets a
collection of its own — and batches, retries and keys each write. Embedding stays a model call
rather than the store's, so indexing is billed and stopped with every other call in one place,
and splitting a chunk past the model's window is the agent's, which has the catalog entry. This
is a boundary against the credential, not against the network
([principle 10](PRINCIPLES.md#10-passwords-never-reach-the-assistant-the-internet-is-open)).

**A backend that reaches a service can fail where BM25 cannot**, and a turn is still answerable
without recall. A store that refuses — rate-limited, out of memory, briefly unreachable — is
warned about and the turn proceeds with the prompt untouched. The failure is emitted as a
`recall` event as well as logged, so a run that answered without memory is not read as a
mechanism that ran badly.

**Repetition is not rewarded**, and that is a known limitation. IDF punishes it: a fact said
twenty-five times scores 0.72 a mention against a one-off remark's 3.41, so ranked individually
the most reinforced memory in a store can come last, and nothing groups or sums hits across the
forms a fact takes.

### The vector store protocol

What `memory: vectors` asks of a store, over http or https (`rust/runner/src/vectors.rs`). Where
the store is, and how its API differs from the defaults below, is the host's `memory.json`
(`docs/operating.md`), which the runner reads and the agent never sees. Like a source, the store
may be reached on a unix socket that `memory.json` names.

| operation | default path | body | answer |
|---|---|---|---|
| ready | `GET /health/ready` | — | any 2xx |
| create | `POST /v1/collections` | `{ <collectionField>: id, vector_schema: { dimensions, metric: "cosine", embedding_space }, metadata_schema: { unit: { type: "string", filterable: true } } }` | 2xx, or `ALREADY_EXISTS`, which counts as created |
| fetch | `POST /v1/collections/{collection}/records:fetch` | `{ ids: [...] }`, at most 256 | `{ records: [{ id }] }`: those it holds |
| upsert | `POST /v1/collections/{collection}/records:upsert` | `{ records: [{ id, vector, metadata: { unit } }] }`, at most 256 and 8 MiB | 2xx |
| query | `POST /v1/collections/{collection}/query` | `{ vector, top_k, mode: "exact", filter: { eq: { field: "unit", value } } }`, `top_k` at most 50,000 | `{ matches: [{ id, distance }] }` |

A create and an upsert carry an `idempotency-key` header, the same for the same write. A refusal
is `{ "error": { "code", "message" } }`; 503 and 504 are retried, six attempts in all, and
`CAPACITY_EXCEEDED` waits eight times longer between them than any other code. A store that does
not answer within 30 s is not asked again. The runner checks `ready` before a turn and refuses to
start one whose store is not ready.

### What a definition declares

`memory` names the backend, `push` and `pull` the depths, `floor` the score a hit must pass, and
`embedding` the model a `vectors` backend embeds with; the fields and their syntax are in
[docs/definition.md](docs/definition.md#memory). Absent `memory`, a workspace
keeps nothing beyond its transcript.

Declaring `memory` requires both depths and the parser holds no default for them
([principle 19](PRINCIPLES.md#19-each-default-is-written-once)): the shipped definition carries the
ones LongMemEval was run at. `floor` is optional, and absent is a real answer: anything scoring
above zero. That is a sign check rather than a threshold — in BM25 any shared word scores positive,
so the slots fill on nearly every turn, and `recallBlock` renders a strong hit and a coincidence
alike. A floor is what lets recall surface nothing. It means the same thing only where the scores
do: BM25 ranks against its own workspace and is unbounded, a cosine score is neither, so a usable
floor depends on the backend.

`embedding` is the model, and so configuration
([principle 7](PRINCIPLES.md#7-a-spore-is-described-in-a-file-not-built-in-code)): required beside `memory: vectors` and
refused anywhere else, since BM25 embeds nothing. The width is the catalog entry's `dimensions`,
so an entry that does not say is refused rather than guessed at, and a vector of another width is
refused before it reaches the store.

## Many spores at once

`runBatch` (`src/core/batch.js`) runs many spores and **calls no model at all**. The conformance
run goes through it. An errand's shape, its request ids and what a batch hands back are in
[INTEGRATION.md §Many spores at once](INTEGRATION.md#many-spores-at-once).

It **observes rather than owns**
([principle 17](PRINCIPLES.md#17-spore-watches-it-runs-no-central-service)): no restart policy, no queue, no
resident process, and no state of its own. How far an errand has got is read back from its
workspace, message by message: each is sent under a request id of the errand's, so the inbox
says which of its messages it holds whatever else the spore was told.

**A message ends with its own turn** (`turnOfMessage`): the finished turn whose
`(inboxFrom, inboxTo]` holds it, or, when nothing is running, the first finished turn started
after it that read nothing — a runner that failed before it got there. The errand's outcome is
those turns, one per message, never the workspace's latest. A runner that died while one of the
errand's messages was outstanding ends the errand, not retried; one that died on another sender's
turn is not the errand's, and its next message starts a runner the way `send` always does. A message
said and never started — its sender interrupted between the append and the start, refused a slot
after the append, or delivered into a turn that was stopped before reading it — is sent again under
its request id once nothing is running, which `send` takes as starting a runner for it, not as
saying it twice. The batch waits on the messages it started a runner for even before their runner
has taken the lock; a message delivered into a running turn is waited on only while that turn runs.

What a spore is doing is `stateOf` (`src/core/state.js`), three facts read back
([principle 15](PRINCIPLES.md#15-the-folder-is-the-spore)). **The kernel says who is
running**: a turn runs while a process holds the `lock`'s `flock`, and `lock_holder`
(`rust/workspace`) finds it in `/proc/locks` by the file's inode, confirmed against that
process's open files. **The file says who crashed**: `releaseLock` truncates rather than unlinks, so
a pid left there with nobody holding the lock is one that never let go. The `turns` view says how
the last turn ended. `stop` is SIGTERM to the holder, through a pidfd opened on its pid and checked
against the lock once more (`stop_holder`), so a pid reused in between is never the one signalled;
it aborts the turn and takes the tree with it.

**How many at once is the caller's to say**
([principle 14](PRINCIPLES.md#14-the-computers-limits-belong-to-its-owner)): it is an argument
rather than a field in a definition. Two callers together are bounded by the user's admission slots
(§Turns of one user): a start refused is tried again on the next poll, and reported as `full`.

**Output of a turn is found, not returned.** A batch starts detached turns and waits on their
records; the answer is the workspace's transcript and whatever its turn's `deliverables` hold.
`runSpore`, the synchronous confined half, is not exported.

### What a turn costs

**Cost is O(concurrent turns), not O(spores).** A defined spore that is not running is 0
processes; a running turn is 2 — the runner and `spore-agent.js` — and each concurrent cell 2
more, `spore-spawn` and `spawn-worker.js`. A contained turn adds `confine` and the namespaces'
first process, two small C processes. Brokers are socket servers inside the runner, not
processes. A thousand idle spores cost disk.

**Measured** against a scripted provider: **149 MB** combined RSS for a turn, about 75 MB for a
Node process with the runtime loaded, and **~450 ms** from `spore send` to the first model call,
all of it module loading — `openWorkspace` is 1–4 ms. A mohdel session is Node too, since the
provider SDKs are JavaScript: 56 MB with mohdel loaded (40 MB bare, ~85 ms of import). The
runner embeds one session for its turn, more only while cells call at once (§CPU and memory on
one machine).

**Two limits:**

- **The transcript is read whole.** Every other record is a query on `state.sqlite` — a status
  read is the workspace's totals and its last turn, a round boundary reads only the inbox past
  its position, a follower only the events past its sequence. But the transcript is read whole
  whenever a turn starts or memory opens its store, since the replay is the whole of it, and
  `retain` does not bound it. Harmless at today's sizes; the thing to watch for a long-lived
  spore that is talked to often.
- **`/tmp/spore-<uid>` accumulates.** Sockets are named by pid and time and unlinked on a clean
  close; a runner that is killed leaves its files, and nothing sweeps them.

### A tool that is not there says so

A model naming a tool it does not have is answered as an ordinary refusal, saying what it has:
`there is no tool called "exec" here — you have read, write, wsexec` (`src/core/tool-kernel.js`)
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)).

### A turn that died still happened

**Every turn a `send` started ends in the workspace's turns, whoever writes it.** A turn killed
by an exception is recorded with `stopReason: 'error'` and the error's type and detail, which
`stateOf` reads as `failed`; that record carries `inboxTo` set where the turn started reading,
since it answered nothing. The runner writes the record when the agent could not: a refusal after
the lock — the definition, the memory or sources configuration, a session or a socket that would
not start (`error: 'START_FAILED'`); a stop before the agent started (`cancelled`); an agent
killed after the grace (`KILLED`, as `cancelled` or `hard:wall`); an agent that ended without a
record (`AGENT_EXITED`, with how it ended). The runner takes the lock before anything that can
refuse, so all of these happen where the record can be written, and losing the lock race still
exits quietly, since the winner reads the message. A runner's record is the failure subset of
the shape — `startedAt`, `endedAt`, `stopReason`, `error`, `detail`, `concluded: false`,
`rounds: null`, `treeMicros` from its ledger, and no `inboxTo`, since the turn read nothing it
answered. No `runId`, which is the agent's, and no `deliverables`, which only the agent walks.
`stateOf` reads it as `failed`, `cancelled` or `halted`, and `runBatch`, which finds each
message's turn among the records, sees it end instead of waiting on it.

`spore-spawn` does the same for a cell whose worker could not record its turn
(`rust/runner/src/spawn.rs`). Its `spawn.json`, though, is written only by the worker: a worker
killed outright leaves the start frame, `"running": true`, in place.

A turn started by `send` is detached, so its stderr goes to `spore.err` in the workspace, and a
spore that died at startup says why there
([principle 21](PRINCIPLES.md#21-when-something-fails-it-says-so)).

### `spawn` under `exec` says which tool to use

`exec` is read-only and `spawn`'s first act is to write the cell's workspace, so `spawn` under
`exec` names the cause and the fix instead of the raw EACCES: *spawn stages a workspace for the
cell before it starts, so it has to run under wsexec* (`rust/runner/src/spawn.rs`).

### Broker sockets

Broker sockets root at `/tmp/spore-<uid>` (`socket_root`, `rust/workspace`). A path past
AF_UNIX's 108-byte limit is refused as `SOCKET_PATH_TOO_LONG`, naming the path and its length,
rather than failing inside a listen. `bin/fanout.js` captures each spawn's stderr: a part with no
frame reports the last line of why in the JSON its parent reads, with the whole of it in
`<part>/spawn.err`.

**One directory per user.** Each user has `/tmp/spore-<uid>`, made `0700`; one found there that
is not a directory this user owns and alone can open is refused (`SOCKET_DIR_UNSAFE`), not used,
since anyone can create a name in `/tmp` first.

**One directory per spore within it.** `/tmp/spore-<uid>/<12 hex of the workspace's real path>`,
made `0700` by the runner each turn and named to the agent as `SPORE_SOCKET_DIR`
(`spore_socket_dir` in `rust/workspace`): the runner binds a turn's sockets there, a cell's enzyme
broker binds there, and a plugin names it as `{sockets}` — the browser's daemon socket lives in
it, past the turn that started it. It is the only place under `/tmp` the agent's sandbox may
write, so one spore cannot unlink or replace another's sockets. A process no spore's sandbox
holds — a `--standalone` cell, a test — binds at the root.

### Spores of different people on one account

The trust boundary is the user
([principle 11](PRINCIPLES.md#11-spore-trusts-the-person-running-it-not-other-spores)), and a
deployment may still run the spores of different people as one user — one container, one uid.
What keeps them apart there:

- **Signals.** On Landlock 6 (Linux 6.12) the agent's sandbox scopes signals and abstract unix
  sockets to its own domain and the domains nested in it: an agent, its tools and its cells
  signal one another, and no process of another spore. `exec` relies on that scope rather than
  scoping its own nested domain, so it can still `kill -0` a detached cell of its spore; a job's
  and a router's command start unconfined, so `confine --scope-signals` scopes them itself. On an
  older kernel nothing is scoped, and `spore doctor` says so.
- **Files and sockets.** Each spore writes only its own workspace, its granted directories and
  its own socket directory; `/tmp` is not granted.
- **Processes.** Where the host gives unprivileged user namespaces, every process tree spore
  starts for untrusted work — a turn's agent, a job's command, a router's, a cell outside any
  turn — starts through `confine --contain`, in a user, PID and mount namespace of its own with a
  `/proc` of that namespace: it sees the processes it started and no other spore's, nor their
  command lines. The namespaces' first process is `confine`'s own: it maps the user to itself, so
  files and `id` read as before, passes on the signals it is sent, reaps what is orphaned to it,
  and ends as the command ended; when it exits the kernel ends everything left in the namespace.
  A turn's cells and `exec`'s commands are the agent's descendants and share its namespace.
  **A host that refuses the namespaces runs nothing**: the runner checks before each turn
  (`confine --contain-check`, beside `freeFloor`) and records one it cannot contain as
  `CONTAIN_FAILED`, its message left unread; a job, a router or a cell outside any turn is
  refused by `confine` itself. The host setting `contain`, on unless set, turns this off, and
  `spore ls` and `spore doctor` say while it is off. It is the host's setting, not a
  definition's ([principle 14](PRINCIPLES.md#14-the-computers-limits-belong-to-its-owner)).
- **Syscalls.** Everything `confine` starts runs under a seccomp filter of spore's own
  (`src/isolation/confine.c`), inherited by all it starts and impossible to remove: making or
  joining namespaces, `mount` and the new mount API, `keyctl`, `bpf`, `perf_event_open`,
  `userfaultfd`, `io_uring`, module and `kexec` loading, `open_by_handle_at`, `acct`, `swapon`,
  `reboot` and `syslog` are refused, and `clone3` answers `ENOSYS` so libc falls back to
  `clone`, whose namespace flags the filter reads. So a container may be loosened for the
  namespaces while what runs in it gets at least Docker's default on the calls an escape uses.
  `--unsafe` starts the agent without `confine`.
- **Never as root.** The runner records a turn it would run as uid 0 as `ROOT_REFUSED`, and
  `confine` runs nothing as root, so a job, a router or a cell outside any turn is refused too.
  Root of a user namespace — rootless podman's container root — is refused as well, since
  nothing tells it from the host's reliably.
- **Host sockets a plugin hands out.** A plugin's `contain` (`docs/plugins.md`) names a directory
  of the host to hide and, if any, the one inside it to keep — the sluice plugin's `%t/sluice` and
  `spores/<spore>/`, one socket per spore — and every contained process of the spore starts with
  `confine --contain --hide … [--keep …]`: the first process opens `keep`, lays an empty tmpfs over
  `hide`, and binds `keep` back, before the seccomp filter refuses `mount`. Landlock does not gate
  connecting to a socket; the mount namespace is what does. A directory is kept rather than the
  socket file, because a broker that restarts makes a new socket, which a file bind would miss.
  A process that would not be contained, or whose `keep` is not there — its `hide`, when it keeps
  nothing — is refused: the runner
  records the turn `CONTAIN_FAILED` (`kept_refusal`, `rust/runner/src/supervise.rs`), and
  `runShell` refuses a job's or a router's command the same way (`keptRefusal`).
- **Not gated:** a UDP port, or a unix socket a spore makes in its own socket directory, is
  reachable from another spore of the same user; TCP bind is refused to every agent and command.
  An agent can connect to any unix socket its process can see, so every socket in a spore's
  reach must ask for a secret, as the brokers' do, or be hidden from it by a plugin's `contain`.

## The supervisor builds, the worker runs

`runSpore` is the confined half of a pair. It **requires** a model client — `MODEL_CLIENT_REQUIRED`
is what a caller gets for supplying none — hosts no broker, and reads nothing about its situation
out of the environment. The socket and the ledger are parameters, passed by whoever owns them:
`bin/spore-agent.js` and `bin/spawn-worker.js` pass the supervisor's. Hosting is the
supervisor's job in both shapes.

The core does not know what a cell is: nothing in it branches on cell-ness. The cell supervisor
refuses a spawn from inside a cell (`SPORE_CELL`, `rust/runner/src/spawn.rs`), which is where that
rule is enforceable.

## Tracing

One `runSpore()` is one `spore.dispatch` span, and a cell's is a child of its parent's, so a
fan-out is one trace instead of fifty roots. The join travels by environment: `runSpore` formats
its own span as a W3C `traceparent` and exports `TRACEPARENT` to every command it starts,
`bin/spawn-worker.js` parses it back into a remote parent span, and `wsexec` handing the whole
environment to `sh -c` carries it the rest of the way.

**Above the turn, the trace comes with the message.** A caller that is tracing sends with
`send(ws, text, { traceparent })`, and the context is kept on the inbox entry, beside the text
and never in what the agent reads. The runner's `spore.turn` span (`rust/runner/src/trace.rs`)
takes as parent the first message the turn answers that carries one, and links every other traced
message it answers: a span has one parent, and the turn belongs to a caller who is tracing, so a
message sent without context does not take the turn out of the trace of one sent with it. A turn
answering no traced message is a trace of its own. The runner does not read its own
`TRACEPARENT` for this, and does not pass it on. A fork reads no message and is untraced. Links are
exported with the span; with nothing exported, the no-op span still carries its parent's
context, so the agent is traced under the caller all the same.

A subprocess inherits no TracerProvider, so each standalone entry point calls
`ensureOtelInitialized()` first; without it every span is the API's no-op, whose context is all
zeroes, and `formatTraceparent` hands on nothing. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the
call returns immediately, so a one-shot pays nothing for the wiring. Spans are batched, so every
exit path flushes with `shutdownOtel()`: `process.exit` discards the buffer, and the span that
goes missing is the parent all the cells hang from.
