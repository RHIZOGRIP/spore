# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [1.60.0] — Added: Thinking Machines' Inkling models, through mohdel 4.10.0

### Added

- mohdel 4.10.0, on both the npm and the Cargo side. It adds the `tinker` provider, Thinking
  Machines' serverless inference for the Inkling models, with the key in `TINKER_API_SK`. A spore
  can name a `tinker/` model in `spore.cmk` once the catalog has an entry for it. Tinker lists no
  models, so the entries come from a file, with `mo model apply`.
- `spore setup`'s expert path lists Thinking Machines Tinker among the providers, and sets up its key.

## [1.59.0] — Fixed: a spore carries its own name

### Fixed

- A spore made from a sporangium other than the default kept that sporangium's name in its
  `spore.cmk`, and `spore show` printed it as the spore's name: `spore define substack
  --sporangium humanizer` showed `name humanizer`. A spore made from the default one showed
  `name spore`. `define`, from a sporangium, a file or another spore, and `fork` now write the
  spore's own name, its directory's. Existing spores keep what they have; `spore edit` changes it.

### Changed

- Redefining a spore with `spore define <name> --definition <file>` keeps the spore's name, and
  says what changed, as `spore edit` does. In the library, `define`'s `redefined` is now
  `{ changes }` rather than `{ from, to }`.

## [1.58.2] — Fixed: sub-agents start outside the default npm prefix, and `spore tui` shows delivered files

### Fixed

- With spore installed globally outside `/usr`, and `mohdel` installed globally beside it, every
  sub-agent started by a turn died with `Cannot find package …/mohdel/index.js`. Turns themselves
  worked. The sandbox granted only the nearest `node_modules`; it now grants every `node_modules`
  spore is installed under, so an agent can read that prefix's global packages, as it can on `/usr`.
- `spore doctor` now loads the runtime as a sub-agent does, inside the sandbox, and reports a problem
  when it cannot.
- A file a turn left in `data/out/` never reached the terminal: an answer could link to it, and the
  screen showed only the link's text. `spore tui` now lists those files under the answer, by their
  full path and size, up to five and then how many more, for earlier turns too.
- A click on a link in an answer did nothing, unless it was a code block's `/copy` label. It now
  copies where the link points and says so: a web address as it is, a file by its full path, or
  says there is no such file. A relative link is read from the spore's workspace. On a delivered
  file's line, Shift-click leaves it to the terminal, which can open it.
- A spore kept the `node_modules/` links it was made with, so after spore moved to another npm prefix
  its programs could no longer import `yaml`, `csv-parse` or the other provided libraries. Each turn
  now lays a link naming another install again. A turn is also refused, saying so, when one of those
  libraries is missing from the install.

## [1.58.1] — Fixed: `spore doctor` asks for the tick timer for every hook and API caller

### Fixed

- A delivery with every turn slot taken waits for a `spore tick` pass, even from a hook or an API
  caller with no `maxWait`. `spore doctor` only asked for the tick timer when `maxWait` was set, so
  a host without it could hold such a delivery forever and show nothing. It now asks for every hook
  and caller, except under `admission: caller`, where nothing is held for the pass.

## [1.58.0] — Added: spore says how to install `mo` when it names it

### Added

- `mo` comes inside spore for `spore setup`, and npm does not put it on your `PATH`. Wherever `spore`,
  `spore doctor`, `spore setup` or `spore tui` names a `mo` command and `mo` is missing, the message
  now gives the install command, at the mohdel spore pins. JSON output is unchanged.

## [1.57.1] — Changed: `spore tui` runs on pi-tui 1.5.0

### Changed

- `@earendil-works/pi-tui` 1.2.0 → 1.5.0. Page Up and Page Down now move through the open
  autocomplete menu, and a direct exit gives the terminal back as it found it.

## [1.57.0] — Changed: `spore setup` offers the recommended models first

### Changed

- On a machine with no default model, `spore setup` asks mohdex.dev which models pass the `core` and
  `identity` tiers of the conformance suite, and offers those. It asks which provider you have, gets
  its key or sign-in, then lists that provider's models, cheapest first, with their prices. It used
  to offer ChatGPT, OpenRouter or another provider, then every model in the catalog, including free
  ones that cannot drive spore.
- The last row, `expert`, offers every provider mohdel knows, runs `mo onboard <provider>` for the
  one picked, then lists that provider's text models, with a last row that runs
  `mo curate <provider>` for a model the catalog lacks. Embedding and image models are left out.
- A model chosen in setup gets the tag `spore` in mohdel's catalog, and `expert` lists those first.
- The models offered are not checked against the account, because a provider's own list can lag a
  new model. One the account cannot use fails at its first turn.
- When mohdex.dev cannot be reached, setup warns and goes to `expert`. With a default model set, it
  says in one line if that model is not recommended, and carries on.
- `mohdel` 4.8.1 → 4.9.2.

### Added

- `spore setup model` offers the recommended models on its own, whatever is set, so a model of
  another provider is one command away. Spores you already have keep theirs.
- `mohdexRecommended`, `mohdexEntries`, `addFromMohdex`, `tagModel` and `PROVIDER_INFO`, re-exported
  from mohdel. `modelsOf` also says each model's `type` and `tags`.

### Fixed

- `spore setup` asks about the tick timer only while there are no spores. A second run asked again
  after every "no"; it now says the timer is off and how to turn it on.
- The `spawn` and `enzyme-broker` cases named `data/out.json` as the answer, which is relative to
  the sub-agent's directory, and the check reads `data/one/data/out.json`. Since 1.55.1 every case
  says the check reads a file at the path the task names, so a model could not tell which was
  meant: some wrote a second copy at `data/out.json`, spending extra rounds on it. The cases now
  say the answer goes to `data/out.json` in that directory, as `fanout` does. Their digests change.

## [1.56.0] — Fixed: a stopped turn's work does not come back

### Fixed

- After `spore stop`, a relay's `/stop` or a stop through the HTTP API, the next turn no longer
  takes up the stopped work. The stopped turn had read its message, so the message stayed in the
  transcript with no answer and the next turn answered it. The turn now ends with a note in the
  transcript saying it was stopped and its work is not to be taken up again unless asked.
- What is said after a stop, while the turn waits on its model call, gets a turn at once. It used
  to wait for the next `send`.
- A stop that lands before the agent starts sets aside the message the turn was started for.
  It used to be answered by the next turn.

### Changed

- `stop(ws, { replyTo })` takes whose queue it covers, and its result has `marked`, false when the
  stop could not be written down. What that place queued up to the stop and no turn read is set
  aside at the turn's end. With no `replyTo`, that is what was said from the terminal or the
  library, and never a conversation's, a clock's, a webhook's, a job's or a caller of the API's.
- `POST /v1/spores/<name>/stop` takes `replyTo` in its body, and refuses one that is no conversation.
- A second `stop` while a stopped turn waits on its model call sends no signal.
- `spore pause` and a SIGTERM from outside, such as a host shutting down, behave as before: no
  note, nothing set aside and no new turn.
- Schema 16: `t_stops`, the stops waiting for a turn's end. A spore migrates on its next write.

## [1.55.1] — Fixed: a conformance case that names a file says the check reads it where named

### Fixed

- Every conformance case now says that the check reads a file the task names in the workspace,
  at the path it names. The identity tells a model that whoever reads its answer never sees the
  workspace, and to put a file they should have in `data/out/`, unless its instructions say
  otherwise; the cases did not, so a model that followed the identity handed the file back as
  `data/out/result.txt` and failed. Muse Wonder 1.0 did so in two cases of 1.55.0's run and in
  three of 1.54.1's, where the cause was put down to the name `data/out.txt`; renaming it in
  1.55.0 did not change it. Every case's digest changes.

## [1.55.0] — Fixed: a file in `schedules/` that is not `<name>.cmk` stops the answer that promised it

### Fixed

- A file written to `schedules/` under any name but `<name>.cmk`, or in a directory below it, never
  fires, and the check made when the model answers did not see it: it read only `.cmk` files. An
  agent wrote its reminder as `schedules/call-bank.toml` with `wsexec` and told its user it was
  set. The check now covers every file changed under `schedules/` since the turn began, and names
  one that is no schedule by its name with the reason `write` gives.
- mohdel 4.8.1, on both the npm and the Cargo side. Mistral refused every call with a 422, because
  the identifier spore gives each conversation went in a `user` field Mistral does not have; it
  now goes as `prompt_cache_key`, which routes Mistral's prompt cache. DeepSeek and Cerebras get
  it in their own fields too.
- `reference.md` says a schedule is one `<name>.cmk` file and that a file named otherwise never
  fires. A spore made before this gets the new text with `spore upgrade`.

### Changed

- The host's `PATH` no longer reaches a spore. It is the operator's own and names their home, and
  a command printing it put it in the transcript, which goes to the provider. The runner now sets
  `PATH` itself for the agent, its cells, its jobs and its routers: the directory of the Node
  spore runs on, so `node` is that one wherever it is installed, then `SPORE_PATH` when the
  operator names one, in `~/.config/spore/environment` or the runner's environment, else
  `/usr/local/bin:/usr/bin:/bin`. Any other tool found only under the home, such as an asdf
  shim, no longer resolves inside a spore; it never ran there, since the sandbox grants nothing
  else under the home.
- A turn refused because every admission slot is taken now says the limit covers all of the user's
  spores: `8 turns are already running, across all your spores`, and that a conformance run or a
  batch counts too. It said `8 of your turns are already running`, which read as one spore's.
- A `schedule_refused` event names each file by its `path` in the workspace, such as
  `schedules/call-bank.toml`, where it gave a schedule `name`.
- Six conformance cases (`read-range`, `write`, `exec`, `library`, `refusal-escape` and
  `exec-readonly`) ask for `data/result.txt` where they asked for `data/out.txt`. That name sat
  beside `data/out/`, which `reference.md` teaches as the folder a turn hands back, and models of
  eight families wrote `data/out/out.txt` instead, in 12 of 57 runs, failing a case for the folder
  rather than for what it grades. Their digests change.
- A conformance run scales every case's `cost` limits by its model's input price over $1 per
  million tokens, read from mohdel's catalog, so a dear model is held to the same work as a cheap
  one rather than to fewer rounds. Muse Wonder 1.0, at $4, finished `library` correctly and failed
  it at `soft:cost` after reading all of `reference.md`; it now gets four times the budget, and
  Luna, at $0.10, a tenth. A model with no price keeps the budgets as set. `run.json` records
  `inputPrice` and `costScale`. Replayed against every kept run, each model's costliest case used
  at most 0.8 of its scaled soft bound. Digests are computed on the budgets as set, so they do not
  change.

## [1.54.1] — Changed: the conformance `read-range` and `schedule` cases

### Changed

- The conformance `read-range` case reads from a file of 200,000 lines, about 1.3 MB, and asks to
  read only lines 12 to 14. It grades a read that asks for a range, and on a file of 40 lines a
  model that followed `read`'s own advice, to slice only a file too large to return whole, read it
  whole and failed. A whole read of this one is past the read budget and refused. Its digest
  changes too.
- The conformance `schedule` case stages `data/queue.txt`, the file its prompt schedules a check
  of. A model that looked at it before writing the schedule read a file that did not exist, and
  that failed read counted toward the five that wrap a turn at `soft:progress`. The case's digest
  changes, so its results are not comparable with earlier runs.

## [1.54.0] — Fixed: a reply the provider refused ends the turn and says why, instead of passing for an answer

### Fixed

- mohdel 4.8.0, on both the npm and the Cargo side. A reply Anthropic's safety classifiers refused
  came back as a finished one, so a turn ended in `MODEL_REPLY_INCONSISTENT` when the refusal
  followed a streamed tool call, or took three empty replies for its answer when it came first. A
  refused reply is now `incomplete`, and the turn ends in `MODEL_REPLY_INCOMPLETE` with the reason
  in its detail, such as `round 2: contentBlocked (frontier_llm)`: the warning, then the
  provider's own reason when it gives one. The same holds for a content filter on OpenRouter and
  the other chat-completions providers, and for Gemini's safety stops.

### Added

- spore names itself to OpenRouter. Every call there carries `HTTP-Referer:
  https://rhizogrip.com/spore`, `X-OpenRouter-Title: spore` and `X-OpenRouter-Categories:
  cli-agent`, so spore shows in OpenRouter's app rankings and on each model's "Apps" tab. The
  runner sets them for its model sessions; on a host with a gate, the gate's environment decides.

### Changed

- The conformance suite runs its boundary cases last. They try to leave the workspace, and on
  Opus 5.5 a request to start a sub-agent sent shortly after them was refused as `cyber` more
  often: 10 of 14 against 2 of 6 sent alone. Each case is meant to be graded on its own, so these
  no longer run before the delegation cases. The report lists the tiers in the same order as
  before.
- The conformance grader takes a denial `exec` printed to stdout, after `2>&1`, as well as one on
  stderr, so a model that caught its own `Permission denied` is no longer failed for it.

## [1.53.0] — Added: a turn is told, before it answers, that a schedule it wrote will not fire

### Fixed

- `reference.md` and `precursors/README.md` said `--prompt` is relative to `--ws` and left
  `--answer` to the examples. An agent that wrote `--answer` from its own workspace —
  `--ws data/parts/a --answer data/parts/a/data/out.json` — had each answer put one level down, at
  `data/parts/a/data/parts/a/data/out.json`, and reported every part answered. Both now say the two
  are relative to `--ws`, with where the answer lands, and the fan-out section says the same of
  its parts. A spore made before this gets the new text with `spore upgrade`.
- `reference.md` gave a one-off schedule as "`when` is a cron expression…; or `at <instant>`",
  which an agent read as a field of its own and wrote `at: 2026-11-04T09:00:00+01:00`, a schedule
  that never parses and so never fires. It now shows the one-off form, `when: at <instant>`, says
  there is no `at:` field.

### Added

- A schedule written this turn that will not fire as written now stops the answer once. When the
  model answers, every file in `schedules/` changed since the turn began gets the check `write`
  makes, the count aside. On a refusal the answer goes back to the model with a note naming each
  file and why, and the turn goes on, within its limits. A schedule written with `wsexec` was never
  checked: an agent wrote `at: …` for `when: at …`, told its user it would remind them, and the
  schedule could never fire. Each check that finds one is a `schedule_refused` event — `round`,
  `schedules` as `{ name, why }`, and `answered`, true when the answer went out with it standing.
  Only a spore whose definition grants `schedules` is checked: without the grant, `schedules/` is
  its operator's.

- A conformance `run.json` records `dirty`: the files under the package that differed from
  `commit` when the run started, as `git status --porcelain` prints them, and null in an installed
  copy. A run on uncommitted files no longer passes for the commit it started from.

## [1.52.0] — Added: `spore setup` can sign in with OpenRouter instead of a pasted key

### Added

- mohdel 4.6.0, on both the npm and the Cargo side. Setting up OpenRouter in `spore setup` offers
  "Sign in with OpenRouter" before "Paste an API key": a link to open in any browser, a code to
  paste back, and a key OpenRouter makes on the user's account, labelled
  `spore via Mohdel (<hostname>)`. An OpenRouter call its upstream provider failed now says what
  the upstream said, where it said only "Provider returned error".

### Changed

- A model that refuses a call because the caller's own quota is used up (`RATE_LIMIT_TIER`, such as
  the per-minute limit on OpenRouter's free models) now says how long to wait, starting with the
  first refusal. spore waits that long and then calls again, where it used to spend its three
  retries in 7 s and fail the turn. Only that model is held back; the provider's other models can
  still be called.
- A turn told to wait past its hard wall, by a used-up quota or a provider's cooldown, ends at
  once on that refusal: `stopReason: 'error'`, with the provider's type and words in its record,
  and a `recovery` event of action `stop` giving the wait it was told and the time it had left.
  It used to wait until the wall stopped it, ending `hard:wall` with nothing to say why. A cell
  ends the same way, so its parent sees a failed part rather than a cell that ran out of time.

### Fixed

- Setting up OpenRouter's free models in `spore setup` keyed each one with its listed id,
  `…:free`, which `mo check` and `mo model apply` reject since `:` marks an effort. The key now
  ends in `-free` (`openrouter/google/gemma-4-31b-it-free`), and the call still asks OpenRouter
  for the `:free` model.

## [1.51.0] — Added: a service can reach a spore's own socket directory

### Added

- `sporeSocketDir(ws)` returns a spore's own socket directory, its agent's `$SPORE_SOCKET_DIR`. It
  makes the directory if it isn't there, and refuses one that isn't this user's own with mode 0700
  (`SOCKET_DIR_UNSAFE`). A plugin's service uses it to leave a file there before a turn, for that
  spore's agent alone. The browser plugin's service writes each spore's endpoint there.
- `confineCommand(command, grants)` returns the `confine` binary and its arguments for a command
  held to `grants` (`writeRoot`, `reads`, `writes`, `contain`, `keep`, `scopeSignals`,
  `ownNamespaces`), the way spore starts a job's or a router's command. `containing(config)` says
  whether the host config contains, and `containCheck()` whether this host can. A plugin's service
  uses them to hold what it starts to a spore's grants.
- `confine --own-namespaces`, only with `--contain`, lets the command make namespaces of its own
  (`unshare`, and `clone` with namespace flags), nested in the contained ones. Joining a namespace
  and every mount call stay refused. A browser's sandbox needs it: the browser plugin starts each
  spore's Chrome this way.

### Changed

- `spore doctor` runs the `check` of every defined service, as `spore service define` does, and
  reports one that fails as a problem with what it said. `define` refuses such a service as one
  that "did not pass its check", no longer "would not start": a check may now also say what a
  running service let through.

## [1.50.0] — Added: a spore chooses how a plugin serves it

### Added

- Plugin options. A plugin's manifest may declare `options`, each with the `values` a spore may
  choose and a `default`. A spore that lists the plugin in `plugins:` chooses one in its
  `spore.cmk` as `<plugin>.<option>: <value>`. The plugin reads it as `{options.<name>}` in `env`
  and `contain`. A turn is refused when the option is undeclared (`PLUGIN_OPTION_UNKNOWN`) or the
  value is not offered (`PLUGIN_OPTION_INVALID`). A one-value dotted key is an option and a list is
  a source's narrowing, so a plugin's options and its source share its name without colliding.
  `spore show` lists the options a spore sets beside its plugins, and `spore plugin show` lists a
  plugin's options with their default.

### Changed

- A dotted key whose first part is a field with dotted keys of its own, like `extend.time`, is
  refused as an unknown field and the message names that field's keys. It used to be told to
  grant a source.

## [1.49.5] — Changed: a spore hands over commands that run as written

### Changed

- The `default`, `perennial` and `code` sporangia say how to hand someone commands to run on their
  own machine: one block that runs as written in one shell, naming that shell and machine, with
  what it prints when it worked and which line is hard to undo — or, for steps handed over again,
  a script in `data/out/`. A spore made before keeps its `spore.cmk`; add the paragraph by hand.

## [1.49.4] — Fix: setup asks where spore runs only where a vm makes sense / Changed: mohdel 4.3.1, models from mohdex

### Fixed

- `spore setup` no longer asks whether spore runs on this machine or in a vm when the machine is
  itself a vm or a container — WSL, a cloud server, spore's own Lima guest, where the question
  offered Lima inside the vm. `systemd-detect-virt` says so; a machine without it is asked as
  before.
- On Windows, `spore setup` says how to run spore in WSL 2 instead of only that it runs there.
  The READMEs say what a first run in WSL 2 showed: its kernel has Landlock on, the Ubuntu
  `wsl --install` gives works as it is, Node 24 comes from nvm, and spores belong under the Linux
  home rather than `/mnt/c`.
- `spore setup`'s "another provider" sets one up. Once mohdel had a provider, it only printed
  mohdel's status and went on to the model list; it now offers the providers not yet set up that
  mohdex holds models for, and sets up the one picked.
- `spore setup` opens with its header before asking where spore runs, not after, and says what
  the sandbox does for a turn instead of naming Landlock and namespaces. Before asking for the
  spores' home it says what a spore keeps there, and asks which directory. The line under a
  list's title is drawn inside setup's frame, where it was printed past its edge.

### Changed

- mohdel 4.3.1, on both the npm and the Cargo side. Setting up a provider in `spore setup` now
  offers the models mohdex.dev holds, with their prices and sources — a ChatGPT plan included,
  priced from the OpenAI entries — and ends by handing back to setup rather than suggesting `mo`
  commands. A turn's model calls read the catalog `mo` wrote wherever `XDG_CONFIG_HOME` puts it:
  with it set, every turn failed with "Unknown model" after a setup that had succeeded.

## [1.49.3] — Fix: the terminal keeps a message it could not send

### Fixed

- `spore tui` and `spore here` keep a message that was refused (`PAUSED`, `ADMISSION_FULL`, a
  `spore.cmk` that does not parse): the error shows and the message is back in the editor and in
  its history, so once the cause is fixed — with `/unpause` typed in the same editor, say — ↑
  brings it back to send again. It was lost and had to be typed again.

## [1.49.2] — Fix: a spore starts what it is asked for

### Changed

- The five sporangia: a request is the go, even asked as a question ("can you handle that?", "do
  you have enough to start?"); the agent starts it instead of asking whether to. A reply to a plan
  the agent proposed — a question about it, agreement, a correction — is still not a go-ahead: the
  agent answers it, then asks through `ask` whether to go ahead. Doubt that the result will meet
  the bar is no reason to ask first: the agent does the work and says what fell short. The agent
  is told it works only while a turn runs, so it does not promise work it has not started. A spore
  made before keeps its own `spore.cmk`.

## [1.49.1] — Fix: a spore is told what was filled in with an approval

### Fixed

- A spore told how an approval ended is told what was filled in with the press too: each text
  quoted, as the person typed it, and each choice by the labels of what was picked. It was told
  only who chose which option, so a spore asked the person again for what they had already given.
  Its reference lists the `fields` and `inputs` columns of `approvals`.

## [1.49.0] — Feature: an approval asks choices to be picked

### Added

- A choice among an approval's `fields`: `{ "id": "env", "kind": "choice", "label": "Where",
  "choices": [{ "id": "prod", "label": "Production" }, …], "least": 0, "most": 1, "value":
  ["prod"], "look": "list" }` — 1 to 100 choices, `least` and `most` how many may be picked (0 and
  1 when unsaid), `value` the ids picked at first, `look` `list` or `menu`, a hint the service
  fills in when left out. What a press picked reaches the hook in `inputs` as an array of ids.
- `lines` on a text field: above 1, a long text.
- `"skip": true` on an option: a press on it is taken without the fields, required or not — a
  Cancel needs no reason.

### Changed

- **Breaking for connectors:** `can.fields` says which kinds of field a connector shows, `{}`,
  `{ "text": true }` or with `"choice": { "several", "list", "menu" }` — whether several may be
  picked, and the most choices it shows as a list and as a menu. A connector carrying approvals
  whose `fields` is still true or false is refused (`<KIND>_CONNECTOR_OUTDATED`), its service
  exiting 2: upgrade the Telegram, Discord, Teams, Slack and console plugins with the core, each
  now needing 1.49.0.
- An approval with a choice the connector of its place cannot show — any choice where it shows
  none, more choices than it holds, several to pick where it lets one be — is refused there, its
  hook told why; a choice is never shown cut down or left out.
- A connector that shows its fields only once a button is pressed is handed `formOf` by the relay
  (`docs/relay.md`), which says what the press is to fill in first, taking nothing.

## [1.48.0] — Feature: caller admission, for a host whose program schedules every turn

### Added

- `admission` in `config.json` (`spore config set admission caller`): who admits turns on the
  host (INTEGRATION.md, "Who admits turns"). `"spore"`, the default, is how spore worked until now:
  `turns` admission slots bound the turns running at once, and a delivery refused at release waits
  for a `spore tick` pass. Under `"caller"`, the program in front of spore schedules every turn:
  spore takes no slot, never refuses `ADMISSION_FULL`, and keeps nothing for later — a turn starts
  now or the program gets a refusal it can retry. A pause still refuses `PAUSED`; a job's turns
  start as before, the work of a turn the caller admitted.
- Under caller admission, what would keep a delivery for later is refused when it starts: `turns`
  in `config.json` (`CONFIG_INVALID`), a caller's or a hook's `maxWait` and `perHour` in
  `api.json` and `hooks.json` (a hook gets no default `perHour` there), and a `spore.cmk` granting
  `jobs.maxWait` (`START_FAILED`, naming the line to remove).

### Changed

- The five sporangia: a reply to what the agent proposed that does not clearly say go or no-go —
  agreement, a correction, a narrower scope — is not a go-ahead. The agent takes it in, then asks
  through `ask` whether to go ahead with the proposal as it now stands. A spore made before keeps
  its own `spore.cmk`.

## [1.47.0] — Feature: a connector says whether its platform edits what it posted

### Added

- `can.edit` in a connector's adapter (`docs/relay.md`): whether the platform lets the bot edit a
  message it posted. Where it does not, a person's own conversation is shown a turn by reaction and
  typing rather than a `working…` message, and a bot file asking `show: working` or `both` there
  is refused with the line to fix.

### Changed

- **Breaking for connectors:** an adapter that does not declare `can.edit` is refused
  (`<KIND>_CONNECTOR_OUTDATED`), its service exiting 2. The Telegram, Discord, Teams, Slack and
  console plugins declare it from their next release; upgrade them with the core.

## [1.46.1] — Fix: a ChatGPT-plan turn no longer fails on the moderation event

### Fixed

- mohdel 4.1.0, on both the npm and the Cargo side. A turn on a `chatgpt/` model failed with
  `Unhandled response stream event: unknown` once the ChatGPT backend began sending a
  `response.metadata` event mid-stream, which the OpenAI SDK's stream helper refused; mohdel now
  reads the raw stream and passes over event types it does not use. The same applies to every
  model on the OpenAI Responses route.

## [1.46.0] — Feature: a source's header can carry the turn and its hop

### Added

- `{turn}` in a source's header value, in `sources.json` or a plugin's manifest, is the `turnId` of
  the turn the call is made in, filled by the runner on each call; a cell sends its root's turn.
  Beside `{name}`, a service behind one credential can lead what it keeps back to the spore and
  the turn that sent it. Like `{name}`, it is refused anywhere but a header.
- `hop` on a delivery through the HTTP API (`POST /v1/spores/<name>/deliveries`): how many
  deliveries led to this one, a whole number from 0, kept in the inbox's new `hop` column
  (schema 15). `{hop}` in a source's header is what the turn passes on: one past the highest hop
  said to the spore since the turn began, 0 when nothing said carries one. A service that wakes
  spores with what other spores sent it can then stop a chain of turns waking each other.
- `apiCaller(name)` in the library: where the HTTP API listens and the token of its caller `name`,
  read from `api.json` and the environment as the API reads them, for a program on the same machine
  that delivers through it.
- `$SPORE_SOURCE … --body -` reads the request body from stdin, so a program run under `exec`,
  which may write nowhere, can send a body it built.

## [1.45.0] — Fix: the clock line speaks as the runtime

### Fixed

- The `Now:` line in front of a turn's message now says it is the runtime's clock and no longer
  tells the agent to compute dates and durations, which the definition's method already does once.
  Sitting inside the person's message, unmarked and repeated every turn, it was quoted back as the
  person's instruction and read as a request to append a clock to every answer.

## [1.44.0] — Feature: fork a spore between its turns

### Added

- `spore fork <name> <new>` copies a spore as it stands after its last turn, and `--at turn:<n>`
  as it stood after turn n: its conversation and turn records, the calls they made, the messages
  they read, and `data/` — memory included — `precursors/` and `home/`. Nothing starts: the copy's
  next message starts its first turn, carrying the conversation on. Its schedules stay behind, so
  the clock wakes only the spore it was cut from, and so do unread messages, running jobs and
  answers waiting to be posted. A spore with no finished turn, or one running, is refused. The
  library's `fork` and `forkWorkspace` take `at` null or `'turn:<n>'` for it, and `readFork`
  returns `turnNo` for such a copy.

### Fixed

- A fork carries `sporangium.json`, so `spore upgrade` reads it against the sporangium its spore
  was made from rather than the default one.

## [1.43.0] — Feature: spore doctor tries the boundary, and gives Ubuntu its fix

### Added

- `spore doctor` tries the boundary on this host rather than only reading what the kernel offers:
  a command confined as spore confines a job's tries to read a file outside its grants, write
  outside its directory and into one it may only read, see and signal a process outside it, and
  make namespaces of its own, and doctor lists each as refused, crossed or untried. A crossing the
  host should have refused is a problem. No model is called, and it takes well under a second.
  `spore setup` says how many ways out were tried and refused. The library exports it as
  `boundary()`, and `spore doctor --json` carries it as `boundary`.
- `spore doctor --report` prints this machine — versions, system, kernel, Landlock, AppArmor,
  whether it can contain, any container or VM — with the boundary as tried and what doctor found
  on the machine, as a GitHub issue, and a link opening the repository's host-report form filled
  with it. It names no path, user, host, spore or model, and spore sends nothing; the reader files
  it or not. The library exports the machine's description as `describeHost()`.

### Changed

- Where AppArmor restricts unprivileged user namespaces — Ubuntu from 23.10 — `spore doctor` and
  `spore setup` print the AppArmor profile that lets this install's `confine`, and no other
  program, make them, with its real path and the command that loads it. They say when an existing
  profile names another `confine` than the installed one, as one written before 1.39.0 does, and
  when the path is one this user may replace.
- A turn refused because the host cannot contain it says `spore doctor` gives the fix.

## [1.42.1] — Fix: a release reaches npm from its tag again

No change to the runtime.

### Fixed

- Pushing a `v*` tag publishes `@rhizogrip/spore` and `@rhizogrip/spore-cli` again. Since 1.39.0
  only a GitHub release did, and 1.40.0 to 1.42.0 were tagged without one, so they reached npm
  late, once their releases were made by hand.

### Changed

- The GitHub release is made by the publish workflow, once both packages are on npm, with the
  version's section of this file as its notes.

### Added

- `CONTRIBUTING.md`: code style, the CLI's shape, changing the workspace database, tests and
  releases.

## [1.42.0] — Feature: the operator sets how long a prepare step may run

### Changed

- `prepare.timeout` in `spore.cmk` is no longer capped at 60 s. The host bounds it instead:
  `spore config set prepareCeiling 15m`, an hour when unset. A delivery whose spore asks more than
  the host allows runs no step, and carries a line saying so and what to set.

## [1.41.0] — Feature: a plugin names the program built for this machine

### Added

- A plugin's program path takes `{arch}`, this machine's architecture as Node names it — `x64`
  or `arm64` — so a plugin whose program comes in a build for each names it once, as
  `agent-browser/bin/agent-browser-linux-{arch}`. Any other placeholder in a program is refused.

## [1.40.0] — Feature: spore runs in a Linux VM

### Added

- On macOS, `npm install -g @rhizogrip/spore-cli` and `spore setup` run spore in a Linux VM that
  setup makes with Lima: Debian 13, the host's Node and the same spore, and spore's own setup run
  inside it, where the model and its key are chosen. Every `spore` command then runs in the VM.
- On Linux, the first `spore setup` asks whether spore runs on this machine — the default — or in
  a VM.
- `spore vm start|stop` starts and stops the VM. A command given while it is stopped says to start
  it and does nothing. Where spore runs on the machine itself, `spore vm` says so and succeeds.

### Changed

- `@rhizogrip/spore-cli` installs on any system: it takes `@rhizogrip/spore` as an optional
  dependency, which npm installs only on Linux x64 and arm64.
- `spore setup` asks as mohdel's own setup does, which it hands over to midway: a list narrowed as
  you type, the default already chosen, Esc or Ctrl-C to leave.
- The terminal screen is always installed. `--omit=optional` no longer leaves out only the
  screen: it leaves out the core, and `spore` then says so — install without it.

## [1.39.0] — Feature: spore runs on arm64 Linux

### Added

- `@rhizogrip/spore` and `@rhizogrip/spore-cli` install and run on arm64 Linux as on x64: the
  package carries both architectures' native parts, built on a runner of each, and loads the
  one matching the machine. On a Mac, a Linux VM no longer needs to emulate x86_64.
- The Telegram, Discord, Slack, Teams and console connectors install on arm64 too.

### Changed

- The native parts live in `native/<arch>/` — `native/x64/` or `native/arm64/` — the addon,
  `spore-runner`, `spore-spawn`, the sandbox addon and `confine` together. A checkout builds
  its own machine's with `npm install`, as before. A confined agent no longer reads `build/`,
  which holds nothing it runs.

### Fixed

- A conversation shown in the terminal or through the HTTP API no longer shows a turn as still
  thinking after it ended, in the moment the runner holds the spore's lock past the turn it made
  final.

## [1.38.1] — Fix: the terminal no longer crashes on a spore.cmk edited while it is open

### Fixed

- `spore tui` and `spore here` give the terminal back when they crash: an
  error nothing caught stops the screen before it is reported, instead of
  leaving the shell in the screen's modes, with mouse movements and keys
  printed as escape codes.
- A `spore.cmk` that does not parse, edited while the terminal is open, is
  shown as a notice until it parses again, rather than ending the terminal —
  while a turn runs, in a slash command, or when another spore is opened with
  ctrl+p, which then stays on the current one.

## [1.38.0] — Feature: flush a spore's conversation

### Added

- `flush({ ws, by })`, `spore flush <name>`, and `/flush` in the terminal and
  in a conversation: the spore's next turn starts over, replaying none of what
  was said before. Nothing is forgotten — the transcript keeps every entry,
  `data/` is untouched, and recall reaches what was said. The turn is shown a
  note saying who flushed it and what is still open: the question the last
  turn asked, approvals not yet settled, jobs still running. No model is
  called. Only between turns: `SPORE_RUNNING` while a turn runs,
  `SPORE_CRASHED` after a crash, `FLUSH_INVALID` without `by`.
- In a conversation many people share, `/flush` is for the people who may
  `/stop`. It works through every connector running on this core; the
  connectors' help text names it from their next releases.
- `log()` returns `flushes`, `{ entryNo, at, by }` each, and `spore log` shows
  them among the turns.

### Changed

- `reference.md` says what a flushed transcript entry means; `spore upgrade`
  brings it to existing spores.
