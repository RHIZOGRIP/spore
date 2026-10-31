/**
 * A fork: a spore copied as it stood between two turns, or carried on from a round boundary of a
 * turn that already ran.
 *
 * Between turns — after the last, or after turn n — the new workspace holds the conversation and
 * the turns up to there, the calls they made, the messages they read and the islands, and runs
 * nothing: its next message starts its first turn of its own. After the last turn the islands are
 * copied as they are; after an earlier one, as they stood when it ended. Schedules stay behind, so
 * the copy is not woken by the clock that wakes the spore it was cut from.
 *
 * The new workspace is the run as it stood when that round's last tool result came back —
 * the transcript up to there, the files the islands held then, the calls it had made — and
 * its turn goes on from the next model call, in the same run, with the rounds it took still
 * counted. What differs is only what the caller changes, usually the definition: the same
 * decision, taken again under another identity, as many times as it takes to see a rate.
 *
 * `replay` cuts one step earlier, before the round's results: the calls the model asked for
 * run again when the fork starts, under the runtime as it is then. That is how a change to
 * what a tool returns is measured — the history is the run's, and only the result differs.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { TOOL_NAMES } from './tool-names.js'
import { callRuns, readCall, readCalls, writeCall } from './call-record.js'
import { withSlot } from './admission.js'
import { preparePlugins } from './plugins.js'
import { startRunner } from './send.js'
import { INBOX_DIR, PLUGINS_DIR, ROOT_DOCS, copyInbox, definitionPath, readPending, readTranscriptEntries, readTurns, writableDirs, writeTranscriptEntries, writeTurnRecords } from './spore-dir.js'
import { openWorkspace } from './workspace.js'
import { parseDefinition } from '../delegation/definition.js'
import { RUNNING, stateOf } from './state.js'
import { SPORANGIUM_RECORD } from './sporangia.js'
import { SporeError } from '../observability/errors.js'
import { CONFIG_FILE } from '../library/config.js'

export const FORK_FILE = 'fork.json'

const refuse = (message, detail) => new SporeError(message, { type: 'FORK_REFUSED', detail })

// File times come from the kernel's coarse clock, which advances a tick at a time, so a file
// can read a few milliseconds off the moment that made it. A cut is moved this far into the
// quiet between two rounds — a model call sits in it, seconds long — so a file lands on the
// side of the round that made it.
const CLOCK_SLACK_MS = 20
const shifted = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString()

const TURN_CUT = /^turn:(\d+)$/
const betweenTurns = (at) => at === null || TURN_CUT.test(at)

export function readFork (ws) {
  const path = join(ws, FORK_FILE)
  if (!existsSync(path)) throw refuse(`${ws} is not a fork`, 'spore fork <name> <new> makes one')
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The turn a fork between turns is cut after: the last finished one, or turn n of `turn:<n>`. */
function turnEnded (run, at) {
  const turns = readTurns(run)
  if (!turns.length) throw refuse(`${run} has finished no turn`, 'a fork copies what its turns left; spore define <new> --from <name> copies what it can do')
  const turnNo = at === null ? turns.at(-1).turnNo : Number(TURN_CUT.exec(at)[1])
  const index = turns.findIndex(t => t.turnNo === turnNo)
  if (index < 0) throw refuse(`no turn ${turnNo} in ${run}`, `spore log lists its turns; the last is ${turns.at(-1).turnNo}`)
  return { turn: turns[index], kept: turns.slice(0, index + 1), last: index === turns.length - 1 }
}

function turnAt (run, at) {
  const pending = readPending(run)
  const turns = pending ? [...readTurns(run), pending] : readTurns(run)
  const [runId, call] = at.includes('/') ? at.split('/') : [turns.at(-1)?.runId, at]
  const index = turns.findIndex(t => t.runId === runId)
  if (index < 0) throw refuse(`no turn ${runId ?? ''} in ${run}`, 'name a call of the last turn, as --at 0003, or of another as --at <runId>/0003')
  if (!/^\d{1,4}$/.test(call)) throw refuse(`"${call}" is not a call`, 'calls are numbered, as in calls/<runId>/0003')
  return { turn: turns[index], earlier: turns.slice(0, index), call: call.padStart(4, '0') }
}

// A tool result is the call's record in context: JSON, or the text part of a result that
// also carried pictures.
function callOf (entry) {
  const text = typeof entry.content === 'string' ? entry.content : entry.content?.find?.(p => p.type === 'text')?.text
  try {
    return JSON.parse(text).call
  } catch {
    return null
  }
}

/**
 * Where to cut: after every result of the round that made the call, since a model that
 * asked for two calls has to be shown both answers.
 */
function cutAt (run, turn, call, replay) {
  const written = readTranscriptEntries(run)
  // A compaction entry is no message; it only ever sits between turns.
  const entries = written.map(entry => ({ at: entry.at, ...(entry.kind === 'message' ? entry.message : {}) }))
  const inTurn = (entry) => entry.at >= turn.startedAt && entry.at <= turn.endedAt
  const found = entries.findIndex(entry => inTurn(entry) && entry.role === 'tool' && callOf(entry) === call)
  if (found < 0) throw refuse(`call ${call} is not in turn ${turn.runId}`, `calls/${turn.runId}/ lists the calls it made`)

  let asked = found
  while (entries[asked].role !== 'assistant') asked--
  const ids = new Set((entries[asked].toolCalls || []).map(c => c.id))
  const rounds = entries.slice(0, asked + 1).filter(entry => inTurn(entry) && entry.role === 'assistant').length
  if (replay) {
    if (entries[asked].toolCalls.some(c => c.name === 'ask')) {
      throw refuse(`the round of call ${call} asked a question`, 'ask ends a turn, so that round cannot run again in the middle of one')
    }
    // The round's calls start before its message is written down — a named output can be
    // opened a few milliseconds ahead of the transcript's timestamp — so the boundary is the
    // first call's own start, which it records before it opens anything.
    const started = entries.slice(asked + 1)
      .filter(entry => entry.role === 'tool' && ids.has(entry.toolCallId))
      .map(entry => readCall(run, turn.runId, callOf(entry)).startedAt)
    const first = Math.min(...started.map(Date.parse))
    return { entries: written.slice(0, asked + 1), rounds, at: new Date(first - CLOCK_SLACK_MS).toISOString() }
  }
  let end = found
  while (end + 1 < entries.length && entries[end + 1].role === 'tool' && ids.has(entries[end + 1].toolCallId)) end++

  return { entries: written.slice(0, end + 1), rounds, at: shifted(entries[end].at, CLOCK_SLACK_MS) }
}

function * filesUnder (dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) yield * filesUnder(path)
    else yield path
  }
}

/**
 * The islands as they stood at the cut, or as they are when there is none. A file born after it
 * is simply not there yet; one born before and changed after cannot be put back as it was, and a
 * fork that differs from its run is not a fork of it — so that refuses, rather than handing back
 * a guess.
 */
function restoreIslands (run, into, at) {
  const cut = at === null ? Infinity : Date.parse(at)
  for (const island of writableDirs(run)) {
    for (const file of filesUnder(island)) {
      const stat = lstatSync(file)
      if (stat.birthtimeMs > cut) continue
      const rel = relative(run, file)
      if (stat.mtimeMs > cut) {
        throw refuse(`${rel} was changed after the round the fork is cut at`, 'its content at that round is gone, so the fork would not start where the run was; cut at a later call, or after the last change')
      }
      const target = join(into, rel)
      mkdirSync(dirname(target), { recursive: true })
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(file), target)
        continue
      }
      copyFileSync(file, target)
      utimesSync(target, stat.atime, stat.mtime)
    }
  }
}

/**
 * What a cut keeps: the turns written down whole, the transcript and the calls up to it, the
 * moment the islands are copied as of (null: as they are), how far the inbox was read, and the
 * fork's record.
 */
function cutBetween (from, at) {
  const { turn, kept, last } = turnEnded(from, at)
  const cutAt = last ? new Date().toISOString() : shifted(turn.endedAt, CLOCK_SLACK_MS)
  // Every entry a turn writes carries its turnId, a turn's last after its endedAt included; only
  // a flush, written between turns, carries none. So the cut is the first entry of a turn not kept.
  const keptIds = new Set(kept.map(t => t.turnId))
  const written = readTranscriptEntries(from)
  const later = written.findIndex(entry => entry.turnId && !keptIds.has(entry.turnId))
  return {
    kept,
    entries: later < 0 ? written : written.slice(0, later),
    islandsAt: last ? null : cutAt,
    callsUpTo: cutAt,
    inboxTo: turn.inboxTo,
    record: { from, at: `turn:${turn.turnNo}`, turnNo: turn.turnNo, cutAt }
  }
}

function cutWithin (from, at, replay) {
  const { turn, earlier, call } = turnAt(from, at)
  const cut = cutAt(from, turn, call, replay)
  return {
    kept: earlier,
    entries: cut.entries,
    islandsAt: cut.at,
    callsUpTo: cut.at,
    inboxTo: turn.inboxTo,
    record: { from, at: `${turn.runId}/${call}`, runId: turn.runId, rounds: cut.rounds, inboxTo: turn.inboxTo, startedAt: turn.startedAt, cutAt: cut.at, replay }
  }
}

/**
 * The forked workspace, running nothing: cut between turns when `at` is null — after the last —
 * or `turn:<n>`, and otherwise at a call, `0003` of the last turn or `<runId>/0003`, ready to
 * carry that turn on.
 */
export function forkWorkspace ({ run, at = null, into, definition, replay = false }) {
  const from = resolve(run)
  const ws = resolve(into)
  const between = betweenTurns(at)
  if (!existsSync(definitionPath(from))) throw refuse(`${from} is not a spore`, 'fork a workspace that has run')
  if (between && replay) throw refuse('--replay runs a round again, and a cut between turns has none', 'cut at a call to replay it, as --at 0003')
  const now = stateOf(from)
  if (now.state === RUNNING && (between || !now.draining)) throw refuse(`${from} is running`, 'fork it once its turn has ended')
  if (existsSync(ws)) throw refuse(`${ws} already exists`, 'a fork is made into a new directory')
  if (definition) {
    const parsed = parseDefinition(readFileSync(definition, 'utf8'), { knownTools: TOOL_NAMES })
    if (parsed.error) throw refuse(`${definition} ${parsed.error}`, 'the definition a fork runs under has to parse like any spore.cmk')
  }

  const cut = between ? cutBetween(from, at) : cutWithin(from, at, replay)

  mkdirSync(ws, { recursive: true })
  try {
    restoreIslands(from, ws, cut.islandsAt)
    writeTurnRecords(ws, cut.kept)
    // A turn cut within is carried on under the fork's own, so what it said so far belongs to
    // no turn here yet.
    const kept = new Set(cut.kept.map(t => t.turnId))
    writeTranscriptEntries(ws, cut.entries.map(({ turnId, ...entry }) => (kept.has(turnId) ? { ...entry, turnId } : entry)))
    // The calls made by the cut, as the islands are: the run numbers on from them, so the
    // streams restored beside them keep the names the transcript gives them.
    for (const runId of callRuns(from)) {
      for (const { call, record } of readCalls(from, runId)) {
        if (record.startedAt <= cut.callsUpTo) writeCall(ws, runId, call, record)
      }
    }
    copyInbox(from, ws, cut.inboxTo)
    const plugins = existsSync(join(from, PLUGINS_DIR)) ? readdirSync(join(from, PLUGINS_DIR)).map(file => join(PLUGINS_DIR, file)) : []
    if (plugins.length) mkdirSync(join(ws, PLUGINS_DIR))
    for (const file of [...ROOT_DOCS, SPORANGIUM_RECORD, ...plugins]) {
      if (existsSync(join(from, file))) copyFileSync(join(from, file), join(ws, file))
    }
    for (const file of filesUnder(join(from, INBOX_DIR))) {
      const target = join(ws, relative(from, file))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(file, target)
    }
    copyFileSync(definition ? resolve(definition) : definitionPath(from), definitionPath(ws))
    const opened = openWorkspace(ws)
    if (opened.error) throw refuse(`${ws} did not open`, opened.error)
    const record = { ...cut.record, definition: definition ? resolve(definition) : null }
    writeFileSync(join(ws, FORK_FILE), JSON.stringify(record, null, 2) + '\n')
    return { ws, ...record }
  } catch (err) {
    rmSync(ws, { recursive: true, force: true })
    throw err
  }
}

/**
 * A fork, made — and, cut at a call, started: like `send`, it returns once the runner is on its
 * way. Cut between turns it starts nothing, and the copy's next message starts its first turn.
 */
export function fork ({ run, at = null, into, definition, replay = false, debug = false, env = process.env }) {
  if (betweenTurns(at)) return forkWorkspace({ run, at, into, definition, replay })
  return withSlot(CONFIG_FILE, slot => {
    const made = forkWorkspace({ run, at, into, definition, replay })
    return { ...made, pid: startRunner(made.ws, { slot, plugins: preparePlugins(made.ws), debug, continuing: true, env }) }
  })
}
