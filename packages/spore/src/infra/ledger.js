import { native } from '../native.js'

/**
 * Shared spend, in dollars. `own` is the agent's, written by its loop after every call;
 * `children` is everything else the tree's model socket has served, read back from the
 * runner. One number bounds the tree, and it is the one an agent cannot rewrite —
 * `spore.cmk` sits at the workspace root, which is a read path to it.
 */
export function createLedger () {
  return { own: 0, children: 0, ownRounds: 0, childRounds: 0 }
}

export const totalSpend = (ledger) => ledger.own + ledger.children

/**
 * Work units: the tree's reasoning, weighted by where it happened. An agent's own round
 * counts double and a cell's counts once, which prices delegation below thinking it through
 * alone.
 *
 * Counted by the runner rather than from the turn records because it is the one place that
 * sees every round of the root and of every cell: a round is a model call, every model call crosses its
 * socket, and a retry is another call.
 */
export const workUnits = (ledger) => native.workUnits(ledger.ownRounds, ledger.childRounds)

/** Dollars as the integer micro-dollars a turn record holds. */
export const micros = (dollars) => Math.round(dollars * 1e6)
