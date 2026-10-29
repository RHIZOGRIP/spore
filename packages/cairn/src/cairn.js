import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { canonical } from './canonical.js'
import { CairnError } from './errors.js'

export const SCHEMA_VERSION = 1
export const ENVELOPE_VERSION = 1

const WRITER_FIELDS = ['at', 'kind', 'refs', 'data', 'actor', 'id', 'hop']

const SCHEMA = `
CREATE TABLE t_cairn (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT    NOT NULL,
  createdAt  TEXT    NOT NULL
) STRICT;

CREATE TABLE t_entries (
  seq    INTEGER PRIMARY KEY,
  line   TEXT    NOT NULL,
  hash   TEXT    NOT NULL UNIQUE,
  at     TEXT    GENERATED ALWAYS AS (json_extract(line, '$.at')) STORED,
  kind   TEXT    GENERATED ALWAYS AS (json_extract(line, '$.kind')) STORED,
  actor  TEXT    GENERATED ALWAYS AS (json_extract(line, '$.actor.name')) STORED,
  role   TEXT    GENERATED ALWAYS AS (json_extract(line, '$.actor.role')) STORED,
  via    TEXT    GENERATED ALWAYS AS (json_extract(line, '$.actor.via')) STORED,
  id     ANY     GENERATED ALWAYS AS (json_extract(line, '$.id')) STORED,
  hop    INTEGER GENERATED ALWAYS AS (json_extract(line, '$.hop')) STORED
) STRICT;

CREATE TABLE t_refs (
  key    TEXT    NOT NULL,
  value  TEXT    NOT NULL,
  seq    INTEGER NOT NULL REFERENCES t_entries (seq),
  PRIMARY KEY (key, value, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX t_refs_seq ON t_refs (seq);
CREATE INDEX t_entries_at ON t_entries (at);
CREATE INDEX t_entries_kind ON t_entries (kind);

CREATE VIEW entries AS
SELECT seq, at, kind, actor, role, via, id, hop,
       json_extract(line, '$.refs') AS refs, json_extract(line, '$.data') AS data,
       json_extract(line, '$.v') AS v, hash
FROM t_entries;

CREATE VIEW subjects AS
SELECT r.key, r.value, e.*
FROM t_refs r JOIN entries e ON e.seq = r.seq;

CREATE VIEW head AS
SELECT seq, hash, at FROM t_entries ORDER BY seq DESC LIMIT 1;

CREATE TRIGGER t_entries_never_changed BEFORE UPDATE ON t_entries
BEGIN SELECT RAISE(ABORT, 'a cairn entry is never changed'); END;
CREATE TRIGGER t_entries_never_removed BEFORE DELETE ON t_entries
BEGIN SELECT RAISE(ABORT, 'a cairn entry is never removed'); END;
CREATE TRIGGER t_refs_never_changed BEFORE UPDATE ON t_refs
BEGIN SELECT RAISE(ABORT, 'a cairn ref is never changed'); END;
CREATE TRIGGER t_refs_never_removed BEFORE DELETE ON t_refs
BEGIN SELECT RAISE(ABORT, 'a cairn ref is never removed'); END;
`

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function create (file, name) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA)
    db.prepare('INSERT INTO t_cairn (id, name, createdAt) VALUES (1, ?, ?)').run(name, new Date().toISOString())
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    db.close()
    throw err
  }
  return db
}

function open (file, name) {
  const db = new DatabaseSync(file)
  const { user_version: version } = db.prepare('PRAGMA user_version').get()
  if (version !== SCHEMA_VERSION) {
    db.close()
    throw new CairnError(`${file} is at schema ${version}, and this cairn reads ${SCHEMA_VERSION}`, { type: 'unknown-schema', detail: file })
  }
  const recorded = db.prepare('SELECT name FROM t_cairn WHERE id = 1').get().name
  if (recorded !== name) {
    db.close()
    throw new CairnError(`${file} is the cairn "${recorded}", not "${name}"`, { type: 'wrong-cairn', detail: file })
  }
  return db
}

function refsOf (refs) {
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    throw new CairnError('refs is a map of subject keys to ids', { type: 'shape-mismatch', detail: '$.refs' })
  }
  return Object.entries(refs).map(([key, value]) => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
      throw new CairnError(`refs.${key} is an id: a string or an integer`, { type: 'shape-mismatch', detail: `$.refs.${key}` })
    }
    return [key, String(value)]
  })
}

/**
 * The writer's side of one cairn: `file` is created when absent, and an existing one must be the
 * cairn called `name`. One process appends; anyone may read the file at the same time.
 */
export function openCairn (file, { name }) {
  const db = existsSync(file) ? open(file, name) : create(file, name)
  const last = db.prepare('SELECT seq, hash FROM t_entries ORDER BY seq DESC LIMIT 1')
  const insertEntry = db.prepare('INSERT INTO t_entries (seq, line, hash) VALUES (?, ?, ?)')
  const insertRef = db.prepare('INSERT INTO t_refs (key, value, seq) VALUES (?, ?, ?)')

  function append (fields, { expectedHead, maxBytes } = {}) {
    for (const field of WRITER_FIELDS) {
      if (fields[field] === undefined) throw new CairnError(`an entry needs ${field}`, { type: 'shape-mismatch', detail: `$.${field}` })
    }
    const refs = refsOf(fields.refs)
    db.exec('BEGIN IMMEDIATE')
    try {
      const head = last.get()
      const seq = head ? head.seq + 1 : 1
      if (expectedHead !== undefined && expectedHead !== seq - 1) {
        throw new CairnError(`the head is ${seq - 1}, not ${expectedHead}`, { type: 'stale-head', detail: String(seq - 1) })
      }
      const entry = { ...Object.fromEntries(WRITER_FIELDS.map(field => [field, fields[field]])), v: ENVELOPE_VERSION, seq, cairn: name, prev: head ? head.hash : null }
      const line = canonical(entry)
      const bytes = Buffer.byteLength(line, 'utf8')
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new CairnError(`the entry is ${bytes} bytes, past ${maxBytes}: a large payload goes to the evidence store, cited by hash`, { type: 'too-large', detail: String(bytes) })
      }
      const hash = sha256(line)
      insertEntry.run(seq, line, hash)
      for (const [key, value] of refs) insertRef.run(key, value, seq)
      db.exec('COMMIT')
      return { seq, hash }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  function head () {
    const row = db.prepare('SELECT seq, hash, at FROM head').get()
    return row ? { seq: row.seq, hash: row.hash, at: row.at } : null
  }

  function since (seq) {
    return db.prepare('SELECT line, hash FROM t_entries WHERE seq > ? ORDER BY seq').all(seq)
      .map(row => ({ ...JSON.parse(row.line), hash: row.hash }))
  }

  function verify ({ from = 1, to = Number.MAX_SAFE_INTEGER } = {}) {
    let previous = null
    if (from > 1) {
      const before = db.prepare('SELECT hash FROM t_entries WHERE seq = ?').get(from - 1)
      if (!before) return { ok: false, checked: 0, gap: { after: from - 1, next: from } }
      previous = before.hash
    }
    const refsAt = db.prepare('SELECT key, value FROM t_refs WHERE seq = ?')
    let expected = from
    let checked = 0
    for (const row of db.prepare('SELECT seq, line, hash FROM t_entries WHERE seq >= ? AND seq <= ? ORDER BY seq').iterate(from, to)) {
      if (row.seq !== expected) return { ok: false, checked, gap: { after: expected - 1, next: row.seq } }
      const broken = (why) => ({ ok: false, checked, firstBreak: { seq: row.seq, why } })
      if (sha256(row.line) !== row.hash) return broken('its line does not hash to its hash')
      let entry, said
      try {
        entry = JSON.parse(row.line)
        if (canonical(entry) !== row.line) return broken('its line is not canonical')
        said = refsOf(entry.refs).map(pair => JSON.stringify(pair)).sort()
      } catch (err) {
        return broken(`its line does not hold: ${err.message}`)
      }
      if (entry.seq !== row.seq) return broken(`its line says seq ${entry.seq}`)
      if (entry.prev !== previous) return broken('its prev is not the hash of the entry before')
      const stored = refsAt.all(row.seq).map(ref => JSON.stringify([ref.key, ref.value])).sort()
      if (stored.join('\n') !== said.join('\n')) return broken('its refs rows are not the refs its line names')
      previous = row.hash
      expected = row.seq + 1
      checked++
    }
    return { ok: true, checked }
  }

  function latest (kind) {
    const row = db.prepare('SELECT line, hash FROM t_entries WHERE kind = ? ORDER BY seq DESC LIMIT 1').get(kind)
    return row ? { ...JSON.parse(row.line), hash: row.hash } : null
  }

  return { name, append, head, since, latest, verify, close: () => db.close() }
}
