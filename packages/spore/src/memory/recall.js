/**
 * What recall looks like when it arrives.
 *
 * The framing carries more weight than it looks. Recall is put *beside the turn that
 * triggered it* — the freshest, most attended part of the prompt, and downstream of every
 * cache breakpoint — which is also where anything the user just said lives. So the first
 * job of the wording is to say **this was not said now**: a line reading "Owns a Sony A7R
 * IV" in front of a question about accessories is otherwise indistinguishable from the
 * person having just volunteered it.
 *
 * What the wording must *not* do is hedge. Whether a line deserves to be here is the
 * threshold's question, answered before the prompt is built; re-opening it in the text
 * hands the judgement back to the model and invites it to skip the lot — which is the
 * failure this exists to repair.
 *
 * The anchor on each line is not decoration. It is provenance — a fact from the notes and
 * one from the record read differently — and it is the way down: the agent that wants the
 * context around a line has the path and the position to ask for it.
 */

/**
 * Everything after "not said now" was cut, and the cut is the point.
 *
 * It read: *"These surfaced by resemblance and may not be relevant; use what fits and
 * ignore the rest."* Three things wrong with it. It hands an agent permission to ignore
 * recall, when not looking is the failure this exists to fix. It moves the judgement of
 * relevance back to the model, when the threshold that surfaced the line is what decides
 * that — the runtime apologising for its own mechanism. And *how* a memory arrived is
 * implementation; nothing recalls a thing and explains the retrieval.
 *
 * What is left does the only two jobs the wording has: these are from before, and nobody
 * said them just now.
 */
export const RECALL_HEADER = '[Recalled — from earlier, not said now.]'

export function recallBlock (hits) {
  if (!hits?.length) return ''
  // A note is usually already a list, so its lines arrive carrying their own bullet or
  // heading marker. Left on, they render as `- - Interested in…`.
  const bare = (text) => text.replace(/\s+/g, ' ').replace(/^[-*#\s]+/, '').trim()

  // Who and when, where they are known. An assistant's suggestion and the person's own
  // statement carry very different weight, and a line arriving without them reads as an
  // unattributed fact — while "next Thursday", said in May, is not a date at all until
  // the May comes with it.
  const attribute = (hit) => {
    if (!hit.role) return ''
    const when = hit.when ? ` on ${String(hit.when).slice(0, 10)}` : ''
    return `${hit.role}${when}: `
  }
  const lines = hits.map(hit => `- ${attribute(hit)}${bare(hit.text)} (${hit.anchor.path}:${hit.anchor.line})`)
  return [RECALL_HEADER, ...lines, ''].join('\n')
}
