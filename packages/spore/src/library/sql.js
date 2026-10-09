/**
 * A spore's records, read with SQL: what `$SPORE_SQL` runs for an agent and `spore sql` for a
 * person. The database is opened read-only; for an agent, what enforces that is its sandbox.
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { SporeError } from '../observability/errors.js'

const VIEWS = "type = 'view'"
const LISTED = "type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'"

const cell = (value) => {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  return String(value)
}

const aligned = (columns, rows) => {
  const lines = [columns, ...rows.map(row => columns.map(name => cell(row[name])))]
  const widths = columns.map((_, i) => Math.max(...lines.map(line => line[i].length)))
  return lines.map(line => line.map((text, i) => text.padEnd(widths[i])).join('  ').trimEnd())
}

const jsonLines = (rows) => rows.map(row => JSON.stringify(row, (key, value) => (typeof value === 'bigint' ? String(value) : value)))

/** `.tables` lists the views, which are what a reader is given; the `t_` tables are storage. */
export function sqlLines (database, query, { json = false } = {}) {
  if (!existsSync(database)) {
    throw new SporeError(`${database} does not exist`, { type: 'SQL_NO_DATABASE', detail: 'nothing has been recorded in this workspace yet' })
  }
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const [command, name] = query.trim().split(/\s+/)
    if (command === '.tables') {
      return db.prepare(`SELECT name FROM sqlite_schema WHERE ${VIEWS} ORDER BY name`).all().map(row => row.name)
    }
    if (command === '.schema') {
      const rows = name
        ? db.prepare(`SELECT sql FROM sqlite_schema WHERE ${LISTED} AND name = ?`).all(name)
        : db.prepare(`SELECT sql FROM sqlite_schema WHERE ${VIEWS} ORDER BY name`).all()
      if (name && !rows.length) throw new SporeError(`no table or view called ${name}`, { type: 'SQL_NO_SUCH_NAME' })
      return rows.map(row => row.sql + ';')
    }
    const statement = db.prepare(query)
    const rows = statement.all()
    return json ? jsonLines(rows) : aligned(statement.columns().map(column => column.name), rows)
  } finally {
    db.close()
  }
}
