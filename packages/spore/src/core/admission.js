/**
 * How many of a user's turns may run at once, held by the kernel — and whether any may
 * start at all: a pause is a mark beside the slots, and no slot is given while it is there.
 *
 * `turns` slot files; a turn holds one `flock` from before its message is said until its
 * runner exits, and a runner that dies frees its slot however it dies.
 *
 * The directory is outside every path the sandbox grants. `flock` needs only a readable
 * descriptor, so a slot an agent could open is a slot an agent could hold.
 *
 * Under caller admission (`admission: caller`) the program in front of spore bounds the turns,
 * so no slot is taken; the pause still holds.
 */

import { closeSync } from 'node:fs'

import { callerAdmits, readConfig } from '../library/config.js'
import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

export const SLOT_DIR = native.slotDir()

export const DEFAULT_TURNS = native.defaultTurns()

const refused = (error, context) => new SporeError(error.message, { type: error.type, retryable: true, detail: error.detail, context })

/**
 * A free slot, held by this process until `fd` closes — under the admission `configFile` names.
 * Refused while the user's spores are paused (`PAUSED`) and when every one is held
 * (`ADMISSION_FULL`): nothing waits here, because waiting is a policy and it belongs to the
 * caller. Under caller admission it takes none, `{ fd: null, path: null }`, and only the pause
 * refuses. The rule is `rust/workspace`'s.
 *
 * @returns {{ fd: number|null, path: string|null }}
 */
export function takeSlot (configFile) {
  const config = readConfig(configFile)
  if (callerAdmits(config)) {
    refusePaused()
    return { fd: null, path: null }
  }
  const turns = config.turns ?? DEFAULT_TURNS
  const taken = JSON.parse(native.takeSlot(turns, SLOT_DIR))
  if (taken.error) throw refused(taken.error, { turns, dir: SLOT_DIR })
  return taken
}

/** Throws `PAUSED` while the user's spores are paused; under caller admission, what admits a turn or a delivery. */
export function refusePaused () {
  const admitted = JSON.parse(native.admit(SLOT_DIR))
  if (admitted.error) throw refused(admitted.error, { dir: SLOT_DIR })
}

/** `then(slot)` with a slot `takeSlot(configFile)` took, let go on every way out: a runner `then` starts holds its own. */
export function withSlot (configFile, then) {
  const slot = takeSlot(configFile)
  try {
    return then(slot)
  } finally {
    if (slot.fd !== null) closeSync(slot.fd)
  }
}

/** The pause in force on the user's spores — `{ at, why? }` — or null. */
export function paused ({ dir = SLOT_DIR } = {}) {
  const mark = native.paused(dir)
  return mark === null ? null : JSON.parse(mark)
}

/** Marks the user's spores paused, the first mark standing: `{ mark, already }`. */
export function pauseSpores ({ why } = {}) {
  return JSON.parse(native.pause(SLOT_DIR, why ?? null))
}

/** Lifts the pause; false when there was none. */
export function unpauseSpores () {
  return native.unpause(SLOT_DIR)
}
