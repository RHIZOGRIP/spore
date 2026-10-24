/**
 * A cell outside any turn: a precursor of a spore, run for a host that is not a turn — a webhook's
 * triage, a schedule's, a command's. `spore-spawn --standalone` starts its own model session, or
 * reaches the host's gate under the spore's `auth`, with a key of its own and the precursor's
 * hard cost; this prepares its directory, waits for it,
 * and records the run in the spore, so its spend is the spore's whatever asked for it. Contract:
 * ARCHITECTURE.md, "A cell outside any turn".
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseDefinition } from '../delegation/definition.js'
import { containing, readConfig, spendLimits } from '../library/config.js'
import { paused, spendStop } from './admission.js'
import { containOf } from './plugins.js'
import { CHATGPT_HELPER, SESSION } from './send.js'
import { PRECURSOR_DIR, definitionPath, readTurns, recordCell } from './spore-dir.js'
import { TOOL_NAMES } from './tool-names.js'

export const SPAWN_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', 'spore-spawn')

const PROMPT = 'in.md'
const ANSWER = 'data/answer.md'

/** Past the cell's own hard wall, which `spore-spawn` enforces: only a supervisor that hangs. */
const BEYOND_WALL_MS = 30_000

/** An origin as one path segment: `hook:forge` is `hook-forge`. */
export const slugOf = (origin) => origin.replace(/[^a-z0-9._-]/gi, '-')

export const cellsRoot = (env) => join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'spore', 'cells')

/**
 * `spore-spawn --standalone` for a cell already prepared, waited for.
 *
 * @returns {Promise<{ answer: string|null, costUsd: number, durationMs: number, failed: string|null }>}
 */
export function launchStandalone ({ ws, precursor, cellWs, prompt, answer, model, auth, env, wallMs, dream = false, signal = null }) {
  const startedAt = Date.now()
  const config = readConfig()
  const spend = spendLimits(config)
  let keep
  try {
    keep = containOf(ws, { config })
  } catch (err) {
    return Promise.resolve({ answer: null, costUsd: 0, durationMs: 0, failed: `could not start — ${err.message}` })
  }
  return new Promise(resolve => {
    const child = spawn(SPAWN_BIN, [
      '--standalone',
      ...(dream ? ['--super'] : []),
      '--node', process.execPath,
      '--session', SESSION,
      '--chatgpt-helper', CHATGPT_HELPER,
      '--precursor', precursor,
      '--ws', cellWs,
      '--prompt', prompt,
      '--answer', answer,
      ...(spend.day === null ? [] : ['--spend-per-day', String(spend.day)]),
      ...(spend.month === null ? [] : ['--spend-per-month', String(spend.month)]),
      ...(containing(config) ? [] : ['--no-contain']),
      ...(keep.length ? ['--contain-keep', JSON.stringify(keep)] : []),
      ...(config.gate ? ['--gate', config.gate] : []),
      ...(config.gate && auth ? ['--auth', auth] : [])
    ], { cwd: ws, env: { ...env, MODEL: model }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), wallMs + BEYOND_WALL_MS)
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    const done = (failure) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      const [turn] = existsSync(join(cellWs, 'state.sqlite')) ? readTurns(cellWs) : []
      const written = join(cellWs, answer)
      resolve({
        answer: existsSync(written) ? readFileSync(written, 'utf8') : null,
        costUsd: turn?.treeUsd ?? 0,
        durationMs: Date.now() - startedAt,
        failed: failure
      })
    }
    child.on('error', err => done(`could not start — ${err.message}`))
    child.on('close', (code, signal) => {
      const said = stderr.trim().split('\n').at(-1)
      done(code === 0 ? null : `ended ${code ?? signal}${said ? ` — ${said}` : ''}`)
    })
  })
}

/**
 * Runs `precursor` — `precursors/<precursor>.cmk` in `ws` — outside any turn: in a directory of its
 * own under the state home, holding `files` (`{ name: path }`), `contents` (`{ name: text }`) and
 * `briefing` as its prompt, on the precursor's model or the spore's. `origin` says who asked
 * (`hook:forge`), `ref` what for. `starting(wallMs)` is told before it starts. Every run that
 * starts is recorded in `ws`.
 *
 * `dream`, `{ wallMs, recorded }`, runs it as the spore's dream: a super cell, its wall the lower
 * of its own and `wallMs`, and `recorded()`'s fields added to its record once it has ended.
 * `signal` stops it as a stop reaches a turn, and the run is recorded as it ended.
 *
 * @returns {Promise<{ answer: string|null, failed: string|null, started: boolean, costUsd: number, durationMs: number, cellWs: string|null }>}
 */
export async function runCell ({ ws, precursor, origin, ref = null, files = {}, contents = {}, briefing, env, starting = () => {}, launch = launchStandalone, now = Date.now, dream = null, signal = null }) {
  const unstarted = (failed) => ({ answer: null, failed, started: false, costUsd: 0, durationMs: 0, cellWs: null })
  if (paused()) return unstarted('spores are paused')
  const stopped = spendStop()
  if (stopped) return unstarted(stopped.message)
  const cell = parseDefinition(readFileSync(join(ws, PRECURSOR_DIR, `${precursor}.cmk`), 'utf8'), { knownTools: TOOL_NAMES, cell: true })
  if (cell.error) return unstarted(`${PRECURSOR_DIR}/${precursor}.cmk ${cell.error}`)
  const root = parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
  if (root.error) return unstarted(`spore.cmk ${root.error}`)

  const named = Object.fromEntries((root.cellModels ?? []).map(entry => [entry.name, entry.model]))
  const naming = Object.keys(named).length > 0 && cell.model !== undefined
  if (naming && !Object.hasOwn(named, cell.model)) return unstarted(`${PRECURSOR_DIR}/${precursor}.cmk runs on the cell model "${cell.model}", which this spore's cell-models does not have — it has ${Object.keys(named).join(', ')}`)
  const model = naming ? named[cell.model] : root.model

  const cellWs = join(cellsRoot(env), basename(ws), slugOf(origin), `${now()}-${randomBytes(3).toString('hex')}`)
  mkdirSync(join(cellWs, 'data'), { recursive: true })
  for (const [name, from] of Object.entries(files)) {
    mkdirSync(dirname(join(cellWs, name)), { recursive: true })
    copyFileSync(from, join(cellWs, name))
  }
  for (const [name, text] of Object.entries(contents)) writeFileSync(join(cellWs, name), text)
  writeFileSync(join(cellWs, PROMPT), briefing)

  const wallMs = dream ? Math.min(cell.limits.wall.hard, dream.wallMs) : cell.limits.wall.hard
  starting(wallMs)
  const ran = await launch({ ws, precursor, cellWs, prompt: PROMPT, answer: ANSWER, model, auth: root.auth, env: { ...env, ...(naming ? { SPORE_CELL_MODELS: JSON.stringify(named) } : {}) }, wallMs, dream: Boolean(dream), signal })
  const failed = ran.failed ?? (ran.answer === null ? 'gave no answer' : null)
  recordCell(ws, {
    precursor,
    origin,
    ...(ref === null ? {} : { ref }),
    cellWs,
    ...(failed ? { error: failed } : { answer: ran.answer }),
    costUsd: ran.costUsd,
    durationMs: ran.durationMs,
    ...(dream ? dream.recorded() : {})
  })
  return { answer: failed ? null : ran.answer, failed, started: true, costUsd: ran.costUsd, durationMs: ran.durationMs, cellWs }
}
