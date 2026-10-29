# @rhizogrip/spore-plugin-cairn

A cairn is a record several spores share: append-only, each entry hashed with the one before it,
written only through a daemon that knows who its members are and what each kind of entry holds.
A member reads the whole record as a SQLite database and writes to it through a source, so the
cairn's token never reaches a spore and every entry says which spore wrote it and in which turn.
The daemon runs on the machine the spores are on as a systemd user unit, one per cairn.

```bash
npm i -g @rhizogrip/spore-plugin-cairn
spore plugin allow cairn root=/srv/cairns                    # gives spores "$SPORE_CAIRN"
echo "CAIRN_LEDGER_TOKEN=$(openssl rand -hex 32)" >> ~/.config/spore/environment
mkdir -p ~/.config/spore/cairn
cat > ~/.config/spore/cairn/ledger.json <<'JSON'
{
  "members": { "triage": "reviewer", "payouts": "writer" },
  "kinds": {
    "finding": { "summary": "string", "severity": "integer", "files?": ["string"] },
    "decision": { "summary": "string" }
  },
  "subjects": { "entry": "seq", "evidence": "sha256", "ticket": "^[A-Z]+-[0-9]+$" }
}
JSON
spore service define cairn@ledger && spore service start cairn@ledger
```

## The instance file

`~/.config/spore/cairn/<cairn>.json` holds three keys, and a fourth when members may be woken:

- `members` — each spore that may write, by the name of its workspace, with its role. The role is
  stamped on every entry the spore writes. `cairn` is the daemon's own name and no member's.
- `kinds` — what may be written: each kind maps its fields to `string`, `integer`, `boolean`, `any`,
  a nested object of fields, or a one-element list such as `["string"]`. A field ending in `?` may
  be left out. Kinds under `cairn.` are the daemon's own.
- `subjects` — what an entry may be about, the keys of its `refs`: `seq` an earlier entry of this
  cairn, `sha256` evidence the cairn holds, or a pattern anchored with `^` and `$`.
- `notify` — `{ "minDelay": "15m", "maxHops": 1 }`, both required: members may then subscribe to
  kinds and are woken when others write them ([Waking members](#waking-members)). Without it a
  member reads the cairn when it chooses, and subscribing is refused.

When the daemon starts with an instance file that differs from the one it last served, it records
the new one as a `cairn.config` entry, so the record says what its rules were when each entry was
written.

## The source

A member writes through a source in the host's `~/.config/spore/sources.json`. A plugin may not
describe a source on a socket, so this entry is yours to add, once per cairn:

```json
{
  "cairn-ledger": {
    "url": "http://cairn/",
    "socket": "/srv/cairns/sockets/ledger.sock",
    "methods": ["POST"],
    "paths": ["append", "evidence"],
    "headers": {
      "Authorization": "Bearer ${CAIRN_LEDGER_TOKEN}",
      "X-Cairn-Actor": "{name}",
      "X-Cairn-Via": "agent",
      "X-Cairn-Id": "{turn}",
      "X-Cairn-Hop": "{hop}"
    }
  }
}
```

The runner fills `{name}` with the spore's name, `{turn}` with the turn the call is made in and
`{hop}` with how many notices led to that turn, so what a spore writes cannot claim to come from
another, nor to start a chain afresh.

## A member

Each member's `spore.cmk` reads the cairn, is granted its source and uses the plugin:

```
plugins: [cairn]
reads: [cairn-ledger=/srv/cairns/ledger]
sources: [cairn-ledger]
```

The read must be named `cairn-<cairn>`: that is where `$SPORE_CAIRN` finds it. The plugin hides
`<root>/sockets` from the spores that use it, so a member reaches the daemon only through the
source, with its own name on what it writes.

## Waking members

A member subscribes to kinds with `"$SPORE_CAIRN" ledger subscribe finding decision`, and stops
with `unsubscribe`. Both are entries, `cairn.subscribe` and `cairn.unsubscribe`, so who asked to be
woken by what, and since when, is in the record. The service then delivers a member a notice
through the HTTP API when others write those kinds: the cairn, the `seq` range, how many entries
of which kinds, and how to read them. The entries stay in the cairn.

- The first entry after a quiet spell is told at once; what follows is gathered into one notice,
  sent once `minDelay` has run since the last.
- A member is never told of its own entries.
- Every entry carries a `hop`: 0 when its turn was not woken by a notice, and otherwise one more
  than the highest hop of the notices that turn read. An entry whose hop reaches `maxHops` wakes
  nobody, so with `maxHops: 1` what a person or a turn started otherwise writes wakes its
  subscribers, and what their woken turns write wakes no one.

The service is the HTTP API's caller `cairn-<cairn>`, reaching its members:

```json
"callers": {
  "cairn-ledger": { "token": "${CAIRN_LEDGER_API}", "spores": ["triage", "payouts"] }
}
```

in `~/.config/spore/api.json`, with `CAIRN_LEDGER_API` in `~/.config/spore/environment` and
`spore-api` running. Where each member was last told is kept in
`$XDG_STATE_HOME/spore/cairn/<cairn>/state.json`, so a restart tells what it missed, and a notice
cut off by a stop is sent again under the same delivery id and taken once. A notice the API does
not take is tried again a minute later, and logged.

## What the service checks

`spore service define` runs `spore-cairn <cairn> --check`, and the daemon runs the same checks when
it starts. It refuses to start, exiting 2, without the plugin's `root`, the instance file, a
readable one, or the token, and, with `notify`, without an `api.json` naming the caller
`cairn-<cairn>` whose token is set. It warns, refusing nothing, of a member whose `spore.cmk` lacks the
read, the source or the plugin; of a member no spore is called; of a spore that is no member and
reads the cairn or is granted its source; and of a `sources.json` that does not describe the
cairn's source or names another socket.

## On disk

```
<root>/sockets/<cairn>.sock      the daemon's socket, in a directory only you may enter
<root>/<cairn>/cairn.sqlite      the record
<root>/<cairn>/evidence/<sha256> each file stored as evidence, read-only once written
$XDG_STATE_HOME/spore/cairn/<cairn>/state.json   how far each member was told
```

A member is a spore by its name, which is unique among one user's spores and not across users:
the members of a cairn are spores of the user running it.
