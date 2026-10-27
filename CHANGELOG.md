# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

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
