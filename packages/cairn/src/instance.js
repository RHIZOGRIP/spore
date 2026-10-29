/**
 * The instance file: who belongs to a cairn and in which role (`members`), what may be written
 * (`kinds`, each a shape), what an entry may be about (`subjects`, each `seq`, `sha256` or an
 * anchored pattern), and, when members may be woken by what others write, how often and how far
 * (`notify`, its `minDelay` and `maxHops`). Kinds under `cairn.` and the member name `cairn` are
 * the daemon's own.
 */

import { readFileSync } from 'node:fs'
import { checkShapeDeclared } from './shape.js'

const KEYS = ['members', 'kinds', 'subjects']
const NOTIFY_KEYS = ['minDelay', 'maxHops']
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 }
const DELAY = /^([1-9][0-9]*)([smh])$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function readInstance (file) {
  const instance = JSON.parse(readFileSync(file, 'utf8'))
  const fail = (message) => { throw new Error(`${file}: ${message}`) }
  if (!isObject(instance)) fail('an instance file is an object')
  for (const key of Object.keys(instance)) if (![...KEYS, 'notify'].includes(key)) fail(`${key} is not an instance key (${[...KEYS, 'notify'].join(', ')})`)
  for (const key of KEYS) if (!isObject(instance[key])) fail(`${key} is an object`)

  for (const [name, role] of Object.entries(instance.members)) {
    if (name === 'cairn') fail('the member name cairn is the daemon\'s own')
    if (typeof role !== 'string' || role === '') fail(`members.${name} is a role`)
  }
  for (const [kind, shape] of Object.entries(instance.kinds)) {
    if (kind.startsWith('cairn.')) fail(`kinds.${kind}: kinds under cairn. are the daemon's own`)
    if (!isObject(shape)) fail(`kinds.${kind} is an object of fields`)
    try {
      checkShapeDeclared(shape, `kinds.${kind}`)
    } catch (err) {
      fail(err.message)
    }
  }
  const subjects = new Map()
  for (const [key, pattern] of Object.entries(instance.subjects)) {
    if (pattern === 'seq' || pattern === 'sha256') {
      subjects.set(key, pattern)
      continue
    }
    if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) {
      fail(`subjects.${key} is seq, sha256 or a pattern anchored with ^ and $`)
    }
    subjects.set(key, new RegExp(pattern, 'u'))
  }
  return { instance, members: instance.members, kinds: instance.kinds, subjects, notify: notifyOf(instance.notify, fail) }
}

function notifyOf (notify, fail) {
  if (notify === undefined) return null
  const shape = 'notify is { "minDelay": "15m", "maxHops": 1 }'
  if (!isObject(notify)) fail(shape)
  for (const key of Object.keys(notify)) if (!NOTIFY_KEYS.includes(key)) fail(`notify.${key} is not a key of notify — ${shape}`)
  const delay = typeof notify.minDelay === 'string' ? DELAY.exec(notify.minDelay) : null
  if (!delay) fail(`notify.minDelay is how long a member's notices are gathered, as 30s, 15m or 2h — got ${JSON.stringify(notify.minDelay)}`)
  if (!Number.isSafeInteger(notify.maxHops) || notify.maxHops < 1) fail(`notify.maxHops is the hop at which an entry wakes nobody, a whole number from 1 — got ${JSON.stringify(notify.maxHops)}`)
  return { minDelayMs: Number(delay[1]) * UNIT_MS[delay[2]], maxHops: notify.maxHops }
}
