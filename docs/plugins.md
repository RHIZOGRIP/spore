# Writing a plugin

A plugin is an npm package that gives the spores using it more than the runtime ships: programs
for the agent, programs the runtime runs on a spore's deliveries, libraries for the agent's own programs, endpoints the runner calls, a reference
the agent reads, precursors, and services the host runs.

How the mechanism works is in [ARCHITECTURE §Plugins](../ARCHITECTURE.md#plugins). What an
operator does with a plugin is in
[operating.md §Plugins on the host](operating.md#plugins-on-the-host) and
[§Plugin services](operating.md#plugin-services), and the field a spore names one with is
[definition.md §`plugins`](definition.md#plugins). The code is `packages/spore/src/core/plugins.js`
and, for services, `packages/spore-cli/src/services.js`.

## What a plugin gives

| part | manifest key | what the spore gets |
|---|---|---|
| programs | `programs` | a variable in the agent's environment naming an executable, which the agent runs, and which the runtime runs on deliveries where the spore's definition binds it: `prepare:` |
| variables | `env` | more variables in the agent's environment, filled per spore |
| sources | `sources` | endpoints the runner calls for the agent through `$SPORE_SOURCE`, granted with the plugin |
| libraries | `modules` | links in `<ws>/node_modules/` that the agent's own programs import by name |
| a reference | `reference` | `plugins/<name>.md` in the workspace, listed in the agent's system prompt |
| precursors | `precursors` | files copied into `precursors/`, which the spore spawns cells from |
| services | `services` | programs the host runs under systemd, outside every sandbox |

From package to turn:

1. The plugin is published as an npm package.
2. The operator installs it beside spore (`npm i -g <package>`).
3. The operator allows it on the machine, with its settings: `spore plugin allow <name> [k=v …]`
   ([operating.md](operating.md#plugins-on-the-host)).
4. A spore names it in its `spore.cmk`: `plugins: [<name>]`
   ([definition.md](definition.md#plugins)).
5. Each turn of that spore is given what the plugin offers, checked again when the turn starts.

A service skips steps 3 to 5: `spore service` offers it once the plugin is installed.

## Names

The package is `spore-plugin-<name>`, or `@<scope>/spore-plugin-<name>`. `<name>` is what a
definition names and what every command takes. A definition accepts it when it is lowercase
letters, digits, `.`, `-` and `_`, starting with a letter or a digit, at most 64.

Spore looks for plugins in its own `node_modules`, in every `node_modules` it is installed under
(the global one `npm i -g` uses among them), and in a checkout's hoisted `node_modules`. A name no
package answers to is refused with `PLUGIN_NOT_INSTALLED`, which lists where it looked. A name two
packages answer to, scoped and unscoped or in two of those places, is refused with
`PLUGIN_AMBIGUOUS`.

The plugin's own variable prefix is `SPORE_` followed by `<name>` in upper case, every character
other than a letter or a digit written `_`: `SPORE_BROWSER` for `browser`, `SPORE_MY_TOOL` for
`my-tool`.

## The manifest

The manifest is the `spore` field of the package's `package.json`, an object. The core reads it and
runs none of the plugin's code.

| key | shape | | rule |
|---|---|---|---|
| `works` | a semver range | required | the `@rhizogrip/spore` versions the plugin works with |
| `settings` | `{ "<key>": "port" \| "text" }` | optional | values the operator gives at `allow` |
| `programs` | `{ "<VARIABLE>": "<program>" }` | optional | `./<path>` in the plugin, or `<package>/<path>` in a dependency |
| `describe` | `[{ "program", "title", "category", "detail"? }, …]` | optional | how a call of one of its `programs` is shown: `program` a regexp naming one of them |
| `env` | `{ "<VARIABLE>": "<text>" }` | optional | text with `{placeholders}` |
| `contain` | `{ "hide", "keep"?, "missing"? }` | optional | text with `{placeholders}`: a directory of the host a contained spore sees nothing of, or only one directory of |
| `modules` | `["<dependency>", …]` | optional | each in `dependencies`, none provisioned |
| `sources` | `{ "<source>": { "url": …, … } }` | optional | as `sources.json` describes a source |
| `reference` | `"<path>"` | optional | one file in the plugin |
| `precursors` | `"<path>"` | optional | a directory in the plugin |
| `services` | `{ "<service>": { "what", "program", "instances"?, "check"? } }` | optional | programs the host runs |

Any other key is refused. A plugin is checked when it is allowed, when a turn of a spore using it
starts, when `spore define` makes such a spore, by `spore plugin ls` and `spore plugin show`, and by
`spore service` for its services. The refusals:

| type | when |
|---|---|
| `PLUGIN_NOT_INSTALLED` | no package answers to the name |
| `PLUGIN_AMBIGUOUS` | two packages answer to it |
| `PLUGIN_INVALID` | the manifest or a file it names breaks a rule on this page |
| `PLUGIN_INCOMPATIBLE` | the installed `@rhizogrip/spore` is outside `works` |
| `PLUGIN_SETTING_UNKNOWN` | the operator gives a setting the manifest does not declare |
| `PLUGIN_SETTING_MISSING` | a declared setting has no value |
| `PLUGIN_SETTING_INVALID` | a value is not of its kind, or a pair is not `key=value` |
| `PLUGIN_NOT_ALLOWED` | a spore names a plugin the machine has not allowed |
| `PLUGIN_CHANGED` | the installed copy is not the one that was allowed |
| `PLUGIN_CONFLICT` | two plugins one spore uses set one variable, offer one module or describe one source |

A minimal plugin gives one program and says how to run it:

```json
{
  "name": "spore-plugin-hello",
  "version": "0.1.0",
  "files": ["bin/", "reference.md"],
  "spore": {
    "works": "^1",
    "programs": { "SPORE_HELLO": "./bin/hello.js" },
    "reference": "reference.md"
  }
}
```

A plugin using every key:

```json
{
  "name": "@example/spore-plugin-ledger",
  "version": "1.2.0",
  "files": ["bin/", "src/", "precursors/", "reference.md"],
  "dependencies": { "ledger-math": "^2.0.0", "ledger-bin": "3.1.0" },
  "peerDependencies": { "@rhizogrip/spore": ">=0.13 <1" },
  "spore": {
    "works": "^1",
    "settings": { "port": "port", "book": "text" },
    "programs": {
      "SPORE_LEDGER": "./bin/ledger.js",
      "SPORE_LEDGER_CLI": "ledger-bin/bin/ledger-linux-{arch}"
    },
    "env": {
      "SPORE_LEDGER_URL": "http://127.0.0.1:{settings.port}/{settings.book}",
      "LEDGER_SESSION": "{name}",
      "LEDGER_WORKSPACE": "{ws}",
      "LEDGER_CACHE": "{data}/ledger",
      "LEDGER_SOCKET": "{sockets}/ledger"
    },
    "modules": ["ledger-math"],
    "sources": {
      "ledger": {
        "url": "https://ledger.example.org/api/v1/",
        "headers": { "Authorization": "Bearer ${LEDGER_TOKEN}" },
        "methods": ["GET", "POST"],
        "paths": ["books/*/entries"]
      }
    },
    "reference": "reference.md",
    "precursors": "precursors",
    "services": {
      "ledger": {
        "what": "posts each spore's entries to the book it names",
        "program": "./bin/spore-ledger.js",
        "instances": { "called": "book" },
        "check": ["--check"]
      }
    }
  }
}
```

Every path in a manifest is relative to the plugin. A path that leaves the plugin is refused
(*names …, outside itself*), and so is one the installed package does not contain (*names …, which
it does not contain*): what the manifest names must be in the package's `files`.

## `works`

```json
"works": "^1"
```

A semver range over `@rhizogrip/spore`, checked against the version installed, prereleases
included. A missing or unparsable range is `PLUGIN_INVALID` (*does not say which spore it works
with*); a version outside it is `PLUGIN_INCOMPATIBLE`, naming both.

## Settings

```json
"settings": { "cdp": "port" }
```

What the operator supplies for this machine, each a kind:

| kind | a value is |
|---|---|
| `port` | a whole number from 1 to 65535 |
| `text` | a non-empty string |

Any other kind is refused. The operator gives them when allowing the plugin, as
`spore plugin allow browser cdp=9222`; a `port` typed as digits is read as a number. Given again,
settings are merged over those already recorded. Every declared setting is required: allowing,
and every turn after, refuses one missing (`PLUGIN_SETTING_MISSING`), one undeclared
(`PLUGIN_SETTING_UNKNOWN`) and one not of its kind (`PLUGIN_SETTING_INVALID`).

A setting reaches the plugin only through `{settings.<key>}` in an `env` value. The plugin's
programs never read `config.json`. A setting, like every variable the plugin sets, reaches the
runner in its environment, which only its own user can read, and is then in the environment of every
command the agent runs. A credential the agent must never see belongs in a [source](#sources).

## Programs

```json
"programs": { "SPORE_BRAVE": "./bin/search.js" }
```

Each key is a variable, each value a program; the agent is given the variable set to the program's
absolute path. A program is either:

- **`./<path>`, in the plugin**, as `brave`'s `./bin/search.js`;
- **`<package>/<path>` or `@<scope>/<package>/<path>`, in a package the plugin depends on**, found
  from the plugin's directory as Node finds one. `browser` ships no program of its own:

  ```json
  "dependencies": { "agent-browser": "0.38.1" },
  "spore": { "programs": { "SPORE_BROWSER": "agent-browser/bin/agent-browser-linux-{arch}" } }
  ```

A program's path takes one placeholder, `{arch}`: this machine's architecture as Node names it,
`x64` or `arm64`, so a package that ships a build for each is named once. No other placeholder is
filled in a program (*with {name}, which spore does not fill in a program*).

A program must be a file with its executable bit set, and its real path must lie inside the
plugin or a package it depends on: its `dependencies` and `optionalDependencies`, and theirs, as
installed. A required dependency that is not installed refuses the plugin (*depends on …, which is
not installed*); an optional one is skipped. An absolute path, an empty one, a dependency that is
not installed, a program that is not there, one without its executable bit and one outside that
set are each `PLUGIN_INVALID`.

A variable name follows [the rule for variables](#variables-a-plugin-may-set). It need not be under
the plugin's prefix, and one program may be named twice: `ssh` gives its wrapper as both
`SPORE_SSH` and `GIT_SSH`, so `git` uses it.

A plugin adds no tool: the agent runs a program as it runs any other, with `exec` or `wsexec`, inside its sandbox and with
its environment. That sandbox reads the plugin and every package it depends on, and nothing else
of the `node_modules` they are installed in; it writes neither. A plugin installed in the
`node_modules` spore is in is read through spore's own grant, and adds none of its own. A program that keeps files writes
them where the agent may write: under `{data}`, `{sockets}`, or `$HOME`, the workspace's `home/`.
A program reaches a source the plugin describes through `$SPORE_SOURCE`, as `brave`'s does:

```js
const asked = spawnSync(process.execPath, [process.env.SPORE_SOURCE, 'brave', '--q', query, '--out', '-'], { encoding: 'utf8' })
```

### How a call of one is shown

```json
"describe": [
  { "program": "^\"?\\$SPORE_BRAVE\"?\\s*(.*)$", "title": "searching the web", "category": "search", "detail": "search $1" }
]
```

What a person watching a turn is told of a call running one of your programs — in a chat, *searching
the web* rather than *running a command*. Each row is a regexp over the command's first line,
whitespace collapsed, in Rust's `regex` syntax (no look-around or back-references), which must name
one of the plugin's `programs`; a `title`; a `category`, one
of `read`, `edit`, `delete`, `move`, `search`, `execute`, `fetch`, `delegate`, `ask`, `other`; and
an optional `detail`, shown where a conversation asked for details, the command line when absent.
`$1`…`$9` in the title and the detail are what the regexp captured. A title is shown where commands
and paths are not, so capture into it only what anyone watching may see. A row that names none of
the plugin's programs, a regexp that does not compile, a `$N` the regexp does not capture, a category
not in the list and a key not among these are each `PLUGIN_INVALID`. A spore's own `:::call` blocks
come before these, and the runtime's rows after ([ARCHITECTURE §Describing a
call](../ARCHITECTURE.md#describing-a-call)).

## Programs that prepare deliveries

```json
"programs": { "SPORE_PDF_PAGES": "./bin/pages.js" }
```

One of `programs` may also prepare a delivery nobody typed: a spore's definition binds it to an
origin by its variable, `prepare: [hook:scans=pdf-pages/SPORE_PDF_PAGES]` ([definition
§prepare](definition.md#prepare)), and the service the delivery arrives at — the webhook service,
the HTTP API, a job's supervisor — runs it on each delivery before any turn reads it. The binding
grants it to that step alone: the spore's turns get the plugin only when its `plugins:` names it
too, and then all of it. A spore takes a plugin whole, so a program meant only for deliveries ships
as a plugin of its own, `spore-plugin-pdf-pages` beside `spore-plugin-pdf`, its reference
describing only what it offers. On a delivery, its contract is:

- **It is called** as `<program> <origin> <event> <ref> <headers>`: the origin (`hook:scans`,
  `api:pipeline`, `job:scan`), the sender's event and delivery id, either empty when the sender
  names none, and the path of the delivery's `headers.json`, empty when it has none. The payload is
  on its stdin, which is empty for a delivery without one.
- **It writes what it attaches to `out/`**, in its working directory: plain files, each named by
  letters, digits, `.`, `_` and `-`. They are attached to the delivery under
  `inbox.d/<delivery>/<VARIABLE>/`, within the spore's `prepare.attach`, and the turn reads them as
  files sent with it. Its stdout is not read.
- **Exit 0 is success.** A non-zero exit, a run past the spore's `prepare.timeout`, a timeout past
  the host's `prepareCeiling`, a file past the bounds, a directory in `out/`, or a program the plugin no longer has attaches nothing, and the
  delivery carries one line saying why instead.
- **It runs confined**, as a spore's router does, by the same runner: it reads the plugin and what
  it depends on, the delivery's own files and the spore's `reads:` grants; it writes nothing but
  its working directory; its environment is `PATH`, `HOME` and `TMPDIR`.

The `routes` key of earlier releases is `PLUGIN_INVALID`.

## `env`

```json
"env": {
  "AGENT_BROWSER_CDP": "{settings.cdp}",
  "AGENT_BROWSER_SESSION": "{name}",
  "AGENT_BROWSER_SOCKET_DIR": "{sockets}/browser",
  "AGENT_BROWSER_SCREENSHOT_DIR": "{data}/browser"
}
```

More variables for the agent. Each value is text, and each `{…}` in it is a placeholder filled when
a turn starts:

| placeholder | filled with |
|---|---|
| `{name}` | the spore's name: its workspace directory's name |
| `{ws}` | the workspace's absolute path |
| `{data}` | `<ws>/data`, which the agent writes |
| `{sockets}` | the spore's own socket directory, the agent's `$SPORE_SOCKET_DIR`, which the agent writes and no other spore can |
| `{settings.<key>}` | the operator's value for a declared setting, as text |

Any other placeholder, a `{settings.<key>}` the manifest does not declare among them, is refused
(*sets … with {…}, which spore does not fill*). There is no escape: a value cannot hold a literal
`{…}`. A value that is not a string is refused, and so is a variable set both as a program and in
`env`.

### Variables a plugin may set

A variable name is a letter or `_`, then letters, digits and `_`. A plugin may not set:

- a variable the runtime sets itself (`RUNTIME_ENV` in `rust/workspace`): `HOME`, `TMPDIR`,
  `TRACEPARENT`, `MOHDEL_MEDIA_ROOTS`, `SPORE_SOCKET_DIR`, `SPORE_CELL`, `SPORE_DEBUG`,
  `SPORE_ENZYME`, `SPORE_ENZYMES`, `SPORE_FANOUT`, `SPORE_JOB`, `SPORE_JOB_DIR`,
  `SPORE_JOB_NAME`, `SPORE_JOB_SOCKET`, `SPORE_MODEL_SOCKET`, `SPORE_NODE`, `SPORE_RECALL`,
  `SPORE_SOURCE`, `SPORE_SOURCES`, `SPORE_SOURCE_SOCKET`, `SPORE_SPAWN`, `SPORE_SQL`,
  `SPORE_STATE_FD`, `SPORE_STORE_SOCKET`, `SPORE_WS`, `SPORE_PLUGIN_READS`, `SPORE_PLUGIN_ENV` and
  `SPORE_PLUGIN_CALLS` — even when its name starts with the plugin's own prefix;
- a variable the runtime passes to every agent: `PATH`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`,
  `TRACEPARENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_INIT_TIMEOUT_MS` and
  `SPORE_OWNERS`;
- any `SPORE_*` other than its own prefix, `SPORE_<NAME>` and `SPORE_<NAME>_*`.

Each is refused as *sets …, which it may not*. Two plugins one spore uses that set the same
variable are refused together at `send` (`PLUGIN_CONFLICT`); the spore can use one of them.

## `contain`

What a contained spore is shown of a directory of the host: `hide` laid empty, and `keep`, a
directory inside it, put back. A plugin that serves every spore of a user from one directory — a
socket each, say — gives each spore its own part and none of the others':

```json
"contain": {
  "hide": "{settings.dir}",
  "keep": "{settings.dir}/spores/{name}",
  "missing": "no ~/.config/spore/sluice/{name}.rules says what this spore may run"
}
```

A plugin that only hides a directory names `hide` alone, and the spore sees nothing of it;
`keep` and `missing` come together or not at all. The three take the placeholders `env` does.
Filled in, `hide` and `keep` are absolute and written plainly, and `keep` lies inside `hide`, or
the spore is refused (`PLUGIN_CONTAIN_INVALID`). Two
plugins of one spore that hide the same directory, or one inside the other, are refused
(`PLUGIN_CONFLICT`).

Every contained process of the spore gets the same view, of every plugin it uses, in `plugins:`
or only in `prepare:` — the agent of a turn, its jobs, its routers and prepare steps, a cell
started outside any turn — laid out by `confine --contain` in the namespace it
already makes, so it holds for whatever the process runs. One that is not contained (`contain
off`, or a spore that says `unconfined: true`) would see all of `hide`, and is refused instead; so is one whose `keep` is not
there, with `missing` as the fix, or, with no `keep`, whose `hide` is not. These refusals are
`CONTAIN_FAILED` for a turn. `spore doctor` reports them for each spore.

## Sources

```json
"sources": {
  "brave": {
    "url": "https://api.search.brave.com/res/v1/web/search",
    "headers": { "X-Subscription-Token": "${BRAVE_API_SK}", "Accept": "application/json" },
    "query": { "count": "5" }
  }
}
```

Endpoints described as the host's `sources.json` describes one: `url`, and `query`, `headers`,
`methods`, `paths` and `requires`
([operating.md §Sources](operating.md#sources-sourcesjson)). The plugin check takes a name of
lowercase letters, digits and `-`, starting with a letter, and a `url` beginning with `http://` or
`https://`; the runner checks the rest when a turn starts, by the rules of `sources.json`. A
plugin's source may not name a `socket`: where one is mounted is the host's to say, in its own
`sources.json`.

A source is granted to every spore using the plugin, whether or not its `spore.cmk` lists it under
`sources`; listing it there is how a spore narrows it, with `<source>.<param>` or `<source>.path`. The runner holds it: the agent asks for it by name through `$SPORE_SOURCE` and never sees
its address or its key. `${VAR}` in `url`, `query` and `headers` is filled from the runner's
environment, which includes `~/.config/spore/environment`, so the plugin's README names each
variable the operator adds there; `spore plugin show --json` lists them as `secrets`. A turn
starts only when every one is set (`SOURCE_SECRET_MISSING`). A header may hold `{name}`, the
calling spore's name, as in `sources.json`; any other placeholder there, and `{name}` anywhere
else, is refused. A source that `requires` a parameter
needs each spore using the plugin to narrow it in its `spore.cmk` (`<source>.<param>`), or its
turns are refused.

A precursor may grant the source to a cell with `sources: [<source>]`, as for any source the spore
holds ([definition.md §`sources`](definition.md#sources)). When the runner reads the host's
`sources.json`, because the spore also grants a source no plugin describes, a name both describe
refuses the turn (`SOURCE_INVALID`). Two plugins one spore uses that describe one source are
refused together (`PLUGIN_CONFLICT`).

## `modules`

```json
"dependencies": { "sharp": "^0.35.5" },
"spore": { "modules": ["sharp"] }
```

Libraries the agent's own programs may import by name. Each entry is a key of the plugin's
`dependencies` (not `optionalDependencies`, `peerDependencies` or `devDependencies`), and none is
one of the libraries every spore is already given, which its `libraries.md` lists. Either is
refused.

When a turn starts, each module is linked as `<ws>/node_modules/<module>` to where it is installed,
beside the provisioned ones. A link no plugin the spore uses offers any more is removed; an entry
there that is not a link is left alone, and no link is made over it. A cell is given none of them.
Two plugins one spore uses that offer one module are refused together (`PLUGIN_CONFLICT`).

## The reference

```json
"reference": "reference.md"
```

One file in the plugin, written for the agent: what each program does, how to run it, what its
exit codes mean. It is copied to `plugins/<name>.md` in the workspace when `spore define` makes a
spore using the plugin and at every turn start, whenever that file is absent. A file already there
is replaced only by `spore upgrade`, or when a runner starts on a host that sets `docs` to `follow`;
`spore send` and `spore show` name it when it differs from the installed one ([operating.md §Root documents](operating.md#root-documents-and-spore-upgrade)).

The agent's system prompt lists the reference of each plugin its `spore.cmk` names, with the file's
first non-blank line, its leading `#`s removed. That line is what the agent knows of the plugin
before reading the file:

```markdown
# brave — web search
```

## Precursors

```json
"precursors": "precursors"
```

A directory in the plugin. Every file directly in it ending in `.cmk` is a precursor, and anything
else there is ignored. Each is parsed as a precursor is ([definition.md](definition.md)), and
refused when it does not parse or when its `name` is not its file name (*has a precursor a.cmk
named b*).

When `spore define` makes a spore using the plugin, and at every turn start, each is copied into the
workspace's `precursors/` when no file of that name is there. One already there is never replaced,
by a turn or by `spore upgrade`, since the agent may have changed it.

A plugin's precursor follows every rule of a precursor, and a cell spawned from it is given nothing
of the plugin: no program, no variable, no module. It may:

- grant the plugin's sources, which the spore holds;
- grant `enzymes`, each a path relative to the spawning spore's workspace. The plugin copies only
  the `.cmk` file, so each path must already be a program there when the cell is spawned.

It may not name `plugins`, nor grant `ask` or `quiet`, as no precursor may.

## Services

```json
"services": {
  "telegram": {
    "what": "a bot of yours in Telegram chats, each chat reaching its spore",
    "program": "./bin/spore-telegram.js",
    "instances": { "called": "bot" },
    "check": ["--check"]
  }
}
```

A service is a Node program the host runs under systemd, as the user spores run under, outside
every sandbox. `spore service` offers the services of every installed plugin, allowed or not
([operating.md §Plugin services](operating.md#plugin-services)).

| key | shape | | rule |
|---|---|---|---|
| (the name) | | | lowercase letters, digits and `-`, starting with a letter |
| `what` | non-empty text | required | the line `spore service ls` shows, and the unit's description |
| `program` | `"./<path>"` | required | a file in the plugin, started with `node`; it needs no executable bit |
| `instances` | `{ "called" }` | optional | one instance per `<instance>.json` in the folder named after the service beside `config.json` |
| `check` | `["<arg>", …]` | optional | arguments that make the program test that it can start, then exit |

Any other key is refused, and so is a name, an `instances` or a `check` outside these shapes. A
service name spore ships (`webhook`, `api`, `ssh-agent`, `sluice`, `tick`), or one two installed
plugins claim, goes to neither plugin, and `spore service ls` shows why. A plugin that declares
services and fails its check shows there as a problem, its services not offered.

A chat connector's service is built on `@rhizogrip/spore/relay`, which keeps what every
connector promises; the plugin brings its adapter ([relay.md](relay.md)).

### The unit

Spore writes the unit; the manifest names a program, never a unit line. For a service with
instances it is a template, `~/.config/systemd/user/spore-<service>@.service`:

```ini
# Written by `spore service define ledger`. Change it with that command, not by hand.
[Unit]
Description=spore-ledger %i: posts each spore's entries to the book it names
X-Spore-Service=ledger

[Service]
ExecStart="/usr/bin/node" "/usr/lib/node_modules/@example/spore-plugin-ledger/bin/spore-ledger.js" %i
Restart=on-failure
RestartPreventExitStatus=2
KillMode=process

[Install]
WantedBy=default.target
```

Without `instances` it is `spore-<service>.service`, and `ExecStart` passes no argument.
`ExecStart` names the Node that ran `spore service define` and the program in the installed
plugin; `spore service ls` flags a unit whose Node or program is gone, and defining it again
rewrites it. The program:

- **is restarted on failure, except after exit code 2.** A program that cannot run as configured
  exits 2, with the reason on stderr, and stays stopped.
- **is stopped alone** (`KillMode=process`). Processes it started — a spore's runner among them —
  keep running when it stops or restarts.
- **loads its own environment.** The unit names no environment file. A program that starts turns
  calls `loadEnvironment()` from `@rhizogrip/spore`, which reads `~/.config/spore/environment`
  beside `config.json`, as `telegram` and `discord` do.

### Instances

```json
"instances": { "called": "bot" }
```

The instances of a service are the files of the folder named after it beside `config.json`
(`~/.config/spore/telegram/`): each `<instance>.json` is one, named by the file without `.json`.
`called` is what an instance is called in messages, as the service name is written, and
`instances` takes nothing else. A chat connector's relay reads its bot files from the same folder
by its adapter's `kind`, so a connector's service is named as its `kind`.

The operator names an instance as `<service>@<instance>`: `spore service define telegram@triage`.
The unit for it is `spore-<service>@<instance>.service`, and the program is given the instance's
name as its first argument; it finds its file itself. An instance counts as defined only while its
file exists. A service with instances named without one is refused (`SERVICE_NEEDS_INSTANCE`),
except by `spore service rm`, which stops every instance and removes the template — given `--yes`
when any of them is running; a service without instances named with one is refused.

### The check

```json
"check": ["--check"]
```

`spore service define` runs `node <program> [<instance>] <check…>` before it writes the unit, in
the environment of the command that runs it. An exit code other than 0 refuses the definition
(`SERVICE_NOT_READY`) with what the program wrote on stderr, or else on stdout, as its detail. A
service with no `check` is written unchecked. `telegram` and `discord` read their bot's file, find
its token and ask the network for the bot before answering 0.

### The version it runs

```js
import { loadEnvironment, recordStarted } from '@rhizogrip/spore'

recordStarted(`telegram@${bot}`, { root: ROOT })
```

A running program records the plugin version it started from with `recordStarted(name, { root })`:
`name` is the service as `spore service` names it, `<service>` or `<service>@<instance>`, and `root`
the plugin's own directory. `spore service ls` then says when the version installed has moved on,
and `spore service restart --outdated` restarts it. Call it from the service process itself, after
its checks pass.

A program that imports the library declares `@rhizogrip/spore` as a peer dependency. In a global
install it gets a copy of its own within that range, which may be another version than the one
spore's command runs.

## Writing one

### Layout

The plugins in this repository are the examples:

| plugin | shows |
|---|---|
| `plugins/brave` | a program in the plugin, and a source it calls |
| `plugins/browser` | a program in a dependency, a `port` setting, every placeholder but `{ws}` |
| `plugins/ssh` | a `text` setting naming a socket |
| `plugins/sluice` | `contain`: each spore shown only its own socket of a directory of them |
| `plugins/documents`, `plugins/images` | `modules`, with nothing for the agent to run |
| `plugins/mcp` | a program, with dependencies of its own |
| `plugins/telegram` | a service with instances, and nothing else |
| `plugins/discord` | a service with instances, beside a program and a source |

None ships precursors. A typical layout:

```
package.json      the manifest, and "files" naming everything it points at
bin/              programs, executable, and a service's program
src/              what they import
reference.md      for the agent
precursors/       <name>.cmk files
README.md         for the operator: install, allow, settings, environment variables
```

A plugin's README is where the operator learns what to give it: each setting, each `${VAR}` its
sources read, each instance file a service expects, and what the plugin leaves reachable.

### Versions

A turn uses the copy that was allowed: `allow` records the plugin's version and real directory,
and a turn whose installed copy differs in either is refused with `PLUGIN_CHANGED` until the
operator allows it again. A published change is a new version, and each new version is allowed
again on every machine using it.

### Testing against the core

`@rhizogrip/spore` exports what the plugins here test with:

| export | checks |
|---|---|
| `showPlugin(name, { configFile, roots })` | the whole manifest, as `spore plugin show`; with no allowed record in `configFile`, settings are not checked |
| `allowPlugin(name, ['key=value', …], { configFile, roots })` | the same with settings, recorded in `configFile` |
| `pluginServices(roots)` | the services every plugin in `roots` offers, and the problems |

`configFile` is a path for the test; one with no file there is a machine where nothing is allowed.
`roots` is the list of directories to look in for `spore-plugin-*` and `@*/spore-plugin-*`, by
default where the installed spore looks. Each plugin here checks its own manifest that way:

```js
import { showPlugin } from '@rhizogrip/spore'

it('is a plugin spore accepts, describing its source and giving its program', () => {
  const shown = showPlugin('brave', { configFile: join(ROOT, 'no-config.json') })
  expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-brave', sources: ['brave'], programs: { SPORE_BRAVE: join(shown.dir, 'bin/search.js') } })
})
```

The rest are tests of the plugin's own programs. `brave` and `discord` run theirs with
`SPORE_SOURCE` set to `bin/source.js` from the installed `@rhizogrip/spore` and
`SPORE_SOURCE_SOCKET` at a stand-in server on a unix socket, and assert what was asked. `documents`
and `images` run the examples of their `reference.md` against the libraries they offer and compare
the output shown there.

### Publishing

A plugin's `files` carry every file the manifest names, and its programs keep their executable bit,
which `allow` checks on the installed copy.
