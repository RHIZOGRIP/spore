# @rhizogrip/cairn

A cairn is a shared record that agents, programs and people add to and nobody changes: each entry
is numbered after the last, says who wrote it, in which role and run, and carries the hash of the
entry before it. One daemon per cairn writes it; anyone with the file reads it as a SQLite
database. It keeps records first and coordinates second: an entry about a task, a payment or a
finding is cited by later ones, and a writer can refuse to write over a head that moved.

This package is the record, its daemon and `cairn verify`. Spores join a cairn through
[`@rhizogrip/spore-plugin-cairn`](../../plugins/cairn/README.md), which runs the daemon as a
service, stamps what a spore writes and wakes members with what others wrote. What a cairn is for,
with an example: [rhizogrip.com/cairn](https://rhizogrip.com/cairn).

It needs Node 24 or newer whose bundled SQLite is 3.51.3 or newer, and refuses an older one.

## The daemon

```bash
export CAIRN_LEDGER_TOKEN=$(openssl rand -hex 32)
cairn serve ledger.json --db /srv/cairns/ledger/cairn.sqlite --socket /srv/cairns/sockets/ledger.sock
```

The cairn is named after its instance file, and its token is `CAIRN_<NAME>_TOKEN` (`-` read as
`_`). It speaks HTTP on the unix socket, made `0600`, and keeps evidence in `evidence/` beside the
database. The instance file:

```json
{
  "members": { "triage": "reviewer", "stripe-feed": "source" },
  "kinds": {
    "finding": { "summary": "string", "severity": "integer", "files?": ["string"] },
    "payment.seen": { "amount": "integer", "currency": "string", "raw": "any" }
  },
  "subjects": { "entry": "seq", "evidence": "sha256", "customer": "^cus_[A-Za-z0-9]+$" },
  "notify": { "minDelay": "15m", "maxHops": 1 }
}
```

- `members` — who may write, each with the role stamped on what they write. `cairn` is the
  daemon's own name.
- `kinds` — what may be written. A shape maps each field to `string`, `integer`, `boolean`, `any`
  (any JSON below it), an object of fields, or a one-element list of a shape; a field ending in
  `?` may be left out, and a field the shape does not name is refused. Kinds under `cairn.` are
  the daemon's own. A changed shape is a new kind name.
- `subjects` — the keys an entry's `refs` may use: `seq` an earlier entry of this cairn, `sha256`
  evidence it holds, or a pattern anchored with `^` and `$`, so two writers cannot name one
  subject two ways.
- `notify`, optional — members may subscribe to kinds; how they are woken is the plugin's.

An instance file that differs from the one the cairn last recorded is appended as a `cairn.config`
entry before the socket opens, so the rules in force for each entry are in the chain.

## Writing

Every request carries `Authorization: Bearer <token>`. Who writes is in headers, never the body,
so whatever forwards a request stamps it and the writer cannot choose:

| header | |
|---|---|
| `X-Cairn-Actor` | the member writing, one of `members` |
| `X-Cairn-Via` | `agent`, `program` or `cli` |
| `X-Cairn-Id` | the writer's run, a spore's turn — absent for a writer that keeps none |
| `X-Cairn-Hop` | how many notices led to the write, `0` when none did |

`POST /append` takes `{ kind, at, refs, data, expectedHead? }` and answers `{ seq, hash }`. `at`
is when what is recorded happened, `2026-10-29T14:02:06.381Z`, milliseconds always, up to 60 s
ahead of the daemon's clock. `expectedHead` is the `seq` of the head the writer read: the append
is refused when anyone wrote since. An entry is at most 4 KB.

`POST /evidence` takes `{ base64 }`, at most 16 MB, and answers `{ sha256, bytes }`. The file is
kept read-only as `evidence/<sha256>`, and an entry cites it under a `sha256` subject. Storing
the same bytes twice changes nothing, and storing is not an entry.

A refusal is `{ error: { type, message, detail } }`, `detail` naming the field or header, and
nothing of it is kept:

| type | status | when |
|---|---|---|
| `unauthenticated` | 401 | no token, or not this cairn's |
| `not-a-member` | 403 | `X-Cairn-Actor` is not in `members` |
| `stale-head` | 409 | `expectedHead` is not the head |
| `too-large` | 413 | an entry past 4 KB, evidence past 16 MB |
| `unknown-kind` | 422 | not a kind of this cairn, or a subscription to one without `notify` |
| `shape-mismatch` | 422 | `data`, the body or a header does not hold what it should |
| `bad-ref` | 422 | a key that is no subject, a value off its pattern, a `seq` not in the cairn, evidence it does not hold |
| `bad-time` | 422 | `at` not written as above, or in the future |

A program that is a member writes with nothing of cairn:

```bash
curl -s --unix-socket /srv/cairns/sockets/ledger.sock http://cairn/append \
  -H "Authorization: Bearer $CAIRN_LEDGER_TOKEN" \
  -H 'X-Cairn-Actor: stripe-feed' -H 'X-Cairn-Via: program' -H 'X-Cairn-Hop: 0' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"payment.seen","at":"2026-10-29T14:02:06.381Z","refs":{"customer":"cus_Q1"},"data":{"amount":4900,"currency":"usd","raw":{}}}'
```

## Reading

The database is the reader's interface. Open it read-only, through its views; the `t_` tables
behind them are storage.

| view | one row per |
|---|---|
| `entries` | entry: `seq`, `at`, `kind`, `actor`, `role`, `via`, `id`, `hop`, `refs` and `data` as JSON, `v`, `hash` |
| `subjects` | ref of an entry: `key`, `value`, then that entry's columns |
| `head` | the last entry: `seq`, `hash`, `at` |

Everything said about one customer is
`SELECT seq, at, actor, kind, data FROM subjects WHERE key = 'customer' AND value = 'cus_Q1' ORDER BY seq`.
The file is in WAL mode while the daemon holds it and back in rollback mode when it stops, so a
reader that may create nothing beside it can still open it then.

Each entry is stored as `line`, the canonical JSON of its envelope — what `jq -cS` prints —
and `hash`, the sha256 of `line`:

| field | | set by |
|---|---|---|
| `at`, `kind`, `refs`, `data` | what happened, when, about what | the writer |
| `actor` | `{ name, role, via }` | the forwarder's headers, `role` from `members` |
| `id`, `hop` | the writer's run, and how many notices led to it | the forwarder's headers |
| `v`, `seq`, `cairn`, `prev` | envelope version, position, the cairn's name, the hash of the entry before | the daemon |

## Checking

```bash
cairn verify /srv/cairns/ledger/cairn.sqlite --evidence
ledger: ok, 1204 entries, 3 evidence files, head seq 1204 9f2c…e1 at 2026-10-29T14:02:06.381Z
```

It reads the file read-only, so it runs beside the daemon, and walks the chain from the first
entry: each line canonical, hashing to its hash, its `seq` the next and its `prev` the hash before,
its refs rows the refs it names. `--evidence` also checks that every file an entry cites under a
`sha256` subject of the `cairn.config` then in force is in `evidence/` and still hashes to its
name. It exits 0 when everything holds, 1 naming the first entry that does not, and 2 when it
cannot read the file; `--json` prints what it found as one object.

Nothing of cairn is needed to check the chain: Node's own `node:sqlite` reads the lines, and `jq`
and `sha256sum` re-derive each one's canonical form and hash:

```bash
tab=$(printf '\t'); prev=null
node -e '
const { DatabaseSync } = require("node:sqlite")
const db = new DatabaseSync(process.argv[1], { readOnly: true })
for (const row of db.prepare("SELECT seq, hash, line FROM t_entries ORDER BY seq").iterate()) console.log(`${row.seq}\t${row.hash}\t${row.line}`)
' cairn.sqlite |
while IFS="$tab" read -r seq hash line; do
  [ "$(printf '%s' "$line" | jq -jcS . | sha256sum | cut -d' ' -f1)" = "$hash" ] || echo "seq $seq: line and hash differ"
  [ "$(printf '%s' "$line" | jq -r '.prev // "null"')" = "$prev" ] || echo "seq $seq: prev is not the hash before"
  prev=$hash
done
```

## As a library

```js
import { openCairn, serve, verifyCairn } from '@rhizogrip/cairn'
```

`serve({ name, instanceFile, file, socket, token })` is the daemon, resolving to `{ close }`.
`openCairn(file, { name })` is the writer's side without one — `append`, `head`, `since(seq)`,
`verify({ from, to })`, `close` — for a single process that owns the file. `verifyCairn(file,
{ evidence })` is what `cairn verify` runs.
