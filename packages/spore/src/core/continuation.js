/**
 * What a killed turn leaves behind.
 * Contract: ARCHITECTURE.md, "Spawn".
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CALLS_ROOT, callRuns, readCalls } from './call-record.js'
import { WRAP, marked } from './marks.js'
import { DATA_DIR, readTranscript } from './spore-dir.js'
import { PRECURSOR_DIR, PRECURSOR_EXT } from '../delegation/definition.js'

const RECENT_CALLS = 8

function produced (ws) {
  const root = resolve(ws, DATA_DIR)
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full, `${prefix}${name}/`)
      else out.push({ path: `${DATA_DIR}/${prefix}${name}`, bytes: st.size })
    }
  }
  walk(root, '')
  return out
}

// `write` and `edit` name their file only in the record of what they produced, so
// without the last branch they arrive here as `write exit 0 —` and the parent reading
// this is told a call happened and nothing about what it touched.
const describe = (m) =>
  m.command
    ? m.command.replace(/\s+/g, ' ').slice(0, 90)
    : m.path || m.url || m.query || m.files?.out?.path || ''

/**
 * Assembled from the record on disk and nothing else — no model call, because the
 * model is what was just stopped. That is also what makes this path incapable of
 * overrunning the limit that reached it.
 */
export function buildContinuation (ws, { stopReason, spent, precursor }) {
  const runId = callRuns(ws)[0] ?? null
  const ran = runId ? readCalls(ws, runId).filter(call => call.record).map(call => call.record) : []
  const files = produced(ws)
  const transcript = readTranscript(ws)
  const lastAsk = [...transcript].reverse().find(m => m.role === 'user' && !marked(m, WRAP))

  // A soft stop only reaches here when an answer was reached and then judged
  // unfinished — `on-wrap: discard`. Every other path had nothing to discard.
  const lines = [
    `# Stopped: ${stopReason}`,
    '',
    `Spent ${spent?.rounds ?? '?'} rounds, $${(spent?.cost ?? 0).toFixed(4)}, ${Math.round((spent?.wall ?? 0) / 1000)}s.`,
    stopReason?.startsWith('soft:')
      ? 'It wrapped up rather than finishing, so its answer was discarded. What follows is the record, not an account of it.'
      : 'No answer was produced. What follows is the record, not an account of it.',
    ''
  ]

  if (lastAsk) lines.push('## Asked', '', String(lastAsk.content).trim().slice(0, 500), '')

  if (ran.length) {
    lines.push(`## Last ${Math.min(RECENT_CALLS, ran.length)} of ${ran.length} calls`, '')
    for (const m of ran.slice(-RECENT_CALLS)) {
      const status = m.killed ? `killed:${m.killed}` : m.exit === undefined ? 'ok' : `exit ${m.exit}`
      lines.push(`- \`${m.tool}\` ${status} — ${describe(m)}`)
    }
    lines.push('')
  }

  if (files.length) {
    lines.push('## Produced', '')
    for (const f of files) lines.push(`- \`${f.path}\` (${f.bytes} B)`)
    lines.push('')
  }

  // A cell cannot be resumed — its workspace is spent once it holds a trail — so
  // the only continuation open to a parent is a fresh one.
  lines.push('## To continue', '', ...(precursor
    ? [
        'This cell is spent: a workspace that has run cannot run again. Spawn a fresh one',
        `on a narrower slice, or raise the limits in \`${PRECURSOR_DIR}/${precursor}${PRECURSOR_EXT}\` first.`
      ]
    : [
        'Run again in this workspace. The transcript replays, so the next turn resumes',
        'from here. Raise the limit in `spore.cmk` first if the work genuinely needs it.'
      ]))

  const text = lines.join('\n') + '\n'
  if (runId) {
    // A fork's run has its calls' records and only the directories its streams needed.
    mkdirSync(resolve(ws, CALLS_ROOT, runId), { recursive: true })
    writeFileSync(resolve(ws, CALLS_ROOT, runId, 'continuation.md'), text)
  }
  return { text, path: runId ? `${CALLS_ROOT}/${runId}/continuation.md` : null }
}
