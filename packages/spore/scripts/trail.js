#!/usr/bin/env node
/**
 * trail — read back what a run actually did.
 *
 *   trail                 the most recent run
 *   trail <runId>         one run by name
 *   trail --list          every run in the workspace
 *   trail --full          untruncated detail and error text
 *
 * Reads the workspace's `calls`, which the agent writes only through its runner.
 */

import { resolve } from 'node:path'

import chalk from 'chalk'
import minimist from 'minimist'

import { callRuns, readCalls } from '../src/core/call-record.js'

const argv = minimist(process.argv.slice(2), {
  string: ['w', 'workspace'],
  boolean: ['list', 'full', 'help'],
  alias: { w: 'workspace', h: 'help' }
})

if (argv.help) {
  console.log(`trail — read back what a run actually did

Usage:
  trail [runId] [-w <workspace>] [--list] [--full]

  (no runId)  the most recent run
  --list      every run in the workspace, newest first
  --full      untruncated commands and error text`)
  process.exit(0)
}

const WS = resolve(argv.workspace || process.cwd())
const runs = callRuns(WS).map(id => ({ id }))

if (!runs.length) {
  console.error(`trail: no calls recorded in ${WS}`)
  process.exit(1)
}

function callsOf (runId) {
  return readCalls(WS, runId).map(({ record }) => record)
}

const clip = (text, width) => {
  const flat = String(text ?? '').replace(/\s*\n\s*/g, ' ⏎ ')
  if (argv.full || flat.length <= width) return flat
  return flat.slice(0, width - 1) + '…'
}

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const lastAt = (calls) => Math.max(0, ...calls.map(c => (c.startedAt ? Date.parse(c.startedAt) + (c.durationMs || 0) : 0)))
const failed = (c) => c.killed || (c.exit !== 0 && c.exit !== undefined) || c.spawnError

function detail (c) {
  if (c.command) return c.command
  if (c.path) return `${c.path}${c.lines !== undefined ? ` (${c.lines} lines)` : ''}`
  const out = c.files?.out
  return out ? `→ ${out.path} (${out.bytes} B)` : ''
}

if (argv.list) {
  console.log(chalk.bold(`runs in ${WS}\n`))
  for (const run of runs) {
    const calls = callsOf(run.id)
    const bad = calls.filter(failed).length
    console.log(
      '  ' + chalk.cyan(run.id.padEnd(12)) +
      String(calls.length).padStart(3) + ' calls  ' +
      (bad ? chalk.red(`${bad} failed`.padEnd(10)) : ' '.repeat(10)) +
      chalk.dim(when(lastAt(calls)))
    )
  }
  process.exit(0)
}

const runId = argv._[0] || runs[0].id
if (!runs.some(run => run.id === runId)) {
  console.error(`trail: no run ${runId} — try --list`)
  process.exit(1)
}

const calls = callsOf(runId)
const total = calls.reduce((n, c) => n + (c.durationMs || 0), 0)
const bad = calls.filter(failed).length

console.log(
  chalk.bold(`run ${runId}`) +
  chalk.dim(` · ${calls.length} calls · ${(total / 1000).toFixed(1)}s spent in tools` +
    (bad ? '' : ' · all clean') + ` · ${when(lastAt(calls))}\n`)
)

for (const c of calls) {
  const outcome = c.killed ?? c.exit ?? c.signal ?? (c.spawnError ? 'error' : 'ok')
  const status = failed(c)
    ? chalk.red(String(outcome).padEnd(9))
    : chalk.green(String(outcome).padEnd(9))
  console.log(
    '  ' + chalk.dim(c.call?.padEnd(6) ?? '      ') +
    (c.tool || '?').padEnd(8) + status +
    String(c.durationMs ?? '').padStart(6) + 'ms  ' +
    clip(detail(c), 60)
  )
  const err = c.files?.err
  if (failed(c) && err?.content) {
    for (const line of clip(err.content, 200).split(' ⏎ ')) {
      if (line.trim()) console.log(chalk.red('           ' + line))
    }
  }
  if (failed(c) && err && !err.content) {
    console.log(chalk.dim(`           stderr is ${err.bytes} B at ${err.path}`))
  }
}

if (bad) console.log(chalk.red(`\n  ${bad} of ${calls.length} calls failed`))
