/**
 * Fan-out: many parts, one precursor, one report — and safe to run again.
 *
 * The mechanics this replaces were carried in the identity prompt: how to size a
 * timeout, how to wait without spending a round per check, how to stop early, where
 * answers land. That is instruction paid for on every round of every turn, verifying
 * nothing. Here it is code, and it has tests.
 *
 * It is a program, not a tool. Nothing about it reaches the model's schema; the agent
 * runs it with `wsexec` like anything else, and the plain `xargs` form it replaces
 * still works exactly as before.
 */

import { cpSync, existsSync, linkSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

import { DATA_DIR, RUNTIME_FILES, SPAWN_FILE, turnSummary } from '../core/spore-dir.js'

export const ATTEMPT_MARK = '--'

// The suffix is reserved, and only this shape is one: `report--north` and
// `report--south` are two parts, not two attempts at `report`. Splitting on any `--`
// merged them and scheduled whichever sorted last.
const ATTEMPT_SUFFIX = /--(\d+)$/

/** What a workspace says about the attempt that ran there, if one did. */
export function attemptOf (ws) {
  const spawned = resolve(ws, SPAWN_FILE)
  if (!existsSync(spawned)) return null
  let frame = {}
  try {
    frame = JSON.parse(readFileSync(spawned, 'utf8').trim().split('\n').at(-1) || '{}')
  } catch {}
  const turn = turnSummary(ws).last
  return {
    ws,
    started: true,
    // The frame decides, not the turn record. They disagree on purpose under
    // `on-wrap: discard`: the loop answered and the spawn threw the answer away, so
    // there is no file to reduce and the part is unfinished. A start frame has no
    // `answer` at all, which is a cell that began and did not come back.
    answered: Boolean(frame.answer),
    stopReason: frame.stopReason ?? turn?.stopReason ?? null,
    // A frame with an error is a worker that failed after its turn, whatever the turn says.
    ...(frame.error ? { failed: frame.error.detail || frame.error.message } : {}),
    // A cell that died before its turn was written down has only the frame to say.
    cost: turn ? turn.treeUsd : (frame.cost ?? 0)
  }
}

const baseName = (name) => name.replace(ATTEMPT_SUFFIX, '')

/**
 * One entry per part, newest attempt first. Retries are siblings named `<part>--2`,
 * so a hand-rolled fan-out and this one leave the same shape for a first attempt and
 * the plain form keeps working.
 */
export function attempts (partsDir) {
  const dirs = existsSync(partsDir)
    ? readdirSync(partsDir).filter(name => statSync(resolve(partsDir, name)).isDirectory())
    : []
  const byPart = new Map()
  for (const name of dirs.sort()) {
    const part = baseName(name)
    if (!byPart.has(part)) byPart.set(part, [])
    byPart.get(part).push(name)
  }
  return byPart
}

/**
 * What is left to do. Re-running is the retry: a part that answered is skipped, and a
 * part whose workspace was started and did not finish gets a fresh one — its own is
 * spent, since a workspace holding `spawn.json` is refused a second run. Working that
 * out was previously left to the agent, and it is where a killed fan-out stranded.
 */
export function planFanout (partsDir, { prompt }) {
  const plan = { run: [], done: [], skipped: [] }

  for (const [part, dirs] of attempts(partsDir)) {
    const results = dirs.map(dir => attemptOf(resolve(partsDir, dir))).filter(Boolean)
    const answered = results.find(r => r.answered)
    if (answered) {
      plan.done.push({ part, ...answered })
      continue
    }
    if (!results.length) {
      // The base directory, or a retry staged by a run that was interrupted before
      // it could start it — reused rather than abandoned, or every interruption
      // would leave an empty workspace behind and number past it.
      plan.run.push({ part, ws: resolve(partsDir, dirs.at(-1)), from: null })
      continue
    }
    const source = resolve(partsDir, dirs[0])
    if (!existsSync(resolve(source, prompt))) {
      plan.skipped.push({ part, reason: `no ${prompt} to retry from` })
      continue
    }
    // Numbered by attempts that ran: the base directory is the first.
    plan.run.push({ part, ws: resolve(partsDir, `${part}${ATTEMPT_MARK}${results.length + 1}`), from: source })
  }
  return plan
}

// What a run leaves behind, which a retry must not inherit: a workspace holding any of
// these has already been used, and `planSpawn` refuses it.
const SPENT = new Set([...RUNTIME_FILES, 'spore.cmk', 'calls', 'home', 'node_modules', 'reference.md', 'libraries.md', 'enzyme.js'])

/**
 * Copy that keeps a hardlink a hardlink.
 *
 * `cpSync` does not: material staged into a part by linking — which is how one 23 MB
 * file is shared by fifty parts without being written fifty times — came back as a real
 * copy the moment a part was retried. Measured on a fan-out of eight: 24 MB became
 * 214 MB.
 */
function relink (from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) relink(join(from, entry), join(to, entry))
    return
  }
  try {
    linkSync(from, to)
  } catch (err) {
    // A different filesystem, or one that refuses links. Both are real, both mean copy.
    if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'EMLINK') throw err
    cpSync(from, to)
  }
}

/**
 * A retry workspace is fresh, so the material has to be put back into it — all of it.
 * Copying only the prompt was enough for a self-contained one and silently wrong for
 * everything else: a prompt saying "read data/input.csv" arrived without the CSV.
 *
 * What a part directory holds before its first run is its material, so that is what a
 * retry gets. What the previous run *produced* is left behind, since a cell that half
 * finished should not hand its own leavings to the next attempt as input.
 */
export function stageAttempt ({ ws, from }, prompt) {
  mkdirSync(ws, { recursive: true })
  if (!from) return ws
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SPENT.has(entry.name)) continue
    // `data/` is the cell's own output directory. Its prompt and inputs live beside it.
    if (entry.name === DATA_DIR) continue
    relink(join(from, entry.name), join(ws, entry.name))
  }
  if (!existsSync(join(ws, prompt))) copyFileSync(join(from, prompt), join(ws, prompt))
  return ws
}

/**
 * Stop paying for the rest when the first few fail the same way. A run of identical
 * stop reasons with nothing answered is the shape of a broken precursor or a broken
 * tool, not of work that happens to be hard.
 */
export function failingAlike (results, threshold) {
  if (results.length < threshold) return null
  if (results.some(r => r.answered)) return null
  const recent = results.slice(-threshold)
  const reason = recent[0].stopReason
  return recent.every(r => r.stopReason === reason) ? reason : null
}
