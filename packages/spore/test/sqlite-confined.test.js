/**
 * What the workspace database rests on: an agent reading a workspace database it cannot
 * write, under the same confinement `exec` runs in, in the four cases an agent can meet.
 * The writer here is `node:sqlite` in the test process or a child; the Rust writer comes
 * later and changes none of what a reader has to find on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'
import { checkSqlite, nodeSqliteVersion } from '../src/core/sqlite.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.sqlite-confined-workspace')
const DB = resolve(WS, 'state.sqlite')
const SQL = resolve(__dirname, '../bin/sql.js')

let exec

const writer = () => {
  const db = new DatabaseSync(DB)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0')
  return db
}

// What a confined reader sees: the row count, or the refusal it got.
const confinedCount = async () => {
  const meta = JSON.parse(await exec({ command: `node ${SQL} state.sqlite --json 'SELECT count(*) AS n FROM said'` }))
  return meta.exit === 0 ? JSON.parse(meta.files.out.content).n : `exit ${meta.exit}: ${meta.files.err?.content}`
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  // The database here is the test's own, with none of the workspace's tables, so the calls
  // that read it are recorded nowhere.
  const unrecorded = { request: () => ({}) }
  exec = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: unrecorded })).fns).exec
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('the SQLite on either side of a workspace database', () => {
  it('is at least the release both are held to', () => {
    expect(checkSqlite()).toBe(nodeSqliteVersion())
    expect(() => checkSqlite('3.50.4')).toThrow(/older than 3\.51\.3/)
  })
})

describe('a confined reader of a WAL database', () => {
  it('reads it while the writer holds it open', async () => {
    const db = writer()
    db.exec("CREATE TABLE said (text TEXT); INSERT INTO said VALUES ('one'), ('two')")
    expect(existsSync(`${DB}-wal`)).toBe(true)
    expect(await confinedCount()).toBe(2)
    db.exec("INSERT INTO said VALUES ('three')")
    expect(await confinedCount()).toBe(3)
    db.close()
  })

  // The header keeps WAL mode after the last close, and opening a WAL database needs `-shm`,
  // which a reader that can create nothing in the root cannot make. This is why the last
  // writer to let go puts the file back in rollback mode.
  it('is refused a WAL database nobody holds, once its sidecars are gone', async () => {
    const db = writer()
    db.exec("CREATE TABLE said (text TEXT); INSERT INTO said VALUES ('one')")
    db.close()
    expect(existsSync(`${DB}-wal`)).toBe(false)
    expect(existsSync(`${DB}-shm`)).toBe(false)
    expect(await confinedCount()).toMatch(/readonly database/)
  })

  it('reads it once nobody holds it, the last writer having put it back in rollback mode', async () => {
    const db = writer()
    db.exec("CREATE TABLE said (text TEXT); INSERT INTO said VALUES ('one')")
    expect(db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode).toBe('delete')
    db.close()
    expect(existsSync(`${DB}-wal`)).toBe(false)
    expect(existsSync(`${DB}-shm`)).toBe(false)
    expect(await confinedCount()).toBe(1)
  })

  it('reads what a writer killed mid-life had committed', async () => {
    const child = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(${JSON.stringify(DB)})
      db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
      db.exec("CREATE TABLE said (text TEXT); INSERT INTO said VALUES ('one'), ('two'), ('three')")
      db.exec('BEGIN; INSERT INTO said VALUES (\\'never committed\\')')
      console.log('ready')
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(resolve => child.stdout.once('data', resolve))
    child.kill('SIGKILL')
    await once(child, 'close')

    expect(existsSync(`${DB}-wal`)).toBe(true)
    expect(existsSync(`${DB}-shm`)).toBe(true)
    expect(await confinedCount()).toBe(3)
  })

  it('cannot write it, by the helper or by opening it for writing itself', async () => {
    const db = writer()
    db.exec("CREATE TABLE said (text TEXT); INSERT INTO said VALUES ('one')")

    const helper = JSON.parse(await exec({ command: `node ${SQL} state.sqlite "INSERT INTO said VALUES ('two')"` }))
    expect(helper.exit).not.toBe(0)
    const attempt = 'new (require(\'node:sqlite\').DatabaseSync)(\'state.sqlite\').exec("INSERT INTO said VALUES (\'three\')")'
    const raw = JSON.parse(await exec({ command: `node -e ${JSON.stringify(attempt)}` }))
    expect(raw.exit).not.toBe(0)
    const removed = JSON.parse(await exec({ command: 'rm -f state.sqlite-wal state.sqlite-shm' }))
    expect(removed.exit).not.toBe(0)

    expect(db.prepare('SELECT count(*) AS n FROM said').get().n).toBe(1)
    db.close()
  })
})
