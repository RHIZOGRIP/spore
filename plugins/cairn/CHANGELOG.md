# Changelog

All notable changes to `@rhizogrip/spore-plugin-cairn` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.1.0] — First release

### Added

- The service `cairn@<cairn>`: the daemon of one cairn, its members, kinds and subjects in
  `~/.config/spore/cairn/<cairn>.json`, its record and evidence under the plugin's `root`, and its
  socket in `<root>/sockets`, which the plugin hides from the spores that use it. It warns of a
  member that cannot reach the cairn and of a spore that can and is no member.
- `$SPORE_CAIRN`: the cairns a spore reads, read with SQL, and written through the source
  `cairn-<cairn>`, whose runner names the spore and the turn on every entry.
