import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openCairn } from './cairn.js'
import { canonical } from './canonical.js'
import { CairnError, entryAt } from './errors.js'
import { checkShape } from './shape.js'

export const MAX_LINE = 4096
export const MAX_EVIDENCE = 16 * 1024 * 1024
const CLOCK_SKEW_MS = 60 * 1000
const VIA = new Set(['agent', 'program', 'cli'])
const ENTRY_KEYS = new Set(['kind', 'at', 'refs', 'data', 'actor', 'via', 'id', 'hop'])
const SHA256 = /^[0-9a-f]{64}$/
const SUBSCRIPTION = new Set(['cairn.subscribe', 'cairn.unsubscribe'])

const refuse = (type, message, detail) => new CairnError(message, { type, detail })
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkAt (at, now) {
  const when = typeof at === 'string' ? new Date(at) : null
  if (!when || Number.isNaN(when.getTime()) || when.toISOString() !== at) {
    throw refuse('bad-time', '$.at is a UTC time, YYYY-MM-DDTHH:MM:SS.fffZ', '$.at')
  }
  if (when.getTime() > now + CLOCK_SKEW_MS) throw refuse('bad-time', `$.at is ${at}, which is in the future`, '$.at')
}

function checkRefs (refs, subjects, lastSeq, held) {
  if (!isObject(refs)) throw refuse('shape-mismatch', 'refs is a map of subject keys to ids', '$.refs')
  for (const [key, value] of Object.entries(refs)) {
    const at = `$.refs.${key}`
    const subject = subjects.get(key)
    if (subject === undefined) throw refuse('bad-ref', `${key} is not a subject of this cairn`, at)
    if (subject === 'seq') {
      if (!Number.isSafeInteger(value) || value < 1 || value > lastSeq) throw refuse('bad-ref', `${at} is the seq of an entry in this cairn`, at)
    } else if (subject === 'sha256') {
      if (typeof value !== 'string' || !SHA256.test(value)) throw refuse('bad-ref', `${at} is a sha256 in lowercase hex`, at)
      if (!held(value)) throw refuse('bad-ref', `${at} is no evidence this cairn holds`, at)
    } else if (typeof value !== 'string' || !subject.test(value)) {
      throw refuse('bad-ref', `${at} does not match ${subject.source}`, at)
    }
  }
}

/**
 * A cairn written under its instance file's rules, by whoever holds the file: the daemon, or a
 * program that is the cairn's only writer. `instance` is what `readInstance` returns. One that
 * differs from the last `cairn.config` entry is recorded as a new one at open. An entry is
 * `{ actor, via, id, hop, kind, at, refs, data }`: `actor` a member, stamped with its role, and
 * the rest checked against the instance — the kind and its shape, `at` no further ahead than the
 * clock's skew, each ref a declared subject, the line at most `MAX_LINE`. A `seq` ref names an
 * entry before it, one earlier in the same batch included. Who the actor is, is the caller's word.
 * Evidence is kept beside the database as `evidence/<sha256>`, read-only once written.
 */
export function openChecked (file, { name, instance }) {
  const { instance: declared, members, kinds, subjects, notify } = instance
  const cairn = openCairn(file, { name })
  const evidence = join(dirname(file), 'evidence')
  mkdirSync(evidence, { recursive: true })
  const recorded = cairn.latest('cairn.config')
  if (!recorded || canonical(recorded.data) !== canonical(declared)) {
    cairn.append({
      at: new Date().toISOString(),
      kind: 'cairn.config',
      refs: {},
      data: declared,
      actor: { name: 'cairn', role: 'cairn', via: 'program' },
      id: null,
      hop: 0
    })
  }

  function memberOf (actor) {
    if (typeof actor !== 'string' || !Object.hasOwn(members, actor)) {
      throw refuse('not-a-member', `${actor ?? 'a writer with no name'} is not a member of ${name}`, String(actor ?? ''))
    }
    return actor
  }

  function checkSubscription (data) {
    checkShape({ kinds: ['string'] }, data, '$.data')
    if (!data.kinds.length) throw refuse('shape-mismatch', '$.data.kinds names at least one kind', '$.data.kinds')
    data.kinds.forEach((kind, i) => {
      if (!Object.hasOwn(kinds, kind)) throw refuse('unknown-kind', `${kind} is not a kind of ${name}`, `$.data.kinds[${i}]`)
    })
  }

  function fieldsOf (entry, lastSeq, now) {
    if (!isObject(entry)) throw refuse('shape-mismatch', 'an entry is an object', '$')
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) throw refuse('shape-mismatch', `${key} is not part of an entry`, `$.${key}`)
    }
    const actor = memberOf(entry.actor)
    if (!VIA.has(entry.via)) throw refuse('shape-mismatch', 'via is agent, program or cli', '$.actor.via')
    if (!Number.isSafeInteger(entry.hop) || entry.hop < 0) throw refuse('shape-mismatch', 'hop is a count', '$.hop')
    if (entry.id !== null && typeof entry.id !== 'string') throw refuse('shape-mismatch', 'id is the writer\'s run, or null for a writer that keeps none', '$.id')
    if (SUBSCRIPTION.has(entry.kind)) {
      if (entry.kind === 'cairn.subscribe' && !notify) throw refuse('unknown-kind', `${name} wakes no one: its instance file has no notify`, entry.kind)
    } else if (!Object.hasOwn(kinds, entry.kind)) {
      throw refuse('unknown-kind', `${entry.kind} is not a kind of ${name}`, String(entry.kind))
    }
    checkAt(entry.at, now)
    checkRefs(entry.refs, subjects, lastSeq, (hash) => existsSync(join(evidence, hash)))
    if (SUBSCRIPTION.has(entry.kind)) checkSubscription(entry.data)
    else checkShape(kinds[entry.kind], entry.data, '$.data')
    return {
      at: entry.at,
      kind: entry.kind,
      refs: entry.refs,
      data: entry.data,
      actor: { name: actor, role: members[actor], via: entry.via },
      id: entry.id,
      hop: entry.hop
    }
  }

  function appendAll (entries, { expectedHead } = {}) {
    if (!Array.isArray(entries)) throw refuse('shape-mismatch', 'a batch is a list of entries', '$')
    if (expectedHead !== undefined && (!Number.isSafeInteger(expectedHead) || expectedHead < 0)) {
      throw refuse('shape-mismatch', 'expectedHead is the seq of the head the writer read', '$.expectedHead')
    }
    const head = cairn.head().seq
    const now = Date.now()
    const fields = entries.map((entry, index) => entryAt(index, () => fieldsOf(entry, head + index, now)))
    return cairn.appendAll(fields, { expectedHead, maxBytes: MAX_LINE })
  }

  function store (actor, bytes) {
    memberOf(actor)
    if (bytes.length > MAX_EVIDENCE) throw refuse('too-large', `the evidence is ${bytes.length} bytes, past ${MAX_EVIDENCE}`, String(bytes.length))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const target = join(evidence, sha256)
    if (!existsSync(target)) {
      const partial = join(evidence, `.${sha256}.${randomBytes(6).toString('hex')}`)
      const fd = openSync(partial, 'wx', 0o600)
      try {
        writeSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodSync(partial, 0o444)
      renameSync(partial, target)
      const dir = openSync(evidence, 'r')
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
    }
    return { sha256, bytes: bytes.length }
  }

  return {
    name,
    append: (entry, options) => appendAll([entry], options)[0],
    appendAll,
    store,
    head: cairn.head,
    since: cairn.since,
    latest: cairn.latest,
    verify: cairn.verify,
    close: cairn.close
  }
}
