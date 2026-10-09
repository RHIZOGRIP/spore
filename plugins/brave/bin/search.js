#!/usr/bin/env node
/**
 * `$SPORE_BRAVE <query>` — a web search through the `brave` source, its results on stdout.
 *
 * The call is `$SPORE_SOURCE`'s, so the address and the key stay with the runner; this only
 * asks for the body on stdout, which under `exec` the call's `out` already holds, and turns it
 * into what an agent reads.
 */

import { spawnSync } from 'node:child_process'

import { searchResults } from '../src/results.js'

const fail = (problem) => {
  console.error(`search: ${problem}`)
  process.exit(1)
}

const query = process.argv.slice(2).join(' ').trim()
if (!query) {
  console.error('search: what to search for? — "$SPORE_BRAVE" <words>')
  process.exit(2)
}
if (!process.env.SPORE_SOURCE) fail('no $SPORE_SOURCE — this runs inside a spore')

const asked = spawnSync(process.execPath, [process.env.SPORE_SOURCE, 'brave', '--q', query, '--out', '-'], { encoding: 'utf8' })
const said = asked.stderr.trim().split('\n').at(-1)
let call
try {
  call = JSON.parse(said)
} catch {
  process.stderr.write(asked.stderr)
  process.exit(asked.status ?? 1)
}

try {
  console.log(searchResults({ status: call.status, ok: call.ok, body: asked.stdout }))
} catch (err) {
  fail(err.message)
}
