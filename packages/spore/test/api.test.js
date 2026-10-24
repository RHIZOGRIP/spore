/**
 * The HTTP API, served on a unix socket as a container serves it, against a real spore and the
 * scripted model: who may call, what each route does, and the trace a message carries on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { heldIn, readInbox, saidOf } from '../src/core/spore-dir.js'
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

describe('a line of the caller\'s own', () => {
  it('is refused while nothing runs, and when it is not a line', async () => {
    const idle = await call('POST', '/v1/spores/alpha/annotate', { body: { text: 'usually 2 min' } })
    expect([idle.status, idle.json()]).toEqual([200, { refused: 'idle' }])
    const empty = await call('POST', '/v1/spores/alpha/annotate', { body: { text: '' } })
    expect([empty.status, empty.json().error.type]).toEqual([400, 'ANNOTATION_INVALID'])
  })
})

describe('a program\'s delivery through the API', () => {
  let released
  const alpha = () => join(root, 'home', 'alpha')
  const held = () => heldIn(alpha()).map(row => JSON.parse(row.entry))
  const sent = { delivery: 'doc-1', text: 'Analyse it.', payload: { doc: 'q3.pdf' } }

  const restart = async (callers = {}, delivering = {}, extra = {}) => {
    const secrets = { API_APP: APP, API_NARROW: NARROW }
    writeFileSync(join(root, 'config', 'api.json'), JSON.stringify({
      socket,
      callers: {
        app: { token: '${API_APP}', spores: ['*'], ...callers.app }, // eslint-disable-line no-template-curly-in-string
        narrow: { token: '${API_NARROW}', spores: ['beta*'] } // eslint-disable-line no-template-curly-in-string
      }
    }))
    await new Promise(resolve => server.close(resolve))
    released = []
    server = createApiServer({
      api: loadApi(join(root, 'config', 'api.json'), secrets),
      env: { PATH: process.env.PATH, ...secrets },
      configFile: join(root, 'config', 'config.json'),
      delivering: { release: (ws) => { released.push(ws); return { released: [1], started: true } }, ...delivering },
      ...extra
    })
    await new Promise(resolve => server.listen(socket, resolve))
  }

  it('holds it from the caller, with its text, its payload first and its files, under the caller\'s trace, once per id, and releases it at once', async () => {
    await restart()
    const body = { ...sent, attach: [{ name: 'note.txt', mime: 'text/plain', data: Buffer.from('n').toString('base64') }] }
    const first = await call('POST', '/v1/spores/alpha/deliveries', { body, headers: { traceparent: `00-${TRACE}-b7ad6b7169203331-01` } })
    expect([first.status, first.json()]).toEqual([202, { delivery: 'doc-1', outcome: 'started', started: true }])
    expect(released).toEqual([alpha()])
    const [entry] = held()
    expect(entry).toMatchObject({ api: 'app', text: 'Analyse it.', requestId: 'api:app:doc-1' })
    expect(entry).not.toHaveProperty('from')
    expect(entry).not.toHaveProperty('hook')
    expect(saidOf(entry)).toMatch(/^Analyse it\.\n/)
    expect(entry.traceparent).toMatch(new RegExp(`^00-${TRACE}-`))
    expect(entry.files.map(file => file.name)).toEqual(['payload.json', 'note.txt'])
    expect(JSON.parse(readFileSync(join(alpha(), entry.files[0].path), 'utf8'))).toEqual({ doc: 'q3.pdf' })

    const again = await call('POST', '/v1/spores/alpha/deliveries', { body: { ...sent, payload: { doc: 'other' } } })
    expect(again.json()).toMatchObject({ delivery: 'doc-1', outcome: 'already received' })
    expect(held()).toHaveLength(1)
    expect(readInbox(alpha())).toEqual([])
  })

  const preparing = (extra = '') => writeFileSync(join(alpha(), 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5').replace('\nretain:', `\nprepare: [api:app=pdf/SPORE_PDF_PAGES]\nprepare.timeout: 30s\nprepare.attach: [4, 1MB]\n${extra}retain:`))

  it('runs the program the spore binds to the caller on its payload, reading what its reads: grant, and the delivery carries what it attached', async () => {
    const docs = join(root, 'docs')
    mkdirSync(docs)
    preparing(`reads: [docs=${docs}]\n`)
    const ran = []
    await restart({}, {
      programOf: () => ({ program: '/plugins/pdf/bin/pages', reads: [] }),
      prepareBy: async (asked) => {
        ran.push(asked)
        mkdirSync(join(asked.ws, asked.into), { recursive: true })
        writeFileSync(join(asked.ws, asked.into, 'pages.json'), readFileSync(asked.payload))
        return { files: [{ path: `${asked.into}/pages.json`, name: 'pages.json', mime: 'application/json', bytes: 16 }] }
      }
    })
    const body = { ...sent, attach: [{ name: 'note.txt', mime: 'text/plain', data: '' }] }
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body })).json()).toMatchObject({ outcome: 'held — prepared by pdf/SPORE_PDF_PAGES', started: false })
    await server.routed()
    expect(ran[0]).toMatchObject({ origin: 'api:app', ref: 'doc-1', headers: null, reads: [docs], timeoutMs: 30_000, attach: { files: 4, bytes: 1024 * 1024 } })
    expect(ran[0].payload).toMatch(/payload\.json$/)
    expect(held()[0].files.map(file => file.name)).toEqual(['payload.json', 'note.txt', 'pages.json'])
    expect(released).toEqual([alpha()])
  })

  it('says a delivery past the caller\'s perHour without starting a turn', async () => {
    await restart({ app: { perHour: 1 } })
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body: sent })).json()).toMatchObject({ outcome: 'started', started: true })
    released = []
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body: { ...sent, delivery: 'doc-2' } })).json())
      .toEqual({ delivery: 'doc-2', outcome: 'said, not started — 1 turns started in the last hour', started: false })
    expect(released).toEqual([])
    expect(readInbox(alpha()).map(entry => [entry.requestId, entry.startsTurn])).toEqual([['api:app:doc-2', false]])
  })

  it('gives the program an empty stdin when the delivery has no payload', async () => {
    preparing()
    const ran = []
    await restart({}, {
      programOf: () => ({ program: '/plugins/pdf/bin/pages', reads: [] }),
      prepareBy: async (asked) => { ran.push(asked); return { files: [] } }
    })
    await call('POST', '/v1/spores/alpha/deliveries', { body: { delivery: 'doc-2', attach: [{ name: 'payload.txt', mime: 'text/plain', data: '' }] } })
    await server.routed()
    expect(ran[0]).toMatchObject({ payload: null, reads: [] })
  })

  it('asks the spore\'s router for the caller, and holds the delivery up to the caller\'s maxWait', async () => {
    mkdirSync(join(alpha(), 'data', 'routes'), { recursive: true })
    writeFileSync(join(alpha(), 'data', 'routes', 'api-app.route'), '#!/bin/sh\n')
    const asked = []
    await restart({ app: { maxWait: '1h' } }, { route: async (question) => { asked.push(question); return { wait: 3 * 3_600_000, summary: 'report queued' } } })
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body: sent })).json()).toMatchObject({ outcome: 'held — timed by api-app.route', started: false })
    await server.routed()
    expect(asked[0]).toMatchObject({ origin: 'api:app', ref: 'doc-1', prepared: null })
    const [row] = heldIn(alpha())
    expect(row.summary).toBe('report queued')
    expect(Date.parse(row.releaseAt) - Date.parse(row.at)).toBeGreaterThanOrEqual(3_600_000)
    expect(Date.parse(row.releaseAt) - Date.parse(row.at)).toBeLessThan(3_600_000 + 5_000)
    expect(row.releaseAt <= row.deadline).toBe(true)
    expect(released).toEqual([])
  })

  it('answers a spore the caller may not reach as one that does not exist, and refuses a delivery it cannot read', async () => {
    await restart()
    const narrow = await call('POST', '/v1/spores/alpha/deliveries', { token: NARROW, body: sent })
    expect([narrow.status, narrow.json().error.type]).toEqual([404, 'NOT_A_WORKSPACE'])
    expect((await call('GET', '/v1/spores/alpha/deliveries')).status).toBe(405)
    for (const [body, why] of [
      [{ ...sent, delivery: undefined }, /delivery is your id/],
      [{ ...sent, delivery: 'a b' }, /delivery is your id/],
      [{ delivery: 'doc-1', text: ' ' }, /carries a text, a payload or a file/],
      [{ ...sent, text: 3 }, /text is a string/],
      [{ ...sent, attach: [{ name: 'payload.json', mime: 'application/json', data: '' }] }, /payload\.json is the payload's name/],
      [{ ...sent, event: 'uploaded' }, /not event/]
    ]) {
      const refused = await call('POST', '/v1/spores/alpha/deliveries', { body })
      expect(refused.status).toBe(400)
      expect(refused.json().error.message).toMatch(why)
    }
    expect(held()).toEqual([])
  })

  it('takes no delivery while spores are paused', async () => {
    await restart({}, {}, { pausedNow: () => ({ at: 'now' }) })
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body: sent })).status).toBe(503)
    expect(held()).toEqual([])
  })

  it('has no route for a hook', async () => {
    expect((await call('POST', '/v1/hooks/scans/deliveries', { body: sent })).status).toBe(404)
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
    const caller = callerOf(read.callers, env.T)
    expect(caller.name).toBe('a')
    expect(callerOf(read.callers, 'u'.repeat(40))).toBe(null)
    expect(['ops', 'support-eu', 'opsx', 'support'].map(name => reaches(caller, name))).toEqual([true, true, false, false])
  })

  it('listens only where it is told, and says so of an address beyond loopback', () => {
    expect(() => loadApi(write({ callers: { a: { token, spores: ['*'] } } }), env)).toThrow(/neither a socket nor an address/)
    expect(() => loadApi(write({ listen: '8787', callers: { a: { token, spores: ['*'] } } }), env)).toThrow(/listens on "8787"/)
    expect(loadApi(write({ listen: '127.0.0.1:8787', callers: { a: { token, spores: ['*'] } } }), env).listen).toEqual({ host: '127.0.0.1', port: 8787, text: '127.0.0.1:8787', shown: '127.0.0.1:8787' })
    expect(loadApi(write({ listen: '0.0.0.0:8787', callers: { a: { token, spores: ['*'] } } }), env).listen.shown).toBe('0.0.0.0:8787 (plain HTTP, reachable beyond this machine)')
  })

  it('takes a caller\'s maxWait, perDay and perHour, and refuses a router, naming where what prepares a delivery is bound now', () => {
    expect(loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], maxWait: '30m', perDay: 5, perHour: 2 } } }), env).callers[0]).toMatchObject({ maxWait: 30 * 60_000, perDay: 5, perHour: 2 })
    expect(loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'] } } }), env).callers[0]).toMatchObject({ maxWait: null, perDay: 100, perHour: null })
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], perHour: 1.5 } } }), env)).toThrow(/caller "a" has a perHour that is not a count — 1.5/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { 'my app': { token, spores: ['*'] } } }), env)).toThrow(/has a caller named "my app"/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], maxWait: 'soon' } } }), env)).toThrow(/caller "a" has a maxWait spore cannot read — "soon"/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], perDay: 0 } } }), env)).toThrow(/caller "a" has a perDay that is not a count — 0/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], router: { plugin: 'pdf', name: 'pages' } } } }), env)).toThrow(/router for a, which api.json no longer binds/)
  })
})
