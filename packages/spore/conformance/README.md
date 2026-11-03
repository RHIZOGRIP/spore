# test:model — can a model drive this runtime?

Twenty-eight small tasks with knowable outcomes, one per feature, graded from the workspace
rather than from prose. It answers two questions with the same run:

- **Has something changed?** Run it on the same model before and after a change. A case
  that stops passing is worth investigating and names which part to look at — but it is
  not by itself evidence that spore changed. A model, a provider or the environment can
  move too, and a model can pass and fail the same case between runs. Re-run before
  concluding, and compare against `npm test`, which is deterministic and does attribute a
  change to this code.
- **Can this model drive the loop at all?** The tiers say how far it gets: the core loop,
  then the boundaries, then the limits, then delegation — and last, whether the prompt spore
  ships holds on it.

Every case is dull on purpose. A model good enough to use tools should pass all of them,
so a failure is a regression or a model that cannot hold the contract — not a hard task.

```bash
npm run test:model                     # every case
npm run test:model -- --only core      # one tier
npm run test:model -- --only fanout    # one case
node conformance/selfcheck.js          # everything checkable without a model
```

Not part of `npm test`: it calls a model, so it costs money and needs `$MODEL` and a
provider key. `npm test` stays free and offline.

## What a run leaves behind

Every run gets its own directory under `--ws`, named like `20260910-1652-openai-gpt-5.6-luna`,
and `latest` points at the newest. By default `--ws` is `$XDG_STATE_HOME/spore/conformance`, or
`~/.local/state/spore/conformance`, beside the cells spore keeps there: outside any checkout and
outside `/tmp`, where a workspace is refused. Nothing is deleted. It used to be one directory,
emptied at the start of each run, which meant the evidence for "this passed yesterday"
was destroyed by the run that wanted to compare against it.

A run directory holds the workspaces exactly as the cases left them — transcripts, call
trails, turn records, the identity generated for each case — and a `run.json`:

```json
{ "model": "openai/gpt-5.6-luna", "spore": "1.51.0", "commit": "823175f", "node": "v25.9.0",
  "startedAt": "...", "elapsedMs": 34000, "concurrency": 8,
  "passed": 28, "of": 28, "spend": 0.016, "neverFinished": [],
  "cases": [{ "id": "read", "passed": true, "rounds": 2, "stopReason": "answer", "spend": 0.0008 }] }
```

Which is what makes two runs comparable. A different pass count says nothing on its own
if the runs differ by model, by build, or by which commit of the cases graded them.

Results stay there, beside the runs, and never in this repository. Spore changes and models
change, so a recorded result stops being true without anything saying so.

The wait is not open-ended. Cases run `--concurrency` at a time until a deadline sized
from their own wall limits; whatever is still running then is stopped and graded on what it
left. A suite that hangs reports nothing, which is worse than a suite that fails.

## Limits, and what a ceiling means

**Rounds are a runaway guard; cost is the budget.** Rounds are set from what a case is
rather than from what a model was seen to need — `[15, 18]` for most, `[30, 36]` where a
case delegates — generous enough that no model reaches them. Set from a measurement, they
were pushed past by each new model, and a case came within one step of failing for being
slow rather than wrong. A round ceiling a working model can touch is a ceiling in the wrong
place.

A case's `cost` is what it may spend: a tenth of a dollar is plenty for reading a file and
writing an answer, whatever the model costs. The hard bound is a stop on what was spent, not
a forecast of what a call will cost, so a dear model runs the same cases as a cheap one and
simply reaches its bound sooner.

## What it covers

| tier | cases | what fails if it breaks |
|---|---|---|
| **core** | answer, read, read-range, write, edit, exec, wsexec, exit-code, library, hand-back, own-state | the tool loop itself: does a turn end, do the seven tools do what they say, is the exit code the success signal, can a program import a provisioned library; a file in `data/out/` comes back in the turn record's `deliverables`; the agent can read its own record through `$SPORE_SQL` |
| **boundaries** | refusal-root, refusal-escape, exec-readonly, schedule | the workspace root is read-only, a path cannot leave the workspace, `exec` cannot write — and the agent is told clearly enough to recover; a schedule written within its grant, in the format `reference.md` gives |
| **limits** | ask, quiet, soft-rounds | `ask` ends the turn with `question`; `quiet` ends it with nothing to say, in a turn the clock started, since a person's message is owed an answer; a soft bound wraps and still answers |
| **delegation** | spawn, fanout, enzyme-broker | one cell, many cells, and an enzyme granted to a cell by name through the broker |
| **identity** | do-not-offer, no-later, compute, greeting, fence, remember, follow-up | the shipped `default` and `perennial` prompts: asked whether it can, it does; the work is done rather than promised; arithmetic is computed; a greeting is greeted; text to copy comes in a fence; what it is told goes in `data/memory/`; a reminder becomes a schedule |

Every other tier runs under a three-line identity granting only the case's tools, which is
what makes those cases about the runtime. The identity tier is the opposite: it runs a shipped
`spore.cmk` as written — its tools and its body, with only the model and the limits the run's —
and its prompts are what a person actually types. So a failure there is about the prompt and
the model together, which is the thing an operator ships. Each case checks one rule the body
states that a live spore has been seen to break.

## How a case is graded

From the workspace, never from what the agent said about it:

- **files** — exact bytes, or a pattern, at a path the task named
- **stopReason** and **concluded** — from the `turns` view
- **calls** — a record in the call trail matched to its tool *and* its target, and to
  whether it was refused, ran and failed, or carries a particular recorded field. A
  boundary case names the call it means: a bare refusal count passed on a refused read
  of a missing file under `data/`, which is a real refusal and not the one being tested.
  Any other key in the spec is matched against the field of that name in the record —
  `exit: 7` for the code a command returned, `eof: false` for a read that asked for a
  range rather than the whole file
- **absent** — a path that must not exist, which is the boundary's other half: the agent
  reporting `blocked` is its own word, the file the runtime kept it from creating is not
- **cells** — spawn frames with an answer, wherever under `data/` they were put, *and*
  the runner's count of that precursor's cells in the parent's turn record
- **deliverables** — a file the runner listed as handed back in the turn record, with a
  path and contents that match: a file in `data/out/` the list does not name was not handed back
- **under** — a file anywhere under a directory, with matching contents, for a note or a
  schedule whose name the model chooses
- **fires** — a one-off schedule firing a number of days after the turn started, at a local
  time, both read on the clock of a named zone: "tomorrow at 9:00, Paris time"
- **uncalled** — tools the turn must not have called, and **answerNot** — a pattern the
  answer must not match

A call spec's `tool` may be a pattern, for a case that accepts `exec` or `wsexec`. A case that
sends several messages lists them as `messages`, sent one turn after another and graded on the
last turn. A case whose message the clock says, not a person, names the schedule it
comes from as `schedule`, and is delivered as `tick` delivers a due one.

That is the runtime's own claim — the answer is what is on disk — so the grader reads the
file the task named. No judge model: slower, dearer, and less certain than `===`.

### Why the right answer is not enough

A case that reads only the artifact grades the answer, not the feature — and the two come
apart in a way the workspace records. Each of these was a live pass with the operation
never performed:

| case | passed by | what it now has to show |
|---|---|---|
| `exit-code` | replying `7`, which the prompt contains, with no tool at all | an `exec` of `exit 7` whose record says `exit: 7` |
| `exec` | writing `40` directly — `read` was granted, so the count needed no shell | `read` is no longer granted, and an `exec` naming the file has to have exited clean |
| `read-range` | reading all forty lines and keeping three | a `read` record with `eof: false` — it asked for a range |
| `library` | writing `50` directly | a program at `data/total.mjs` whose source imports `csv-parse`, a `wsexec` that ran it, and a total only a CSV parser reaches |

The last one is also a fixture change. `qty` moved behind a quoted comma —
`bolt,"hex, 8mm",12` — so splitting on commas reads `" 8mm"` as the third field and totals
`NaN`. The answer is now evidence of the parse rather than of arithmetic.

Restricting grants does most of this work and none of it alone: taking `read` away from
`exec` removes the shortcut, but nothing yet required the granted tool to be used. That
is what the call spec is for.

### Why delegation needs two kinds of evidence

A spawn frame is not proof. `spawn.json` lives under `data/`, one of the three write
islands Landlock grants back, so an agent that does the cells' work itself and writes the
frames afterwards produces a workspace indistinguishable from one that delegated — files
at the right paths, frames with the right shape. Models do this — read the questions,
write the answers where the cells would have, and report having delegated — which is why
the frame count exists at all; but the count only catches the ones that do not bother
writing frames.

The turn record cannot be forged the same way. It is in `state.sqlite` at the workspace
root, which the ruleset leaves as a read path, and only the runner writes it;
`test/sqlite-confined.test.js` asserts that a confined process can read it and cannot write
it, through `$SPORE_SQL` or by opening it for writing itself.

Its `byPrecursor` says, for each precursor, how many of its cells called the model through the
runner: a cell's model client names its precursor and its own workspace on every call, and the
runner counts the workspaces. Only a process holding a broker connection can be counted. A case
that expects cells requires both: the frames say *which* parts were delegated and what came
back, and the count says *that many cells really ran*.

It is a count, not money. The grader used to read `treeMicros > ownMicros` — spend a descendant
made through the broker — and a call on an unmetered route such as `chatgpt/`, or on a free
model, records no spend, so a delegation that really ran failed there. The count holds on any
route.

What it does not prove: `enzyme-broker` still cannot tell a cell that called the enzyme from
one that upper-cased the word itself. Nothing inside a cell workspace can settle that, and it is
structural rather than an omission — a confined parent can only create a directory where it is
allowed to write, which is one of its own islands, and it has to create the cell's workspace and
write the prompt into it. Every file a cell produces is therefore a file its parent could have
produced. Closing it means evidence written outside the islands of the enzyme's run, which this
suite does not have yet.

## What the runs taught about writing a case

Writing the cases found two defects in spore —
`spawn` under `exec` answering with a raw `EACCES` and a node stack trace instead of
naming `wsexec`, and `precursors/README.md` never saying that the runtime writes the
answer file, so a precursor telling a cell to write it sends the cell hunting the
filesystem. Everything else that failed was the case, and each taught a rule:

- **Where a feature depends on the model choosing, take the choice away** rather than
  arguing with the tool's own guidance. `ask` discourages itself — "look first, ask only
  about what looking cannot answer" — so the case grants nothing to look *with*.
- **Ask for the mechanism, not the intent.** A model told to "ask the user" replies with
  the question, which from its side is asking, and the turn ends `answer`. What the tool
  does is end the turn `question` so a caller can tell waiting from finished. Until the case
  said that, it was testing a judgement rather than a feature.
- **Name the fixture as a fixture.** Say what is already in the workspace and that it is
  not to be changed. `spawn` said "giving it in.md as its prompt", and a model read that
  as an instruction to create the file — `echo "hello" > data/one/in.md` — destroying the
  question, after which the cell answered a greeting. `fanout` says the directory *holds*
  a question and never had the problem.
- **A budget that is nearly enough is a flaky case.** `echo` had `rounds: [3, 4]`, and a
  cell that took 4 wrapped at the soft bound and lost an answer it had produced, because
  `on-wrap: discard` is doing its job.

The mechanism rule caught a second case later, which is the reason to write these down. `refusal-root` said "first try to write at the workspace root, and when that
is refused, write it to data/ instead" — and a model that already knew the root is
read-only, which `reference.md` tells it, sensibly skipped the doomed call: one write
straight to `data/`, the word "refused", and no refusal for the trail to record. It now
asks for the call itself and says the refusal is the point. Knowing a rule and applying it
to the case in front of you are separate acts.

## Adding a case

Add it to `cases.js` with the tool grants it needs and nothing more; a case granting a
tool it never uses is a case that can pass by accident. A case of the identity tier names a
shipped sporangium instead, and grants nothing of its own. Then run `selfcheck.js`, which
checks the case's shape, that its identity parses and grants exactly what it asked for,
that its fixtures stage, and — the part that matters — that the grader gives the right
verdict on a workspace built to pass and one built to fail. A grader that is wrong makes
the suite lie in the direction nobody checks.

## Two things it deliberately does not do

**It does not measure quality.** Every case is pass/fail against a known answer. Accuracy is a
benchmark's job, not this suite's, and ten runs of one cannot separate a real difference from
run-to-run noise anyway.

**It does not retry.** A model that passes only sometimes has not passed. If a case is
flaky the case is wrong — make it duller.
