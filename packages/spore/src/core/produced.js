/**
 * What a turn left behind.
 *
 * Contract: ARCHITECTURE.md, "What a run produced". An answer is prose, so the only way an
 * agent could hand back a file was to name it in a sentence — structure inside the text,
 * which is what the call contract exists to keep out of it. This is the field beside the
 * prose: a consumer reads `{ output, produced }` and never parses an answer to find a file.
 *
 * Read from the filesystem and not from the call trail, though the trail is where it
 * looks like it should come from. A call records the streams it redirected and the file
 * `write` and `edit` acted on — not what a program did while it ran. `wsexec node
 * render.js` leaves `data/report.pdf` on disk and nothing about it in the record, and that
 * is the case this exists for.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { mimeOf } from './call-record.js'
import { DATA_DIR, writableDirs } from './spore-dir.js'

// What the agent means to hand back, as `data/memory` is what it means to remember. The
// runtime reads the name and nothing more: which of these a consumer passes on is a
// consumer's business, the way the allow-list in front of a bot is.
export const DELIVER_DIR = `${DATA_DIR}/out`

// A fan-out writes one directory per part and every part writes files. Listing all of them
// is a turn record nobody can read and a `complete` event nobody wants to ship, so the
// count survives when the list does not.
export const PRODUCED_CAP = 50

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
 * Every file under the agent's writable directories that this turn touched, newest first,
 * with anything it deliberately delivered ahead of the rest so the cap takes scratch.
 *
 * `since` is the turn's start, and the file has to still be there: something written and
 * then deleted was working, not produced. `dataBytes` is everything under `data/` at the end,
 * counted on the same walk.
 */
export function producedIn (ws, since, { cap = PRODUCED_CAP } = {}) {
  const startedAt = new Date(since).getTime()
  const deliverAt = resolve(ws, DELIVER_DIR)
  const dataAt = resolve(ws, DATA_DIR)

  const found = []
  let dataBytes = 0
  for (const island of writableDirs(ws)) {
    // The trail is the runtime's own record of the turn, and `home/` is where the programs it
    // ran keep their settings: neither is something the turn made.
    if (island.endsWith(`${sep}calls`) || island.endsWith(`${sep}home`) || !existsSync(island)) continue
    for (const full of walk(island)) {
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (island === dataAt) dataBytes += st.size
      if (st.mtimeMs < startedAt) continue
      found.push({
        path: relative(ws, full),
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        mime: mimeOf(full),
        delivered: full === deliverAt || full.startsWith(deliverAt + sep)
      })
    }
  }

  found.sort((a, b) => (Number(b.delivered) - Number(a.delivered)) || b.mtime.localeCompare(a.mtime))
  return { produced: found.slice(0, cap), more: Math.max(0, found.length - cap), dataBytes }
}
