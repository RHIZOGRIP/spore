/**
 * A spore's router for one origin — `hook:forge`, later `job:scan` — at `data/routes/<origin>.route`
 * in its workspace (`hook-forge.route`): a program the spore wrote or its owner put there, asked how
 * long a delivery nobody typed may wait. Contract: ARCHITECTURE.md, "Deliveries nobody typed".
 *
 * It reads a payload whoever triggered the event wrote, so it runs confined — the workspace
 * readable, nothing writable but a scratch directory, an environment holding none of the
 * service's secrets — and its answer can only delay, by no more than the hook's `maxWait`.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { mimeOf } from './call-record.js'
import { runShell } from './command.js'
import { slugOf } from './cell.js'
import { containOf } from './plugins.js'
import { durationMs, parseDefinition, sizeBytes } from '../delegation/definition.js'
import { containing, readConfig } from '../library/config.js'
import { definitionPath } from './spore-dir.js'
import { TOOL_NAMES } from './tool-names.js'

export const ROUTE_TIMEOUT_MS = 10_000
export const OWNER_ROUTE_MOST_MS = 60_000
export const ATTACH_MOST = Object.freeze({ files: 100, bytes: 256 * 1024 * 1024 })
const ATTACHED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SUMMARY_CHARS = 300

export function routerFor (ws, origin) {
  for (const name of [`${slugOf(origin)}.route`, `${slugOf(origin)}.route.js`]) {
    const path = join(ws, 'data', 'routes', name)
    if (existsSync(path)) return path
  }
  return null
}

const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`

export function answerOf (printed) {
  let answer
  try {
    answer = JSON.parse(printed.trim())
  } catch {
    return { failed: 'printed something that is not one JSON object' }
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { failed: 'printed something that is not one JSON object' }
  if (answer.ask === true) return { ask: true }
  const wait = answer.wait === 0 || answer.wait === '0' ? 0 : durationMs(String(answer.wait))
  if (wait === null || !(wait >= 0)) return { failed: `answered a wait of ${JSON.stringify(answer.wait)}, which is neither "0" nor a duration as 30m` }
  const summary = typeof answer.summary === 'string' && answer.summary.trim()
    ? answer.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS)
    : null
  return { wait, summary, replaces: answer.replaces === true }
}

/**
 * `{ wait, summary, replaces }` — `wait` in milliseconds, `replaces` dropping any delivery still
 * held from the same origin — `{ ask: true }` when it leaves the delivery to the
 * spore's triage cell, or `{ failed }` saying why there is no answer:
 * it could not start, ran past `timeoutMs`, exited non-zero, or printed something else.
 */
export async function runRouter ({ router, ws, payload, headers, origin, event, ref, timeoutMs = ROUTE_TIMEOUT_MS, contain = containing(readConfig()) }) {
  let keep
  try {
    keep = containOf(ws)
  } catch (err) {
    return { failed: `could not start — ${err.message}` }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'spore-route-'))
  try {
    const program = router.endsWith('.js') ? `${quote(process.execPath)} ${quote(router)}` : quote(router)
    const outAbs = join(scratch, 'out')
    const errAbs = join(scratch, 'err')
    const ran = await runShell({
      command: [program, quote(origin), quote(event ?? ''), quote(ref), quote(headers ?? '')].join(' '),
      cwd: ws,
      inAbs: payload,
      outAbs,
      errAbs,
      confine: { writeRoot: scratch, reads: [ws], scopeSignals: true, contain, keep },
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      timeoutMs,
      idleMs: timeoutMs
    })
    if (ran.spawnError) return { failed: `could not start — ${ran.spawnError}` }
    if (ran.killed) return { failed: `was stopped after ${timeoutMs / 1000} s` }
    if (ran.exit !== 0) {
      const said = readFileSync(errAbs, 'utf8').trim().split('\n').at(-1)
      return { failed: `exited ${ran.exit ?? ran.signal}${said ? ` — ${said}` : ''}` }
    }
    return answerOf(readFileSync(outAbs, 'utf8'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const ROUTER_SHAPE = `router is { "plugin", "name", "timeout": "45s", "attach": { "files": 20, "bytes": "200MB" }, "reads": ["<a directory>"] or "spore" } — at most ${OWNER_ROUTE_MOST_MS / 1000} s, ${ATTACH_MOST.files} files and ${ATTACH_MOST.bytes / 1024 / 1024} MB; "spore" reads what the spore's reads: grant`

/**
 * The owner's router as `hooks.json` or `api.json` binds it, its bounds checked against the
 * runtime's ceilings: `{ router }`, or `{ problem }` saying what is wrong with it.
 */
export function parseRouter (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'has a router spore cannot read' }
  const unknown = Object.keys(raw).filter(key => !['plugin', 'name', 'timeout', 'attach', 'reads'].includes(key))
  if (unknown.length) return { problem: `has a router field spore does not know — ${unknown.join(', ')}` }
  if (typeof raw.plugin !== 'string' || !raw.plugin || typeof raw.name !== 'string' || !raw.name) return { problem: 'has a router that names no plugin and router' }
  const timeoutMs = typeof raw.timeout === 'string' ? durationMs(raw.timeout) : null
  if (!(timeoutMs > 0 && timeoutMs <= OWNER_ROUTE_MOST_MS)) return { problem: `has a router timeout spore cannot take — ${raw.timeout}` }
  const files = raw.attach?.files
  const bytes = typeof raw.attach?.bytes === 'string' ? sizeBytes(raw.attach.bytes) : null
  if (!(Number.isInteger(files) && files >= 1 && files <= ATTACH_MOST.files && bytes > 0 && bytes <= ATTACH_MOST.bytes)) {
    return { problem: `has a router attach spore cannot take — ${JSON.stringify(raw.attach)}` }
  }
  const reads = raw.reads ?? []
  if (reads !== 'spore' && !(Array.isArray(reads) && reads.every(dir => typeof dir === 'string' && isAbsolute(dir) && resolve(dir) !== '/'))) {
    return { problem: `has router reads that are neither directories nor "spore" — ${JSON.stringify(raw.reads)}` }
  }
  return { router: { plugin: raw.plugin, name: raw.name, timeoutMs, attach: { files, bytes }, reads: reads === 'spore' ? reads : reads.map(dir => resolve(dir)) } }
}

/** The directories a binding's router reads in `ws`: its own list, or for `"spore"` the read-only grants of the spore's definition. */
export const readsOf = (ws, reads) => reads === 'spore'
  ? parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES }).reads.map(grant => grant.path)
  : reads

const sizeText = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`

/** What `out/` holds, checked against `attach`: `{ found: [{ name, path, bytes }] }` or `{ failed }`. */
function attachedIn (out, attach) {
  const found = []
  for (const name of readdirSync(out).sort()) {
    const path = join(out, name)
    const stat = lstatSync(path)
    if (!stat.isFile()) return { failed: `wrote out/${name}, which is not a plain file` }
    if (!ATTACHED_NAME.test(name)) return { failed: `wrote out/${JSON.stringify(name).slice(1, -1)}, a name of letters, digits, ., _ and - it is not` }
    found.push({ name, path, bytes: stat.size })
  }
  if (found.length > attach.files) return { failed: `wrote ${found.length} files, more than the ${attach.files} its owner allows` }
  const bytes = found.reduce((total, file) => total + file.bytes, 0)
  if (bytes > attach.bytes) return { failed: `wrote ${sizeText(bytes)}, more than the ${sizeText(attach.bytes)} its owner allows` }
  return { found }
}

/**
 * Runs the owner's router `program` on a delivery to the spore at `ws` and attaches what it writes
 * to `out/`, its working directory's, under `into` — `inbox.d/<delivery>/<router>`, relative to
 * `ws` — as file records of the delivery's entry; or `{ failed }`, saying why there is none: it
 * could not start, ran past `timeoutMs`, exited non-zero, or wrote what `attach` does not allow.
 * It reads the payload on its stdin, the delivery's own files and `reads`, and writes nothing else.
 */
export async function runOwnerRouter ({ program, programReads, ws, delivery, payload, headers, origin, event, ref, into, timeoutMs, attach, reads, contain = containing(readConfig()) }) {
  let keep
  try {
    keep = containOf(ws)
  } catch (err) {
    return { failed: `could not start — ${err.message}` }
  }
  const missing = reads.find(dir => !existsSync(dir))
  if (missing) return { failed: `could not start — ${missing}, which it is let read, is not there` }
  const scratch = mkdtempSync(join(tmpdir(), 'spore-route-'))
  try {
    mkdirSync(join(scratch, 'out'))
    const errAbs = join(scratch, 'err')
    const ran = await runShell({
      command: [quote(program), quote(origin), quote(event ?? ''), quote(ref), quote(headers ?? '')].join(' '),
      cwd: scratch,
      inAbs: payload,
      outAbs: '/dev/null',
      errAbs,
      confine: { writeRoot: scratch, reads: [...programReads, ...(delivery ? [delivery] : []), ...reads], scopeSignals: true, contain, keep },
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      timeoutMs,
      idleMs: timeoutMs
    })
    if (ran.spawnError) return { failed: `could not start — ${ran.spawnError}` }
    if (ran.killed) return { failed: `was stopped after ${timeoutMs / 1000} s` }
    if (ran.exit !== 0) {
      const said = readFileSync(errAbs, 'utf8').trim().split('\n').at(-1)
      return { failed: `exited ${ran.exit ?? ran.signal}${said ? ` — ${said}` : ''}` }
    }
    const checked = attachedIn(join(scratch, 'out'), attach)
    if (checked.failed) return checked
    mkdirSync(join(ws, into), { recursive: true })
    return {
      files: checked.found.map(file => {
        copyFileSync(file.path, join(ws, into, file.name))
        return { path: `${into}/${file.name}`, name: file.name, mime: mimeOf(join(ws, into, file.name)), bytes: file.bytes }
      })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
