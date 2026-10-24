/**
 * A running turn's limits, changed by its owner: raised within the ceilings its definition
 * grants, or brought sooner to a wrap. Contract: ARCHITECTURE.md, "Changing a running turn's
 * limits".
 */

import { readFileSync } from 'node:fs'

import { SporeError } from '../observability/errors.js'
import { durationMs, limitAmount, parseDefinition } from '../delegation/definition.js'
import { changeLimits, definitionPath } from './spore-dir.js'
import { TOOL_NAMES } from './tool-names.js'

export const DIMENSIONS = ['rounds', 'cost', 'wall']

const SHAPE = { rounds: '20', cost: '1.50', wall: '30m' }

export function limitText (dimension, value) {
  if (dimension === 'cost') return `$${value.toFixed(2)}`
  if (dimension === 'rounds') return `${value} rounds`
  if (value < 60_000) return `${Math.round(value / 1000)}s`
  const minutes = Math.round(value / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}` : `${minutes}m`
}

const sayRefusal = ({ refused, dimension, room, ceiling }) => {
  if (refused === 'idle') return 'nothing is running'
  if (refused === 'unrecorded') return `the running turn kept no ${dimension} limit to change`
  if (refused === 'ungranted') return `its spore.cmk grants no extend.${dimension}, so its ${dimension} cannot be raised while it runs`
  if (refused === 'later') return 'it already wraps by then'
  return room > 0
    ? `extend.${dimension} is ${limitText(dimension, ceiling)}, so it can be raised by ${limitText(dimension, room)} at most`
    : `its ${dimension} is already at extend.${dimension}, ${limitText(dimension, ceiling)}`
}

export function runningLines ({ startedAt, limits }, extend, now = Date.now()) {
  return DIMENSIONS.filter(dimension => limits[dimension]).map(dimension => {
    const { soft, hard } = limits[dimension]
    const ceiling = extend?.[dimension]
    const into = dimension === 'wall' ? `${limitText('wall', now - Date.parse(startedAt))} in, ` : ''
    return `${dimension}: ${into}wraps at ${limitText(dimension, soft)}, stops at ${limitText(dimension, hard)}${ceiling ? ` — can be raised to ${limitText(dimension, ceiling)}` : ''}`
  })
}

export function changeText (answer, { brief = false } = {}) {
  if (answer.refused) return sayRefusal(answer)
  const { dimension, why, soft, hard } = answer
  if (why === 'wrap') return `it wraps at ${limitText('wall', soft)} into the turn${brief ? '' : `, and still stops at ${limitText('wall', hard)}`}`
  return `its ${dimension} now wraps at ${limitText(dimension, soft)} and stops at ${limitText(dimension, hard)}`
}

/** Raises soft and hard `dimension` of the running turn by `amount`, as written: `30m`, `1.50`, `20`. */
export function extendTurn (ws, dimension, amount) {
  if (!DIMENSIONS.includes(dimension)) {
    throw new SporeError(`a turn's limits are ${DIMENSIONS.join(', ')}, not "${dimension}"`, {
      type: 'LIMIT_UNKNOWN',
      detail: 'as spore extend <name> wall 30m'
    })
  }
  const by = limitAmount(dimension, amount ?? '')
  if (!(by > 0)) {
    throw new SporeError(`"${amount ?? ''}" is not an amount of ${dimension}`, {
      type: 'LIMIT_AMOUNT',
      detail: `as spore extend <name> ${dimension} ${SHAPE[dimension]}`
    })
  }
  const definition = parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) {
    throw new SporeError(`${definitionPath(ws)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  }
  return changeLimits(ws, { why: 'extend', dimension, by, ceiling: definition.extend?.[dimension] ?? null })
}

/** Brings the running turn's wrap to `wait` from now — `10m` — or to now when absent. */
export function wrapTurn (ws, wait) {
  const ms = wait === undefined ? 0 : durationMs(wait)
  if (ms === null) {
    throw new SporeError(`"${wait}" is not a wait`, { type: 'LIMIT_AMOUNT', detail: 'as spore wrap <name> 10m, or nothing for now' })
  }
  return changeLimits(ws, { why: 'wrap', in: ms })
}
