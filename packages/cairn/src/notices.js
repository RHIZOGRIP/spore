const SUBSCRIPTION = new Set(['cairn.subscribe', 'cairn.unsubscribe'])

/**
 * Whom each of `entries` wakes, in seq order, as `{ member, seq, kind, hop }`: the members its
 * kind is subscribed by in the entries before it, never its writer, and nobody once its `hop`
 * reaches `maxHops`. An entry is a row of the `entries` view. `subscribed`, member to kinds, is
 * where the reading starts, and is left where it ends.
 */
export function wakes (entries, { maxHops }, subscribed) {
  const woken = []
  for (const { seq, kind, actor, hop, data } of entries) {
    if (SUBSCRIPTION.has(kind)) {
      const kinds = subscribed.get(actor) ?? new Set()
      for (const named of JSON.parse(data).kinds) {
        if (kind === 'cairn.subscribe') kinds.add(named)
        else kinds.delete(named)
      }
      subscribed.set(actor, kinds)
      continue
    }
    if (hop >= maxHops) continue
    for (const [member, kinds] of subscribed) {
      if (member !== actor && kinds.has(kind)) woken.push({ member, seq, kind, hop })
    }
  }
  return woken
}
