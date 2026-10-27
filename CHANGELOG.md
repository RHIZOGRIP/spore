# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

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
