#!/usr/bin/env node
/**
 * `$SPORE_SOURCE` — call a named endpoint and put what it says in a file.
 *
 * A program rather than a tool, for the reason `spawn` and `fanout` are: the call contract
 * is already the right shape. The response goes to `--out`, the exit code is the only
 * success signal, and nothing enters context until the agent reads the file.
 *
 * The name is all this carries. What it resolves to, and any credential it needs, belong
 * to the runner on the other end of the socket.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import minimist from 'minimist'

import { createSourceClient } from '../src/infra/source-client.js'
import { readTreeKey } from '../src/core/spore-dir.js'

// Every value as written: read as a number, an id past 2^53 would reach the endpoint changed.
const named = process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => arg.slice(2).split('=')[0])
const argv = minimist(process.argv.slice(2), { string: named.filter(name => !['list', 'help'].includes(name)) })
const [source] = argv._

if (argv.help || (!source && !argv.list)) {
  console.log(`source — ask a named endpoint for data

Usage:
  node "$SPORE_SOURCE" <name> [--<param> <value>]... --out <file>
  node "$SPORE_SOURCE" <name> --method POST --path <path> --body <file.json> --out <file>
  node "$SPORE_SOURCE" --list

  --out     where the response is written, byte for byte, under data/ — or -, to
            stdout, for a program run under exec, whose stdout the call's out
            already holds
  --method  for a source that allows more than one, as --list shows
  --path    under the source's address, for a source that lists paths
  --body    a JSON file sent as the request body
  --list    the sources this spore was granted, and what it may ask each for

Anything else you pass becomes a query parameter. What a name means, and any key it
needs, is the host's — you get the answer and never the address.`)
  process.exit(argv.help ? 0 : 2)
}

const fail = (problem, detail) => {
  console.error(`source: ${problem}${detail ? ` — ${detail}` : ''}`)
  process.exit(1)
}

const socketPath = process.env.SPORE_SOURCE_SOCKET
if (!socketPath) fail('no source broker', 'this spore was granted no sources')

let view
try {
  view = process.env.SPORE_SOURCES ? JSON.parse(process.env.SPORE_SOURCES) : undefined
} catch (e) {
  fail('SPORE_SOURCES is not readable JSON', e.message)
}
const client = createSourceClient({ socketPath, key: readTreeKey(process.cwd()), view })

if (argv.list) {
  const { sources } = await client.list().catch(e => fail(e.message, e.detail))
  for (const { name, scope, methods, base, paths } of sources) {
    const narrowed = Object.entries(scope).map(([param, values]) => `${param}: ${values.join(', ')}`)
    if (methods) narrowed.push(`methods: ${methods.join(', ')}`)
    if (paths) narrowed.push(`paths: ${paths.join(', ')} under ${base}`)
    console.log(narrowed.length ? `${name.padEnd(12)} ${narrowed.join('  ')}` : name)
  }
  process.exit(0)
}

if (!argv.out) fail('--out is required', 'a response goes to a file, not into the answer')

const params = Object.fromEntries(
  Object.entries(argv).filter(([k]) => !['_', 'out', 'list', 'help', 'method', 'path', 'body'].includes(k))
)

let body
if (argv.body) {
  try {
    body = JSON.parse(readFileSync(resolve(process.cwd(), argv.body), 'utf8'))
  } catch (e) {
    fail(`--body ${argv.body} is not a readable JSON file`, e.message)
  }
}

try {
  const answer = await client.fetch(source, params, { method: argv.method, path: argv.path, body })
  const said = Buffer.from(answer.bodyBase64, 'base64')
  const summary = JSON.stringify({ source, status: answer.status, ok: answer.ok, bytes: said.length, out: argv.out })
  if (argv.out === '-') {
    process.stdout.write(said)
    console.error(summary)
  } else {
    writeFileSync(resolve(process.cwd(), argv.out), said)
    console.log(summary)
  }
  // An endpoint that answered with an error answered: the file holds what it said, and
  // the exit code says the call did not get what it asked for.
  process.exit(answer.ok ? 0 : 1)
} catch (e) {
  fail(e.message, e.detail)
}
