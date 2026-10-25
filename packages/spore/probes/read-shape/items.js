/**
 * The read-shape probe's items, the shapes a read result is shown in, and the grader.
 *
 * An item is one question about one corpus file, asked after one `read` of it. The read is
 * run by the runtime's own tool and kernel, so the `record` shape is exactly what an agent is
 * shown today; every other shape is built from that same record, so they carry the same facts
 * and only the form differs. `numbered-record` is the runtime's own read with `numbered` set; in
 * `choose`, the model makes the read and the item is answered in the shape it asked for.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCallTrail } from '../../src/core/call-record.js'
import { hostState } from '../../src/core/spore-dir.js'
import { executeTools } from '../../src/core/tool-kernel.js'
import { silent } from '../../src/observability/logger.js'
import { maxResultSizeForContext } from '../../src/resilience/transcript.js'
import { makeTools } from '../../src/tools/make-tools.js'

export const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), 'corpus')
export const TASKS = ['locate', 'quote', 'delete', 'insert', 'continue']
export const ARMS = ['record', 'plain', 'numbered', 'numbered-record', 'choose']
export const SHAPED = ARMS.filter(arm => arm !== 'choose')

const SYSTEM = 'You work in a workspace through tools. Base every answer on what the tools returned.'
const ADDED = { 'config.js': '// reviewed', 'rules.mk': '# reviewed', 'inbox.md': 'Reviewed.', 'parts.csv': 'A-999,Reviewed,steel,0,0,0.00,', 'settings.ini': '; reviewed', 'carnet.txt': 'Relu.' }

const mulberry32 = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const occurrences = (haystack, needle) => {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++
  return count
}

export const linesOf = (text) => {
  const lines = text.split('\n')
  const final = lines.at(-1) === ''
  if (final) lines.pop()
  return { lines, final }
}

const bare = (line) => line.replace(/\r$/, '')
const hard = (line) => /["\\\t\r\u0080-\uffff]|\s$/.test(line)

function phraseOf (line, text, random) {
  const words = bare(line).trim().split(/\s+/)
  for (let tries = 0; tries < 40; tries++) {
    const count = Math.min(words.length, 2 + Math.floor(random() * 5))
    const start = Math.floor(random() * (words.length - count + 1))
    const phrase = words.slice(start, start + count).join(' ')
    if (phrase.length >= 10 && phrase.length <= 40 && !/[“”]/.test(phrase) && line.includes(phrase) && occurrences(text, phrase) === 1) return phrase
  }
  return null
}

const pick = (candidates, count, random) => {
  const pool = [...candidates]
  const chosen = []
  while (chosen.length < count && pool.length) chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
  return chosen
}

const quoted = (phrase) => `“${phrase}”`

/**
 * Every item, the same for a given seed and corpus: `perFile` of each task for each file.
 * `locate` reads half of its items through a slice, so a line number has to be counted from
 * the slice's offset; `continue` asks about a slice that stops short of the end or reaches it.
 */
export function buildItems ({ perFile = 5, seed = 1, tasks = TASKS, corpus = CORPUS } = {}) {
  const items = []
  for (const file of readdirSync(corpus).sort()) {
    const text = readFileSync(join(corpus, file), 'utf8')
    const { lines, final } = linesOf(text)
    const random = mulberry32(seed + file.length * 7919 + text.length)
    const path = `data/${file}`
    const named = lines.map((line, i) => ({ n: i + 1, line, phrase: bare(line).trim().length >= 10 ? phraseOf(line, text, random) : null }))
      .filter(entry => entry.phrase)
    const notLast = named.filter(entry => entry.n < lines.length || final)

    for (const task of tasks) {
      const id = (i) => `${file}:${task}:${i}`
      if (task === 'locate') {
        pick(named, perFile, random).forEach((entry, i) => {
          const sliced = i % 2 === 1
          const offset = sliced ? Math.max(1, entry.n - Math.floor(random() * 30)) : undefined
          const length = sliced ? Math.min(40, lines.length - offset + 1) : undefined
          const read = sliced ? { path, offset, length } : { path }
          items.push({ id: id(i), task, file, read, n: entry.n, ask: `In ${path}, on which line is the text ${quoted(entry.phrase)}? Read it, then answer with the line number alone.`, truth: entry.n })
        })
      }
      if (task === 'quote') {
        const preferred = named.filter(entry => hard(entry.line))
        pick(preferred.length >= perFile ? preferred : named, perFile, random).forEach((entry, i) => {
          items.push({ id: id(i), task, file, n: entry.n, read: { path }, ask: `Read ${path} and quote the line that contains ${quoted(entry.phrase)} exactly as it is in the file, every character of it, between <line> and </line>, and nothing else.`, truth: bare(entry.line) })
        })
      }
      if (task === 'delete') {
        pick(notLast, perFile, random).forEach((entry, i) => {
          const kept = lines.filter((_, at) => at !== entry.n - 1)
          items.push({ id: id(i), task, file, n: entry.n, read: { path }, ask: `Read ${path}, then delete the line that contains ${quoted(entry.phrase)} with your edit tool. Leave everything else as it is.`, truth: kept.join('\n') + (final ? '\n' : '') })
        })
      }
      if (task === 'insert') {
        pick(notLast, perFile, random).forEach((entry, i) => {
          items.push({ id: id(i), task, file, n: entry.n, read: { path }, ask: `Read ${path}, then add the line ${quoted(ADDED[file])} right after the line that contains ${quoted(entry.phrase)}, with your edit tool. Leave everything else as it is.`, truth: { after: entry.n, added: ADDED[file], crlf: entry.line.endsWith('\r') } })
        })
      }
      if (task === 'continue') {
        for (let i = 0; i < perFile; i++) {
          const ends = i % 2 === 1
          const length = 10 + Math.floor(random() * 30)
          const offset = ends ? Math.max(1, lines.length - length + 1) : 1 + Math.floor(random() * Math.max(1, lines.length - length - 10))
          const shown = Math.min(length, lines.length - offset + 1)
          items.push({ id: id(i), task, file, read: { path, offset, length }, ask: `Read ${path} from line ${offset}, ${length} lines. Then tell me whether you have now seen the end of the file: answer "end" if so, or "next N", N being the line to read from next.`, truth: offset + shown > lines.length ? 'end' : `next ${offset + shown}` })
        }
      }
    }
  }
  return items
}

export async function readMessage (ws, read, { id = 'r1', contextTokens = 200_000 } = {}) {
  const trail = createCallTrail(ws, { runId: 'probe', state: hostState(ws) })
  const { fns } = makeTools(ws, maxResultSizeForContext(contextTokens), trail)
  const [message] = await executeTools({ toolCalls: [{ id, name: 'read', arguments: read }], toolFns: fns, mutators: new Set(), describe: () => ({}), emitter: { emit () {} }, logger: silent })
  return message
}

export function stageCorpus (ws, corpus = CORPUS) {
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(join(ws, 'data'), { recursive: true })
  for (const file of readdirSync(corpus)) copyFileSync(join(corpus, file), join(ws, 'data', file))
}

export function toolDefs (ws) {
  const { defs } = makeTools(ws, maxResultSizeForContext(200_000), createCallTrail(ws, { runId: 'defs', state: hostState(ws) }))
  return defs.filter(def => def.name === 'read' || def.name === 'edit')
}

/**
 * The text of a read result in each shape. `plain` and `numbered` keep every field of the
 * record but its content on one JSON line above the text, so no fact is lost or added.
 */
export function shapes (recordText, numberedText) {
  const record = JSON.parse(recordText)
  if (typeof record.content !== 'string') throw new Error(`the read was not answered with its content: ${recordText.slice(0, 200)}`)
  const { content, ...facts } = record
  const header = JSON.stringify(facts)
  const { lines } = linesOf(content)
  const first = record.unit === 'lines' ? (record.offset ?? 1) : 1
  const numbered = lines.map((line, i) => `${String(first + i).padStart(6)}\t${line}`).join('\n')
  return { record: recordText, plain: `${header}\n${content}`, numbered: `${header}\n${numbered}`, 'numbered-record': numberedText }
}

export const asking = (item) => [{ role: 'system', content: SYSTEM }, { role: 'user', content: item.ask }]

export function choiceOf (result) {
  const call = (result.toolCalls ?? []).find(each => each.name === 'read')
  return call ? call.arguments?.numbered === true : null
}

export function conversation (item, shown, { id = 'r1', numbered = false } = {}) {
  return [
    ...asking(item),
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: numbered ? { ...item.read, numbered: true } : item.read }] },
    { role: 'tool', toolCallId: id, toolName: 'read', content: shown }
  ]
}

export const toolChoiceOf = (item) => (item.task === 'delete' || item.task === 'insert' ? 'auto' : 'none')

const applyEdit = (text, call) => {
  const { old, new: replacement } = call.arguments ?? {}
  if (typeof old !== 'string' || typeof replacement !== 'string' || old === '') return { error: 'malformed' }
  const count = occurrences(text, old)
  if (count === 0) return { error: 'old not found' }
  if (count > 1) return { error: 'old repeated' }
  return { text: text.replace(old, () => replacement) }
}

export function grade (item, result, original) {
  if (item.task === 'locate') {
    const found = /-?\d+/.exec(result.output ?? '')
    if (!found) return { ok: false, why: 'no number' }
    const off = Number(found[0]) - item.truth
    return off === 0 ? { ok: true } : { ok: false, why: `off by ${off}` }
  }
  if (item.task === 'quote') {
    const found = [...(result.output ?? '').matchAll(/<line>\n?([\s\S]*?)\n?<\/line>/g)].at(-1)
    if (!found) return { ok: false, why: 'no tags' }
    const said = found[1]
    if (said === item.truth) return { ok: true }
    if (said.trimEnd() === item.truth.trimEnd()) return { ok: false, why: 'trailing whitespace' }
    if (said.trim() === item.truth.trim()) return { ok: false, why: 'leading whitespace' }
    if (said.replace(/\s+/g, ' ').trim() === item.truth.replace(/\s+/g, ' ').trim()) return { ok: false, why: 'inner whitespace' }
    return { ok: false, why: 'different text' }
  }
  if (item.task === 'continue') {
    const said = (result.output ?? '').toLowerCase()
    const next = /next\s+(\d+)/.exec(said)
    const answer = next ? `next ${next[1]}` : /\bend\b/.test(said) ? 'end' : null
    if (!answer) return { ok: false, why: 'no answer' }
    return answer === item.truth ? { ok: true } : { ok: false, why: `said ${answer}` }
  }
  const calls = (result.toolCalls ?? []).filter(call => call.name === 'edit')
  if (!calls.length) return { ok: false, why: 'no edit' }
  let text = original
  for (const call of calls) {
    if (!String(call.arguments?.path ?? '').endsWith(item.file)) return { ok: false, why: 'wrong path' }
    const applied = applyEdit(text, call)
    if (applied.error) return { ok: false, why: applied.error }
    text = applied.text
  }
  if (item.task === 'delete') return text === item.truth ? { ok: true } : { ok: false, why: 'wrong result' }
  const before = linesOf(original)
  const after = linesOf(text)
  const { after: at, added, crlf } = item.truth
  if (after.final !== before.final || after.lines.length !== before.lines.length + 1) return { ok: false, why: 'wrong result' }
  const expected = [...before.lines.slice(0, at), null, ...before.lines.slice(at)]
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) {
      const line = after.lines[i]
      if (line.trim() !== added) return { ok: false, why: 'wrong result' }
      if (line.endsWith('\r') !== crlf) return { ok: false, why: 'line ending' }
    } else if (after.lines[i] !== expected[i]) {
      return { ok: false, why: 'wrong result' }
    }
  }
  return { ok: true }
}

export function signTest (aOnly, bOnly) {
  const n = aOnly + bOnly
  if (!n) return 1
  const k = Math.min(aOnly, bOnly)
  let tail = 0
  let choose = 1
  for (let i = 0; i <= k; i++) {
    tail += choose
    choose = choose * (n - i) / (i + 1)
  }
  return Math.min(1, 2 * tail / 2 ** n)
}
