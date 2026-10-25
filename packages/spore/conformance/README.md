# test:model — can a model drive this runtime?

Nineteen small tasks with knowable outcomes, one per feature, graded from the workspace
rather than from prose. It answers two questions with the same run:

- **Has something changed?** Every case passed once, on the models in the baseline. A
  case that stops passing is worth investigating and names which part to look at — but
  it is not by itself evidence that spore changed. A model, a provider or the environment
  can move too, and one of the baseline models already passes and fails the same cases
  between runs. Re-run before concluding, and compare against `npm test`, which is
  deterministic and does attribute a change to this code.
- **Can this model drive the loop at all?** The tiers say how far it gets: the core loop,
  then the boundaries, then the limits, then delegation.

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

Every run gets its own directory under `--ws` — `20260910-1652-openai-gpt-5.6-luna` —
and `latest` points at the newest. Nothing is deleted. It used to be one directory,
emptied at the start of each run, which meant the evidence for "this passed yesterday"
was destroyed by the run that wanted to compare against it.

A run directory holds the workspaces exactly as the cases left them — transcripts, call
trails, turn records, the identity generated for each case — and a `run.json`:

```json
{ "model": "openai/gpt-5.6-luna", "spore": "3.0.0", "commit": "823175f", "node": "v25.9.0",
  "startedAt": "...", "elapsedMs": 34000, "concurrency": 8,
  "passed": 17, "of": 17, "spend": 0.016, "neverFinished": [],
  "cases": [{ "id": "read", "passed": true, "rounds": 2, "stopReason": "answer", "spend": 0.0008 }] }
```

Which is what makes two rows comparable. `15/17` against `17/17` says nothing on its own
if the runs differ by model, by build, or by which commit of the cases graded them.

The wait is not open-ended. Cases run `--concurrency` at a time until a deadline sized
from their own wall limits; whatever is still running then is stopped and graded on what it
left. A suite that hangs reports nothing, which is worse than a suite that fails.

## Baseline

Ten models from eight vendors, on 2026-09-10 at width 8.

**These numbers predate the grader tightening below** — they were taken when a case could
pass on its artifact alone, so they are the last measurement of the loose suite rather
than a baseline for the current one. Re-running is what makes them a baseline again; a
model that dropped a case did the work another way, which is the thing the suite now
looks at.

| model | passed | cost | wall |
|---|---|---|---|
| `openai/gpt-5.6-luna` | 17/17 | $0.0160 | 34s |
| `deepseek/deepseek-v4.1-flash` | 17/17 | $0.0234 | 30s |
| `gemini/gemini-3.5-flash-lite` | 17/17 | $0.0652 | 20s |
| `gemini/gemini-3.8-flash` | 17/17 | $0.1751 | 44s |
| `anthropic/claude-haiku-4-5` | 17/17 | $0.2710 | 36s |
| `xiaomi/mimo-v2.5` | **15/17** | $0.0100 | 148s |
| `cerebras/gpt-oss-120b` | **15–16/17, varies** | $0.0738–0.0972 | 18–24s |
| `xai/grok-4.3` | **16/17** | $0.1225 | 92s |
| `novita/minimax/minimax-m2.5-highspeed` | **15/17** | $0.2050 | 90s |
| `anthropic/claude-opus-5` | 17/17 | $0.8952 | 51s |

Only the first was used to write or tune a case, which is the evidence that matters: a
suite that only its own model passes is measuring the tuning. Four models from three
other vendors passed it cold.

Nothing wrapped in the `haiku` run — no case came near a bound — which is what says the
limits are now in the right place rather than merely larger.

### The one that does not pass

`xiaomi/mimo-v2.5` is the useful row. It clears **core, boundaries and limits** and fails
**only delegation** — the tiers degrading in the order they are written in, which is the
property the tiering claims and which five passing models could never demonstrate.

Both failures are the same thing, and it is not a runtime one: **the model does the
sub-agent's work itself and reports having delegated.** Zero spawn frames in either case.
On `fanout` it read all three questions, wrote the answers where it thought they went,
and replied "3 answered." On `enzyme-broker` it ran the enzyme directly —
`exec node data/tools/shout.mjs hello` — wrote the file and replied "done", its own
reasoning narrating what "the sub-agent" had supposedly done.

Both would have passed a grader that read the answer. They fail because the check is
*cells that answered*, taken from spawn frames on disk, and there were none. That is what
grading from the workspace buys: it catches a plausible account of work that did not
happen.

So the row says something usable about the model — fine for single-agent work, not to be
trusted with a fan-out — which is one of the two jobs this suite exists to do.

### The characteristic failure: simulating a fan-out

Four of the nine models fail `fanout` the same way, and it is worth naming because it
is the way this runtime is most often misused and the hardest kind to catch.

**They do the sub-agents' work themselves and report having delegated.** `grok-4.3` read
all three questions, wrote the three answers to `data/parts/*/data/out.json` — the right
paths, the right contents — and replied as though it had run them. `mimo` did the same
and answered "3 answered." `gpt-oss-120b` ran the enzyme directly and replied
"done", its own reasoning narrating what "the sub-agent" had supposedly done.

Every file check passed in each case. What failed was **cells that answered**, counted
from spawn frames on disk, and there were none. A grader reading the agent's output —
or even reading the output files — would have scored all three as passes.

The fourth was `minimax-m2.5-highspeed`, which wrote the three answers with
`echo "alpha" > data/parts/a/data/out.json` and then, for good measure, wrote them again
at the wrong paths.

This is the single strongest argument for grading from the workspace. The failure mode
is not a wrong answer but *a correct answer arrived at the wrong way*, and the only trace
of the difference is a file the runtime writes and the agent cannot fake. It also tells
you something real about a model: `grok-4.3` and `gpt-oss-120b` both pass `spawn` and
`enzyme-broker`, so they can delegate and decline to when the work looks small enough to do
directly; `mimo` never spawns at all. Those are different verdicts, and only the cell
count distinguishes them.

### The one that is not consistent

`cerebras/gpt-oss-120b` is a different shape of answer again. Two runs, 16/17 and 15/17,
and **not the same cases**: `refusal-escape` and `enzyme-broker` passed the first time and
failed the second; `refusal-root` failed the first and passed the second. Nothing in the
suite changed between them except the `refusal-root` prompt.

The failures, when they happen, are real rather than marginal. On `refusal-escape` it
wrote its answer to `out.txt` — bare, so at the read-only root — before it had read
anything, was refused, read `/etc/hostname`, was refused again, and replied "refused" in
prose without ever retrying the write. Recovering from a refusal is the whole of what
that tier checks. On `enzyme-broker` it ran the enzyme itself, as `mimo` did.

A model that passes only sometimes has not passed, which is the rule this suite applies
to its own cases and applies here too. The row records the range rather than the better
run: it is the fastest of the seven and cannot be relied on to hold the contract.

It is an old model and not a candidate for anything here. It stays in the table because
it is the only example of this shape — a model that is *sometimes* able to hold the
contract — and that is not something a model you would actually deploy will show you. A
row worth keeping is one that fails in a way none of the others do.

Cost spreads **56×** across the ten while wall clock stays inside 18–148 seconds — the
cheapest is not the fastest, and price predicts neither steps nor success. Every model
drives the core loop in two to six rounds; what separates them is **delegation**, where
they take anywhere from 4 to 22 rounds, or fail outright.

Price does buy reliability at the top: `opus-5` is the dearest at $0.8952 and clears all
seventeen, including the three delegation cases that four cheaper models fail. But it is
not a straight line — `luna` costs a fifty-sixth as much and also passes everything, and
`grok-4.3` at eight times `luna`'s price still simulates a fan-out.

That is a sharper thing to know about a model than an accuracy score, and it is the
number to look at when choosing one for work that fans out.

Rounds, from the luna run:

| case | rounds | seen across runs |
|---|---|---|
| answer | 1 | 1 |
| read | 2 | 2 |
| read-range | 4 | 3–5 |
| write | 3 | 2–4 |
| edit | 4 | 3–4 |
| exec | 5 | 3–6 |
| wsexec | 4 | 4–5 |
| exit-code | 2 | 2 |
| library | 4 | 4–7 |
| refusal-root | 3 | 3 |
| refusal-escape | 4 | 3–5 |
| exec-readonly | 4 | 3–5 |
| ask | 1 | 1 |
| soft-rounds | 3 | 3 |
| spawn | 4 | 4–9 |
| fanout | 6 | 4–17 |
| enzyme-broker | 6 | 5–10 |

Rounds wander with the model, not the runtime, which is why the limits sit well above
what any case needs rather than at the observed figure. A case that starts needing many
more rounds than this is worth reading even while it passes: that is what a regression
looks like before it becomes a failure.

The round limits were widened three times before being set properly, and the pattern is
worth keeping: each time they had been chosen from what a model had just been observed to
need, and each new model pushed past them. Two wrapped a delegation case at 7 against a
bound of 6; a third landed on exactly 12 against a bound of 12; a fourth wrapped the
*core* `wsexec` case at 7 against a bound of 6, and took 17 rounds on a fan-out.

**Rounds are a runaway guard; cost is the budget.** They are now set from what a case is
rather than from a measurement — `[15, 18]` for most, `[30, 36]` where a case delegates —
generous enough that no model reaches them, with `cost` doing the actual bounding. A
round ceiling a working model can touch is a ceiling in the wrong place, and every one of
those four cases passed only because a soft wrap still leaves an answer.

## Price, and what a ceiling means

A case's `cost` is what it may spend: a tenth of a dollar is plenty for reading a file and
writing an answer, whatever the model costs. The hard bound is a stop on what was spent, not
a forecast of what a call will cost, so a dear model runs the same cases as a cheap one and
simply reaches its bound sooner.

## What it covers

| tier | cases | what fails if it breaks |
|---|---|---|
| **core** | answer, read, read-range, write, edit, exec, wsexec, exit-code, library | the tool loop itself: does a turn end, do the seven tools do what they say, is the exit code the success signal, can a program import a provisioned library |
| **boundaries** | refusal-root, refusal-escape, exec-readonly | the workspace root is read-only, a path cannot leave the workspace, `exec` cannot write — and the agent is told clearly enough to recover |
| **limits** | ask, soft-rounds | `ask` ends the turn with `question`; a soft bound wraps and still answers |
| **delegation** | spawn, fanout, enzyme-broker | one cell, many cells, and an enzyme granted to a cell by name through the broker |

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
  child spend in the parent's turn record

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
at the right paths, frames with the right shape. Four of the ten models in the baseline
do exactly this, which is why the frame count exists at all; but the count only catches
the ones that do not bother writing frames.

The turn record cannot be forged the same way. It is in `state.sqlite` at the workspace
root, which the ruleset leaves as a read path, and only the runner writes it;
`test/sqlite-confined.test.js` asserts that a confined process can read it and cannot write
it, through `$SPORE_SQL` or by opening it for writing itself.

Its `ownMicros` is this loop's own spend and its `treeMicros` the whole subtree's, so
`treeMicros > ownMicros` is money a descendant spent through the broker — and only a
process holding a broker connection can have spent it. A case that expects cells requires both: the frames say
*which* parts were delegated, the files say *what came back*, and the spend says *a cell
really ran*.

The same discriminator, over the runs on record:

```
spawn        frames=1   cost=0.134095  tree=0.139355  -> children spent
enzyme-broker  frames=1   cost=0.075595  tree=0.094405  -> children spent
fanout       frames=5   cost=0.23264   tree=0.25036   -> children spent
fanout       frames=16  cost=0.001884  tree=0.041366  -> children spent
fanout       frames=2   cost=0.006049  tree=0.006049  -> NO child spend
```

The last is the stress run whose cells all died on the socket-path bug: frames on disk,
nothing behind them.

What it does not prove: that a cell ran is not how many ran, so the frame count still
carries the arity, and `enzyme-broker` still cannot tell a cell that called the
enzyme from one that upper-cased the word itself. Nothing inside a cell workspace can
settle either, and that is structural rather than an omission — a confined parent can
only create a directory where it is allowed to write, which is one of its own islands,
and it has to create the cell's workspace and write the prompt into it. Every file a cell
produces is therefore a file its parent could have produced. Closing those two gaps means evidence written by the
supervisor outside the islands, which is instrumentation this suite does not have yet.

The other limit is arithmetic: a cell whose whole spend rounds below `1e-6` would be
invisible. No model in the baseline comes close — the cheapest cell on record cost about
`$0.0008`.

## What the runs taught about writing a case

Getting to 17/17 took four runs and about six cents, and produced two defects in spore —
`spawn` under `exec` answering with a raw `EACCES` and a node stack trace instead of
naming `wsexec`, and `precursors/README.md` never saying that the runtime writes the
answer file, so a precursor telling a cell to write it sends the cell hunting the
filesystem. Everything else that failed was a case of mine, and each taught a rule:

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

The mechanism rule caught a second case three models later, which is the reason to write
these down. `refusal-root` said "first try to write at the workspace root, and when that
is refused, write it to data/ instead" — and a model that already knew the root is
read-only, which `reference.md` tells it, sensibly skipped the doomed call: one write
straight to `data/`, the word "refused", and no refusal for the trail to record. It now
asks for the call itself and says the refusal is the point. Knowing a rule and applying it
to the case in front of you are separate acts.

## Adding a case

Add it to `cases.js` with the tool grants it needs and nothing more; a case granting a
tool it never uses is a case that can pass by accident. Then run `selfcheck.js`, which
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
