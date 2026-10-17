/**
 * The HTTP API, served on a unix socket as a container serves it, against a real spore and the
 * scripted model: who may call, what each route does, and the trace a message carries on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { readInbox } from '../src/core/spore-dir.js'
import { callerOf, loadApi, reaches } from '../api/config.js'
import { createApiServer } from '../api/server.js'

const APP = 'a'.repeat(40)
const NARROW = 'n'.repeat(40)
const TRACE = '0af7651916cd43dd8448eb211c80319c'

let root
let broker
let server
let socket

const configure = () => {
  const configFile = join(root, 'config', 'config.json')
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(configFile, JSON.stringify({ home: join(root, 'home') }))
  writeFileSync(join(root, 'config', 'api.json'), JSON.stringify({
    socket: join(root, 'run', 'api.sock'),
    callers: {
      app: { token: '${API_APP}', spores: ['*'] }, // eslint-disable-line no-template-curly-in-string
      narrow: { token: '${API_NARROW}', spores: ['beta*'] } // eslint-disable-line no-template-curly-in-string
    }
  }))
  return configFile
}

const call = (method, path, { token = APP, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request({ socketPath: socket, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }))
  })
  req.on('error', reject)
  req.end(body ? JSON.stringify(body) : undefined)
})

beforeEach(async () => {
  root = outsideRoot('api')
  const ws = join(root, 'home', 'alpha')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
  const configFile = configure()
  const secrets = { API_APP: APP, API_NARROW: NARROW }
  const api = loadApi(join(root, 'config', 'api.json'), secrets)
  broker = createModelServer({ mo: scriptedMo(async () => answers('hello back')), socketPath: brokerSocketPath('api-test'), limit: 10 })
  await broker.listen()
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MODEL: 'anthropic/claude-haiku-4-5', SPORE_MODEL_SOCKET: broker.socketPath, ...secrets }
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 })
  socket = api.socket
  server = createApiServer({ api, env, configFile })
  await new Promise(resolve => server.listen(socket, resolve))
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  await broker?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('who may call', () => {
  it('refuses a request without a token or with one it does not know', async () => {
    expect((await call('GET', '/v1/spores', { token: null })).status).toBe(401)
    const wrong = await call('GET', '/v1/spores', { token: 'x'.repeat(40) })
    expect(wrong.status).toBe(401)
    expect(wrong.json().error.type).toBe('API_UNAUTHORIZED')
  })

  it('answers a spore outside a caller\'s names as one that does not exist, and lists only its own', async () => {
    expect((await call('GET', '/v1/spores/alpha', { token: NARROW })).json().error.type).toBe('NOT_A_WORKSPACE')
    expect((await call('GET', '/v1/spores', { token: NARROW })).json()).toEqual({ spores: [] })
    expect((await call('GET', '/v1/spores')).json().spores.map(s => s.name)).toEqual(['alpha'])
  })
})

describe('a message through the API', () => {
  it('starts a turn under the caller\'s trace, is taken once under its request id, and streams the turn to its end', async () => {
    const sent = await call('POST', '/v1/spores/alpha/messages', { body: { text: 'hello', requestId: 'r1' }, headers: { traceparent: `00-${TRACE}-b7ad6b7169203331-01` } })
    expect(sent.status).toBe(202)
    expect(sent.json()).toEqual({ inbox: 1, started: true, repeated: false })
    expect(readInbox(join(root, 'home', 'alpha'))[0].traceparent.split('-')[1]).toBe(TRACE)

    const streamed = (await call('GET', '/v1/spores/alpha/events?after=0')).text.trim().split('\n').map(line => JSON.parse(line))
    expect(streamed.find(event => event.event === 'complete')).toMatchObject({ output: 'hello back' })
    const last = streamed.at(-1).seq

    const again = await call('POST', '/v1/spores/alpha/messages', { body: { text: 'hello', requestId: 'r1' } })
    expect(again.json()).toMatchObject({ inbox: 1, repeated: true })
    expect((await call('GET', `/v1/spores/alpha/events?after=${last}&follow=false`)).text).toBe('')
    expect((await call('GET', '/v1/spores/alpha')).json()).toMatchObject({ model: 'anthropic/claude-haiku-4-5', waiting: 0 })
  })

  it('answers a body past its limit with 413 before closing the connection', async () => {
    const answered = await new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, method: 'POST', path: '/v1/spores/alpha/messages', headers: { authorization: `Bearer ${APP}`, 'content-type': 'application/json' } }, (res) => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }))
      })
      req.on('error', (err) => { if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err) })
      req.end(Buffer.alloc(33 * 1024 * 1024, 'a'))
    })
    expect(answered.status).toBe(413)
    expect(answered.json.error.type).toBe('API_TOO_LARGE')
  })

  it('refuses a message with no text, and a route it does not have', async () => {
    expect((await call('POST', '/v1/spores/alpha/messages', { body: {} })).json().error.type).toBe('API_BAD_REQUEST')
    expect((await call('GET', '/v1/elsewhere')).status).toBe(404)
    expect((await call('DELETE', '/v1/spores/alpha')).status).toBe(405)
  })
})

describe('the running turn', () => {
  it('is none while nothing runs, at whichever level is asked, and a level it does not have is refused', async () => {
    expect((await call('GET', '/v1/spores/alpha/live')).json()).toEqual({ live: null, lines: [], seq: null })
    expect((await call('GET', '/v1/spores/alpha/live?level=brief')).status).toBe(200)
    const loud = await call('GET', '/v1/spores/alpha/live?level=loud')
    expect(loud.status).toBe(400)
    expect(loud.json().error.message).toMatch(/level is brief, plain, details — not loud/)
  })
})

describe('api.json', () => {
  const write = (config) => {
    const path = join(root, 'config', 'probe.json')
    writeFileSync(path, JSON.stringify(config))
    return path
  }
  const token = '${T}' // eslint-disable-line no-template-curly-in-string
  const env = { T: 't'.repeat(40) }

  it('reads a caller\'s token from the environment and never from the file', () => {
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token: 't'.repeat(40), spores: ['*'] } } }), env)).toThrow(/not \$\{VAR\}/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'] } } }), {})).toThrow(/\$T for a, which is not set/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'] } } }), { T: 'short' })).toThrow(/shorter than 32/)
    const read = loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['ops', 'support-*'] } } }), env)
    expect(read.secrets).toEqual(new Set(['T']))
    const caller = callerOf(read.callers, env.T)
    expect(caller.name).toBe('a')
    expect(callerOf(read.callers, 'u'.repeat(40))).toBe(null)
    expect(['ops', 'support-eu', 'opsx', 'support'].map(name => reaches(caller, name))).toEqual([true, true, false, false])
  })

  it('listens only where it is told, and on this machine\'s loopback alone', () => {
    expect(() => loadApi(write({ callers: { a: { token, spores: ['*'] } } }), env)).toThrow(/neither a socket nor an address/)
    expect(() => loadApi(write({ listen: '0.0.0.0:8787', callers: { a: { token, spores: ['*'] } } }), env)).toThrow(/not this machine's loopback/)
    expect(loadApi(write({ listen: '127.0.0.1:8787', callers: { a: { token, spores: ['*'] } } }), env).listen).toEqual({ host: '127.0.0.1', port: 8787 })
  })
})
