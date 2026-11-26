import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CairnError, MAX_EVIDENCE, openChecked, readInstance, verifyCairn } from '../src/index.js'

const INSTANCE = {
  members: { app: 'frontend', backend: 'service' },
  kinds: {
    'page.opened': { path: 'string' },
    'job.done': { 'ms?': 'integer' }
  },
  subjects: { entry: 'seq', user: '^u_[0-9]+$', evidence: 'sha256' }
}

const AT = '2026-01-01T00:00:00.000Z'
const opened = (path = '/home', extra = {}) => ({ actor: 'app', via: 'program', id: null, hop: 0, kind: 'page.opened', at: AT, refs: { user: 'u_7' }, data: { path }, ...extra })
const done = (entry, extra = {}) => ({ actor: 'backend', via: 'program', id: 'run-1', hop: 0, kind: 'job.done', at: AT, refs: { entry }, data: {}, ...extra })

const refusal = (fn) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(CairnError)
    return err
  }
  throw new Error('expected a refusal')
}

let dir, file, instanceFile

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-checked-'))
  file = join(dir, 'cairn.sqlite')
  instanceFile = join(dir, 'user.json')
  writeFileSync(instanceFile, JSON.stringify(INSTANCE))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const open = () => openChecked(file, { name: 'user', instance: readInstance(instanceFile) })

describe('a cairn written under its instance file, with no daemon', () => {
  it('records the instance once, and again only when it changes', () => {
    open().close()
    open().close()
    writeFileSync(instanceFile, JSON.stringify({ ...INSTANCE, members: { ...INSTANCE.members, steward: 'steward' } }))
    const cairn = open()
    expect(cairn.since(0).map(e => e.kind)).toEqual(['cairn.config', 'cairn.config'])
    expect(cairn.latest('cairn.config').data.members.steward).toBe('steward')
    cairn.close()
  })

  it('stamps the member\'s role, and takes a batch in one chain', () => {
    const cairn = open()
    expect(cairn.append(opened())).toMatchObject({ seq: 2 })
    expect(cairn.appendAll([opened('/a'), done(3), done(4)]).map(w => w.seq)).toEqual([3, 4, 5])
    const [, first, , job] = cairn.since(0)
    expect(first).toMatchObject({ actor: { name: 'app', role: 'frontend', via: 'program' }, id: null, hop: 0, refs: { user: 'u_7' } })
    expect(job).toMatchObject({ actor: { name: 'backend', role: 'service', via: 'program' }, id: 'run-1', refs: { entry: 3 } })
    cairn.close()
    expect(verifyCairn(file, { evidence: true })).toMatchObject({ ok: true, checked: 5 })
  })

  it('refuses what the daemon refuses, names the entry, and writes nothing of the batch', () => {
    const cairn = open()
    const cases = [
      ['a stranger', opened('/a', { actor: 'stranger' }), 'not-a-member', 'stranger'],
      ['no actor', { ...opened(), actor: undefined }, 'not-a-member', ''],
      ['a via that is none of the three', opened('/a', { via: 'person' }), 'shape-mismatch', '$.actor.via'],
      ['a hop that is no count', opened('/a', { hop: -1 }), 'shape-mismatch', '$.hop'],
      ['an id that is no run', opened('/a', { id: 7 }), 'shape-mismatch', '$.id'],
      ['a role the writer chose', opened('/a', { role: 'owner' }), 'shape-mismatch', '$.role'],
      ['a kind not declared', opened('/a', { kind: 'page.closed' }), 'unknown-kind', 'page.closed'],
      ['a kind of the daemon\'s', opened('/a', { kind: 'cairn.config' }), 'unknown-kind', 'cairn.config'],
      ['a subscription where nobody is woken', opened('/a', { kind: 'cairn.subscribe', data: { kinds: ['job.done'] } }), 'unknown-kind', 'cairn.subscribe'],
      ['a field missing', opened('/a', { data: {} }), 'shape-mismatch', '$.data.path'],
      ['a subject not declared', opened('/a', { refs: { order: 'o1' } }), 'bad-ref', '$.refs.order'],
      ['a value off its pattern', opened('/a', { refs: { user: '7' } }), 'bad-ref', '$.refs.user'],
      ['evidence the cairn does not hold', opened('/a', { refs: { evidence: 'b'.repeat(64) } }), 'bad-ref', '$.refs.evidence'],
      ['a time in the future', opened('/a', { at: '2999-01-01T00:00:00.000Z' }), 'bad-time', '$.at'],
      ['a line past 4 KB', opened('x'.repeat(5000)), 'too-large', expect.any(String)]
    ]
    for (const [label, bad, type, detail] of cases) {
      const err = refusal(() => cairn.appendAll([opened('/first'), opened('/second'), bad, opened('/last')]))
      expect(err, label).toMatchObject({ type, detail, index: 2 })
    }
    expect(refusal(() => cairn.appendAll(opened()))).toMatchObject({ type: 'shape-mismatch', detail: '$' })
    expect(refusal(() => cairn.appendAll([opened()], { expectedHead: '1' }))).toMatchObject({ type: 'shape-mismatch', detail: '$.expectedHead' })
    expect(refusal(() => cairn.appendAll([opened()], { expectedHead: 4 }))).toMatchObject({ type: 'stale-head', detail: '1' })
    expect(cairn.head().seq).toBe(1)
    cairn.close()
  })

  it('lets an entry cite one before it in the same batch, and none after', () => {
    const cairn = open()
    expect(refusal(() => cairn.appendAll([opened(), done(3), opened()]))).toMatchObject({ type: 'bad-ref', detail: '$.refs.entry', index: 1 })
    expect(refusal(() => cairn.appendAll([opened(), done(4), opened()]))).toMatchObject({ type: 'bad-ref', index: 1 })
    expect(cairn.appendAll([opened(), done(2), done(1)]).map(w => w.seq)).toEqual([2, 3, 4])
    cairn.close()
  })

  it('keeps evidence by its hash for an entry to cite', () => {
    const cairn = open()
    const bytes = Buffer.from('a page, fetched')
    const sha256 = execFileSync('sha256sum', { input: bytes }).toString().split(' ')[0]
    expect(refusal(() => cairn.store('stranger', bytes)).type).toBe('not-a-member')
    expect(refusal(() => cairn.store('app', Buffer.alloc(MAX_EVIDENCE + 1))).type).toBe('too-large')
    expect(cairn.store('app', bytes)).toEqual({ sha256, bytes: bytes.length })
    expect(cairn.store('backend', bytes)).toEqual({ sha256, bytes: bytes.length })
    const kept = join(dir, 'evidence', sha256)
    expect(readFileSync(kept)).toEqual(bytes)
    expect(statSync(kept).mode & 0o777).toBe(0o444)
    expect(cairn.append(opened('/a', { refs: { evidence: sha256 } }))).toMatchObject({ seq: 2 })
    cairn.close()
    expect(verifyCairn(file, { evidence: true })).toMatchObject({ ok: true, evidence: { files: 1 } })
  })
})
