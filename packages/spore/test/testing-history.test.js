import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { definitionWith, writeTranscriptEntries, writeTurnRecords } from '../src/testing.js'
import { readEvents, readTranscript, readTurns } from '../src/core/spore-dir.js'
import { openWorkspace } from '../src/core/workspace.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ws = resolve(__dirname, '.testing-history-workspace')

const said = [['What is the notice period?', 'Ninety days.'], ['And for the landlord?', 'Six months.']]

const writeHistory = () => {
  const turns = said.map((_, i) => ({ turnId: `t${i}`, startedAt: `2026-10-0${i + 1}T10:00:00.000Z`, endedAt: `2026-10-0${i + 1}T10:01:00.000Z`, stopReason: 'answer', concluded: true }))
  writeTurnRecords(ws, turns)
  writeTranscriptEntries(ws, said.flatMap(([prompt, answer], i) => [
    { turnId: `t${i}`, at: turns[i].startedAt, kind: 'message', role: 'user', message: { role: 'user', content: prompt } },
    { turnId: `t${i}`, at: turns[i].endedAt, kind: 'message', role: 'assistant', message: { role: 'assistant', content: answer } }
  ]))
}

describe('a history written before a spore first runs', () => {
  beforeEach(() => { rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true }) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('is the earlier turns the spore reads, and announces none', () => {
    writeHistory()
    expect(readTurns(ws).map(t => [t.turnNo, t.stopReason])).toEqual([[1, 'answer'], [2, 'answer']])
    expect(readTranscript(ws).map(m => [m.role, m.content])).toEqual(said.flatMap(([p, a]) => [['user', p], ['assistant', a]]))
    expect(readEvents(ws, { after: 0 })).toEqual([])
  })

  it('survives the definition arriving after it', () => {
    writeHistory()
    writeFileSync(resolve(ws, 'spore.cmk'), definitionWith('fixture/model'))
    openWorkspace(ws)
    expect(readTranscript(ws)).toHaveLength(4)
  })
})
