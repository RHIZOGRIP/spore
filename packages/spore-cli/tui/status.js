import { basename } from 'node:path'

import { durationText, RUNNING } from '@rhizogrip/spore'

const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const bound = ({ soft, hard }, used) => (used > soft ? hard : soft)

const unmetered = (shown) => shown.billing && shown.billing.kind !== 'metered'

export function stateText (shown, { paused, now }) {
  if (paused) return 'paused'
  if (shown.state !== RUNNING) return shown.state
  if (shown.dreaming) return `dreaming ${durationText(now - Date.parse(shown.startedAt))}`
  if (shown.draining) return 'finishing'
  if (shown.turnLimits?.limits.wall) return 'running'
  return `running ${durationText(now - Date.parse(shown.startedAt))}`
}

export function limitsText ({ startedAt, limits }, { rounds, cost, now }) {
  const parts = []
  if (limits.rounds) parts.push(`round ${rounds}/${bound(limits.rounds, rounds)}`)
  if (limits.wall) {
    const elapsed = now - Date.parse(startedAt)
    parts.push(`${durationText(elapsed)}/${durationText(bound(limits.wall, elapsed))}`)
  }
  if (limits.cost && cost !== null) parts.push(`≈$${cost.toFixed(4)}/$${bound(limits.cost, cost).toFixed(2)}`)
  return parts.join(' · ')
}

export function spendText (shown) {
  if (unmetered(shown)) return `not metered · ${shown.billing.label}`
  return `$${shown.treeUsd.toFixed(4)}`
}

export const attentionText = (attention) => attention.map(({ name, asked }) => `${name} ${asked ? 'asked' : 'answered'}`).join(' · ')

export const sporeLabel = ({ shown, paused, now }) => `${basename(shown.ws)} · ${stateText(shown, { paused, now })}`

export function statusParts ({ shown, live, attention, now }) {
  const parts = []
  if (attention.length) parts.push(`${attentionText(attention)} — Ctrl+P`)
  const limited = Boolean(shown.turnLimits) && !shown.draining
  if (limited) parts.push(limitsText(shown.turnLimits, { rounds: live.rounds, cost: unmetered(shown) ? null : live.cost, now }))
  if (live.input !== null) parts.push(`${thousands(live.input)} in${live.cached ? ` (${thousands(live.cached)} cached)` : ''}`)
  if (!limited || unmetered(shown)) parts.push(spendText(shown))
  parts.push(shown.model)
  return parts
}

const perMillion = (price) => `$${Number(price.toPrecision(4))}`

/** A listed model's prices per million tokens, or that the listing gives none. */
export const priceText = ({ inputPrice, outputPrice }) => inputPrice === null || outputPrice === null
  ? 'no prices'
  : `${perMillion(inputPrice)} in · ${perMillion(outputPrice)} out per million tokens`

/** The items holding every word typed, in any order, anywhere in their label, value or description. */
export const matching = (items, typed) => {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(item => {
    const text = `${item.label} ${item.value} ${item.description ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}
