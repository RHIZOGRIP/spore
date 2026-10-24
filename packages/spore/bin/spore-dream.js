#!/usr/bin/env node
/**
 * The spore's dream, run by its runner under the lock the runner holds: checked again, since
 * something may have been said between the pass that found it due and the lock, then run as a
 * super cell. A stop reaches it as SIGTERM, as it reaches a turn's agent.
 */
import { parseArgs } from 'node:util'

import { dreamDue, runDream } from '../src/core/dream.js'
import { turnSummary } from '../src/core/spore-dir.js'
import { endedIn } from '../src/core/state.js'
import { parsedDefinition } from '../src/delegation/definition.js'

const { values: { ws } } = parseArgs({ options: { ws: { type: 'string' } } })

const stopping = new AbortController()
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopping.abort())

try {
  const definition = parsedDefinition(ws)
  if (definition.error) throw new Error(`spore.cmk ${definition.error}`)
  if (!definition.dream) throw new Error('this spore declares no dream')
  const due = dreamDue(ws, { dream: definition.dream, spore: { state: endedIn(turnSummary(ws).last) } })
  if (!due.due) {
    console.error(`spore: no dream — ${due.why}`)
    process.exit(0)
  }
  const ran = await runDream(ws, { env: process.env, signal: stopping.signal })
  if (ran.failed) {
    console.error(`spore: the dream ${ran.started ? 'ended' : 'did not start'} — ${ran.failed}`)
    process.exit(1)
  }
  console.error(`spore: dreamt — ${ran.changed.removed.length} removed, ${ran.changed.added.length} added, $${ran.costUsd.toFixed(4)}`)
} catch (err) {
  console.error(`spore: the dream did not start — ${err.detail ? `${err.message} — ${err.detail}` : err.message}`)
  process.exit(1)
}
