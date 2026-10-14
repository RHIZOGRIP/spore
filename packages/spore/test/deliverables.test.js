import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mimeOf } from '../src/core/call-record.js'
import { DELIVERABLES_CAP, OUT_DIR, deliverablesIn } from '../src/core/deliverables.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.deliverables-workspace')

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

describe('what a turn hands back', () => {
  it('finds a file no call record mentions, which is the case it exists for', () => {
    // `wsexec node render.js` records the streams it redirected and nothing about the
    // report the program wrote. The filesystem is the only place that knows.
    write(`${OUT_DIR}/report.pdf`, '%PDF-1.4')
    const { deliverables } = deliverablesIn(WS, since())
    expect(deliverables.map(f => f.path)).toEqual([`${OUT_DIR}/report.pdf`])
  })

  it('lists data/out and none of the working files around it', () => {
    write('data/parse.js')
    write('data/parts/p1/clean.csv')
    write('precursors/clean.cmk')
    write(`${OUT_DIR}/summary.md`)
    const { deliverables } = deliverablesIn(WS, since())
    expect(deliverables.map(f => f.path)).toEqual([`${OUT_DIR}/summary.md`])
  })

  it('leaves out what was there before the turn started', () => {
    write(`${OUT_DIR}/old.txt`)
    const { deliverables } = deliverablesIn(WS, new Date(Date.now() + 60_000).toISOString())
    expect(deliverables).toEqual([])
  })

  it('counts everything data/ holds, old or new, and nothing outside it', () => {
    write('data/old.txt', '12345')
    write('data/new/part.json', '{}')
    write('home/.cache/pip/blob', 'cached')
    write('calls/r1/0001/out', 'streamed')
    expect(deliverablesIn(WS, new Date(Date.now() + 60_000).toISOString()).dataBytes).toBe(7)
  })

  it('leaves out what the turn wrote and then deleted', () => {
    write(`${OUT_DIR}/draft.md`)
    rmSync(resolve(WS, `${OUT_DIR}/draft.md`))
    write(`${OUT_DIR}/final.md`)
    const { deliverables } = deliverablesIn(WS, since())
    expect(deliverables.map(f => f.path)).toEqual([`${OUT_DIR}/final.md`])
  })

  it('lists at most the cap and counts the ones left out', () => {
    for (let i = 0; i < DELIVERABLES_CAP + 10; i++) write(`${OUT_DIR}/f${i}.csv`)
    const { deliverables, more } = deliverablesIn(WS, since())
    expect(deliverables).toHaveLength(DELIVERABLES_CAP)
    expect(more).toBe(10)
  })

  it('says nothing rather than throwing when there is nothing to walk', () => {
    rmSync(resolve(WS, 'data'), { recursive: true, force: true })
    expect(deliverablesIn(WS, since())).toEqual({ deliverables: [], more: 0, dataBytes: 0 })
  })
})

describe('what a file is', () => {
  it('reads the bytes when the name does not say', () => {
    write(`${OUT_DIR}/chart`, PNG)
    expect(deliverablesIn(WS, since()).deliverables[0].mime).toBe('image/png')
  })

  it('trusts the extension for the formats a workspace mostly holds', () => {
    write(`${OUT_DIR}/notes.md`, '# hi')
    expect(deliverablesIn(WS, since()).deliverables[0].mime).toBe('text/markdown')
  })

  it('admits it does not know rather than guessing', () => {
    write(`${OUT_DIR}/blob`, Buffer.alloc(40))
    expect(deliverablesIn(WS, since()).deliverables[0].mime).toBe('application/octet-stream')
  })

  it('does not throw on a path that is gone', () => {
    expect(mimeOf(resolve(WS, 'data/never-existed'))).toBe('application/octet-stream')
  })
})
