#!/usr/bin/env node
/**
 * One decision, taken again and again under different definitions.
 *
 *   node scripts/try-definitions.js --run <workspace> --at <call> --into <dir> [--times 20] [--at-once 4] [--replay] [other.cmk …]
 *
 * Forks the run at the call's round `--times` times under its own definition, and as many
 * times under each definition given, then says how often each one delivered — a file under
 * `data/out/`, read from the turn record — and how its turns ended. A failure seen once in
 * a full run is reached every time from a fork, so a handful of forks says what a hundred
 * full runs would.
 *
 * Every fork is a real turn and spends money; the provider keys come from this shell.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import minimist from 'minimist'

import { fork, readTurns } from '../src/index.js'
import { stateOf } from '../src/core/state.js'
import { readCalls } from '../src/core/call-record.js'

const argv = minimist(process.argv.slice(2), { string: ['run', 'at', 'into'], boolean: ['replay'], default: { times: 20, 'at-once': 4 } })
const missing = ['run', 'at', 'into'].filter(key => !argv[key])
if (missing.length) {
  console.error(`try-definitions: missing ${missing.map(key => `--${key}`).join(', ')} — --run <workspace> --at <call> --into <dir> are all required`)
  process.exit(2)
}
const absent = argv._.filter(file => !existsSync(file))
if (absent.length) {
  console.error(`try-definitions: no such definition ${absent.join(', ')} — each extra argument is a .cmk to fork under`)
  process.exit(2)
}
const times = Number(argv.times)
const atOnce = Number(argv['at-once'])

const arms = [{ name: 'as-is', definition: undefined }, ...argv._.map(file => ({ name: basename(file, '.cmk'), definition: resolve(file) }))]
const runs = arms.flatMap(arm => Array.from({ length: times }, (_, i) => ({ arm, into: join(resolve(argv.into), arm.name, String(i + 1).padStart(3, '0')) })))

// Arms interleaved, so drift in the provider over the minutes this takes lands on every arm alike.
runs.sort((a, b) => basename(a.into).localeCompare(basename(b.into)) || arms.indexOf(a.arm) - arms.indexOf(b.arm))

// Whether a fork, after its cut, had an exec refused writing: how often the decision under
// test came up at all, as against how the fork ended.
function refused (run) {
  const { runId, at, replay } = JSON.parse(readFileSync(join(run.into, 'fork.json'), 'utf8'))
  // A replayed round runs its call again, and that run is part of what is being measured.
  const cut = Number(at.split('/')[1]) - (replay ? 1 : 0)
  return readCalls(run.into, runId).filter(({ call, record }) => record && Number(call) > cut).some(({ record: meta }) => {
    const err = meta.files?.err?.path && existsSync(join(run.into, meta.files.err.path)) ? readFileSync(join(run.into, meta.files.err.path), 'utf8') : ''
    return meta.tool === 'exec' && meta.exit !== 0 && /EACCES|EROFS|Permission denied|PermissionError|Read-only file system/.test(err)
  })
}

const ended = (run) => run.started && (stateOf(run.into).lastTurnNo > run.before || stateOf(run.into).state === 'crashed')

for (;;) {
  const going = runs.filter(run => run.started && !ended(run)).length
  let room = atOnce - going
  for (const run of runs) {
    if (room <= 0) break
    if (run.started) continue
    const made = fork({ run: argv.run, at: argv.at, into: run.into, definition: run.arm.definition, replay: argv.replay })
    run.before = stateOf(made.ws).lastTurnNo
    run.started = true
    room--
  }
  if (runs.every(ended)) break
  process.stderr.write(`\r${runs.filter(ended).length}/${runs.length} ended`)
  await new Promise(resolve => setTimeout(resolve, 2000))
}
process.stderr.write('\n')

console.log(`${'definition'.padEnd(20)} ${'runs'.padStart(4)}  ${'delivered'.padStart(12)}  ${'exec refused'.padStart(12)}  ${'rounds'.padStart(6)}  ${'cost'.padStart(8)}  ended`)
for (const arm of arms) {
  const turns = runs.filter(run => run.arm === arm).map(run => readTurns(run.into).at(-1)).filter(Boolean)
  const hit = runs.filter(run => run.arm === arm && refused(run)).length
  const delivered = turns.filter(turn => turn.deliverables?.length).length
  const reasons = {}
  for (const turn of turns) reasons[turn.stopReason ?? 'none'] = (reasons[turn.stopReason ?? 'none'] ?? 0) + 1
  const mean = (key) => turns.length ? turns.reduce((sum, turn) => sum + turn[key], 0) / turns.length : 0
  console.log(`${arm.name.padEnd(20)} ${String(times).padStart(4)}  ${`${delivered} (${Math.round(100 * delivered / times)}%)`.padStart(12)}  ${String(hit).padStart(12)}  ` +
    `${mean('rounds').toFixed(1).padStart(6)}  ${('$' + mean('ownUsd').toFixed(4)).padStart(8)}  ` +
    `${Object.entries(reasons).map(([r, n]) => `${r} ${n}`).join(' · ')}${turns.length < times ? ` · ${times - turns.length} died` : ''}`)
}
