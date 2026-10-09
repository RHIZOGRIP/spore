#!/usr/bin/env node
/**
 * A job's supervisor, started detached by the runner when a turn runs `$SPORE_JOB start`. It
 * answers one JSON line on stdout — the job begun, or why not — and lets go of stdout; what it
 * does after is in its job's `data/jobs/<name>/supervisor.log` and `t_jobs`. Contract:
 * src/core/job.js.
 */

import { closeSync, writeSync } from 'node:fs'

import minimist from 'minimist'

import { loadEnvironment } from '../src/library/config.js'
import { superviseJob } from '../src/core/job.js'

const argv = minimist(process.argv.slice(2), { string: ['ws', 'name', 'count', 'wall', 'command'] })

let answered = false
const answer = (line) => {
  writeSync(1, JSON.stringify(line) + '\n')
  closeSync(1)
  answered = true
}

const envOf = () => {
  const fresh = { ...process.env }
  loadEnvironment(undefined, fresh)
  return fresh
}

const stopping = new AbortController()
for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => stopping.abort())

try {
  await superviseJob({
    ws: argv.ws,
    name: argv.name,
    count: Number(argv.count),
    wallMs: Number(argv.wall),
    command: argv.command,
    answer,
    env: process.env,
    envOf,
    signal: stopping.signal
  })
} catch (err) {
  if (!answered) answer({ refused: { type: err.type ?? 'JOB_START_FAILED', message: 'the job could not be started', detail: err.message } })
  process.exitCode = 1
}
