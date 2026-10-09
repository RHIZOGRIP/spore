/**
 * The SQLite inside the Node an agent runs on, which is what reads a workspace's database
 * (ARCHITECTURE §The workspace database). It must be at least the release the Rust writer is held to — one rule,
 * `rust/workspace`'s, since two SQLite builds meet on one file.
 */

import { DatabaseSync } from 'node:sqlite'

import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

export function nodeSqliteVersion () {
  const db = new DatabaseSync(':memory:')
  try {
    return db.prepare('SELECT sqlite_version() AS version').get().version
  } finally {
    db.close()
  }
}

/** The version, or a refusal naming both it and the one required. */
export function checkSqlite (version = nodeSqliteVersion()) {
  if (!native.sqliteSupported(version)) {
    throw new SporeError(`this Node's SQLite is ${version}, older than ${native.sqliteMinimum()}`, {
      type: 'SQLITE_TOO_OLD',
      detail: 'a workspace database needs the WAL-reset fix; run spore on a Node that bundles a newer SQLite'
    })
  }
  return version
}
