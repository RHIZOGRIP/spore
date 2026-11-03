/**
 * Grading a finished case, from the workspace rather than from prose.
 *
 * The runtime's own claim is that the answer is what is on disk, so that is what is
 * checked: exact bytes in a named file, the stop reason in the `turns` view, a call in the
 * trail matched to its tool and target, what the runner listed as handed back, a schedule's
 * firing, a cell's spawn frame and the runner's count of cells. A judge model would be
 * slower, dearer and less certain than reading the file the task named.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { readTranscript, turnSummary } from '../src/core/spore-dir.js'
import { callRuns, readCalls } from '../src/core/call-record.js'
import { walk } from '../src/core/deliverables.js'
import { readSchedules } from '../src/core/schedule.js'

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
  if (!matches(record.tool, spec.tool)) return false
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

const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
const timeIn = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
const daysAfter = (day, n) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * A one-off schedule firing `days` after the day the turn started, at `at`, both read on the
 * clock of `tz` — which is what "tomorrow at 9:00, Paris time" means wherever the run is. One
 * firing, so an `at` schedule: a cron that fires that morning fires every year after it too.
 */
const firing = (ws, turn, { tz, days, at }) => {
  const day = daysAfter(dayIn(Date.parse(turn.startedAt), tz), days)
  const found = readSchedules(ws)
  if (found.some(s => s.parsed.at && dayIn(Date.parse(s.parsed.at), tz) === day && timeIn(Date.parse(s.parsed.at), tz) === at)) return null
  const said = found.map(s => `${s.name}: ${s.parsed.error ?? s.parsed.when}`).join(', ')
  return `no schedule fires once on ${day} at ${at} ${tz} — ${said || 'schedules/ holds none'}`
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
  if (expect.answerNot && expect.answerNot.test(lastAnswer(ws, turn))) {
    problems.push(`answer matched ${expect.answerNot}, which the case forbids — got ${JSON.stringify(lastAnswer(ws, turn).slice(0, 60))}`)
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

  if (expect.uncalled) {
    const used = callRecords(ws).filter(record => expect.uncalled.includes(record.tool))
    if (used.length) problems.push(`the case wanted no ${expect.uncalled.join(', ')} call — ${used.map(summarise).join(', ')}`)
  }

  // A file whose name the model chooses: anywhere under the directory, any one that matches.
  for (const [dir, wanted] of Object.entries(expect.under || {})) {
    const found = walk(resolve(ws, dir))
    if (!found.some(full => matches(readFileSync(full, 'utf8'), wanted))) {
      problems.push(`nothing under ${dir} matched ${wanted} — ${found.length ? found.map(full => relative(ws, full)).join(', ') : 'it holds no file'}`)
    }
  }

  // What the turn handed back is the runner's list in the turn record, not a file the
  // agent says it made: the list is what a consumer receives.
  for (const spec of expect.deliverables || []) {
    const handed = turn.deliverables ?? []
    const ok = handed.some(d => matches(d.path, spec.path) && (!spec.body || matches(readFileSync(resolve(ws, d.path), 'utf8'), spec.body)))
    if (!ok) problems.push(`no deliverable at ${spec.path}${spec.body ? ` matching ${spec.body}` : ''} — ${handed.length ? handed.map(d => d.path).join(', ') : 'the turn handed back nothing'}`)
  }

  if (expect.fires) {
    const missed = firing(ws, turn, expect.fires)
    if (missed) problems.push(missed)
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
    // afterwards passes every file and frame check. The turn record is out of reach — the
    // runner writes it, into a database the agent can read and never write — and its
    // `byPrecursor` counts the cells of each precursor that called the model through the
    // broker. A count rather than spend, since a call on an unmetered route such as
    // `chatgpt/`, or on a free model, records 0.
    const ran = turn.byPrecursor?.[item.precursor]?.cells ?? 0
    if (ran < expect.cells) {
      problems.push(`the runner served ${ran} ${item.precursor} cells, wanted ${expect.cells} — the cells did not run, whatever the frames say`)
    }
  }

  return problems
}
