/**
 * A call a tool would not run, as a value. The model is shown `error: <reason>`; the result
 * carries the `refused` mark, and whatever asks whether a call was refused reads the mark and
 * never the text — `ask` and `quiet` hand back what the model wrote, which may begin with
 * anything.
 */

import { REFUSED, mark } from './marks.js'

export const refuse = (reason) => ({ refused: reason })

export const isRefusal = (value) => value !== null && typeof value === 'object' && typeof value.refused === 'string'

export const refusalText = ({ refused }) => `error: ${refused}`

export const refusedResult = (toolCallId, toolName, reason) =>
  mark({ role: 'tool', toolCallId, toolName, content: refusalText(refuse(reason)) }, REFUSED)
