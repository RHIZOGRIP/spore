#!/usr/bin/env node
/**
 * recall — ask long-term memory for something, in words.
 *
 *   node "$SPORE_RECALL" the camera gear they mentioned
 *
 * A program, not a tool, for the reason `fanout.js` gives: instruction is paid for on
 * every round of every turn and verifies nothing, while a program is code with tests.
 *
 * This is the deliberate half of memory. The runtime already surfaces what resembles the
 * turn in front of it, unasked — but an agent that notices it does not know something can
 * ask, and ask wider: `pull` retrieves at turn size and hands back the section around each
 * hit rather than the line alone. Measured over 470 instances, that reaches 80% of the
 * evidence where retrieving whole sessions reaches 85% for twice the tokens.
 *
 * It reads. It never writes, so it runs under `exec` as happily as `wsexec`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseDefinition } from '../src/delegation/definition.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { DEFINITION_FILE, readTreeKey, readSaidSoFar } from '../src/core/spore-dir.js'
import { openStore } from '../src/memory/store.js'
import { createModelClient } from '../src/infra/model-client.js'

const phrase = process.argv.slice(2).join(' ').trim()

const fail = (message) => {
  console.error(`recall: ${message}`)
  process.exit(2)
}

if (!phrase || phrase === '--help' || phrase === '-h') {
  console.log(`recall — ask long-term memory for something, in words

  recall <phrase>

Words, not a pattern: this is not grep. Describe what you are trying to remember and the
closest things written down come back, each with where it came from.`)
  process.exit(phrase ? 0 : 2)
}

const ws = process.cwd()
const definition = resolve(ws, DEFINITION_FILE)
if (!existsSync(definition)) fail(`no ${DEFINITION_FILE} here — recall runs in a workspace`)

const parsed = parseDefinition(readFileSync(definition, 'utf8'), { knownTools: TOOL_NAMES })
if (parsed.error) fail(`${DEFINITION_FILE} ${parsed.error}`)
if (!parsed.memory) fail(`this workspace keeps no long-term memory — add a memory backend to ${DEFINITION_FILE} if it should`)

// Everything except the turn being answered. A deliberate question may reach anywhere in
// the record — that is the point of asking — but the message the agent is answering right
// now is already in front of it, and returning it spends a slot saying so.
//
// By position, not by resemblance. The store used to veto any hit whose text contained
// the query, which suppressed the right answer whenever the query was a good prefix of
// it: searching `project release password` lost the note reading `Project release
// password is marigold.`
const said = readSaidSoFar(ws).length
const key = readTreeKey(ws)
const mo = parsed.memory.embedding
  ? await createModelClient({ socketPath: process.env.SPORE_MODEL_SOCKET, modelIds: [parsed.memory.embedding], key, workspace: ws })
  : null
const hits = await openStore(ws, {
  ...parsed.memory,
  horizon: Math.max(0, said - 1),
  socket: process.env.SPORE_STORE_SOCKET,
  key,
  mo
}).pull(phrase)

if (!hits.length) {
  console.log(`nothing recalled for "${phrase}"`)
  process.exit(0)
}

for (const hit of hits) {
  console.log(`--- ${hit.anchor.path}:${hit.anchor.line}`)
  console.log(hit.text)
}
