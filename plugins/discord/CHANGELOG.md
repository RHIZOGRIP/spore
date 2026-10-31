# Changelog

All notable changes to `@rhizogrip/spore-plugin-discord` are documented here, from 0.11.0. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.12.0] — Feature: approvals in a channel

### Added

- An approval asked in a channel is posted under the spore's name, a button per option, and
  answered by a press from someone it names; Discord tells only them what came of it. Its fields
  are drawn in a form its button opens: a text short or long, a choice as a radio group,
  checkboxes (up to 10) or a menu (up to 25). Presses reach the service on its Gateway
  connection, so the bot needs no public address.

### Changed

- Needs spore 1.49.0, which asks every connector which kinds of field it shows.

## [0.11.1] — Changed: says that Discord edits what the bot posted

### Changed

- The adapter declares `can.edit`, which spore 1.47.0 asks of every connector and refuses one
  without.

## [0.11.0] — Feature: mentioning the bot reaches a channel's only spore

### Added

- In a channel with one spore, mentioning the bot — the entry Discord's picker tags APP — reaches
  that spore, which is told the mention as `@<spore>`, so `@bot status`, `stop`, `wrap`, `extend`
  and `flush` work as they do through its role. In a channel with several spores a mention of the
  bot reaches none, and blocks no role mention or reply beside it. When it is all a message
  addresses, the log says so and names the roles to mention instead.
- `rolesOnly` in a channel of the bot file: `true` makes a mention of the bot reach no spore there,
  so only a role or a reply does.

### Fixed

- A spore named as the bot gets a mentionable role of its own. The bot took the role Discord gives
  the bot itself, which carries the bot's name and which no one can make mentionable, so only the
  server's owner and admins could address the spore. A spore already mapped to that role keeps it
  until its entry under `roles` is removed from the service's `state.json` with the service
  stopped.
