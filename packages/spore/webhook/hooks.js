/**
 * Which webhooks are received, for which spore, and how a request proves where it came from.
 * Beside `config.json` for the reason a Telegram bot's file is: it says who reaches what, and
 * nothing a confined agent can read may say that. Secrets are `${VAR}`, from the environment.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Ajv from 'ajv'

import { CONFIG_FILE, SporeError } from '../src/index.js'
import { sizeBytes } from '../src/delegation/definition.js'
import { deliveryBounds } from '../src/core/route.js'
import { NAMES } from '../src/core/names.js'

export const HOOKS_FILE = 'hooks.json'
export const hooksPath = (configFile = CONFIG_FILE) => resolve(dirname(configFile), HOOKS_FILE)

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_PER_HOUR = 30

/** `delivery` is the header whose value a sender repeats when it retries. */
export const PRESETS = Object.freeze({
  github: { method: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=', event: 'x-github-event', delivery: 'x-github-delivery' },
  forgejo: { method: 'hmac', header: 'x-forgejo-signature', algorithm: 'sha256', encoding: 'hex', prefix: '', event: 'x-forgejo-event', delivery: 'x-forgejo-delivery' },
  gitea: { method: 'hmac', header: 'x-gitea-signature', algorithm: 'sha256', encoding: 'hex', prefix: '', event: 'x-gitea-event', delivery: 'x-gitea-delivery' },
  gitlab: { method: 'header', header: 'x-gitlab-token', event: 'x-gitlab-event', delivery: 'x-gitlab-event-uuid' },
  stripe: { method: 'stripe', header: 'stripe-signature', tolerance: 300, event: null, delivery: null }
})

const ajv = new Ajv({ allErrors: false, strictTypes: false })
const compiled = new Map()

/** A payload schema compiled once per text, since `hooks.json` is read again on every request. */
function payloadCheck (path, name, schema) {
  const key = JSON.stringify(schema)
  if (!compiled.has(key)) {
    try {
      compiled.set(key, ajv.compile(schema))
    } catch (err) {
      throw refuse(path, name, 'has an accept.payload that is not a JSON Schema', err.message)
    }
  }
  return compiled.get(key)
}

/**
 * Why a request fails an `accept` — its header filter, then its payload schema — or null when it
 * is kept. The same for a hook's `accept`, which every spore it reaches shares, and for one
 * spore's own.
 */
export function acceptRefusal (accept, headers, body) {
  if (accept.header && !accept.values.includes(headers[accept.header])) return `${accept.header} is ${headers[accept.header] ?? 'absent'}`
  return accept.payload ? payloadRefusal(accept.payload, body) : null
}

/**
 * Why `body` fails a hook's payload schema — ajv's first error, where in the payload and what
 * it broke — or null when it matches.
 */
export function payloadRefusal (match, body) {
  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return 'the body is not JSON, and the hook filters on its payload'
  }
  if (match(payload)) return null
  const [first] = match.errors
  return `the payload does not match — ${first.instancePath || '/'} ${first.message}${first.params?.allowedValue !== undefined ? ` (${JSON.stringify(first.params.allowedValue)})` : ''}`
}

const refuse = (path, name, problem, detail) => new SporeError(`${path}: hook "${name}" ${problem}`, { type: 'WEBHOOK_INVALID', detail })

function fill (path, name, value, env, used) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable) => {
    if (env[variable] === undefined || env[variable] === '') {
      throw refuse(path, name, `wants $${variable}, which is not set`, 'a secret is read from the environment — add it to ~/.config/spore/environment')
    }
    used.push(variable)
    return env[variable]
  })
}

function verifier (path, name, verify, env, used) {
  if (!verify || typeof verify !== 'object') {
    throw refuse(path, name, 'says nothing about checking its sender', 'an unchecked URL starts a paid turn for anyone who finds it — give it verify: { token } at least')
  }
  const secret = (field) => {
    if (typeof verify[field] !== 'string' || !verify[field]) {
      throw refuse(path, name, `needs verify.${field}`, 'the shared secret, as ${VAR} naming the variable that holds it') // eslint-disable-line no-template-curly-in-string
    }
    return fill(path, name, verify[field], env, used)
  }
  const header = (value) => String(value).toLowerCase()
  if (verify.preset !== undefined) {
    const preset = PRESETS[verify.preset]
    if (!preset) throw refuse(path, name, `names a preset "${verify.preset}" spore does not know`, `the presets are ${Object.keys(PRESETS).join(', ')}`)
    return { ...preset, secret: secret('secret') }
  }
  if (verify.hmac !== undefined) {
    if (!['sha256', 'sha1'].includes(verify.hmac)) throw refuse(path, name, `has verify.hmac "${verify.hmac}"`, 'sha256 or sha1')
    if (typeof verify.header !== 'string') throw refuse(path, name, 'has verify.hmac and no verify.header', 'the header the signature arrives in')
    const encoding = verify.encoding ?? 'hex'
    if (!['hex', 'base64'].includes(encoding)) throw refuse(path, name, `has verify.encoding "${encoding}"`, 'hex or base64')
    return { method: 'hmac', header: header(verify.header), algorithm: verify.hmac, encoding, prefix: verify.prefix ?? '', secret: secret('secret'), event: null, delivery: null }
  }
  if (verify.header !== undefined) {
    return { method: 'header', header: header(verify.header), secret: secret('token'), event: null, delivery: null }
  }
  if (verify.token !== undefined) {
    return { method: 'path', secret: secret('token'), event: null, delivery: null }
  }
  throw refuse(path, name, 'has a verify spore cannot read', 'verify is { preset, secret }, { hmac, header, secret }, { header, token }, or { token }')
}

function parseAccept (path, name, raw) {
  const { header, values, payload } = raw ?? {}
  const shape = 'accept is { header, values: [ … ] }, { payload: <JSON Schema> } or both — a request is kept when the header has one of the values and the payload matches the schema'
  const unknownAccept = Object.keys(raw ?? {}).filter(key => !['header', 'values', 'payload'].includes(key))
  if (unknownAccept.length) throw refuse(path, name, `has an accept field spore does not know — ${unknownAccept.join(', ')}`, shape)
  const byHeader = header !== undefined || values !== undefined
  if (byHeader && (typeof header !== 'string' || !Array.isArray(values) || !values.length || !values.every(v => typeof v === 'string'))) {
    throw refuse(path, name, 'has an accept spore cannot read', shape)
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    throw refuse(path, name, 'has an accept.payload that is not a JSON Schema', shape)
  }
  if (!byHeader && payload === undefined) throw refuse(path, name, 'has an accept that accepts everything', shape)
  return {
    ...(byHeader ? { header: header.toLowerCase(), values } : {}),
    ...(payload !== undefined ? { payload: payloadCheck(path, name, payload) } : {})
  }
}

export function loadHooks (path = hooksPath(), env = process.env) {
  if (!existsSync(path)) {
    throw new SporeError(`no ${path}`, {
      type: 'WEBHOOK_NO_HOOKS',
      detail: 'it names each hook, the spore it reaches and how its sender is checked, as { "<name>": { "spore": "<spore>", "verify": { … } } }'
    })
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SporeError(`${path} is not readable JSON`, { type: 'WEBHOOK_INVALID', detail: err.message })
  }
  const hooks = new Map()
  for (const [name, hook] of Object.entries(raw)) {
    if (!NAMES.hook.pattern.test(name)) throw refuse(path, name, 'has a name that cannot be part of a URL', NAMES.hook.says)
    const entries = typeof hook?.spore === 'string' ? [hook.spore] : hook?.spore
    const named = (entry) => (typeof entry === 'string' && entry) || (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.name === 'string' && entry.name)
    if (!Array.isArray(entries) || !entries.length || !entries.every(named)) {
      throw refuse(path, name, 'names no spore', 'spore is the spore the hook reaches, by name, or a list of them — each a name, or { "name", "accept" } for one that wants only some deliveries')
    }
    const spores = entries.map(entry => (typeof entry === 'string' ? entry : entry.name))
    const twice = spores.find((spore, i) => spores.indexOf(spore) !== i)
    if (twice) throw refuse(path, name, `names spore "${twice}" twice`, 'each spore gets every delivery once')
    const accepts = new Map()
    for (const entry of entries.filter(entry => typeof entry === 'object')) {
      const unknownEntry = Object.keys(entry).filter(key => !['name', 'accept'].includes(key))
      if (unknownEntry.length) throw refuse(path, name, `has spore "${entry.name}" with a field spore does not know — ${unknownEntry.join(', ')}`, 'a spore entry is { "name", "accept" }')
      if (entry.accept !== undefined) accepts.set(entry.name, parseAccept(path, `${name}" → "${entry.name}`, entry.accept))
    }
    if (hook.router !== undefined) throw refuse(path, name, 'has a router, which hooks.json no longer binds', 'what prepares a delivery is the spore\'s: prepare: [hook:<name>=<plugin>/<program>] in its spore.cmk')
    const known = ['spore', 'verify', 'accept', 'maxBytes', 'perHour', 'maxWait', 'perDay']
    const unknown = Object.keys(hook).filter(key => !known.includes(key))
    if (unknown.length) throw refuse(path, name, `has a field spore does not know — ${unknown.join(', ')}`, `a hook takes ${known.join(', ')}`)
    const secrets = []
    const check = verifier(path, name, hook.verify, env, secrets)
    const accept = hook.accept === undefined ? null : parseAccept(path, name, hook.accept)
    const maxBytes = hook.maxBytes === undefined ? DEFAULT_MAX_BYTES : sizeBytes(hook.maxBytes)
    if (!(maxBytes > 0)) throw refuse(path, name, `has a maxBytes spore cannot read — ${hook.maxBytes}`, 'a size such as 1MB or 512KB')
    const { maxWait, perDay, perHour } = deliveryBounds(hook, (problem, detail) => refuse(path, name, problem, detail), { perHour: DEFAULT_PER_HOUR })
    hooks.set(name, { name, spores, accepts, check, accept, maxBytes, perHour, maxWait, perDay, secrets })
  }
  return hooks
}
