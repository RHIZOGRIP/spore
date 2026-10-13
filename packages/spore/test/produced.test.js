import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mimeOf } from '../src/core/call-record.js'
import { DELIVER_DIR, PRODUCED_CAP, producedIn } from '../src/core/produced.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.produced-workspace')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900)])
const write = (rel, data = 'x') => {
  mkdirSync(dirname(resolve(WS, rel)), { recursive: true })
  writeFileSync(resolve(WS, rel), data)
}

// Before every file this test writes, so everything counts as this turn's.
const since = () => new Date(Date.now() - 5000).toISOString()

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('what a turn left behind', () => {
  it('finds a file no call record mentions, which is the case it exists for', () => {
    // `wsexec node render.js` records the streams it redirected and nothing about the
    // report the program wrote. The filesystem is the only place that knows.
    write('data/report.pdf', '%PDF-1.4')
    const { produced } = producedIn(WS, since())
    expect(produced.map(f => f.path)).toEqual(['data/report.pdf'])
  })

  it('leaves out what was there before the turn started', () => {
    write('data/old.txt')
    const { produced } = producedIn(WS, new Date(Date.now() + 60_000).toISOString())
    expect(produced).toEqual([])
  })

  it('counts everything data/ holds, old or new, and nothing outside it', () => {
    write('data/old.txt', '12345')
    write('data/new/part.json', '{}')
    write('home/.cache/pip/blob', 'cached')
    write('calls/r1/0001/out', 'streamed')
    expect(producedIn(WS, new Date(Date.now() + 60_000).toISOString()).dataBytes).toBe(7)
  })

  it('leaves out what the turn wrote and then deleted', () => {
    write('data/scratch.tmp')
    rmSync(resolve(WS, 'data/scratch.tmp'))
    write('data/kept.txt')
    const { produced } = producedIn(WS, since())
    expect(produced.map(f => f.path)).toEqual(['data/kept.txt'])
  })

  it('never lists the trail, which is the runtime\'s record and not the turn\'s work', () => {
    write('calls/r1/0001/out', 'streamed')
    write('data/real.txt')
    const { produced } = producedIn(WS, since())
    expect(produced.map(f => f.path)).toEqual(['data/real.txt'])
  })

  it('puts what the agent delivered ahead of what it merely used', () => {
    write('data/parse.js')
    write('data/clean.csv')
    write(`${DELIVER_DIR}/summary.md`)
    const { produced } = producedIn(WS, since())
    expect(produced[0].path).toBe(`${DELIVER_DIR}/summary.md`)
    expect(produced[0].delivered).toBe(true)
    expect(produced.filter(f => f.delivered)).toHaveLength(1)
  })

  it('caps the list and counts the rest, so a fan-out cannot make an unreadable record', () => {
    for (let i = 0; i < PRODUCED_CAP + 13; i++) write(`data/parts/p${i}.json`, '{}')
    const { produced, more } = producedIn(WS, since())
    expect(produced).toHaveLength(PRODUCED_CAP)
    expect(more).toBe(13)
  })

  it('keeps the deliverable when the cap bites', () => {
    for (let i = 0; i < PRODUCED_CAP + 20; i++) write(`data/parts/p${i}.json`, '{}')
    write(`${DELIVER_DIR}/answer.md`)
    const { produced } = producedIn(WS, since())
    expect(produced[0].path).toBe(`${DELIVER_DIR}/answer.md`)
  })

  it('says nothing rather than throwing when there is nothing to walk', () => {
    rmSync(resolve(WS, 'data'), { recursive: true, force: true })
    expect(producedIn(WS, since())).toEqual({ produced: [], more: 0, dataBytes: 0 })
  })
})

describe('what a file is', () => {
  it('reads the bytes when the name does not say', () => {
    write('data/chart', PNG)
    expect(producedIn(WS, since()).produced[0].mime).toBe('image/png')
  })

  it('trusts the extension for the formats a workspace mostly holds', () => {
    write('data/notes.md', '# hi')
    expect(producedIn(WS, since()).produced[0].mime).toBe('text/markdown')
  })

  it('admits it does not know rather than guessing', () => {
    write('data/blob', Buffer.alloc(40))
    expect(producedIn(WS, since()).produced[0].mime).toBe('application/octet-stream')
  })

  it('does not throw on a path that is gone', () => {
    expect(mimeOf(resolve(WS, 'data/never-existed'))).toBe('application/octet-stream')
  })
})
