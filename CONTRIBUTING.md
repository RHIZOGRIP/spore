# Contributing

## Code Style

StandardJS — no semicolons, 2-space indent, single quotes. Enforced via `npm run lint`; Rust via
`cargo fmt --check`.

- **Environment:** Node.js 24+, ES modules, Linux x64 or arm64
- **Modules:** `import`/`export` only, no `require`; static imports at the top of the file
- **Async:** `async/await`, no callbacks
- **Error variable:** `err` (not `e`, `error`, `ex`)
- **Errors:** one kind, `SporeError` (`src/observability/errors.js`), branched on by `type`, never by
  `message`
- **Comments:** only explain *why*, never *what*. Design rationale belongs in
  [ARCHITECTURE.md](ARCHITECTURE.md), bug history in the commit message
- **Terms:** several words carry narrow meanings here (`precursor`, `trail`, `call`, `confine`,
  `tool`, `enzyme`); check ARCHITECTURE.md before coining one

### No silent fallbacks

A default stands in for state that is legitimately absent at runtime: an optional setting, a field a
provider may omit. It never stands in for a mistake. A missing native build, a renamed field or a
definition that does not parse fails loudly, with a `SporeError` that says what to do.

### Tests never shape the code

No export, option, parameter default or branch exists only so a test can reach something. A test
drives the real entry points with the real shapes; when it cannot, the test changes, not the code. A
fake has the shape of the thing it replaces.

## Layout

npm workspaces, and one Cargo workspace (`rust/`).

| path | what |
|------|------|
| `packages/spore/` | `@rhizogrip/spore`: the runtime and the library |
| `packages/spore-cli/` | `@rhizogrip/spore-cli`: the `spore` command and its terminal |
| `packages/cairn/` | `@rhizogrip/cairn`: a shared, append-only record, its daemon and `cairn verify` |
| `plugins/<name>/` | `@rhizogrip/spore-plugin-<name>`, one package each |
| `rust/definition` | the `.cmk` parser |
| `rust/workspace` | the workspace lock, admission slots, the agent's environment, the database's schema and writers |
| `rust/runner` | `spore-runner` and `spore-spawn` |
| `rust/node` | the addon carrying `definition` and `workspace` into JavaScript |

### One implementation, two languages

The runner is Rust and the library is JavaScript, and they meet on the same files. What both need is
written once, in a crate, and the addon carries it into JavaScript: the `.cmk` parser
(`src/delegation/definition.js` wraps `rust/definition`), and the database schema, the lock and the
slots (`spore-dir.js`, `admission.js` and `agent-env.js` wrap `rust/workspace`). A second
implementation of either in JavaScript is drift, however small.

## CLI Design

The `spore` command follows the **verb-spore** pattern:

```
spore <verb> [<spore>] [args] [flags]
```

**Verbs on a spore:** `define`, `send`, `attach`, `show`, `log`, `sql`, `model`, `fork`, `flush`,
`stop`, `rm`, …
**Verbs on the machine:** `ls`, `config`, `plugin`, `service`, `pause`, `unpause`, `tick`, `doctor`,
`setup`, `vm`, …

The full list is the help text in `packages/spore-cli/bin/spore.js`.

### Rules

- Parsing lives in `packages/spore-cli/bin/spore.js`, rendering in `src/dispatch.js`, and the answer
  in the library's verb. A verb's logic never lives in the CLI: the TUI, the HTTP API and the
  plugins reach the same verb through `src/index.js`
- `--json` prints the library's own shape, one object, so a script reads what an embedder reads
- A verb's exit code is a function of that object, the same with `--json` as without
- A refusal says what to type next (`spore config set home <dir>`), not only what is wrong

### Adding a verb

1. Add the verb to the library and export it from `packages/spore/src/index.js`
2. Parse it in `packages/spore-cli/bin/spore.js`, render it in `src/dispatch.js`
3. Update the help text in the same file
4. Document it in [INTEGRATION.md](INTEGRATION.md) if a program may drive it, and in
   [docs/operating.md](docs/operating.md) if an operator runs it

## Tools

A spore has seven tools, and that number is a principle, not a backlog
([PRINCIPLES.md §4](PRINCIPLES.md)). Searching, fetching, a service that needs a credential: each is
an ordinary program an agent runs, or a plugin that gives it one. A proposal for an eighth tool has
to show a need nothing else can meet.

## Changing the workspace database

`<ws>/state.sqlite` outlives the spore version that made it, so its shape is a migration, never an
edit. In `rust/workspace/src/state.rs`:

1. **Schema** — change `SCHEMA`, which is what a fresh workspace gets.
2. **Migration** — append to `MIGRATIONS` the statements that move the previous version to the new
   one. Each leaves the database as a fresh one at that version would be.
3. **Version** — bump `SCHEMA_VERSION`. A runtime refuses a newer database and migrates an older
   one.
4. **Shape test** — `migrates_a_workspace_an_older_spore_made_into_what_a_fresh_one_is` builds a
   database from `rust/workspace/tests/fixtures/schema-1.sql`, runs every migration over it, and
   compares the result with a fresh one, table by table and view by view. It must pass unchanged. A
   migration that moves data also asserts the rows it moved.

The views (`turns`, `inbox`, `transcript`, `events`, `calls`, …) are the contract: a view selects and
filters and never renames. The `t_` tables behind them are storage and free to change. Columns are
camelCase, money is integer micro-dollars (`…Micros`), and the agent's own documentation of the views
is `reference.md`.

## The event schema

The event log is read by consumers outside this repository, so three rules hold: names never change
meaning, fields are only added, and a consumer ignores an event it does not know. A new event is
named in `EVENTS` (`src/observability/event-log.js`) and documented in
[INTEGRATION.md §Events](INTEGRATION.md#events).

## The definition

`spore.cmk` is parsed in one place, `rust/definition`. A new field touches:

1. The parser and its tests in `rust/definition/src/lib.rs`
2. Whatever reads it, through `parsedDefinition` (`src/delegation/definition.js`)
3. [docs/definition.md](docs/definition.md)

## Settings

`config.json` is the operator's. A new key goes in `KEYS` in `src/library/config.js`, with its
default in `DEFAULTS` and, when it is a duration, in `DURATIONS`; `spore config set` refuses anything
else. Document it in the table in [docs/operating.md §config.json](docs/operating.md#configjson). A
bound a spore asks for and the host caps (`callCeiling`, `prepareCeiling`) is refused at the point of
use with the command that would raise it.

## Writing a plugin

[docs/plugins.md](docs/plugins.md) is the full account: the manifest, programs, sources, services
and how to test one against the core. A plugin declares what it can do; a spore's `spore.cmk`
chooses what it uses, and the operator allows it. A feature more than one connector plugin needs
goes in the core, not in one plugin.

## Testing

```bash
npm test                                   # every package's suite, offline, free
npm run test:rust                          # the crates' own tests
npx vitest run test/exec-readonly.test.js  # one file, from packages/spore
npm run lint
cargo fmt --check
MODEL=<provider>/<name> npm run test:model -w @rhizogrip/spore   # conformance, calls a model
```

`npm test` never calls a model. Many of its files run the real executables end to end — Landlock,
both brokers, the locks and the records are real, and only the model's replies are scripted, through
`startGate` or `createModelServer` in `test/fixtures/model-server.js`.

### Isolation

Every test file reads its config (`XDG_CONFIG_HOME`) and takes admission slots (`XDG_STATE_HOME`)
from a directory of its own, set by the setup files in `packages/spore/vitest.config.js`. Run the
suite through the package config, never a bare `vitest` from somewhere it is not loaded: the
machine's `~/.config/spore` is the user's.

Tests that run a turn need a workspace the sandbox does not refuse, which excludes `test/` and `/tmp`.
They use `../tmp/spore-tests` beside the checkout, or `$SPORE_TEST_DIR`, and it must allow execution.

### Conventions

- Assert against the layer that owns the fact: what the model sees from the tool's return value,
  what a call did from its `calls` record
- A conformance case is dull on purpose: a flaky case is a wrong case

## Release

`npm run release` (release-it) needs a clean tree on `main` and a `## [x.y.z]` section in
`CHANGELOG.md`. It runs lint, `cargo fmt --check` and `npm test`, bumps the version, carries it into
every package and crate (`scripts/sync-version.js`), and pushes the commit and the `v<version>`
tag. The tag fires `.github/workflows/publish.yml`, which:

1. Builds the native code on one runner per architecture, x64 and arm64.
2. Places each in `native/<arch>/` of the package.
3. Publishes `@rhizogrip/spore` and `@rhizogrip/spore-cli` with provenance.
4. Creates the GitHub release, its notes the version's `CHANGELOG.md` section.

The release is the workflow's, with its own token, so nothing on the releasing machine needs one.

A plugin is released on its own: bump its `version`, commit, and run `node scripts/tag-plugins.js`,
which tags `plugin-<name>-v<version>` for every plugin whose version has no tag yet and pushes it.
`.github/workflows/publish-plugin.yml` publishes from the tag. A plugin that needs a new core says so
in `works`. `@rhizogrip/cairn` is released on its own the same way, from the tag
`package-cairn-v<version>`, which `npx release-it` in `packages/cairn/` bumps, commits and pushes.

## Configuration

All under `~/.config/spore/` (`$XDG_CONFIG_HOME/spore`):

| File | Purpose |
|------|---------|
| `config.json` | where workspaces live and what the machine allows |
| `environment` | provider keys and the variables sources read (`KEY=value`) |
| `sources.json` | what each source name means, with its credentials |
| `memory.json` | the vector store of `memory: vectors` |
| `hooks.json` | the webhook service's hooks |
| `api.json` | the HTTP API's socket, address and callers |
| `vm.json` | the Linux VM spore runs in, on a machine that needs one |

State under `$XDG_STATE_HOME/spore/` (admission slots, services' own state). Full account in
[docs/operating.md](docs/operating.md).
