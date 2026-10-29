import { describe, expect, it } from 'vitest'
import { wakes } from '../src/index.js'

const entry = (seq, kind, actor, extra = {}) => ({ seq, kind, actor, hop: 0, data: '{}', ...extra })
const subscription = (seq, actor, kinds, verb = 'subscribe') => entry(seq, `cairn.${verb}`, actor, { data: JSON.stringify({ kinds }) })

describe('whom an entry wakes', () => {
  it('is each member subscribed to its kind before it, never its writer', () => {
    const subscribed = new Map()
    expect(wakes([
      entry(1, 'note', 'ann'),
      subscription(2, 'ann', ['note', 'task']),
      subscription(3, 'bob', ['note']),
      entry(4, 'note', 'ann'),
      entry(5, 'task', 'bob'),
      subscription(6, 'ann', ['note'], 'unsubscribe'),
      entry(7, 'note', 'bob')
    ], { maxHops: 1 }, subscribed)).toEqual([
      { member: 'bob', seq: 4, kind: 'note', hop: 0 },
      { member: 'ann', seq: 5, kind: 'task', hop: 0 }
    ])
    expect(subscribed).toEqual(new Map([['ann', new Set(['task'])], ['bob', new Set(['note'])]]))
  })

  it('is nobody once its hop reaches maxHops', () => {
    const subscribed = new Map([['bob', new Set(['note'])]])
    expect(wakes([entry(1, 'note', 'ann', { hop: 1 }), entry(2, 'note', 'ann', { hop: 2 })], { maxHops: 2 }, subscribed))
      .toEqual([{ member: 'bob', seq: 1, kind: 'note', hop: 1 }])
  })
})
