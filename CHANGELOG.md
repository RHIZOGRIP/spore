# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

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
