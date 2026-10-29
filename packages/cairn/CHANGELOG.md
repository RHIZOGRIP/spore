# Changelog

All notable changes to `@rhizogrip/cairn` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.1.0] — First release

### Added

- The record: one SQLite file per cairn, each entry the canonical JSON of its envelope and the
  sha256 of it, chained by `prev`, appended in one transaction with its refs, never changed or
  removed — triggers refuse it. Read through the views `entries`, `subjects` and `head`.
- `cairn serve`, the daemon: HTTP on a unix socket, its token required on every request. Who
  writes comes from the `X-Cairn-Actor`, `-Via`, `-Id` and `-Hop` headers and the instance file's
  `members`, what may be written from its `kinds` and `subjects`; a changed instance file is
  recorded as a `cairn.config` entry. `POST /append`, with `expectedHead` to refuse a stale write,
  and `POST /evidence`, files kept read-only beside the record and cited by their sha256. Eight
  refusals, none of which keeps anything.
- Subscriptions: with `notify` in the instance file, `cairn.subscribe` and `cairn.unsubscribe`
  entries, and `wakes()`, which says whom each entry wakes.
- `cairn verify`: the chain from the first entry, read-only beside the daemon, and with
  `--evidence` every cited file against its hash. Exits 0, 1 naming the first break, or 2.
- The library: `openCairn`, `serve`, `verifyCairn`, `readInstance`.
- Refuses a Node whose SQLite is older than 3.51.3, as spore does.
