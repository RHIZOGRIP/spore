/**
 * What spores spent, per local day and by spore, origin, model, outcome and precursor, from the
 * records their workspaces keep: settled micros only, and a turn on a model no meter counts is
 * tallied as not metered rather than as free.
 */

import { SporeError } from '../observability/errors.js'
import { billingFor, unmetered } from './billing.js'
import { asked, originOf, usageRecords } from './spore-dir.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const ZONE_SPAN_MS = 14 * 3_600_000

const COUNTERS = ['micros', 'turns', 'cells', 'unmetered', 'rounds', 'inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheWriteTokens']
const TOKENS = COUNTERS.slice(5)

const tally = () => Object.fromEntries(COUNTERS.map(name => [name, 0]))

const add = (into, from) => {
  for (const name of COUNTERS) into[name] += from[name] ?? 0
}

const daysOf = (since, until) => {
  const days = []
  for (let at = Date.parse(since); at <= Date.parse(until); at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10))
  return days
}

/**
 * Who started a turn, from the first entry it answered: `schedule:<name>`, `hook:<name>` or
 * `job:<name>`; else the sender a request id names before its first `:`, as `telegram` in
 * `telegram:<update>` or `errand` in `errand:<id>:<i>`; else `person`. `continued` for a turn that
 * answered no entry.
 */
const originOfTurn = (turn, entries) => {
  const [first] = asked(turn, entries)
  if (!first) return 'continued'
  const named = originOf(first)
  if (named !== null) return named
  const sender = first.requestId?.match(/^([^:]+):/)
  return sender ? sender[1] : 'person'
}

/**
 * `spores` as `[{ name, ws }]`, over the local days `since` to `until` (`YYYY-MM-DD`, both
 * included) in `tz`. Answers `{ window, days, by, totals, unsettled }`: one row per day of the
 * window, empty ones included; `by.<axis>` as `[{ key, ...counters }]`, most spent first, a null
 * key being a model not recorded — a turn that reached none, or a triage cell — or for `precursor`
 * the spend no precursor made;
 * `unsettled` counts the final turns no ledger settled, which no sum includes.
 */
export function usage ({ spores, since, until, tz = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  if (!DATE.test(since) || !DATE.test(until) || since > until) {
    throw new SporeError('a usage window is two dates, the first not after the second', { type: 'USAGE_INVALID', detail: `since ${since}, until ${until}` })
  }
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const dayOf = (iso) => local.format(new Date(iso))
  const from = new Date(Date.parse(since) - ZONE_SPAN_MS).toISOString()
  const to = new Date(Date.parse(until) + DAY_MS + ZONE_SPAN_MS).toISOString()

  const days = new Map(daysOf(since, until).map(day => [day, { day, ...tally() }]))
  const axes = { spore: new Map(), origin: new Map(), model: new Map(), outcome: new Map(), precursor: new Map() }
  const totals = tally()
  const unsettled = { turns: 0 }

  const count = (axis, key, counters) => {
    if (!axes[axis].has(key)) axes[axis].set(key, { key, ...tally() })
    add(axes[axis].get(key), counters)
  }

  for (const { name, ws } of spores) {
    const { turns, inbox, cells } = usageRecords(ws, { from, to })
    for (const turn of turns) {
      const day = days.get(dayOf(turn.startedAt))
      if (!day) continue
      if (!turn.settled) {
        unsettled.turns++
        continue
      }
      const model = turn.model
      const counters = {
        micros: turn.treeMicros,
        turns: 1,
        unmetered: model !== null && unmetered(billingFor(model)) ? 1 : 0,
        rounds: turn.rounds,
        ...Object.fromEntries(TOKENS.map(token => [token, turn[token]]))
      }
      add(day, counters)
      add(totals, counters)
      count('spore', name, counters)
      count('origin', originOfTurn(turn, inbox), counters)
      count('model', model, counters)
      count('outcome', turn.stopReason, counters)

      const split = Object.entries(turn.byPrecursor ?? {})
      for (const [precursor, { micros, rounds }] of split) count('precursor', precursor, { micros, rounds, turns: 1 })
      const named = split.reduce((sum, [, { micros }]) => sum + micros, 0)
      count('precursor', null, { ...counters, micros: turn.treeMicros - named })
    }
    for (const cell of cells) {
      const day = days.get(dayOf(cell.at))
      if (!day) continue
      const counters = { micros: cell.costMicros, cells: 1 }
      add(day, counters)
      add(totals, counters)
      count('spore', name, counters)
      count('origin', cell.origin, counters)
      count('model', null, counters)
      count('outcome', cell.error === null ? 'answer' : 'error', counters)
      count('precursor', cell.precursor, counters)
    }
  }

  const ranked = (rows) => [...rows.values()].sort((a, b) => b.micros - a.micros || (b.turns + b.cells) - (a.turns + a.cells))
  return {
    window: { since, until, tz },
    days: [...days.values()],
    by: Object.fromEntries(Object.entries(axes).map(([axis, rows]) => [axis, ranked(rows)])),
    totals,
    unsettled
  }
}
