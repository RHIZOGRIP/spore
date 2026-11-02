#!/usr/bin/env node
/**
 * `$SPORE_BROWSER <command>` — agent-browser, on this spore's own browser. The address carries the
 * endpoint's secret, so it goes to agent-browser in its environment, never in its arguments, which
 * any process can read in /proc.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { ENDPOINT_FILE } from '../src/endpoint-file.js'

const fail = (problem) => {
  console.error(`browser: ${problem}`)
  process.exit(1)
}

const sockets = process.env.SPORE_SOCKET_DIR
if (!sockets) fail('SPORE_SOCKET_DIR is not set — the browser runs only in a spore\'s turn')

let url
try {
  ({ url } = JSON.parse(readFileSync(join(sockets, ENDPOINT_FILE), 'utf8')))
} catch (err) {
  if (err.code === 'EACCES') fail('run it with wsexec — exec cannot reach this spore\'s browser')
  if (err.code !== 'ENOENT') throw err
  fail('this spore has no browser — the browser service is not running, or has not seen this spore yet: spore service ls')
}

const engine = join(dirname(createRequire(import.meta.url).resolve('agent-browser/package.json')), 'bin', `agent-browser-linux-${process.arch}`)
const ran = spawnSync(engine, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, AGENT_BROWSER_CDP: url } })
if (ran.error) throw ran.error
process.exit(ran.status ?? 1)
