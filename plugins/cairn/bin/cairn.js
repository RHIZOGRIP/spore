#!/usr/bin/env node
/**
 * `$SPORE_CAIRN` — the cairns this spore reads, and writing to them.
 *
 *   "$SPORE_CAIRN" list
 *   "$SPORE_CAIRN" <cairn> .tables | '.schema <view>' | [--json] '<sql>'
 *   "$SPORE_CAIRN" <cairn> append <kind> [--refs <json>] [--data <json>] [--at <time>] [--expected-head <seq>]
 *   "$SPORE_CAIRN" <cairn> evidence <file>
 *   "$SPORE_CAIRN" <cairn> subscribe|unsubscribe <kind>...
 *
 * A cairn is read where its `reads:` grant links it, `$SPORE_WS/cairn-<cairn>`, and written
 * through the source `cairn-<cairn>`, whose runner adds the token and who is writing. The body
 * goes to the source on stdin, so a write needs no writable file and runs under `exec`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = `"$SPORE_CAIRN" list
"$SPORE_CAIRN" <cairn> .tables | '.schema <view>' | [--json] '<sql>'
"$SPORE_CAIRN" <cairn> append <kind> [--refs <json>] [--data <json>] [--at <time>] [--expected-head <seq>]
"$SPORE_CAIRN" <cairn> evidence <file>
"$SPORE_CAIRN" <cairn> subscribe|unsubscribe <kind>...`
const PREFIX = 'cairn-'

const fail = (problem, code = 1) => {
  console.error(`cairn: ${problem}`)
  process.exit(code)
}

const ws = process.env.SPORE_WS
if (!ws || !process.env.SPORE_SQL) fail('no $SPORE_WS or $SPORE_SQL — this runs inside a spore')

const database = (cairn) => join(ws, `${PREFIX}${cairn}`, 'cairn.sqlite')

function sql (cairn, args) {
  const file = database(cairn)
  if (!existsSync(file)) fail(`${cairn} is no cairn this spore reads — "$SPORE_CAIRN" list names the ones it does`)
  return spawnSync(process.execPath, [process.env.SPORE_SQL, file, ...args], { encoding: 'utf8' })
}

function post (cairn, path, body) {
  if (!process.env.SPORE_SOURCE) fail('no $SPORE_SOURCE — this spore was granted no sources')
  const asked = spawnSync(process.execPath, [
    process.env.SPORE_SOURCE, `${PREFIX}${cairn}`, '--method', 'POST', '--path', path, '--body', '-', '--out', '-'
  ], { input: JSON.stringify(body), encoding: 'utf8' })
  let call
  try {
    call = JSON.parse(asked.stderr.trim().split('\n').at(-1))
  } catch {
    process.stderr.write(asked.stderr)
    process.exit(asked.status ?? 1)
  }
  if (call.ok) {
    process.stdout.write(asked.stdout.endsWith('\n') ? asked.stdout : `${asked.stdout}\n`)
    process.exit(0)
  }
  let said
  try {
    said = JSON.parse(asked.stdout).error
  } catch {
    fail(`${cairn} answered ${call.status}: ${asked.stdout.slice(0, 300)}`)
  }
  fail(`${cairn} refused, ${said.type}: ${said.message}${said.detail ? ` (${said.detail})` : ''}`)
}

const [first, ...rest] = process.argv.slice(2)
if (!first) fail(USAGE, 2)

if (first === 'list' && rest.length === 0) {
  for (const entry of readdirSync(ws).filter(entry => entry.startsWith(PREFIX)).sort()) {
    const cairn = entry.slice(PREFIX.length)
    if (!existsSync(database(cairn))) {
      console.log(`${cairn}  not started yet`)
      continue
    }
    const read = sql(cairn, ['--json', 'SELECT seq, at FROM head'])
    if (read.status !== 0) fail(`${cairn}: ${read.stderr.trim()}`)
    const head = JSON.parse(read.stdout)
    console.log(`${cairn}  ${head.seq} entries, the last at ${head.at}`)
  }
  process.exit(0)
}

const cairn = first
const [verb, ...args] = rest

if (verb === 'append') {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { refs: { type: 'string', default: '{}' }, data: { type: 'string', default: '{}' }, at: { type: 'string' }, 'expected-head': { type: 'string' } }
    })
  } catch (err) {
    fail(`${err.message}\n${USAGE}`, 2)
  }
  const [kind, ...extra] = parsed.positionals
  if (!kind || extra.length) fail(USAGE, 2)
  const json = (flag) => {
    try {
      return JSON.parse(parsed.values[flag])
    } catch (err) {
      fail(`--${flag} is not JSON — ${err.message}`, 2)
    }
  }
  const body = { kind, at: parsed.values.at ?? new Date().toISOString(), refs: json('refs'), data: json('data') }
  const expected = parsed.values['expected-head']
  if (expected !== undefined) {
    if (!/^\d+$/.test(expected)) fail('--expected-head is the seq of the head you read', 2)
    body.expectedHead = Number(expected)
  }
  post(cairn, 'append', body)
}

if (verb === 'evidence') {
  if (args.length !== 1) fail(USAGE, 2)
  let bytes
  try {
    bytes = readFileSync(args[0])
  } catch (err) {
    fail(`${args[0]} cannot be read — ${err.message}`)
  }
  post(cairn, 'evidence', { base64: bytes.toString('base64') })
}

if (verb === 'subscribe' || verb === 'unsubscribe') {
  if (!args.length || args.some(arg => arg.startsWith('-'))) fail(USAGE, 2)
  post(cairn, 'append', { kind: `cairn.${verb}`, at: new Date().toISOString(), refs: {}, data: { kinds: args } })
}

if (!verb) fail(USAGE, 2)
const read = sql(cairn, rest)
process.stdout.write(read.stdout)
process.stderr.write(read.stderr)
process.exit(read.status ?? 1)
