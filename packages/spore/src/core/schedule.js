/**
 * Schedules — `schedules/<name>.cmk` in a root workspace: what the clock says to a spore,
 * and when. Contract: ARCHITECTURE.md, "Turns the clock starts".
 *
 * The grammar, the refusals and when a schedule is due are `rust/definition`'s, through the
 * addon. What is here is the reading of a workspace's schedules that `write`, `edit`, the
 * pass that fires them and `spore show` share, so the four cannot disagree about which
 * schedule is refused or held.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { native } from '../native.js'
import { readInbox } from './spore-dir.js'
import { SporeError } from '../observability/errors.js'

export const SCHEDULE_DIR = 'schedules'
export const SCHEDULE_EXT = '.cmk'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** @returns {object | { error: string }} */
export function parseSchedule (source) {
  return JSON.parse(native.parseSchedule(source))
}

/**
 * Where a schedule stands at `now`, given `after` — the slot it last fired for or when it
 * was last changed, whichever is later.
 *
 * @returns {{ state: 'due', slot: string } | { state: 'later', next: string } | { state: 'stale', slot: string, next?: string } | { state: 'spent' } | { error: string }}
 */
export function dueOf (source, { after, now }) {
  return JSON.parse(native.scheduleDue(source, Math.floor(after), Math.floor(now)))
}

/** The shortest time between two of its slots, in ms; null for an `at` schedule. */
export function shortestGap (source, { from, floor }) {
  return JSON.parse(native.scheduleGap(source, Math.floor(from), floor))
}

export const scheduleDir = (ws) => resolve(ws, SCHEDULE_DIR)

const fileOf = (ws, name) => resolve(scheduleDir(ws), name + SCHEDULE_EXT)

const minutes = (ms) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`)

/**
 * The name a path gives a schedule, or why it gives none. A schedule is a file directly in
 * `schedules/`, since the pass reads one level and a file below it would never fire.
 */
export function scheduleNameOf (ws, abs) {
  const within = relative(scheduleDir(ws), abs)
  if (within.includes(sep) || !within.endsWith(SCHEDULE_EXT)) {
    return { error: `${SCHEDULE_DIR}/ holds only <name>${SCHEDULE_EXT} files, one per schedule — ${relative(ws, abs)} is not one` }
  }
  const name = within.slice(0, -SCHEDULE_EXT.length)
  if (!NAME.test(name)) {
    return { error: `"${name}" is not a schedule name — letters, digits, ., _ and -, starting with a letter or digit` }
  }
  return { name }
}

/** An `at` schedule whose instant is past fires no more, so it no longer counts against the grant. */
const live = (parsed, now) => !parsed.at || Date.parse(parsed.at) > now

/**
 * Every schedule file in the workspace, each with its source and its parse. A file that
 * does not parse is kept, with its error, because the pass reports it rather than
 * skipping it.
 */
export function readSchedules (ws) {
  const dir = scheduleDir(ws)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(file => file.endsWith(SCHEDULE_EXT))
    .sort()
    .map(file => {
      const path = resolve(dir, file)
      const source = readFileSync(path, 'utf8')
      return { name: file.slice(0, -SCHEDULE_EXT.length), path, source, changed: statSync(path).mtimeMs, parsed: parseSchedule(source) }
    })
}

/**
 * Why a schedule may not stand as written, or null. `grant` is the root definition's
 * `schedules` pair; absent, nothing bounds what the operator writes. `others` is how many
 * other schedules in the directory still count against the grant; `counting: false` leaves
 * the count to the caller, which the pass does because it holds the whole directory at once.
 */
export function refusalOf (source, { grant, others = 0, now = Date.now(), writing = false, counting = true }) {
  const parsed = parseSchedule(source)
  if (parsed.error) return parsed.error
  if (writing && parsed.at && Date.parse(parsed.at) <= now) {
    return `fires at ${parsed.at}, which has already passed`
  }
  if (!grant) return null
  const gap = shortestGap(source, { from: now, floor: grant.interval })
  if (gap.error) return gap.error
  if (gap.gap != null && gap.gap < grant.interval) {
    return `fires ${minutes(gap.gap)} apart at its closest, and this spore's schedules are held to at least ${minutes(grant.interval)} — schedules: [${grant.count}, ${minutes(grant.interval)}] in spore.cmk`
  }
  const counted = others + (live(parsed, now) ? 1 : 0)
  if (counting && counted > grant.count) {
    return `would make ${counted} schedules, and this spore may keep ${grant.count} — remove one first, or drop a spent one`
  }
  return null
}

/**
 * The check `write` and `edit` make before a file under `schedules/` changes: the file as
 * it would be, against the directory as it would stand. Why it is refused, or null.
 */
export function refuseScheduleWrite (ws, abs, content, { grant, now = Date.now() }) {
  const named = scheduleNameOf(ws, abs)
  if (named.error) return named.error
  const others = readSchedules(ws).filter(s => s.name !== named.name && !s.parsed.error && live(s.parsed, now)).length
  const refused = refusalOf(content, { grant, others, now, writing: true })
  return refused ? `${SCHEDULE_DIR}/${named.name}${SCHEDULE_EXT} ${refused}` : null
}

/** The slot each schedule last fired for, read back from the inbox, where firing is recorded. */
export function lastFired (ws) {
  const fired = new Map()
  for (const entry of readInbox(ws)) {
    if (entry.schedule) fired.set(entry.schedule, entry.due)
  }
  return fired
}

// A turn the clock starts is a new turn. Every other state would take the message as
// something else: an interjection into a running turn, the answer to a question, or a
// retry of a turn that failed.
export const FIRES_INTO = new Set(['idle', 'wrapped', 'halted', 'cancelled'])

/**
 * Where every schedule of one workspace stands: refused (it breaks the grammar or the
 * grant), held (due, and the spore is in no state to take it or its grant's firings are
 * spent for now), due, stale, later or spent.
 * `spore show` prints this and `tick` fires what it says is due, so both read the same.
 *
 * @param {{ state: string, draining?: boolean }} spore — `stateOf(ws)`
 * @param {{ count: number, interval: number } | null} grant — the root definition's `schedules`
 */
export function survey (ws, { spore, grant, now = Date.now() }) {
  const schedules = readSchedules(ws)
  const fired = lastFired(ws)
  // The grant bounds what fires, not only what is declared: a spent one-shot replaced by
  // another, or a schedule deleted and made again, is a new declaration each time. The inbox
  // holds every firing, so the window is counted there, across every schedule.
  const recent = grant
    ? readInbox(ws).filter(entry => entry.schedule && Date.parse(entry.at) > now - grant.interval).length
    : 0
  const spent = grant && recent >= grant.count
    ? `${recent} firing${recent === 1 ? '' : 's'} in the last ${minutes(grant.interval)}, and this spore may have ${grant.count} — schedules: [${grant.count}, ${minutes(grant.interval)}] in spore.cmk`
    : null
  const counted = schedules.filter(s => !s.parsed.error && live(s.parsed, now)).length
  const over = grant && counted > grant.count
    ? `${counted} schedules, and this spore may keep ${grant.count}`
    : null
  const busy = spore.draining ? 'draining' : FIRES_INTO.has(spore.state) ? null : spore.state

  return schedules.map(({ name, source, changed, parsed }) => {
    const last = fired.get(name) ?? null
    const row = { name, when: parsed.when ?? null, tz: parsed.tz ?? null, at: parsed.at ?? null, lastFired: last }
    const refused = refusalOf(source, { grant, now, counting: false })
    if (refused) return { ...row, state: 'refused', why: refused }
    if (over) return { ...row, state: 'held', why: over }
    const after = Math.max(last ? Date.parse(last) : 0, changed)
    const due = dueOf(source, { after, now })
    if (due.error) return { ...row, state: 'refused', why: due.error }
    if (due.state === 'due' && spent) return { ...row, state: 'held', why: spent, slot: due.slot }
    if (due.state === 'due' && busy) return { ...row, state: 'held', why: busy, slot: due.slot }
    return { ...row, ...due, message: parsed.message }
  })
}

/**
 * Install a schedule the operator wrote, parsed first and renamed into place, the way a
 * definition is installed: a half-written file would be refused at the next pass, and the
 * schedule would stop firing with it. The grant bounds the directory whoever writes it.
 */
export function writeSchedule (ws, name, source, { grant, now = Date.now() }) {
  const path = fileOf(ws, name)
  const refused = refuseScheduleWrite(ws, path, source, { grant, now })
  if (refused) throw new SporeError(refused, { type: 'SCHEDULE_REFUSED' })
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, source)
  renameSync(temporary, path)
  return { ws, name: basename(path, SCHEDULE_EXT), path }
}

/** Remove a schedule. What it fired stays on the inbox, which is the record of it. */
export function dropSchedule (ws, name) {
  const path = fileOf(ws, name)
  const named = scheduleNameOf(ws, path)
  if (named.error) throw new SporeError(named.error, { type: 'SCHEDULE_REFUSED' })
  if (!existsSync(path)) {
    throw new SporeError(`no schedule called "${name}"`, { type: 'SCHEDULE_MISSING', detail: `nothing at ${path} — spore schedule ls shows what there is` })
  }
  rmSync(path)
  return { ws, name, path }
}
