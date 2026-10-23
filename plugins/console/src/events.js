/**
 * The console's event log: everything that happened in each person's conversation, in order, under
 * a `seq` that only grows and is never handed out twice, whatever the person. A program reads a
 * conversation back from the last `seq` it saw, so the log is the console's source of truth and
 * outlives the service; `said` keeps each message's client id against its `seq`, so a message sent
 * twice is said once.
 */

import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL,
  person    TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  approval  TEXT,
  body      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_person ON events (person, seq);
CREATE INDEX IF NOT EXISTS events_card ON events (approval) WHERE type = 'card';
CREATE TABLE IF NOT EXISTS said (
  id         TEXT    PRIMARY KEY,
  seq        INTEGER NOT NULL REFERENCES events (seq),
  delivered  INTEGER NOT NULL DEFAULT 0
);
`

const ANSWERS = ['reply', 'question']

export function openEvents (path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  const added = new EventEmitter().setMaxListeners(0)

  const insert = db.prepare('INSERT INTO events (at, person, type, approval, body) VALUES (?, ?, ?, ?, ?) RETURNING seq')
  const bySeq = db.prepare('SELECT * FROM events WHERE seq = ?')
  const after = db.prepare('SELECT * FROM events WHERE person = ? AND seq > ? ORDER BY seq LIMIT ?')
  const card = db.prepare('SELECT * FROM events WHERE type = \'card\' AND approval = ?')
  const saidAs = db.prepare('SELECT seq, delivered FROM said WHERE id = ?')
  const keep = db.prepare('INSERT INTO said (id, seq) VALUES (?, ?)')
  const done = db.prepare('UPDATE said SET delivered = 1 WHERE id = ?')
  const covered = db.prepare(`SELECT COALESCE(MAX(j.value), 0) AS seq FROM events e, json_each(e.body, '$.answers') j WHERE e.person = ? AND e.type IN (${ANSWERS.map(() => '?').join(', ')})`)
  const asked = db.prepare('SELECT seq FROM events WHERE person = ? AND type = \'message\' AND seq > ? AND seq <= ? ORDER BY seq')

  const eventOf = (row) => ({ seq: row.seq, at: row.at, person: row.person, type: row.type, ...JSON.parse(row.body) })

  const write = (person, type, fields) => {
    const at = new Date().toISOString()
    const { seq } = insert.get(at, person, type, fields.approval ?? null, JSON.stringify(fields))
    return { seq, at, person, type, ...fields }
  }

  return {
    append (person, type, fields) {
      const event = write(person, type, fields)
      added.emit('event', event)
      return event
    },

    /**
     * What a person said, under the client's `id`: the event written with its `said` row in one
     * transaction, or the one written the first time that id came, with whether it reached the
     * spore then.
     */
    say (person, id, fields) {
      const found = saidAs.get(id)
      if (found) return { event: eventOf(bySeq.get(found.seq)), repeated: true, delivered: found.delivered === 1 }
      db.exec('BEGIN IMMEDIATE')
      let event
      try {
        event = write(person, 'message', { id, ...fields })
        keep.run(id, event.seq)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      added.emit('event', event)
      return { event, repeated: false, delivered: false }
    },

    delivered: (id) => { done.run(id) },

    after: (person, seq, limit) => after.all(person, seq, limit).map(eventOf),

    cardOf (approval) {
      const row = card.get(approval)
      return row ? eventOf(row) : null
    },

    /** The messages of `person` up to `seq` that no answer has covered yet: what an answer to `seq` answers. */
    answering: (person, seq) => asked.all(person, covered.get(person, ...ANSWERS).seq, seq).map(row => row.seq),

    next: (person, ms, signal) => new Promise(resolve => {
      const stop = () => {
        clearTimeout(timer)
        added.off('event', heard)
        signal.removeEventListener('abort', stop)
        resolve()
      }
      const heard = (event) => { if (event.person === person) stop() }
      const timer = setTimeout(stop, ms)
      added.on('event', heard)
      signal.addEventListener('abort', stop, { once: true })
    }),

    subscribe (person, fn) {
      const heard = (event) => { if (event.person === person) fn(event) }
      added.on('event', heard)
      return () => added.off('event', heard)
    },

    close: () => db.close()
  }
}
