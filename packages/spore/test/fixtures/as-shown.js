/**
 * Tool functions whose results come back as the model is shown them — a refusal as its
 * `error:` text, a call record as its JSON — through the kernel's own serialization, so a
 * test of what a tool says keeps reading what the model reads.
 */

import { isRecorded } from '../../src/core/call-record.js'
import { isRefusal, refusalText } from '../../src/core/refusal.js'

export const asShown = (result) => {
  if (isRefusal(result)) return refusalText(result)
  if (isRecorded(result)) return result.images ? { content: JSON.stringify(result.record), images: result.images } : JSON.stringify(result.record)
  return result
}

export const shownToModel = (fns) =>
  Object.fromEntries(Object.entries(fns).map(([name, fn]) => [name, async (...args) => asShown(await fn(...args))]))
