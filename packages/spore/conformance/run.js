#!/usr/bin/env node
/**
 * The conformance run: every case, in parallel, graded from the workspace.
 *
 *   npm run test:model                      every case
 *   npm run test:model -- --only core       one tier
 *   npm run test:model -- --only fanout     one case
 *
 * Deliberately not part of `npm test`: it calls a model, so it costs money and needs
 * `$MODEL` and a provider key. `npm test` stays free and offline.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import minimist from 'minimist'
import { loadCuratedCache } from 'mohdel'

import { version } from '../src/index.js'
import { runBatch } from '../src/core/batch.js'
import { send } from '../src/core/send.js'
import { turnSummary } from '../src/core/spore-dir.js'
import { stateOf, stop } from '../src/core/state.js'
import { openWorkspace } from '../src/core/workspace.js'
import { CASES, REFERENCE_PRICE, TIERS, caseLimits, inputPrice, pricedLimits } from './cases.js'
import { LATEST, MANIFEST, provenance, runDir } from './record.js'
import { caseDigest } from './digest.js'
import { runDeadline } from './schedule.js'
import { stage } from './stage.js'
import { grade } from './check.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RUNS = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'spore', 'conformance')

const argv = minimist(process.argv.slice(2), {
  string: ['ws', 'only'],
  boolean: ['help'],
  default: { concurrency: 8, ws: RUNS },
  alias: { h: 'help' }
})

if (argv.help) {
  console.log(`test:model — can a model drive this runtime?

  npm run test:model                   every case
  npm run test:model -- --only core    one tier: ${TIERS.join(', ')}
  npm run test:model -- --only fanout  one case
  npm run test:model -- --ws <dir>     where runs are kept (default ${RUNS})

Each run gets its own directory under --ws, named for when it ran and what it ran on,
with "latest" pointing at the newest. Nothing is deleted: comparing two models, or the
same model before and after a change, means having both runs still on disk. Each keeps
the workspaces, the definitions it generated, and a run.json saying what produced it.

Needs $MODEL and a provider key. Every case is dull on purpose: a model good enough to
use tools should pass all of them, so a failure is either a runtime regression or a model
that cannot drive the loop.`)
  process.exit(0)
}

const fail = (message) => {
  console.error(`test:model: ${message}`)
  process.exit(2)
}

const wanted = CASES.filter(item => !argv.only || item.id === argv.only || item.tier === argv.only)
if (!wanted.length) fail(`nothing matches "${argv.only}"`)
if (!process.env.MODEL) fail('$MODEL is not set — this runs a model and costs money')
const entry = (await loadCuratedCache())[process.env.MODEL]
if (!entry) fail(`${process.env.MODEL} is not an entry of mohdel's catalog here, so its price is unknown — name the model by its catalog id, as mo model show prints it`)
const price = inputPrice(entry)
const limitsOf = (item) => pricedLimits(caseLimits(item), price)

// One directory per run, kept. It used to be one directory, emptied at the start of
// every run: the evidence for "it passed yesterday" was deleted by the run asking.
const RUN_DIR = runDir(resolve(argv.ws), { model: process.env.MODEL })
mkdirSync(RUN_DIR, { recursive: true })
const latest = resolve(resolve(argv.ws), LATEST)
rmSync(latest, { recursive: true, force: true })
try {
  symlinkSync(RUN_DIR, latest)
} catch {
  // A filesystem without symlinks. The run directory is named in the output anyway.
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const started = Date.now()
const deadline = runDeadline(wanted, { concurrency: Number(argv.concurrency), limitsOf })

// Every case staged and opened before any starts, so a definition that does not parse stops
// the run before anything has been spent.
const digests = new Map()
const runs = wanted.map(item => {
  const { ws, cmk } = stage(RUN_DIR, item, process.env.MODEL, limitsOf(item))
  digests.set(item.id, caseDigest({ ws, cmk }, item))
  const opened = openWorkspace(ws, { definition: cmk })
  if (opened.error) fail(`${item.id}: ${opened.error}`)
  return { ws, messages: item.messages ?? [item.prompt], label: item.id, id: ws, schedule: item.schedule }
})
const scheduleOf = new Map(runs.filter(run => run.schedule).map(run => [run.ws, run.schedule]))

// A case the clock speaks in is delivered as `tick` delivers a due schedule.
const deliver = (ws, message, options) => scheduleOf.has(ws)
  ? send(ws, message, { ...options, schedule: { name: scheduleOf.get(ws), due: new Date().toISOString() } })
  : send(ws, message, options)

process.stderr.write(`running ${wanted.length} cases at width ${argv.concurrency}, ${price ? `cost limits × ${price / REFERENCE_PRICE} for $${price}/M input` : 'cost limits as set: the model has no price'}\n`)
const { stuck: left } = await runBatch(runs, { atOnce: Number(argv.concurrency), deadline, deliver, wait: sleep })
const stuck = left.map(run => run.label)
for (const run of left) {
  process.stderr.write(`test:model: ${run.label} never finished — stopping it and grading what it left\n`)
  stop(run.ws)
}

const results = wanted.map(item => {
  const ws = resolve(RUN_DIR, 'cases', item.id)
  const turn = turnSummary(ws).last
  return {
    ...item,
    problems: grade(ws, item),
    spend: stateOf(ws).treeUsd,
    rounds: turn?.rounds ?? null,
    stopReason: turn?.stopReason ?? null,
    error: turn?.error ?? null,
    detail: turn?.detail ?? null,
    wallMs: turn?.startedAt && turn?.endedAt ? Date.parse(turn.endedAt) - Date.parse(turn.startedAt) : null
  }
})

const passed = results.filter(r => !r.problems.length)
for (const tier of TIERS) {
  const rows = results.filter(r => r.tier === tier)
  if (!rows.length) continue
  const ok = rows.filter(r => !r.problems.length).length
  console.log(`\n${tier}  ${ok}/${rows.length}`)
  for (const row of rows) {
    const mark = row.problems.length ? '✗' : '✓'
    console.log(`  ${mark} ${row.id.padEnd(16)} ${String(row.rounds ?? '-').padStart(2)} rounds  ${(row.stopReason || '-').padEnd(12)} $${row.spend.toFixed(4)}  ${row.feature}`)
    for (const problem of row.problems) console.log(`      ${problem}`)
  }
}

const spend = results.reduce((total, r) => total + r.spend, 0)
const elapsedMs = Date.now() - started

writeFileSync(resolve(RUN_DIR, MANIFEST), JSON.stringify({
  ...provenance({ root: ROOT, model: process.env.MODEL, spore: version }),
  startedAt: new Date(started).toISOString(),
  elapsedMs,
  concurrency: Number(argv.concurrency),
  only: argv.only || null,
  inputPrice: price,
  costScale: price ? price / REFERENCE_PRICE : 1,
  passed: passed.length,
  of: results.length,
  spend: Math.round(spend * 1000000) / 1000000,
  neverFinished: stuck,
  cases: results.map(r => ({
    id: r.id,
    digest: digests.get(r.id),
    tier: r.tier,
    feature: r.feature,
    passed: !r.problems.length,
    problems: r.problems,
    rounds: r.rounds,
    stopReason: r.stopReason,
    error: r.error,
    detail: r.detail,
    wallMs: r.wallMs,
    spend: r.spend
  }))
}, null, 2) + '\n')

console.log(`\n${passed.length}/${results.length} · $${spend.toFixed(4)} · ${(elapsedMs / 1000).toFixed(0)}s · ${process.env.MODEL}`)
console.log(`this run at ${RUN_DIR}`)
process.exit(passed.length === results.length ? 0 : 1)
