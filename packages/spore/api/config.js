/**
 * Where the HTTP API listens and who may call it, from `api.json` beside `config.json`. A token is
 * `${VAR}`, read from the environment, so the file holds no secret; a caller reaches the spores
 * its patterns name. Contract: ARCHITECTURE.md, "The HTTP API".
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { CONFIG_FILE } from '../src/library/config.js'
import { SporeError } from '../src/observability/errors.js'
import { deliveryBounds } from '../src/core/route.js'
import { NAMES } from '../src/core/names.js'
import { variableOf } from '../src/core/variables.js'

export const API_FILE = 'api.json'
export const apiPath = (configFile = CONFIG_FILE) => resolve(dirname(configFile), API_FILE)

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._*-]{0,63}$/

const refuse = (path, problem, detail) => new SporeError(`${path} ${problem}`, { type: 'API_CONFIG_INVALID', detail })

const digest = (text) => createHash('sha256').update(text).digest()

const matcher = (pattern) => new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`)

/**
 * `{ socket, listen, callers, secrets }`: `listen` as `{ host, port }`, each caller `{ name,
 * spores, maxWait }` with its token kept only as a digest and `maxWait` the longest a spore's
 * router may hold its deliveries, or null, and `secrets` the variables the tokens came from,
 * which nothing the API starts is given.
 */
export function loadApi (path = apiPath(), env = process.env) {
  if (!existsSync(path)) throw new SporeError(`no ${path}`, { type: 'API_NO_CONFIG', detail: 'it says where the API listens and who may call it — see docs/operating.md, "The HTTP API service"' })
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw refuse(path, 'is not readable JSON', err.message)
  }
  const known = ['socket', 'listen', 'callers']
  const unknown = Object.keys(raw).filter(key => !known.includes(key))
  if (unknown.length) throw refuse(path, `has ${unknown.join(', ')}, which the API does not read`, `it takes ${known.join(', ')}`)
  if (raw.socket === undefined && raw.listen === undefined) throw refuse(path, 'says neither a socket nor an address to listen on', 'socket: an absolute path, listen: <loopback host>:<port>')
  if (raw.socket !== undefined && !(typeof raw.socket === 'string' && isAbsolute(raw.socket))) throw refuse(path, 'has a socket that is not an absolute path', `got ${JSON.stringify(raw.socket)}`)

  let listen = null
  if (raw.listen !== undefined) {
    const found = typeof raw.listen === 'string' ? /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw.listen) : null
    if (!found || !(Number(found[2]) > 0 && Number(found[2]) < 65536)) throw refuse(path, `has a listen it cannot read — got ${JSON.stringify(raw.listen)}`, 'expected <host>:<port>, as 127.0.0.1:8787')
    if (!LOOPBACK.has(found[1])) throw refuse(path, `listens on ${found[1]}, which is not this machine's loopback`, 'listen on 127.0.0.1 and expose it through a reverse proxy you choose')
    listen = { host: found[1], port: Number(found[2]) }
  }

  if (!(raw.callers && typeof raw.callers === 'object' && !Array.isArray(raw.callers) && Object.keys(raw.callers).length)) {
    throw refuse(path, 'names no callers', 'callers: { "<name>": { "token": "${VAR}", "spores": ["*"] } }') // eslint-disable-line no-template-curly-in-string
  }
  const secrets = new Set()
  const callers = Object.entries(raw.callers).map(([name, caller]) => {
    if (!NAMES.caller.pattern.test(name)) throw refuse(path, `has a caller named ${JSON.stringify(name)}`, `a caller is named with ${NAMES.caller.says}: the name is its origin, api:<caller>`)
    const variable = variableOf(caller?.token)
    if (!variable) throw refuse(path, `has a token for ${name} that is not \${VAR}`, 'a token is read from the environment, never written in the file')
    const token = env[variable]
    if (!token) throw refuse(path, `wants $${variable} for ${name}, which is not set`, 'add it to ~/.config/spore/environment')
    if (token.length < 32) throw refuse(path, `has a token for ${name} shorter than 32 characters`, 'openssl rand -hex 32 makes one')
    const patterns = caller.spores
    if (!(Array.isArray(patterns) && patterns.length && patterns.every(p => typeof p === 'string' && PATTERN.test(p)))) {
      throw refuse(path, `has spores for ${name} that are not a list of names or patterns`, 'as ["*"], ["support-*", "ops"]')
    }
    if (caller.router !== undefined) throw refuse(path, `has a router for ${name}, which api.json no longer binds`, 'what prepares a delivery is the spore\'s: prepare: [api:<caller>=<plugin>/<program>] in its spore.cmk')
    const { maxWait, perDay, perHour } = deliveryBounds(caller, (problem, detail) => refuse(path, `caller ${JSON.stringify(name)} ${problem}`, detail))
    secrets.add(variable)
    return { name, digest: digest(token), spores: patterns.map(matcher), maxWait, perDay, perHour }
  })
  return { socket: raw.socket ?? null, listen, callers, secrets }
}

/** The caller whose token `presented` is, compared in constant time against every one; null for none. */
export function callerOf (callers, presented) {
  if (typeof presented !== 'string' || !presented) return null
  const given = digest(presented)
  let found = null
  for (const caller of callers) if (timingSafeEqual(caller.digest, given)) found = caller
  return found
}

export const reaches = (caller, name) => caller.spores.some(pattern => pattern.test(name))
