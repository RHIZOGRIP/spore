import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mimeOf } from '../src/core/call-record.js'
import { DELIVERABLES_CAP, OUT_DIR, WEIGH_EVERY_MS, dataBytesIn, deliverablesIn } from '../src/core/deliverables.js'
import { writeTurnRecords } from '../src/core/spore-dir.js'

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
    expect(deliverablesIn(WS, since())).toEqual({ deliverables: [], more: 0 })
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

  it('names the Office formats a person is handed, whatever case the name is in', () => {
    const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)])
    write(`${OUT_DIR}/report.docx`, zip)
    write(`${OUT_DIR}/figures.xlsx`, zip)
    write(`${OUT_DIR}/Deck.PPTX`, zip)
    const mimes = Object.fromEntries(deliverablesIn(WS, since()).deliverables.map(d => [d.path.split('/').at(-1), d.mime]))
    expect(mimes).toEqual({
      'report.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'figures.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Deck.PPTX': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
  })

  it('names source files as source, where the registry has them as something else or not at all', () => {
    for (const [name, mime] of [['main.ts', 'text/x-typescript'], ['lib.rs', 'text/x-rust'], ['run.py', 'text/x-python'], ['parse.ml', 'text/x-ocaml'], ['notes.yaml', 'text/yaml']]) {
      write(`data/${name}`, 'x')
      expect(mimeOf(resolve(WS, 'data', name))).toBe(mime)
    }
  })

  it('names a picture by its bytes, whatever it was saved as', () => {
    write('data/chart.jpg', PNG)
    expect(mimeOf(resolve(WS, 'data/chart.jpg'))).toBe('image/png')
  })

  it('does not throw on a path that is gone', () => {
    expect(mimeOf(resolve(WS, 'data/never-existed'))).toBe('application/octet-stream')
  })
})

describe('what data/ weighs', () => {
  const NOW = Date.parse('2026-10-25T12:00:00.000Z')
  const weighed = (endedAt, dataBytes) => writeTurnRecords(WS, [{ startedAt: endedAt, endedAt, stopReason: 'answer', concluded: true, dataBytes }])

  beforeEach(() => {
    write('data/old.txt', '12345')
    write('data/out/part.json', '{}')
    write('home/.cache/pip/blob', 'cached')
    write('calls/r1/0001/out', 'streamed')
  })

  it('is everything under data/, and nothing outside it, for a spore that dreams', () => {
    expect(dataBytesIn(WS, { dreams: true, now: NOW })).toBe(7)
  })

  it('is not weighed for a spore that does not dream', () => {
    expect(dataBytesIn(WS, { dreams: false, now: NOW })).toBe(null)
  })

  it('is weighed again only once the last turn that weighed it ended an hour ago', () => {
    weighed(new Date(NOW - WEIGH_EVERY_MS + 1000).toISOString(), 3)
    expect(dataBytesIn(WS, { dreams: true, now: NOW })).toBe(null)
    expect(dataBytesIn(WS, { dreams: true, now: NOW + 1000 })).toBe(7)
  })
})
