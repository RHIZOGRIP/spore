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
commits needs its identity next time too. It is not something a turn made, so `produced` skips
