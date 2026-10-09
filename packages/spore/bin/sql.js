#!/usr/bin/env node
/**
 * `$SPORE_SQL` — a spore's state, read with SQL.
 *
 *   node "$SPORE_SQL" state.sqlite .tables
 *   node "$SPORE_SQL" state.sqlite '.schema turns'
 *   node "$SPORE_SQL" state.sqlite 'SELECT …'            rows as aligned columns
 *   node "$SPORE_SQL" state.sqlite --json 'SELECT …'     one JSON object per row
 */

import { sqlLines } from '../src/library/sql.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const [path, query] = args.filter(arg => arg !== '--json')

if (!path || !query) {
  console.error('usage: node "$SPORE_SQL" <database> [--json] <sql | .tables | .schema [name]>')
  process.exit(2)
}

try {
  for (const line of sqlLines(path, query, { json })) console.log(line)
} catch (err) {
  console.error(`sql: ${err.message}${err.detail ? ` — ${err.detail}` : ''}`)
  process.exit(1)
}
