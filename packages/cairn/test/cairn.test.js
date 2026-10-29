import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CairnError, SCHEMA_VERSION, canonical, openCairn, verifyCairn } from '../src/index.js'

const APPEND_FOREVER = fileURLToPath(new URL('./fixtures/append-forever.js', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/cairn.js', import.meta.url))

const entry = (n, data = { note: 'x' }) => ({
  at: '2026-10-29T10:00:00.000Z',
  kind: 'task.claim',
  refs: { task: n, customer: 'cus_1' },
  data,
  actor: { name: 'main', role: 'lead', via: 'agent' },
  id: 'turn-1',
  hop: 0
})

const refusal = (fn) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(CairnError)
    return err
  }
  throw new Error('expected a refusal')
}

let dir, file

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
  file = join(dir, 'cairn.sqlite')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const filled = (count) => {
  const cairn = openCairn(file, { name: 'ops' })
  for (let n = 1; n <= count; n++) cairn.append(entry(n))
  return cairn
}

const tampered = (sql) => {
  const db = new DatabaseSync(file)
  db.exec(sql)
  db.close()
}

describe('the chain', () => {
  it('verifies 1,000 appended entries (A1)', () => {
    const cairn = filled(1000)
    expect(cairn.verify()).toEqual({ ok: true, checked: 1000 })
    expect(cairn.head()).toMatchObject({ seq: 1000, at: '2026-10-29T10:00:00.000Z' })
    cairn.close()
  })

  it('stamps what the writer does not choose, and chains each entry to the one before', () => {
    const cairn = filled(2)
    const [first, second] = cairn.since(0)
    expect(first).toMatchObject({ seq: 1, v: 1, cairn: 'ops', prev: null, kind: 'task.claim', refs: { task: 1, customer: 'cus_1' } })
    expect(second.prev).toBe(first.hash)
    expect(cairn.since(1).map(e => e.seq)).toEqual([2])
    cairn.close()
  })

  it('names the entry whose line was changed (A2)', () => {
    filled(10).close()
    tampered("DROP TRIGGER t_entries_never_changed; UPDATE t_entries SET line = replace(line, '\"x\"', '\"y\"') WHERE seq = 5")
    const cairn = openCairn(file, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: false, checked: 4, firstBreak: { seq: 5, why: 'its line does not hash to its hash' } })
    cairn.close()
  })

  it('names the entry after one rewritten with a hash to match', () => {
    filled(10).close()
    const db = new DatabaseSync(file)
    const { line } = db.prepare('SELECT line FROM t_entries WHERE seq = 5').get()
    const forged = line.replace('"x"', '"y"')
    const hash = execFileSync('sha256sum', { input: forged }).toString().split(' ')[0]
    db.exec('DROP TRIGGER t_entries_never_changed')
    db.prepare('UPDATE t_entries SET line = ?, hash = ? WHERE seq = 5').run(forged, hash)
    db.close()
    const cairn = openCairn(file, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: false, checked: 5, firstBreak: { seq: 6, why: 'its prev is not the hash of the entry before' } })
    cairn.close()
  })

  it('reports the gap a removed entry leaves (A3)', () => {
    filled(10).close()
    tampered('DROP TRIGGER t_entries_never_removed; DROP TRIGGER t_refs_never_removed; DELETE FROM t_refs WHERE seq = 5; DELETE FROM t_entries WHERE seq = 5')
    const cairn = openCairn(file, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: false, checked: 4, gap: { after: 4, next: 6 } })
    cairn.close()
  })

  it('names the entry whose refs rows were added to', () => {
    filled(10).close()
    tampered("INSERT INTO t_refs (key, value, seq) VALUES ('customer', 'cus_9', 3)")
    const cairn = openCairn(file, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: false, checked: 2, firstBreak: { seq: 3, why: 'its refs rows are not the refs its line names' } })
    cairn.close()
  })

  it('verifies a range from inside the chain', () => {
    const cairn = filled(10)
    expect(cairn.verify({ from: 4, to: 7 })).toEqual({ ok: true, checked: 4 })
    cairn.close()
  })

  it('refuses UPDATE and DELETE through SQLite (A10)', () => {
    filled(3).close()
    const db = new DatabaseSync(file)
    expect(() => db.exec("UPDATE t_entries SET hash = 'x' WHERE seq = 1")).toThrow('a cairn entry is never changed')
    expect(() => db.exec('DELETE FROM t_entries WHERE seq = 1')).toThrow('a cairn entry is never removed')
    expect(() => db.exec("UPDATE t_refs SET value = 'x'")).toThrow('a cairn ref is never changed')
    expect(() => db.exec('DELETE FROM t_refs')).toThrow('a cairn ref is never removed')
    db.close()
  })

  it('keeps nothing of an entry it refuses', () => {
    const cairn = filled(2)
    expect(refusal(() => cairn.append(entry(3, { ratio: 1.5 }))).type).toBe('shape-mismatch')
    expect(refusal(() => cairn.append({ ...entry(3), refs: { task: 1.5 } })).type).toBe('shape-mismatch')
    const noHop = entry(3)
    delete noHop.hop
    expect(refusal(() => cairn.append(noHop)).detail).toBe('$.hop')
    expect(cairn.head().seq).toBe(2)
    expect(cairn.verify()).toEqual({ ok: true, checked: 2 })
    cairn.close()
  })

  it('opens only the cairn it was created as', () => {
    filled(1).close()
    expect(refusal(() => openCairn(file, { name: 'finance' })).type).toBe('wrong-cairn')
  })

  it('has the schema this version reads', () => {
    filled(1).close()
    const db = new DatabaseSync(file, { readOnly: true })
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION)
    const columns = (table) => db.prepare(`PRAGMA table_xinfo(${table})`).all().map(c => c.name)
    expect(columns('t_cairn')).toEqual(['id', 'name', 'createdAt'])
    expect(columns('t_entries')).toEqual(['seq', 'line', 'hash', 'at', 'kind', 'actor', 'role', 'via', 'id', 'hop'])
    expect(columns('t_refs')).toEqual(['key', 'value', 'seq'])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all().map(v => v.name)).toEqual(['entries', 'head', 'subjects'])
    expect(columns('entries')).toEqual(['seq', 'at', 'kind', 'actor', 'role', 'via', 'id', 'hop', 'refs', 'data', 'v', 'hash'])
    expect(columns('subjects')).toEqual(['key', 'value', 'seq', 'at', 'kind', 'actor', 'role', 'via', 'id', 'hop', 'refs', 'data', 'v', 'hash'])
    expect(columns('head')).toEqual(['seq', 'hash', 'at'])
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete')
    db.close()
  })
})

describe('the journal', () => {
  const mode = () => {
    const db = new DatabaseSync(file, { readOnly: true })
    const { journal_mode: journal } = db.prepare('PRAGMA journal_mode').get()
    db.close()
    return journal
  }

  it('is WAL while the writer holds the file, and rollback once it lets go, with no sidecars left', () => {
    const cairn = filled(2)
    expect(mode()).toBe('wal')
    cairn.close()
    expect(mode()).toBe('delete')
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
    filled(1).close()
    expect(mode()).toBe('delete')
  })

  it('says so when a reader holds the file past the writer closing, and the next writer lets go of it', () => {
    const cairn = filled(1)
    const reader = new DatabaseSync(file, { readOnly: true })
    reader.prepare('SELECT seq FROM head').get()
    expect(refusal(() => cairn.close())).toMatchObject({ type: 'busy', message: expect.stringMatching(/stays in WAL/) })
    reader.close()
    filled(0).close()
    expect(mode()).toBe('delete')
  })
})

describe('the views', () => {
  const read = (sql, ...params) => {
    const db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare(sql).all(...params).map(row => ({ ...row }))
    db.close()
    return rows
  }

  it('answer what happened when, about what, and by whom', () => {
    const cairn = openCairn(file, { name: 'ops' })
    cairn.append({ ...entry(1), at: '2026-10-01T09:00:00.000Z', kind: 'task.open' })
    cairn.append({ ...entry(2), at: '2026-10-02T09:00:00.000Z', kind: 'task.open' })
    cairn.append({ ...entry(1), at: '2026-10-03T09:00:00.000Z', actor: { name: 'vdg', role: 'auditor', via: 'agent' }, id: 'turn-9', data: { note: 'done' } })

    expect(read('SELECT seq FROM entries WHERE at >= ? AND at < ? ORDER BY seq', '2026-10-02', '2026-10-04')).toEqual([{ seq: 2 }, { seq: 3 }])
    expect(read("SELECT seq, kind, actor FROM subjects WHERE key = 'task' AND value = '1' ORDER BY seq")).toEqual([
      { seq: 1, kind: 'task.open', actor: 'main' },
      { seq: 3, kind: 'task.claim', actor: 'vdg' }
    ])
    expect(read("SELECT count(*) AS n FROM subjects WHERE key = 'customer' AND value = 'cus_1'")).toEqual([{ n: 3 }])
    const [third] = read('SELECT * FROM entries WHERE seq = 3')
    expect(third).toMatchObject({ actor: 'vdg', role: 'auditor', via: 'agent', id: 'turn-9', hop: 0, v: 1 })
    expect(JSON.parse(third.refs)).toEqual({ task: 1, customer: 'cus_1' })
    expect(JSON.parse(third.data)).toEqual({ note: 'done' })
    expect(read('SELECT * FROM head')).toEqual([cairn.head()])
    cairn.close()
  })

  it('read an entry written under an older envelope, and leave it as written (A14)', () => {
    filled(2).close()
    const db = new DatabaseSync(file)
    const { hash: prev } = db.prepare('SELECT hash FROM t_entries WHERE seq = 2').get()
    const { hop, ...beforeHop } = entry(1, { text: 'from before hop' })
    const older = canonical({
      ...beforeHop,
      kind: 'task.note',
      refs: { task: 1 },
      v: 0,
      seq: 3,
      cairn: 'ops',
      prev
    })
    const hash = execFileSync('sha256sum', { input: older }).toString().split(' ')[0]
    db.prepare('INSERT INTO t_entries (seq, line, hash) VALUES (3, ?, ?)').run(older, hash)
    db.prepare("INSERT INTO t_refs (key, value, seq) VALUES ('task', '1', 3)").run()
    db.close()

    const cairn = openCairn(file, { name: 'ops' })
    expect(cairn.append(entry(4))).toMatchObject({ seq: 4 })
    expect(cairn.verify()).toEqual({ ok: true, checked: 4 })
    cairn.close()
    expect(read('SELECT seq, kind, v, hop FROM entries WHERE seq = 3')).toEqual([{ seq: 3, kind: 'task.note', v: 0, hop: null }])
    expect(read("SELECT seq FROM subjects WHERE key = 'task' AND value = '1' ORDER BY seq")).toEqual([{ seq: 1 }, { seq: 3 }])
    expect(read('SELECT line FROM t_entries WHERE seq = 3')).toEqual([{ line: older }])
    expect(JSON.parse(read('SELECT line FROM t_entries WHERE seq = 4')[0].line).prev).toBe(hash)
  })
})

describe('the canonical line', () => {
  it('sorts keys by code point, as jq does', () => {
    expect(canonical({ '😀': 1, '\uffff': 2, a: 3, b: { d: 1, c: 2 } })).toBe('{"a":3,"b":{"c":2,"d":1},"\uffff":2,"😀":1}')
  })

  it('refuses what jq would not print back the same', () => {
    expect(refusal(() => canonical({ n: 1.5 })).detail).toBe('$.n')
    expect(refusal(() => canonical({ n: 2 ** 53 })).detail).toBe('$.n')
    expect(refusal(() => canonical({ s: 'a\ud800b' })).detail).toBe('$.s')
    expect(refusal(() => canonical({ list: [1, undefined] })).detail).toBe('$.list[1]')
  })

  it('is what jq -cS prints, and hashes as sha256sum does (A11)', () => {
    const cairn = openCairn(file, { name: 'ops' })
    const reader = new DatabaseSync(file, { readOnly: true })
    const awkward = [
      { text: 'x\u007fy\u0001\u001f\u2028é😀"\\/\t\n' },
      { top: 2 ** 53 - 1, bottom: -(2 ** 53 - 1), zero: 0 },
      { '\uffff': 1, '😀': 2, é: 3, nested: [{ b: 1, a: [true, null, false] }] }
    ]
    for (const data of awkward) {
      const { seq, hash } = cairn.append(entry(1, data))
      const { line } = reader.prepare('SELECT line FROM t_entries WHERE seq = ?').get(seq)
      expect(execFileSync('jq', ['-jcS', '.'], { input: line }).toString()).toBe(line)
      expect(execFileSync('sh', ['-c', 'jq -jcS . | sha256sum'], { input: line }).toString().split(' ')[0]).toBe(hash)
    }
    reader.close()
    cairn.close()
  })
})

describe('a writer killed mid-append (A7)', () => {
  it('leaves every entry whole, with its refs, and the chain intact', async () => {
    const child = spawn(process.execPath, [APPEND_FOREVER, file], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    const cairn = openCairn(file, { name: 'ops' })
    const { seq } = cairn.head()
    expect(seq).toBeGreaterThanOrEqual(50)
    expect(cairn.verify()).toEqual({ ok: true, checked: seq })
    const db = new DatabaseSync(file, { readOnly: true })
    expect(db.prepare('SELECT count(*) AS n FROM t_refs').get().n).toBe(2 * seq)
    db.close()
    cairn.close()
  })
})

describe('a cairn verified from outside', () => {
  const HELD = execFileSync('sha256sum', { input: 'the report' }).toString().split(' ')[0]
  const ELSEWHERE = 'f'.repeat(64)
  const config = (subjects) => ({ ...entry(0), kind: 'cairn.config', refs: {}, data: { members: {}, kinds: {}, subjects }, actor: { name: 'cairn', role: 'cairn', via: 'program' }, id: null })
  const citing = (proof) => ({ ...entry(0), kind: 'finding', refs: { proof } })
  const stored = (text) => {
    mkdirSync(join(dir, 'evidence'), { recursive: true })
    const path = join(dir, 'evidence', HELD)
    writeFileSync(path, text, { mode: 0o444 })
    return path
  }
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'verify', ...args], { encoding: 'utf8' })

  it('reads the chain while the writer holds it, and says the head it reached', () => {
    const cairn = filled(5)
    const result = verifyCairn(file)
    expect(result).toEqual({ name: 'ops', head: cairn.head(), ok: true, checked: 5 })
    cairn.close()
  })

  it('names a broken chain as verify does', () => {
    filled(10).close()
    tampered("DROP TRIGGER t_entries_never_changed; UPDATE t_entries SET line = replace(line, '\"x\"', '\"y\"') WHERE seq = 5")
    expect(verifyCairn(file)).toMatchObject({ ok: false, checked: 4, firstBreak: { seq: 5, why: 'its line does not hash to its hash' } })
  })

  it('checks each file an entry cites under a sha256 subject of the config in force, and none other', () => {
    const cairn = openCairn(file, { name: 'ops' })
    cairn.append(config({ proof: '^[0-9a-f]{64}$' }))
    cairn.append(citing(ELSEWHERE))
    cairn.append(config({ proof: 'sha256' }))
    cairn.append(citing(HELD))
    cairn.append(citing(HELD))
    cairn.close()
    const path = stored('the report')
    expect(verifyCairn(file, { evidence: true })).toMatchObject({ ok: true, checked: 5, evidence: { files: 1 } })

    chmodSync(path, 0o644)
    appendFileSync(path, ', amended')
    expect(verifyCairn(file, { evidence: true })).toMatchObject({ ok: false, checked: 5, evidence: { files: 1, broken: { seq: 4, key: 'proof', sha256: HELD, why: 'it no longer hashes to its name' } } })
    expect(verifyCairn(file)).toMatchObject({ ok: true, checked: 5 })

    rmSync(path)
    expect(verifyCairn(file, { evidence: true }).evidence.broken).toEqual({ seq: 4, key: 'proof', sha256: HELD, why: 'it is not in the evidence store' })
  })

  it('exits 0 on a cairn that holds, 1 on one that does not, and 2 on what it cannot read', () => {
    const cairn = openCairn(file, { name: 'ops' })
    cairn.append(config({ proof: 'sha256' }))
    cairn.append(citing(HELD))
    const { hash } = cairn.head()
    cairn.close()
    stored('the report')

    const held = cli(file, '--evidence')
    expect(held.status, held.stderr).toBe(0)
    expect(held.stdout).toBe(`ops: ok, 2 entries, 1 evidence file, head seq 2 ${hash} at 2026-10-29T10:00:00.000Z\n`)
    expect(JSON.parse(cli(file, '--json').stdout)).toEqual(verifyCairn(file))

    rmSync(join(dir, 'evidence', HELD), { force: true })
    const missing = cli(file, '--evidence')
    expect(missing.status).toBe(1)
    expect(missing.stdout).toBe(`ops: evidence broken at seq 2: its proof ${HELD} — it is not in the evidence store\n`)

    expect(cli(join(dir, 'none.sqlite')).status).toBe(2)
    expect(cli().status).toBe(2)
  })
})
