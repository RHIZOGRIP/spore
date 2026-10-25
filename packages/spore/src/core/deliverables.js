/**
 * What a turn hands back.
 *
 * Contract: ARCHITECTURE.md, "What a turn hands back". An answer is prose, so the only way an
 * agent could hand back a file was to name it in a sentence — structure inside the text,
 * which is what the call contract exists to keep out of it. This is the field beside the
 * prose: a consumer reads `{ output, deliverables }` and never parses an answer to find a file.
 *
 * Read from the filesystem and not from the call trail, though the trail is where it
 * looks like it should come from. A call records the streams it redirected and the file
 * `write` and `edit` acted on — not what a program did while it ran. `wsexec node
 * render.js` leaves `data/out/report.pdf` on disk and nothing about it in the record, and that
 * is the case this exists for.
 */

import { readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { mimeOf } from './call-record.js'
import { DATA_DIR, dataMeasured } from './spore-dir.js'

// What the agent means to hand back, as `data/memory` is what it means to remember. The
// runtime reads the name and nothing more: which of these a consumer passes on is a
// consumer's business, the way the allow-list in front of a bot is.
export const OUT_DIR = `${DATA_DIR}/out`

// How many files a turn hands back. Each becomes something a person receives, so past this the
// agent bundles them.
export const DELIVERABLES_CAP = 50

// The walk stats every file `data/` keeps, and dream pressure needs how far it grew between
// dreams, not its size at every turn.
export const WEIGH_EVERY_MS = 3_600_000

export const walk = (dir, out = []) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * What this turn hands back: the files in `data/out/` it wrote, newest first, at most `cap`
 * of them, with `more` the ones left out.
 *
 * `since` is the turn's start, and the file has to still be there: something written and
 * then deleted was a draft, not a deliverable.
 */
export function deliverablesIn (ws, since, { cap = DELIVERABLES_CAP } = {}) {
  const startedAt = new Date(since).getTime()
  const found = []
  for (const full of walk(resolve(ws, OUT_DIR))) {
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.mtimeMs < startedAt) continue
    found.push({
      path: relative(ws, full),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      mime: mimeOf(full)
    })
  }

  found.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return { deliverables: found.slice(0, cap), more: Math.max(0, found.length - cap) }
}

/**
 * Everything under `data/`, in bytes, for a spore that `dreams` and was last weighed
 * `WEIGH_EVERY_MS` or more before `now`; null when it is not weighed, and the dream reads the
 * last turn that was.
 */
export function dataBytesIn (ws, { dreams, now = Date.now() }) {
  if (!dreams) return null
  const last = dataMeasured(ws)
  if (last && now - Date.parse(last.endedAt) < WEIGH_EVERY_MS) return null
  let total = 0
  for (const full of walk(resolve(ws, DATA_DIR))) {
    try {
      total += statSync(full).size
    } catch {}
  }
  return total
}
