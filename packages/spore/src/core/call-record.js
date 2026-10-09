/**
 * Call records — the per-invocation trail: one record per call in the workspace's `calls`,
 * and the streams it did not name under `<workspace>/calls/`.
 * Contract and rationale: ARCHITECTURE.md, "The call record".
 */

import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { RECORD, REFUSED, mark, marked } from './marks.js'
import { SNIFF_BYTES, sniffImage } from './media.js'
import { textOf } from './message.js'
import { CALLS_DIR, readState, recordCall, storable } from './spore-dir.js'
import { SporeError } from '../observability/errors.js'

export const CALLS_ROOT = CALLS_DIR
const INLINE_BUDGET = 4096

const HASH_LEN = 16
const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const SPACE = 32
const DEL = 127

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ml': 'text/x-ocaml',
  '.py': 'text/x-python',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf'
}

/**
 * The one naming of what a file is. The extension answers for the formats a workspace
 * mostly holds, and the bytes answer when it does not — a chart the agent just rendered
 * has whatever name it was given, and a consumer deciding whether to show it or attach it
 * has only this to go on.
 */
export function mimeOf (absPath) {
  const byExt = MIME_BY_EXT[extname(absPath)]
  if (byExt) return byExt
  try {
    const fd = openSync(absPath, 'r')
    try {
      const head = Buffer.alloc(SNIFF_BYTES)
      const read = readSync(fd, head, 0, SNIFF_BYTES, 0)
      return sniffImage(head.subarray(0, read)) || 'application/octet-stream'
    } finally {
      closeSync(fd)
    }
  } catch {
    return 'application/octet-stream'
  }
}

function hasControlChars (text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue
    if (code < SPACE || code === DEL) return true
  }
  return false
}

function decodeText (buf) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
  return hasControlChars(text) ? null : text
}

// Streamed so a multi-gigabyte artifact costs constant memory.
export async function hashFile (path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex').slice(0, HASH_LEN)
}

export async function fileRecord (absPath, { workspace, inlineBudget = INLINE_BUDGET } = {}) {
  if (!existsSync(absPath)) return null
  const st = statSync(absPath)
  const record = {
    path: relative(workspace, absPath),
    bytes: st.size,
    mtime: new Date(st.mtimeMs).toISOString(),
    mime: mimeOf(absPath),
    hash: await hashFile(absPath)
  }
  if (st.size <= inlineBudget) {
    const text = decodeText(readFileSync(absPath))
    if (text !== null) {
      record.content = text
      if (record.mime === 'application/octet-stream') record.mime = 'text/plain'
    }
  }
  return record
}

const OFF_THE_RECORD = new Set(['startedAt', 'lastProgressAt', 'hash', 'round'])
const ONLY_WHEN_KILLED = new Set(['timeoutMs', 'idleMs'])

/**
 * What the caller sees. The record in `calls` stays complete — hashes, mtimes
 * and the bounds of a call that finished are for the trail, and replaying
 * them into context every round costs more than they are worth to a model.
 * What survives is what it could act on.
 */
export function contextView (meta) {
  const view = {}
  for (const [key, value] of Object.entries(meta)) {
    if (OFF_THE_RECORD.has(key) || value === null) continue
    if (ONLY_WHEN_KILLED.has(key) && !meta.killed) continue
    if (key !== 'files') {
      view[key] = value
      continue
    }
    view.files = {}
    for (const [slot, record] of Object.entries(value)) {
      if (!record) {
        view.files[slot] = null
        continue
      }
      view.files[slot] = { path: record.path, bytes: record.bytes }
      if (record.content !== undefined) view.files[slot].content = record.content
    }
  }
  return view
}

// Only the file — the directory it sits in is the call's own, and still holds the
// record.
export function dropIfEmpty (absPath) {
  if (!existsSync(absPath) || statSync(absPath).size > 0) return
  rmSync(absPath)
}

/**
 * A tool's result that is a call record, as a value: the kernel shows the model its JSON and
 * marks the message `record`, so what a call did is read from the record and never guessed
 * from text — `ask` and `quiet` hand back what the model wrote, which may be JSON too.
 */
export const recorded = (record, images) => (images ? { record, images } : { record })

export const isRecorded = (value) => value !== null && typeof value === 'object' && typeof value.record === 'object' && value.record !== null

export const recordedResult = (toolCallId, toolName, record) =>
  mark({ role: 'tool', toolCallId, toolName, content: JSON.stringify(record) }, RECORD)

/**
 * What a tool result says happened — the one reading of it, so the guard, the events
 * and the memory cannot disagree about whether a call worked.
 *
 * The call contract defines success twice over and both are here: a result marked refused
 * (`refusal.js`) ran nothing, and a result marked `record` carries the command's own verdict
 * as its exit code. Anything else is text a tool returned and worked by getting that far.
 */
export function readOutcome (message) {
  const content = textOf(message)
  if (marked(message, REFUSED)) return { ok: false, exit: null, refused: true, error: content.replace(/^error: /, '') }
  if (!marked(message, RECORD)) return { ok: true, exit: null, refused: false }
  let record
  try {
    record = JSON.parse(content)
  } catch {
    // The transcript sanitiser's last resort cuts a record too large to compact to plain
    // text, and what it said about its exit went with it.
    return { ok: true, exit: null, refused: false }
  }
  if (record.exit !== undefined) return { ok: record.exit === 0, exit: record.exit, refused: false, record }
  return { ok: true, exit: null, refused: false, record }
}

// The columns a reader queries, beside the record whole.
const callRow = (runId, meta) => ({
  runId,
  callNo: Number(meta.call),
  ...(Number.isInteger(meta.round) ? { round: meta.round } : {}),
  tool: meta.tool,
  startedAt: meta.startedAt,
  ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
  ...(Number.isInteger(meta.exit) ? { exit: meta.exit } : {}),
  refused: Boolean(meta.refused),
  ...(meta.files?.out?.path ? { outPath: storable(meta.files.out.path) } : {}),
  ...(meta.files?.err?.path ? { errPath: storable(meta.files.err.path) } : {}),
  record: meta
})

const callId = (callNo) => String(callNo).padStart(4, '0')

/**
 * Every run that has recorded a call, the most recent first — by its latest call, in the order
 * calls were written down, which is the rule pruning keeps too. The view has no such order, so
 * this reads the table behind it.
 */
export function callRuns (workspace) {
  return readState(workspace, [], db => db.prepare('SELECT runId FROM t_calls GROUP BY runId ORDER BY max(rowid) DESC').all().map(row => row.runId))
}

/** The calls a run recorded, in order: `{ call, record }`. */
export function readCalls (workspace, runId) {
  return readState(workspace, [], db => db.prepare('SELECT callNo, record FROM calls WHERE runId = ? ORDER BY callNo').all(runId)
    .map(row => ({ call: callId(row.callNo), record: JSON.parse(row.record) })))
}

/** One call's record, or null when it left none. */
export function readCall (workspace, runId, call) {
  const row = readState(workspace, null, db => db.prepare('SELECT record FROM calls WHERE runId = ? AND callNo = ?').get(runId, Number(call)))
  return row ? JSON.parse(row.record) : null
}

/**
 * A call's record written as a finished call writes it, through a turn's writer — or, given a
 * workspace, from the host side, for fixtures.
 */
export function writeCall (target, runId, call, record) {
  recordCall(target, callRow(runId, { ...record, call }))
}

/** How many calls a run has written down, which is where a continued run numbers on from. */
export function callsIn (workspace, runId) {
  return readState(workspace, 0, db => db.prepare('SELECT coalesce(max(callNo), 0) AS last FROM calls WHERE runId = ?').get(runId).last)
}

export function createCallTrail (workspace, { runId = Date.now().toString(36), seq: from = 0, round = null, state } = {}) {
  if (!state) {
    throw new SporeError('a call trail records through the turn\'s writer', {
      type: 'STATE_CHANNEL',
      detail: 'pass the turn\'s channel, or hostState(ws) from the host side, as state'
    })
  }
  const root = resolve(workspace, CALLS_ROOT, runId)
  // A continued turn numbers on from where its calls stopped, so the paths its transcript
  // already names stay the right ones.
  let seq = from
  let finished = 0

  return {
    runId,
    root,
    // How many calls have been written down. A tool that refused before it got that far
    // left nothing behind, which is what `recordRefusals` in make-tools watches for.
    get finished () {
      return finished
    },
    get round () {
      return round
    },
    set round (n) {
      round = n
    },
    begin (tool) {
      seq += 1
      const id = String(seq).padStart(4, '0')
      const dir = resolve(root, id)
      mkdirSync(dir, { recursive: true })
      return { id, dir, tool, startedAt: Date.now(), round }
    },
    abandon (call) {
      rmSync(call.dir, { recursive: true, force: true })
    },
    // A stream the caller did not name belongs to the call, not to the workspace:
    // it goes beside the record that points at it, so one directory is one call and
    // dropping a run's trail takes its leftovers with it.
    autoPath (call, kind) {
      return resolve(call.dir, kind)
    },
    // The record as it would be written. Lets a caller measure what the model would
    // receive before committing to it — `read` budgets the whole serialized result,
    // not just the bytes it sliced.
    preview (call, observed) {
      return {
        tool: call.tool,
        call: call.id,
        ...(call.round === null ? {} : { round: call.round }),
        startedAt: new Date(call.startedAt).toISOString(),
        durationMs: Date.now() - call.startedAt,
        ...observed
      }
    },
    finish (call, observed) {
      const meta = this.preview(call, observed)
      recordCall(state, callRow(runId, meta))
      finished += 1
      return meta
    },
    /**
     * A refusal is a call too. Validation that fails before a tool opens a record used
     * to leave nothing on disk, so the trail disagreed with the transcript about what
     * the agent had tried.
     */
    refuse (tool, { args, error }) {
      const call = this.begin(tool)
      this.finish(call, { args, exit: 1, refused: true, error })
    }
  }
}
