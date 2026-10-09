import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callRuns, writeCall } from '../src/core/call-record.js'
import { cloneCapability } from '../src/core/clone.js'
import { appendEvents, appendInbox, readEvents, readInbox, readTranscriptEntries, readTurns, writeTranscriptEntries, writeTurnRecords } from '../src/core/spore-dir.js'
import { describePrecursors } from '../src/delegation/precursor-catalog.js'
import { define } from '../src/library/verbs.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '.clone-workspace')
const CONFIG = resolve(ROOT, 'config.json')

const put = (ws, rel, body = 'x') => {
  mkdirSync(dirname(resolve(ws, rel)), { recursive: true })
  writeFileSync(resolve(ws, rel), body)
}

const PRECURSOR = `---
name: triage
tools: [read, exec]
enzymes: [chart=data/lib/chart.js]
rounds: [4, 6]
cost: [0.10, 0.20]
wall: [2m, 3m]
on-wrap: keep
---

:::enzyme chart
Draws a chart from a CSV.
:::

You triage what you are given.
`

/** A spore that has done some work and learned something along the way. */
const experienced = (ws) => {
  put(ws, 'precursors/triage.cmk', PRECURSOR)
  put(ws, 'data/lib/chart.js', 'console.log(1)')
  put(ws, 'data/bin/ungranted.js', 'module.exports = 1')
  put(ws, 'data/memory/person.md', 'they prefer tables')
  put(ws, 'data/out/report.md', '# the answer')
  put(ws, 'data/scratch.json', '{}')
  writeTranscriptEntries(ws, [{ at: '2026-09-25T00:00:00.000Z', kind: 'message', role: 'user', message: { role: 'user', content: 'hi' } }])
  writeTurnRecords(ws, [{ startedAt: '2026-09-25T00:00:00.000Z', stopReason: 'answer' }])
  appendInbox(ws, 'hi')
  writeCall(ws, 'r1', '0001', { tool: 'exec', startedAt: '2026-09-25T00:00:00.000Z' })
  appendEvents(ws, [{ v: 1, at: '2026-09-25T00:00:00.000Z', runId: 'r1', event: 'round' }])
  return ws
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify({ home: resolve(ROOT, 'home'), workspaces: [] }))
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('what a clone carries', () => {
  let from, to

  beforeEach(() => {
    from = experienced(outsideWorkspace('clone-from'))
    to = resolve(ROOT, 'to')
    mkdirSync(to, { recursive: true })
  })

  afterEach(() => rmSync(from, { recursive: true, force: true }))

  it('carries the precursors it authored', () => {
    const carried = cloneCapability(from, to)
    expect(carried.precursors).toContain('triage.cmk')
    expect(readFileSync(resolve(to, 'precursors/triage.cmk'), 'utf8')).toBe(PRECURSOR)
  })

  it('carries the programs those precursors grant, wherever they sit', () => {
    // `enzymes` is a path into the workspace, so precursors alone clone into a spore whose
    // first spawn is refused for an enzyme that does not exist.
    const carried = cloneCapability(from, to)
    expect(carried.programs).toContain('data/lib/chart.js')
    expect(existsSync(resolve(to, 'data/lib/chart.js'))).toBe(true)
  })

  // A precursor is the only unit that transfers. A program nothing grants is working
  // space, and carrying it would move scratch into a fresh spore under the name of an enzyme.
  it('leaves behind a program no precursor declares', () => {
    const carried = cloneCapability(from, to)
    expect(carried.programs).not.toContain('data/bin/ungranted.js')
    expect(existsSync(resolve(to, 'data/bin/ungranted.js'))).toBe(false)
  })

  it('carries what an enzyme says it needs beside itself', () => {
    put(from, 'data/lib/palette.js', 'module.exports = []')
    put(from, 'data/lib/templates/bar.svg', '<svg/>')
    put(from, 'precursors/triage.cmk', PRECURSOR.replace('on-wrap: keep', 'on-wrap: keep\nchart.with: [data/lib/palette.js, data/lib/templates/]'))

    const carried = cloneCapability(from, to)

    expect(carried.programs).toEqual(['data/lib/chart.js', 'data/lib/palette.js', 'data/lib/templates'])
    expect(readFileSync(resolve(to, 'data/lib/templates/bar.svg'), 'utf8')).toBe('<svg/>')
  })

  it('refuses a clone missing what an enzyme says it needs, rather than one that fails later', () => {
    put(from, 'precursors/triage.cmk', PRECURSOR.replace('on-wrap: keep', 'on-wrap: keep\nchart.with: [data/lib/helper.js]'))

    expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/grants chart, and data\/lib\/helper.js is not there/) }))
  })

  describe('an enzyme that reaches what it needs through a link', () => {
    const charts = (withLine) => put(from, 'precursors/triage.cmk', PRECURSOR
      .replace('chart=data/lib/chart.js', 'chart=data/lib/chart.mjs')
      .replace('on-wrap: keep', `on-wrap: keep\n${withLine}`))

    beforeEach(() => {
      put(from, 'data/lib/chart.mjs', "import { answer } from './helper.mjs'\nconsole.log(answer)\n")
      put(from, 'data/shared/helper.mjs', 'export const answer = 42\n')
    })

    const runs = (ws) => execFileSync(process.execPath, [resolve(ws, 'data/lib/chart.mjs')], { encoding: 'utf8' }).trim()

    it('carries the link as a link, with what it points at, and the clone runs without the source', () => {
      symlinkSync('../shared/helper.mjs', resolve(from, 'data/lib/helper.mjs'))
      charts('chart.with: [data/lib/helper.mjs]')
      expect(runs(from)).toBe('42')

      const carried = cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(carried.programs).toEqual(['data/lib/chart.mjs', 'data/lib/helper.mjs', 'data/shared/helper.mjs'])
      expect(readlinkSync(resolve(to, 'data/lib/helper.mjs'))).toBe('../shared/helper.mjs')
      expect(runs(to)).toBe('42')
    })

    // A module's imports resolve from where it really is: carried as its target's bytes at
    // the link's place, the helper would look for base.mjs beside the link.
    it('keeps what a linked module imports resolving from where the module really is', () => {
      put(from, 'data/shared/helper.mjs', "export { answer } from './base.mjs'\n")
      put(from, 'data/shared/base.mjs', 'export const answer = 42\n')
      symlinkSync('../shared/helper.mjs', resolve(from, 'data/lib/helper.mjs'))
      charts('chart.with: [data/lib/helper.mjs, data/shared/base.mjs]')
      expect(runs(from)).toBe('42')

      cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(runs(to)).toBe('42')
    })

    it('makes a link that named its target absolutely relative, so the clone never reaches back', () => {
      symlinkSync(resolve(from, 'data/shared/helper.mjs'), resolve(from, 'data/lib/helper.mjs'))
      charts('chart.with: [data/lib/helper.mjs]')

      cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(readlinkSync(resolve(to, 'data/lib/helper.mjs'))).toBe('../shared/helper.mjs')
      expect(runs(to)).toBe('42')
    })

    it('carries what a link inside a declared directory points at, and the directory a link names', () => {
      mkdirSync(resolve(from, 'data/lib/vendor'), { recursive: true })
      symlinkSync('../../shared/helper.mjs', resolve(from, 'data/lib/vendor/helper.mjs'))
      put(from, 'data/assets/logo.svg', '<svg/>')
      symlinkSync('../assets', resolve(from, 'data/lib/assets'))
      charts('chart.with: [data/lib/vendor/, data/lib/assets]')

      const carried = cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(carried.programs).toEqual(expect.arrayContaining(['data/shared/helper.mjs', 'data/assets']))
      expect(readlinkSync(resolve(to, 'data/lib/vendor/helper.mjs'))).toBe('../../shared/helper.mjs')
      expect(readFileSync(resolve(to, 'data/lib/vendor/helper.mjs'), 'utf8')).toBe('export const answer = 42\n')
      expect(readlinkSync(resolve(to, 'data/lib/assets'))).toBe('../assets')
      expect(readFileSync(resolve(to, 'data/lib/assets/logo.svg'), 'utf8')).toBe('<svg/>')
    })

    it('refuses a link to the whole workspace', () => {
      symlinkSync('../..', resolve(from, 'data/lib/everything'))
      charts('chart.with: [data/lib/everything]')
      expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/links to the whole workspace/) }))
    })

    it('refuses a declared link that leads out of the workspace', () => {
      const away = resolve(from, '..', `elsewhere-${process.pid}.mjs`)
      writeFileSync(away, 'export const answer = 1\n')
      try {
        symlinkSync(away, resolve(from, 'data/lib/helper.mjs'))
        charts('chart.with: [data/lib/helper.mjs]')
        expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/leads out of the workspace/) }))
      } finally {
        rmSync(away, { force: true })
      }
    })

    it('refuses a link inside a declared directory that leads out of it', () => {
      const away = resolve(from, '..', `elsewhere-${process.pid}.mjs`)
      writeFileSync(away, 'export const answer = 1\n')
      try {
        mkdirSync(resolve(from, 'data/lib/vendor'), { recursive: true })
        symlinkSync(away, resolve(from, 'data/lib/vendor/helper.mjs'))
        charts('chart.with: [data/lib/vendor/]')
        expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/links out of the workspace/) }))
      } finally {
        rmSync(away, { force: true })
      }
    })

    it('refuses a declared path outside the workspace rather than leaving it behind', () => {
      charts('chart.with: [../somewhere/helper.mjs]')
      expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/outside the workspace/) }))
    })
  })

  describe('a precursor that is a link', () => {
    const readable = (ws) => describePrecursors(ws).map(({ name, error }) => ({ name, error }))

    it('stays a link to its local target, and the clone discovers it without the source', () => {
      symlinkSync('triage.cmk', resolve(from, 'precursors/alias.cmk'))

      const carried = cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(carried.precursors).toEqual(['alias.cmk', 'triage.cmk'])
      expect(readlinkSync(resolve(to, 'precursors/alias.cmk'))).toBe('triage.cmk')
      expect(readable(to)).toEqual([{ name: 'alias', error: undefined }, { name: 'triage', error: undefined }])
    })

    it('carries a definition it points at elsewhere in the workspace, relatively', () => {
      put(from, 'data/defs/shared.cmk', PRECURSOR)
      symlinkSync(resolve(from, 'data/defs/shared.cmk'), resolve(from, 'precursors/shared.cmk'))

      cloneCapability(from, to)
      rmSync(from, { recursive: true, force: true })

      expect(readlinkSync(resolve(to, 'precursors/shared.cmk'))).toBe('../data/defs/shared.cmk')
      expect(readable(to)).toContainEqual({ name: 'shared', error: undefined })
    })

    it('refuses one that leads out of the workspace', () => {
      const away = resolve(from, '..', `elsewhere-${process.pid}.cmk`)
      writeFileSync(away, PRECURSOR)
      try {
        symlinkSync(away, resolve(from, 'precursors/away.cmk'))
        expect(() => cloneCapability(from, to)).toThrow(expect.objectContaining({ type: 'CLONE_INCOMPLETE', message: expect.stringMatching(/links out of the workspace/) }))
      } finally {
        rmSync(away, { force: true })
      }
    })
  })

  it('carries one that is granted, wherever the author put it', () => {
    put(from, 'data/bin/plot.js', 'console.log(2)')
    put(from, 'precursors/draw.cmk', PRECURSOR.replace('name: triage', 'name: draw').replace('chart=data/lib/chart.js', 'plot=data/bin/plot.js').replace(':::enzyme chart', ':::enzyme plot'))
    const carried = cloneCapability(from, to)
    expect(carried.programs).toContain('data/bin/plot.js')
  })

  it('leaves the conversation behind', () => {
    cloneCapability(from, to)
    expect(readTranscriptEntries(to), 'transcript').toEqual([])
    expect(readTurns(to), 'turns').toEqual([])
    expect(readInbox(to), 'inbox').toEqual([])
    expect(readEvents(to), 'events').toEqual([])
    expect(callRuns(to), 'calls').toEqual([])
  })

  it('leaves what it remembered behind, which is the point', () => {
    cloneCapability(from, to)
    expect(existsSync(resolve(to, 'data/memory/person.md'))).toBe(false)
  })

  it('leaves the working space and the deliverable behind', () => {
    cloneCapability(from, to)
    expect(existsSync(resolve(to, 'data/scratch.json'))).toBe(false)
    expect(existsSync(resolve(to, 'data/out/report.md'))).toBe(false)
  })

  it('carries a precursor that no longer parses, and none of its grants', () => {
    put(from, 'precursors/broken.cmk', '---\nname: broken\nnonsense\n')
    const carried = cloneCapability(from, to)
    expect(carried.precursors).toContain('broken.cmk')
    expect(existsSync(resolve(to, 'precursors/broken.cmk'))).toBe(true)
  })

  it('says nothing rather than throwing when there is nothing to carry', () => {
    const bare = outsideWorkspace('clone-bare')
    try {
      rmSync(resolve(bare, 'precursors'), { recursive: true, force: true })
      expect(cloneCapability(bare, to)).toEqual({ precursors: [], programs: [] })
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('define --from', () => {
  let from, into

  beforeEach(() => {
    from = experienced(outsideWorkspace('define-from'))
    // The target has to be outside the sandbox's granted paths too: `openWorkspace`
    // refuses one there, and `test/` is granted.
    into = outsideRoot('define-into')
  })

  afterEach(() => {
    rmSync(from, { recursive: true, force: true })
    rmSync(into, { recursive: true, force: true })
  })

  const successor = (name = 'successor') => resolve(into, name)

  it('cuts a spore from another and reports what came', () => {
    const made = define({ ws: successor(), from, configFile: CONFIG })
    expect(made.cloned.from).toBe(from)
    expect(made.cloned.precursors).toContain('triage.cmk')
    expect(existsSync(resolve(made.ws, 'spore.cmk'))).toBe(true)
    expect(readTranscriptEntries(made.ws)).toEqual([])
    expect(existsSync(resolve(made.ws, 'data/memory/person.md'))).toBe(false)
  })

  it('gives it the source definition, not the default', () => {
    writeFileSync(resolve(from, 'spore.cmk'), readFileSync(resolve(from, 'spore.cmk'), 'utf8').replace('retain: 10', 'retain: 3'))
    const made = define({ ws: successor(), from, configFile: CONFIG })
    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('retain: 3')
  })

  it('carries an authored precursor as it was written', () => {
    put(from, 'precursors/summarize.cmk', PRECURSOR.replace('name: triage', 'name: summarize'))
    const made = define({ ws: successor(), from, configFile: CONFIG })
    expect(readFileSync(resolve(made.ws, 'precursors/summarize.cmk'), 'utf8')).toContain('You triage what you are given.')
  })

  it('still seeds the precursor format beside what it carried', () => {
    const made = define({ ws: successor(), from, configFile: CONFIG })
    expect(existsSync(resolve(made.ws, 'precursors/README.md'))).toBe(true)
  })

  it('refuses a source that is not a spore', () => {
    expect(() => define({ ws: successor(), from: resolve(into, 'nowhere'), configFile: CONFIG }))
      .toThrow(/no spore at/)
  })

  it('refuses two ways of saying what a spore is', () => {
    expect(() => define({ ws: successor(), from, definition: resolve(from, 'spore.cmk'), configFile: CONFIG }))
      .toThrow(/one place/)
  })

  it('makes an ordinary spore otherwise, with nothing cloned reported', () => {
    const made = define({ ws: successor('plain'), definition: resolve(from, 'spore.cmk'), configFile: CONFIG })
    expect(made.cloned).toBeNull()
  })
})
