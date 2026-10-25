/**
 * When a spore dreams: pressure that rises with every turn since the last dream, weighed by how much
 * `data/` grew, and quiet that rises while no turn runs and falls to nothing with each one. A dream
 * is due when the two, each over what `dream: [turns, quiet]` declares, multiply to 1. Read from the
 * records alone, since the tick pass reads every spore every minute. Contract: ARCHITECTURE.md,
 * "Dreams".
 */

import { existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { formatMessagesForSummary } from '../resilience/compaction.js'
import { runCell } from './cell.js'
import { DREAMT, mark } from './marks.js'
import { walk } from './deliverables.js'
import { FIRES_INTO, scheduleDir } from './schedule.js'
import { CALLS_DIR, DATA_DIR, PRECURSOR_DIR, appendTranscript, dreamRecords, readTranscriptEntries, turnsAfter, writableDirs } from './spore-dir.js'
import { parsedDefinition } from '../delegation/definition.js'

/** Below a quarter of its own, neither counts: too little to dream about, or too soon after a turn. */
export const DREAM_FLOOR = 0.25

/**
 * Whether the spore at `ws` is due a dream under `dream`, its definition's, and if not, why.
 * `quietLeft` is how long, at today's pressure, the spore must stay without a turn for one —
 * null while pressure is under its floor, which no quiet makes up for.
 *
 * Paused spores and the admission slots are the starter's to check, as they are for any turn.
 *
 * @param {{ turns: number, quiet: number, wall: { hard: number } }} dream
 * @param {{ state: string, draining?: boolean }} spore — `stateOf(ws)`
 */
export function dreamDue (ws, { dream, spore, now = Date.now() }) {
  const records = dreamRecords(ws)
  const growth = records.dreamBytes && records.dataBytes ? Math.max(1, records.dataBytes / records.dreamBytes) : 1
  const pressure = records.turnsSince * growth / dream.turns
  const sinceTurn = records.endedAt === null ? 0 : now - Date.parse(records.endedAt)
  const quiet = sinceTurn / dream.quiet
  const needed = pressure < DREAM_FLOOR ? null : Math.max(DREAM_FLOOR, 1 / pressure) * dream.quiet
  const row = { pressure, quiet, quietLeft: needed === null ? null : Math.max(0, needed - sinceTurn), afterTurn: records.afterTurn, dataBytes: records.dataBytes }

  if (spore.draining || !FIRES_INTO.has(spore.state)) return { ...row, due: false, why: spore.draining ? 'draining' : spore.state }
  if (records.unread) return { ...row, due: false, why: 'something said waits unread' }
  if (records.heldDue !== null && Date.parse(records.heldDue) < now + dream.wall.hard) return { ...row, due: false, why: 'a held delivery is released before a dream could end' }
  if (needed === null) return { ...row, due: false, why: 'too little since the last dream' }
  if (sinceTurn < needed) return { ...row, due: false, why: 'not quiet long enough' }
  return { ...row, due: true, why: null }
}

const DAY = 86_400_000
const UNTOUCHED_DAYS = 30
const LISTED = 50

const BRIEFING = `You are the spore at spore/, dreaming: nothing reaches it while you run, and it reads your answer when it next wakes.

- spore/ is its workspace. You write spore/data/ and spore/home/, and spore/schedules/ when it may write its own; everything else there you only read, its precursors and the directories its grants link included.
- transcript.md is what was said since its last dream.
- facts.json is what its directories hold: sizes, files untouched for ${UNTOUCHED_DAYS} days, empty files, its memory notes.

Answer with a note to the spore: what you moved and where to, what you removed and why, what you wrote down.
`

/** What a dream writes of the spore: the agent's own directories but its trail and its precursors. */
function islandsOf (ws, definition) {
  const kept = writableDirs(ws).filter(dir => !dir.endsWith(`${sep}${CALLS_DIR}`) && !dir.endsWith(`${sep}${PRECURSOR_DIR}`))
  return [...kept, ...(definition.schedules ? [scheduleDir(ws)] : [])]
}

/** Every file under `islands`, by its path from `ws`, with its size and when it last changed. */
function filesIn (ws, islands) {
  const files = new Map()
  for (const island of islands) {
    for (const full of walk(island)) {
      try {
        const st = statSync(full)
        files.set(relative(ws, full), { bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {}
    }
  }
  return files
}

const ancestors = (path) => {
  const parts = path.split('/')
  return parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join('/'))
}

/**
 * `paths` of `side` as a person reads them: a directory all of whose files are in `paths`, and
 * that `other` has nothing under, is one line with its file count and bytes.
 */
function collapse (paths, side, other) {
  const among = new Set(paths)
  const elsewhere = new Set([...other.keys()].flatMap(ancestors))
  const counts = new Map()
  for (const path of side.keys()) {
    for (const dir of ancestors(path)) {
      const count = counts.get(dir) ?? { all: 0, among: 0 }
      count.all++
      if (among.has(path)) count.among++
      counts.set(dir, count)
    }
  }
  const whole = (dir) => counts.get(dir).all === counts.get(dir).among && !elsewhere.has(dir)
  const lines = new Map()
  for (const path of paths) {
    const at = ancestors(path).find(whole) ?? path
    const line = lines.get(at) ?? { path: at, files: 0, bytes: 0 }
    line.files++
    line.bytes += side.get(path).bytes
    lines.set(at, line)
  }
  return [...lines.values()].sort((a, b) => b.bytes - a.bytes)
}

/** What a dream changed, observed: what is gone and what is new, by path. */
export function changedBetween (before, after) {
  return {
    removed: collapse([...before.keys()].filter(path => !after.has(path)), before, after),
    added: collapse([...after.keys()].filter(path => !before.has(path)), after, before)
  }
}

function factsOf (files, { now }) {
  const tops = new Map()
  const empty = []
  for (const [path, { bytes, mtimeMs }] of files) {
    const top = path.split('/').slice(0, 2).join('/')
    const fact = tops.get(top) ?? { path: top, files: 0, bytes: 0, newest: 0, untouched: { files: 0, bytes: 0 } }
    fact.files++
    fact.bytes += bytes
    fact.newest = Math.max(fact.newest, mtimeMs)
    if (now - mtimeMs > UNTOUCHED_DAYS * DAY) {
      fact.untouched.files++
      fact.untouched.bytes += bytes
    }
    tops.set(top, fact)
    if (bytes === 0) empty.push(path)
  }
  const memory = `${DATA_DIR}/memory/`
  return {
    directories: [...tops.values()].sort((a, b) => b.bytes - a.bytes).map(fact => ({ ...fact, newest: new Date(fact.newest).toISOString() })),
    empty: { files: empty.length, paths: empty.slice(0, LISTED) },
    memory: [...files].filter(([path]) => path.startsWith(memory)).map(([path, { bytes }]) => ({ path, bytes }))
  }
}

function transcriptSince (ws, afterTurn) {
  const turns = new Set(turnsAfter(ws, afterTurn).map(turn => turn.turnId))
  const said = readTranscriptEntries(ws).filter(entry => entry.kind === 'message' && turns.has(entry.turnId)).map(entry => entry.message)
  return formatMessagesForSummary(said)
}

const lineOf = ({ path, files, bytes }) => `- ${path}${files > 1 ? ` — ${files.toLocaleString('en-US')} files` : ''}, ${bytes.toLocaleString('en-US')} bytes`

function noteOf ({ answer, failed }, changed) {
  const said = answer ?? `The dream ended without a note — ${failed}.`
  const observed = [
    ...(changed.removed.length ? ['Removed:', ...changed.removed.map(lineOf)] : []),
    ...(changed.added.length ? ['Added:', ...changed.added.map(lineOf)] : [])
  ]
  return `[While idle, you dreamt]\n\n${said}${observed.length ? `\n\nWhat changed, as observed:\n${observed.join('\n')}` : ''}`
}

/**
 * The spore at `ws` dreams: its `dream.precursor` run as a super cell, handed what was said since
 * its last dream and what its directories hold, its changes observed by walking them before and
 * after, recorded with the turn it ran after and the bytes its `data/` came to, and its note
 * appended to the conversation — when it said or changed anything. The caller holds the spore's
 * lock: nothing else writes it meanwhile.
 */
export async function runDream (ws, { env, signal = null } = {}) {
  const definition = parsedDefinition(ws)
  if (definition.error) return { started: false, failed: `spore.cmk ${definition.error}` }
  if (!definition.dream) return { started: false, failed: 'this spore declares no dream' }
  const { precursor, wall } = definition.dream
  if (!existsSync(join(ws, PRECURSOR_DIR, `${precursor}.cmk`))) {
    return { started: false, failed: `dream.precursor names ${precursor}, and ${PRECURSOR_DIR}/${precursor}.cmk is not there` }
  }

  const islands = islandsOf(ws, definition)
  const records = dreamRecords(ws)
  const afterTurn = records.afterTurn + records.turnsSince
  const before = filesIn(ws, islands)
  let changed = { removed: [], added: [] }
  const ran = await runCell({
    ws,
    precursor,
    origin: 'dream',
    contents: {
      'transcript.md': transcriptSince(ws, records.afterTurn),
      'facts.json': JSON.stringify(factsOf(before, { now: Date.now() }), null, 2)
    },
    briefing: BRIEFING,
    env,
    signal,
    dream: {
      wallMs: wall.hard,
      recorded: () => {
        const after = filesIn(ws, islands)
        changed = changedBetween(before, after)
        const dataBytes = [...after].filter(([path]) => path.startsWith(`${DATA_DIR}/`)).reduce((total, [, { bytes }]) => total + bytes, 0)
        return { afterTurn, dataBytes, changed }
      }
    }
  })
  if (ran.started && (ran.answer !== null || changed.removed.length || changed.added.length)) {
    appendTranscript(ws, mark({ role: 'user', content: noteOf(ran, changed) }, DREAMT))
  }
  return { ...ran, changed }
}
