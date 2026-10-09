/**
 * Grading a finished case, from the workspace rather than from prose.
 *
 * The runtime's own claim is that the answer is what is on disk, so that is what is
 * checked: exact bytes in a named file, the stop reason in `turns.jsonl`, a call in the
 * trail matched to its tool and target, a cell's spawn frame. A judge model would be slower, dearer and less
 * certain than reading the file the task named.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { readTranscript, turnSummary } from '../src/core/spore-dir.js'
import { callRuns, readCalls } from '../src/core/call-record.js'

const matches = (value, expected) =>
  expected instanceof RegExp ? expected.test(value) : value === expected

/**
 * What a call was aimed at — which is what separates "the runtime refused the write to
 * the workspace root" from "a read of a missing file under data/ was refused, and the
 * model wrote the word anyway". Both are real refusals; only one is the boundary.
 *
 * A refusal keeps the raw arguments, because it never got as far as a tool. A call that
 * ran keeps whatever its tool records instead: `path` for read, `command` for the exec
 * pair, the written file for write.
 */
const aimedAt = (record) => {
  if (record.args) return String(record.args.path ?? record.args.command ?? '')
  return String(record.path ?? record.command ?? record.files?.out?.path ?? '')
}

const SHAPED = new Set(['tool', 'target', 'refused', 'failed'])

/**
 * `tool` and `target` say which call; `refused` and `failed` say how it ended. Anything
 * else in the spec is matched against the field of that name in the record, which is
 * what lets a case pin the part of the call that is the feature — `exit: 7` for the code
 * a command returned, `eof: false` for a read that asked for a range rather than the
 * file. A spec naming a field the record does not carry matches nothing, so a typo
 * fails the case rather than passing it.
 */
const made = (record, spec) => {
  if (record.tool !== spec.tool) return false
  if (spec.target && !spec.target.test(aimedAt(record))) return false
  if (spec.refused !== undefined && Boolean(record.refused) !== spec.refused) return false
  if (spec.failed !== undefined && (record.exit !== 0) !== spec.failed) return false
  return Object.entries(spec).every(([key, value]) => SHAPED.has(key) || matches(record[key], value))
}

const describeCall = (spec) => {
  const how = [spec.refused && 'refused', spec.failed && 'failed'].filter(Boolean)
    .concat(Object.entries(spec).filter(([k]) => !SHAPED.has(k)).map(([k, v]) => `${k} ${v}`))
    .join(' and ')
  return `${spec.tool} call${spec.target ? ` at ${spec.target}` : ''}${how ? ` that ${how}` : ''}`
}

const summarise = (record) =>
  `${record.tool}(${JSON.stringify(aimedAt(record).slice(0, 40))})${record.refused ? ' refused' : ` exit ${record.exit}`}${record.eof === false ? ' partial' : ''}`

/** Every call record this run wrote, refusals included, oldest run first. */
export function callRecords (ws) {
  return callRuns(ws).reverse().flatMap(runId => readCalls(ws, runId).filter(call => call.record).map(call => call.record))
}

/** Cells that reported a frame, wherever under the workspace they were put. */
export function cellFrames (ws) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = resolve(dir, entry.name)
      const frame = resolve(child, 'spawn.json')
      if (existsSync(frame)) {
        try {
          found.push(JSON.parse(readFileSync(frame, 'utf8').trim().split('\n').at(-1)))
        } catch {}
      }
      walk(child, depth + 1)
    }
  }
  walk(resolve(ws, 'data'), 0)
  return found
}

/**
 * What the turn ended up saying — and only what the *agent* said.
 *
 * A turn that ends on `ask` has no assistant echo, because the runtime skips it: the
 * tool result already is the question. Reading only assistant messages scored a working
 * `ask` as silent, so this was widened to any role — which opened a hole worth more than
 * the one it closed. With no assistant message at all, the last message is the *user
 * prompt*, and a prompt contains the words the case is looking for: a spore that wrote
 * its prompt and then died satisfied `answer: /ready/i`.
 *
 * So the fallback is narrow and conditional: the terminal tool result, and only when the
 * turn actually ended `question`. Never the instruction the case gave.
 */
const lastAnswer = (ws, turn) => {
  const transcript = readTranscript(ws)
  const said = (m) => typeof m.content === 'string' && m.content.trim()
  if (turn?.stopReason === 'question') {
    const asked = [...transcript].reverse().find(m => m.role === 'tool' && said(m))
    if (asked) return asked.content.trim()
  }
  const message = [...transcript].reverse().find(m => m.role === 'assistant' && said(m))
  return message ? message.content.trim() : ''
}

/**
 * Returns the failed expectations, so an empty array is a pass and a report can say
 * what was wrong rather than only that something was.
 */
export function grade (ws, item) {
  const problems = []
  const expect = item.expect || {}
  const turn = turnSummary(ws).last

  if (!turn) return ['never ran — no turn record']

  // Every case wants a turn that ended properly, and most never said so — they checked
  // only their artifact, so a turn that errored and happened to leave the file behind
  // passed. A case that means to accept an interrupted turn says which reason.
  const wanted = expect.stopReason ?? 'answer'
  if (!matches(turn.stopReason || '', wanted)) {
    problems.push(`stopReason was ${turn.stopReason}, wanted ${wanted}`)
  }
  if (expect.concluded !== undefined && turn.concluded !== expect.concluded) {
    problems.push(`concluded was ${turn.concluded}, wanted ${expect.concluded}`)
  }
  if (expect.answer && !matches(lastAnswer(ws, turn), expect.answer)) {
    problems.push(`answer did not match ${expect.answer} — got ${JSON.stringify(lastAnswer(ws, turn).slice(0, 60))}`)
  }

  for (const [path, wanted] of Object.entries(expect.files || {})) {
    const full = resolve(ws, path)
    if (!existsSync(full)) {
      problems.push(`${path} was not written`)
      continue
    }
    const body = readFileSync(full, 'utf8')
    if (!matches(body, wanted)) {
      problems.push(`${path} was ${JSON.stringify(body.slice(0, 40))}, wanted ${wanted}`)
    }
  }

  if (expect.calls) {
    const records = callRecords(ws)
    for (const spec of expect.calls) {
      if (!records.some(record => made(record, spec))) {
        problems.push(`no ${describeCall(spec)} — ${records.length ? records.map(summarise).join(', ') : 'no calls at all'}`)
      }
    }
  }

  for (const path of expect.absent || []) {
    if (existsSync(resolve(ws, path))) {
      problems.push(`${path} exists — the call the case forbids went through`)
    }
  }

  if (expect.cells !== undefined) {
    const answered = cellFrames(ws).filter(frame => frame.answer).length
    if (answered < expect.cells) {
      problems.push(`${answered} cells answered, wanted ${expect.cells}`)
    }
    // Frames alone are not proof: `spawn.json` lives under `data/`, and a confined shell
    // writes one happily, so a parent that does the work itself and writes the frames
    // afterwards passes every file and frame check. The turn record is out of reach —
    // the runner writes it, into a database the agent can read and never write.
    // `ownMicros` is this loop's own spend and `treeMicros` the
    // subtree's, so the difference is money a descendant spent through the broker, which
    // only a cell that really ran can have spent.
    if (!(turn.treeMicros > turn.ownMicros)) {
      problems.push(`no child spend recorded (own ${turn.ownUsd}, tree ${turn.treeUsd}) — the cells did not run, whatever the frames say`)
    }
  }

  return problems
}
