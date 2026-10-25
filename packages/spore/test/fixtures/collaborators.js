/**
 * The loop, the kernel and recovery with every collaborator a turn hands them, each one a
 * stand-in that does nothing — so a test names only the collaborator it looks at.
 */

import { loop } from '../../src/core/loop.js'
import { executeTools } from '../../src/core/tool-kernel.js'
import { withRecovery } from '../../src/resilience/recovery.js'
import { createSessionMemory } from '../../src/resilience/session-memory.js'
import { createLedger } from '../../src/infra/ledger.js'
import { silent } from '../../src/observability/logger.js'

export const QUIET = { emit () {}, on () {} }

const UNBOUNDED = { soft: Infinity, hard: Infinity }

// Filled in place, not copied: a test that raises a limit mid-turn changes the object the
// loop holds.
export const loopOf = (over) => {
  if (over.limits) {
    over.limits.cost ??= UNBOUNDED
    over.limits.wall ??= UNBOUNDED
  }
  return loop({
    system: [{ text: 'sys' }],
    describe: () => ({}),
    ledger: createLedger(),
    emitter: QUIET,
    mutators: new Set(),
    terminalTools: new Map(),
    logger: silent,
    onMessage () {},
    interject: () => [],
    relimited: () => [],
    sessionMemory: createSessionMemory({ logger: silent }),
    cacheTtl: '5m',
    reasoning: [],
    initialMessages: [],
    ...over
  })
}

export const kernelOf = (over) => executeTools({ describe: () => ({}), emitter: QUIET, logger: silent, mutators: new Set(), ...over })

export const recoveryOf = (model, over) => withRecovery(model, { sessionMemory: createSessionMemory({ logger: silent }), logger: silent, emitter: QUIET, ...over })
