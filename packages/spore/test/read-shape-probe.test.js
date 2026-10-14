import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CORPUS, buildItems, choiceOf, grade, linesOf, readMessage, shapes, signTest, stageCorpus } from '../probes/read-shape/items.js'

const WS = resolve(dirname(fileURLToPath(import.meta.url)), '.read-shape-workspace')
const items = buildItems()
const original = (item) => readFileSync(join(CORPUS, item.file), 'utf8')
const lineOf = (item) => linesOf(original(item)).lines[item.n - 1]

const right = (item) => {
  if (item.task === 'locate') return { output: `${item.truth}` }
  if (item.task === 'quote') return { output: `<line>${item.truth}</line>` }
  if (item.task === 'continue') return { output: item.truth }
  const line = lineOf(item)
  const path = item.read.path
  if (item.task === 'delete') return { toolCalls: [{ name: 'edit', arguments: { path, old: `${line}\n`, new: '' } }] }
  return { toolCalls: [{ name: 'edit', arguments: { path, old: `${line}\n`, new: `${line}\n${item.truth.added}${item.truth.crlf ? '\r' : ''}\n` } }] }
}

beforeAll(() => stageCorpus(WS))
afterAll(() => rmSync(WS, { recursive: true, force: true }))

describe('the read-shape probe', () => {
  it('draws every task from every corpus file, the same items for the same seed', () => {
    expect(items).toHaveLength(150)
    expect(buildItems().map(item => item.id)).toEqual(items.map(item => item.id))
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
  })

  it('shows every arm the same text and the same facts', async () => {
    for (const item of items.filter(each => each.task === 'locate' || each.task === 'continue')) {
      const { record, plain, numbered, 'numbered-record': numberedText } = shapes((await readMessage(WS, item.read)).content, (await readMessage(WS, { ...item.read, numbered: true })).content)
      const { content, ...facts } = JSON.parse(record)
      const [header, ...rest] = plain.split('\n')
      expect(JSON.parse(header)).toEqual(facts)
      expect(rest.join('\n')).toBe(content)
      const first = numbered.split('\n')[1]
      expect(first).toMatch(new RegExp(`^ *${item.read.offset ?? 1}\\t`))
      expect(numbered.split('\n').slice(1).map(line => line.replace(/^ *\d+\t/, '')).join('\n')).toBe(linesOf(content).lines.join('\n'))
      const numberedRecord = JSON.parse(numberedText)
      expect(numberedRecord.numbered).toBe(true)
      expect(numberedRecord.content.replace(/^\d+→/gm, '')).toBe(content)
    }
  })

  it('takes the right answer to every item', () => {
    for (const item of items) expect([item.id, grade(item, right(item), original(item))]).toEqual([item.id, { ok: true }])
  })

  it('says what kind of wrong an answer is', () => {
    const locate = items.find(item => item.task === 'locate')
    expect(grade(locate, { output: `line ${locate.truth + 1}` }, original(locate))).toEqual({ ok: false, why: 'off by 1' })
    const quote = items.find(item => item.task === 'quote')
    expect(grade(quote, { output: `<line>${quote.truth} </line>` }, original(quote)).why).toMatch(/whitespace/)
    const deletion = items.find(item => item.task === 'delete')
    const numbered = { toolCalls: [{ name: 'edit', arguments: { path: deletion.read.path, old: `${String(deletion.n).padStart(6)}\t${lineOf(deletion)}\n`, new: '' } }] }
    expect(grade(deletion, numbered, original(deletion))).toEqual({ ok: false, why: 'old not found' })
    expect(grade(deletion, { output: 'done' }, original(deletion))).toEqual({ ok: false, why: 'no edit' })
    const crlf = items.find(item => item.task === 'insert' && item.truth.crlf)
    const line = lineOf(crlf)
    const bare = { toolCalls: [{ name: 'edit', arguments: { path: crlf.read.path, old: `${line}\n`, new: `${line}\n${crlf.truth.added}\n` } }] }
    expect(grade(crlf, bare, original(crlf))).toEqual({ ok: false, why: 'line ending' })
  })

  it('reads whether the model asked for numbers', () => {
    expect(choiceOf({ toolCalls: [{ name: 'read', arguments: { path: 'data/x', numbered: true } }] })).toBe(true)
    expect(choiceOf({ toolCalls: [{ name: 'read', arguments: { path: 'data/x' } }] })).toBe(false)
    expect(choiceOf({ output: 'no idea' })).toBe(null)
  })

  it('weighs a split between two arms', () => {
    expect(signTest(0, 0)).toBe(1)
    expect(signTest(5, 5)).toBe(1)
    expect(signTest(10, 0)).toBeCloseTo(2 / 1024)
  })
})
