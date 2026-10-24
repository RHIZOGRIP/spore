/**
 * How many of a user's turns may run at once, held by the kernel — and whether any may
 * start at all: a pause is a mark beside the slots, and no slot is given while it is there.
 *
 * `turns` slot files; a turn holds one `flock` from before its message is said until its
 * runner exits, and a runner that dies frees its slot however it dies.
 *
 * The directory is outside every path the sandbox grants. `flock` needs only a readable
 * descriptor, so a slot an agent could open is a slot an agent could hold.
 */

import { closeSync } from 'node:fs'

import { readConfig } from '../library/config.js'
import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

export const SLOT_DIR = native.slotDir()

export const DEFAULT_TURNS = native.defaultTurns()

/**
 * A free slot, held by this process until `fd` closes. Refused while the user's spores are paused
 * (`PAUSED`) and when every one is held (`ADMISSION_FULL`): nothing waits here, because waiting
 * is a policy and it belongs to the caller. The rule is `rust/workspace`'s.
 *
 * @returns {{ fd: number, path: string }}
 */
export function takeSlot ({ config = readConfig(), turns = config.turns ?? DEFAULT_TURNS, dir = SLOT_DIR } = {}) {
  const taken = JSON.parse(native.takeSlot(turns, dir))
  if (taken.error) {
    throw new SporeError(taken.error.message, {
      type: taken.error.type,
      retryable: true,
      detail: taken.error.detail,
      context: { turns, dir }
    })
  }
  return taken
}

/** `then(slot)` with a slot `takeSlot(options)` took, let go on every way out: a runner `then` starts holds its own. */
export function withSlot (then, options) {
  const slot = takeSlot(options)
  try {
    return then(slot)
  } finally {
    closeSync(slot.fd)
  }
}

/** The pause in force on the user's spores — `{ at, why? }` — or null. */
export function paused ({ dir = SLOT_DIR } = {}) {
  const mark = native.paused(dir)
  return mark === null ? null : JSON.parse(mark)
}

/** Marks the user's spores paused, the first mark standing: `{ mark, already }`. */
export function pauseSpores ({ why, dir = SLOT_DIR } = {}) {
  return JSON.parse(native.pause(dir, why ?? null))
}

/** Lifts the pause; false when there was none. */
export function unpauseSpores ({ dir = SLOT_DIR } = {}) {
  return native.unpause(dir)
}
