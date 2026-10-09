#!/usr/bin/env node
/**
 * fanout — run one precursor over many parts, join, report, and be safe to re-run.
 * Contract: ARCHITECTURE.md, "Fan-out".
 *
 * A program, not a tool: reached as `$SPORE_FANOUT`, in no schema. The `xargs` form
 * it replaces still works; this one carries the parts that were previously carried by
 * instructions — sizing the wait, joining without spending a round per check,
 * stopping early, and knowing that a workspace which already ran cannot run again.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import minimist from 'minimist'

import { parseDefinition } from '../src/delegation/definition.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { attemptOf, failingAlike, planFanout, stageAttempt } from '../src/delegation/fanout.js'

const SPAWN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'spore-spawn')
const FAIL_ALIKE = 3
const WAVE_SLACK_MS = 30_000
const SPAWN_ERR = 'spawn.err'
// Under the 120 s a command may go silent before exec kills it as idle.
const HEARTBEAT_MS = 60_000

const lastLine = (text) => text.trim().split('\n').filter(Boolean).at(-1) || null

const argv = minimist(process.argv.slice(2), {
  string: ['precursor', 'parts', 'prompt', 'answer'],
  boolean: ['help'],
  default: { prompt: 'in.md', answer: 'data/out.json', width: 8 },
  alias: { h: 'help' }
})

if (argv.help) {
  console.log(`fanout — one precursor over many parts

Usage:
  fanout --precursor <name> --parts <dir> [--prompt in.md] [--answer data/out.json]
         [--width 8] [--timeout <seconds>]

Each subdirectory of --parts is one part and holds its own --prompt file. Run it
again to finish what is unfinished: a part that answered is left alone, and one whose
workspace was started and did not finish is retried in a fresh <part>--2 beside it,
because a workspace that has run cannot run again.

Stops early when the first ${FAIL_ALIKE} finished parts all stopped the same way and none
answered. Prints one JSON report.`)
  process.exit(0)
}

const fail = (message) => {
  console.error(`fanout: ${message}`)
  process.exit(2)
}

if (!argv.precursor || !argv.parts) fail('--precursor and --parts are both required')
const partsDir = resolve(process.cwd(), argv.parts)
if (!existsSync(partsDir)) fail(`no such directory — ${argv.parts}`)

// The precursor's own hard wall is what a part is allowed; the deadline is that times
// the number of waves. Sizing this by hand was the instruction most often got wrong,
// and getting it wrong killed the fan-out and every cell in it.
const precursorPath = resolve(process.cwd(), 'precursors', `${argv.precursor}.cmk`)
if (!existsSync(precursorPath)) fail(`no precursor named ${argv.precursor}`)
const definition = parseDefinition(readFileSync(precursorPath, 'utf8'), { knownTools: TOOL_NAMES, cell: true })
if (definition.error) fail(`precursor ${argv.precursor} ${definition.error}`)

const width = Math.max(1, Number(argv.width) || 8)
const plan = planFanout(partsDir, { prompt: argv.prompt })
const waves = Math.ceil(plan.run.length / width) || 1
const deadline = Date.now() + (Number(argv.timeout) * 1000 || waves * definition.limits.wall.hard + WAVE_SLACK_MS)

const results = [...plan.done]
const running = new Map()
let stoppedEarly = null

const startOne = (entry) => {
  const ws = stageAttempt(entry, argv.prompt)
  // stdout is the spawn frame, which the workspace also holds; stderr is why a spawn
  // that never got as far as a frame did not. Discarding it left a part reporting
  // `stopReason: null` with nothing anywhere to say what happened — measured against a
  // enzyme-broker socket that could not bind, where every part failed identically and
  // silently and the agent went and did the work by hand instead.
  const child = spawn(SPAWN, [
    '--precursor', argv.precursor,
    '--ws', relative(process.cwd(), ws),
    '--prompt', argv.prompt,
    '--answer', argv.answer
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env })

  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  running.set(child, entry)
  child.on('close', () => {
    running.delete(child)
    const attempt = attemptOf(ws)
    if ((!attempt || attempt.failed) && stderr.trim()) writeFileSync(resolve(ws, SPAWN_ERR), stderr)
    results.push({
      part: entry.part,
      ...(attempt || { ws, started: false, answered: false, stopReason: null, cost: 0 }),
      // The last line rather than the whole of it: a stack trace belongs in the file,
      // and what the reducer needs is the sentence naming the cause.
      ...(attempt ? {} : { failed: lastLine(stderr) })
    })
    const ended = results.at(-1)
    progress(`${entry.part} ${ended.answered ? 'answered' : ended.failed ? `failed (${ended.failed})` : `unfinished (${ended.stopReason ?? 'no frame'})`}`)
  })
  return child
}

// The parts this run is accountable for, fixed before anything starts. Every one of
// them ends the run as answered, unfinished, skipped or never-started — dropping the
// ones an early stop never reached made a batch look smaller than it was.
const scheduled = [...plan.run]
const pending = [...plan.run]
let neverStarted = []
let lastSaid = Date.now()

function progress (what) {
  const ended = results.length - plan.done.length
  process.stderr.write(`fanout: ${what} — ${ended} of ${scheduled.length} ended, ${running.size} running\n`)
  lastSaid = Date.now()
}

for (;;) {
  if (stoppedEarly === null && Date.now() < deadline) {
    while (pending.length && running.size < width) startOne(pending.shift())
  }
  if (!running.size) break
  await new Promise(resolve => setTimeout(resolve, 200))
  if (Date.now() - lastSaid >= HEARTBEAT_MS) progress('waiting')

  stoppedEarly = stoppedEarly ?? failingAlike(results.filter(r => r.started), FAIL_ALIKE)
  if (stoppedEarly !== null || Date.now() >= deadline) {
    for (const child of running.keys()) child.kill('SIGTERM')
    neverStarted = pending.splice(0).map(entry => ({ part: entry.part }))
  }
}

const answered = results.filter(r => r.answered)
const unfinished = results.filter(r => !r.answered).map(r => ({ part: r.part, stopReason: r.stopReason }))
const parts = plan.done.length + scheduled.length + plan.skipped.length

console.log(JSON.stringify({
  precursor: argv.precursor,
  parts,
  answered: answered.length,
  unfinished,
  // A part that never produced a frame has no stop reason to give, so what it has
  // instead is the reason its spawn died.
  failed: results.filter(r => r.failed).map(r => ({ part: r.part, error: r.failed })),
  neverStarted,
  skipped: plan.skipped,
  cost: Math.round(results.reduce((total, r) => total + (r.cost || 0), 0) * 1000000) / 1000000,
  stoppedEarly,
  timedOut: Date.now() >= deadline || undefined,
  answers: answered.map(r => relative(process.cwd(), resolve(r.ws, argv.answer)))
}))

// Success is every part answered. Comparing answers against collected results only
// said "nothing failed among the things that ran", so a batch whose one part was
// skipped for a missing prompt exited 0 with nothing done.
process.exit(answered.length === parts ? 0 : 1)
