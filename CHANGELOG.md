# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

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
