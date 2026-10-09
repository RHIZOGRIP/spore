#!/usr/bin/env node
/**
 * `$SPORE_DISCORD history <channel> [--before <message>] [--limit <n>]` — what was said in a
 * channel, oldest first, through the `discord` source, so the bot's token stays with the runner.
 */

import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { historyLines } from '../src/forward.js'

const USAGE = '"$SPORE_DISCORD" history <channel> [--before <message>] [--limit <1-100>]'

const fail = (problem, code = 1) => {
  console.error(`discord: ${problem}`)
  process.exit(code)
}

let parsed
try {
  parsed = parseArgs({ allowPositionals: true, options: { before: { type: 'string' }, limit: { type: 'string', default: '50' } } })
} catch (err) {
  fail(`${err.message} — ${USAGE}`, 2)
}
const [verb, channel] = parsed.positionals
if (verb !== 'history' || !/^\d+$/.test(channel ?? '')) fail(USAGE, 2)
if (!/^\d+$/.test(parsed.values.limit) || Number(parsed.values.limit) < 1 || Number(parsed.values.limit) > 100) fail(`--limit is 1 to 100 — ${USAGE}`, 2)
if (parsed.values.before !== undefined && !/^\d+$/.test(parsed.values.before)) fail(`--before is a message id — ${USAGE}`, 2)
if (!process.env.SPORE_SOURCE) fail('no $SPORE_SOURCE — this runs inside a spore')

const asked = spawnSync(process.execPath, [
  process.env.SPORE_SOURCE, 'discord', '--path', `${channel}/messages`, '--limit', parsed.values.limit,
  ...(parsed.values.before ? ['--before', parsed.values.before] : []),
  '--out', '-'
], { encoding: 'utf8' })
const said = asked.stderr.trim().split('\n').at(-1)
let call
try {
  call = JSON.parse(said)
} catch {
  process.stderr.write(asked.stderr)
  process.exit(asked.status ?? 1)
}
if (!call.ok) fail(`Discord answered ${call.status}: ${asked.stdout.slice(0, 300)}`)

let messages
try {
  messages = JSON.parse(asked.stdout)
} catch (err) {
  fail(`Discord's answer is not JSON — ${err.message}`)
}
console.log(historyLines(messages).join('\n'))
