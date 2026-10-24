/**
 * A delivery nobody typed — a webhook's, a job's, a program's through the API — held, then taken
 * through two steps before it reaches its spore: the program its definition binds to the origin
 * prepares it, attaching what it makes, and the spore's router for the origin, then its triage
 * cell, decide how long it may wait, never past the origin's `maxWait`, never dropping it. Held
 * first, until both have had their time, so a step that hangs, a cell that fails or a host that
 * dies still lets it go then. Contract: ARCHITECTURE.md, "Deliveries nobody typed".
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SporeError } from '../observability/errors.js'
import { launchStandalone } from './cell.js'
import { release as releaseHeld } from './send.js'
import { pluginProgram } from './plugins.js'
import { prepareFor, runPrepare } from './prepare.js'
import { INBOX_DIR, attachHeld, enqueue, holdDelivery, originOfOptions, releaseHeld as releaseDue, rescheduleHeld, startingSince } from './spore-dir.js'
import { ROUTE_TIMEOUT_MS, routerFor, runRouter } from './router.js'
import { precursorFor, triage, triageIn, TRIAGE_PER_DAY } from './triage.js'
import { durationMs, parseDefinition } from '../delegation/definition.js'
import { TOOL_NAMES } from './tool-names.js'

const iso = (ms) => new Date(ms).toISOString()
const PREPARE_GRACE_MS = 5_000
const HOUR_MS = 3_600_000
const PREPARED_DIR = 'prepared'

const KEPT_HELD = {
  ADMISSION_FULL: 'held — every turn slot is taken, the pass releases it once one frees',
  PAUSED: 'held — spores are paused, the pass releases it after spore unpause',
  SPEND_LIMIT: 'held — the spend limit is reached, the pass releases it once the day or month turns or the limit is raised'
}

/**
 * The bounds an operator's file sets on the deliveries of one origin — a hook's in `hooks.json`,
 * a caller's in `api.json` — as `deliver` takes them: `{ maxWait, perDay, perHour }`, `maxWait`
 * null when unsaid, `perHour` the file's own default (`perHour`, null for none). A spore's own jobs
 * are bounded in its `spore.cmk`. `refused(problem, detail)` is the error the file's loader throws.
 */
export function deliveryBounds (raw, refused, { perHour: unsaidPerHour = null } = {}) {
  const maxWait = raw.maxWait === undefined ? null : durationMs(String(raw.maxWait))
  if (raw.maxWait !== undefined && !(maxWait > 0)) {
    throw refused(`has a maxWait spore cannot read — ${JSON.stringify(raw.maxWait)}`, 'the longest a spore\'s router or triage cell may keep a delivery waiting, as 30m or 2h')
  }
  const perDay = raw.perDay ?? TRIAGE_PER_DAY
  if (!Number.isInteger(perDay) || perDay < 1) {
    throw refused(`has a perDay that is not a count — ${JSON.stringify(raw.perDay)}`, 'how many triage cells its deliveries may start in a spore a day, a whole number from 1')
  }
  const perHour = raw.perHour ?? unsaidPerHour
  if (perHour !== null && (!Number.isInteger(perHour) || perHour < 1)) {
    throw refused(`has a perHour that is not a count — ${JSON.stringify(raw.perHour)}`, 'how many of its deliveries may start a turn in a spore an hour, a whole number from 1')
  }
  return { maxWait, perDay, perHour }
}

/** Releases what is due in `ws` and says what came of it; every slot taken, or a pause, leaves it held. */
function releaseNow (release, ws, options) {
  try {
    const released = release(ws, options)
    return { outcome: released.started ? 'started' : released.released.length ? 'said to the turn running' : 'held', started: released.started }
  } catch (err) {
    if (!KEPT_HELD[err.type]) throw err
    return { outcome: KEPT_HELD[err.type], started: false }
  }
}

/** What times deliveries from `origin` in `ws`: its router and its triage precursor, either absent. */
export function judgesOf (ws, origin) {
  return { router: routerFor(ws, origin), precursor: triageIn(ws, origin) }
}

/** The longest the spore's own step may take to decide: its router's timeout, then its cell's hard wall. */
function decidingMs ({ router, precursor }, routeTimeoutMs) {
  const cell = precursor ? parseDefinition(readFileSync(precursor, 'utf8'), { knownTools: TOOL_NAMES, cell: true }) : null
  // A precursor the agent wrote may not parse; its cell then fails at once, so deciding takes no longer.
  const cellMs = cell && !cell.error ? cell.limits.wall.hard : 0
  return (router ? routeTimeoutMs : 0) + (precursor ? cellMs + routeTimeoutMs : 0)
}

/**
 * Says `said` with `options` (as `holdDelivery` takes them) to the spore at `ws`, from the origin
 * they name (`hook:forge`, `job:scan`, `api:pipeline`) — the one way a message nobody typed
 * arrives. It is held first; the program `prepare:` binds to the origin, if any, runs on it and
 * attaches what it makes; then the spore's router or triage cell for the origin, if it keeps one,
 * answers how long it may wait, up to `maxWait` (none: it is released at once, a summary or
 * `replaces` still taken). Released, it starts a turn or joins the one running, and no free slot,
 * or a pause, leaves it held for the pass. Once `perHour` deliveries from its origin were let start
 * a turn in the last hour (null: no bound), it is said without starting one, its entry's
 * `startsTurn` false, and skips the spore's step. `stdin` and `headers` are the names of the attached files given to both
 * steps as the payload and the headers, either null; `briefing({ payload, headers })` is
 * what a triage cell is told; `envOf()` the environment a cell and a release start with. Answers
 * `{ outcome, judged, started, prepared }`: a line for the caller's log, the steps under way,
 * whether a turn started now, and whether a prepare step runs.
 */
export function deliver ({
  ws, said, options: given, maxWait = null, perHour = null, stdin = null, headers = null, event, ref, perDay, briefing, envOf, log, heading,
  now = Date.now, release = releaseHeld, say = enqueue, route = runRouter, launch = launchStandalone, routeTimeoutMs = ROUTE_TIMEOUT_MS,
  prepareOf = prepareFor, programOf = pluginProgram, prepareBy = runPrepare
}) {
  const origin = originOfOptions(given)
  if (origin === null) throw new SporeError('a message a person typed is said, never delivered', { type: 'DELIVERY_INVALID', detail: 'deliver takes a webhook\'s, a job\'s or an API caller\'s message; send takes a person\'s' })
  const start = perHour === null || startingSince(ws, origin, iso(now() - HOUR_MS)) < perHour
  const options = start ? given : { ...given, startsTurn: false }
  const past = start ? '' : ` — ${perHour} turns started in the last hour`
  const prepare = prepareOf(ws, origin)
  if (!start && !prepare) {
    const sent = say(ws, said, options)
    return { outcome: `${sent.repeated ? 'already received' : 'said, not started'}${past}`, judged: Promise.resolve(), started: false, prepared: false }
  }
  const judges = start ? judgesOf(ws, origin) : {}
  const timed = Boolean(judges.router || judges.precursor)
  const arrived = now()
  const preparing = prepare ? prepare.timeoutMs + PREPARE_GRACE_MS : 0
  const deciding = timed ? decidingMs(judges, routeTimeoutMs) : 0
  const label = prepare && `what "${prepare.plugin}/${prepare.program}" prepares`
  const untold = prepare && { path: null, name: label, mime: null, bytes: null, missing: 'it did not answer: what ran it stopped first' }
  const kept = holdDelivery(ws, said, {
    ...options,
    ...(prepare ? { attach: [...(options.attach ?? []), untold] } : {}),
    releaseAt: iso(arrived + preparing + (timed ? routeTimeoutMs : 0)),
    deadline: iso(arrived + preparing + deciding + (timed ? maxWait ?? 0 : 0))
  })
  if (kept.repeated) return { outcome: `already ${kept.repeated === true ? 'received' : kept.repeated}`, judged: Promise.resolve(), started: false, prepared: false }

  if (!prepare && !timed) {
    return { ...releaseNow(release, ws, { env: envOf(), now: now() }), judged: Promise.resolve(), prepared: false }
  }

  const tell = (line) => log(`${heading} · ${line}`)
  const judged = (async () => {
    const prepared = prepare ? await prepareStep({ ws, kept, prepare, untold, stdin, headers, origin, event, ref, programOf, prepareBy, now, said: tell }) : []
    if (prepared === null) return
    if (timed) return timeStep({ ws, kept, prepared, judges, stdin, headers, origin, event, ref, maxWait, perDay, briefing, envOf, now, release, route, launch, routeTimeoutMs, said: tell })
    rescheduleHeld(ws, kept.held, iso(now()), { urgent: true })
    if (!start) {
      releaseDue(ws, iso(now()), { due: true })
      return tell('said, not started')
    }
    tell(releaseNow(release, ws, { env: envOf() }).outcome)
  })().catch(err => log(`${heading} · failed — ${err.type ?? err.name} ${err.message}${err.detail ? ` — ${err.detail}` : ''}; it is released at its deadline`))
  const steps = [prepare && `prepared by ${prepare.plugin}/${prepare.program}`, timed && `timed by ${judges.router ? judges.router.split('/').pop() : `precursors/${precursorFor(origin)}.cmk`}`].filter(Boolean)
  return { outcome: `held — ${steps.join(', then ')}${past}`, judged, started: false, prepared: Boolean(prepare) }
}

/**
 * Runs the program that prepares the held delivery and puts what it attached, or the line saying
 * why nothing was, in place of the line that it has not answered. Answers the files it attached,
 * or null when the delivery was released meanwhile, with nothing left of what it attached.
 */
async function prepareStep ({ ws, kept, prepare, untold, stdin, headers: headersName, origin, event, ref, programOf, prepareBy, now, said }) {
  const files = kept.files.slice(0, -1)
  const payload = stdin === null ? null : files.find(file => file.path && file.name === stdin)
  const headers = headersName === null ? null : files.find(file => file.path && file.name === headersName)
  const first = files.find(file => file.path)
  const delivery = first ? dirname(first.path) : `${INBOX_DIR}/${iso(now()).replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`
  const into = `${delivery}/${prepare.program}`
  const what = `${prepare.plugin}/${prepare.program}`
  let attached
  try {
    const { program, reads } = programOf(prepare.plugin, prepare.program)
    attached = await prepareBy({
      program,
      programReads: reads,
      ws,
      delivery: first ? join(ws, delivery) : null,
      payload: payload ? join(ws, payload.path) : null,
      headers: headers ? join(ws, headers.path) : null,
      origin,
      event,
      ref,
      into,
      timeoutMs: prepare.timeoutMs,
      attach: prepare.attach,
      reads: prepare.reads
    })
  } catch (err) {
    attached = { failed: `could not start — ${err.message}${err.detail ? ` — ${err.detail}` : ''}` }
  }
  const told = attached.failed ? [{ ...untold, missing: `it ${attached.failed}` }] : attached.files
  if (!attachHeld(ws, kept.held, [...files, ...told])) {
    rmSync(join(ws, into), { recursive: true, force: true })
    said(`${what} answered after the delivery was released without it`)
    return null
  }
  said(attached.failed ? `${what} ${attached.failed}; delivered without what it prepares` : `${what} attached ${attached.files.length} file${attached.files.length === 1 ? '' : 's'}`)
  return attached.failed ? [] : attached.files
}

/**
 * The spore's own step: its router, then its triage cell, answer how long the delivery may wait,
 * each shown what the prepare step attached.
 */
async function timeStep ({ ws, kept, prepared, judges: { router, precursor }, stdin, headers: headersName, origin, event, ref, maxWait, perDay, briefing, envOf, now, release, route, launch, routeTimeoutMs, said }) {
  const decided = now()
  const payload = stdin === null ? null : kept.files.find(file => file.path && file.name === stdin)
  const headers = headersName === null ? null : kept.files.find(file => file.path && file.name === headersName)
  let answer = { ask: true }
  if (router) {
    const routed = await route({ router, ws, payload: payload ? join(ws, payload.path) : null, headers: headers?.path ?? null, prepared: prepared.length ? dirname(prepared[0].path) : null, origin, event, ref, timeoutMs: routeTimeoutMs })
    answer = routed.failed ? { failed: `the router ${routed.failed}` } : routed
  }
  if (answer.ask) {
    answer = precursor
      ? await triage({
        ws,
        origin,
        ref,
        files: {
          ...(payload ? { [payload.name]: join(ws, payload.path) } : {}),
          ...(headers ? { 'headers.json': join(ws, headers.path) } : {}),
          ...Object.fromEntries(prepared.map(file => [`${PREPARED_DIR}/${file.name}`, join(ws, file.path)]))
        },
        briefing: briefing({ payload: payload?.name ?? null, headers: Boolean(headers) }) + (prepared.length ? `What was prepared for it is in ${PREPARED_DIR}/: ${prepared.map(file => file.name).join(', ')}.\n` : ''),
        perDay,
        env: envOf(),
        started: (wallMs) => rescheduleHeld(ws, kept.held, iso(now() + wallMs + routeTimeoutMs)),
        launch,
        now
      })
      : { failed: `the router asked for a triage cell, and there is no precursors/${precursorFor(origin)}.cmk` }
  }
  const wait = answer.failed ? 0 : Math.min(answer.wait, maxWait ?? 0)
  rescheduleHeld(ws, kept.held, iso(decided + wait), { urgent: wait === 0, summary: answer.summary ?? null, replaces: answer.replaces === true })
  said(`${answer.failed ? `${answer.failed}; delivered now` : wait === 0 ? 'routed now' : `routed to wait ${Math.round(wait / 60000)}m`}${answer.replaces ? ', replacing what was held' : ''}${answer.summary ? ` — ${answer.summary}` : ''}`)
  if (wait === 0) said(releaseNow(release, ws, { env: envOf() }).outcome)
}
