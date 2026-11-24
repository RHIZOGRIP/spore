/**
 * The HTTP API, served on a unix socket as a container serves it, against a real spore and the
 * scripted model: who may call, what each route does, and the trace a message carries on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { request } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { startGate } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, withAuth } from './fixtures/outside-ws.js'
import { pauseSpores, unpauseSpores } from '../src/core/admission.js'
import { CONFIG_DIR, CONFIG_FILE } from '../src/library/config.js'
import { definitionWith } from '../src/testing.js'
import { acquireLock, approvalOf, heldIn, postApproval, readInbox, readTranscript, releaseLock, saidOf, writeTranscriptEntries } from '../src/core/spore-dir.js'
import { askApproval } from '../src/library/approvals.js'
import { apiCaller, callerOf, loadApi, reaches } from '../api/config.js'
import { createApiServer } from '../api/server.js'

// A release starts nothing, a plugin's program is named, and what it prepares is written, by the test.
const given = vi.hoisted(() => ({ release: null, programOf: null, prepare: null }))
vi.mock('../src/core/send.js', async (original) => {
  const real = await original()
  return { ...real, release: (...args) => (given.release ?? real.release)(...args) }
})
vi.mock('../src/core/plugins.js', async (original) => {
  const real = await original()
  return { ...real, pluginProgram: (...args) => (given.programOf ?? real.pluginProgram)(...args) }
})
vi.mock('../src/core/prepare.js', async (original) => {
  const real = await original()
  return { ...real, runPrepare: (...args) => (given.prepare ?? real.runPrepare)(...args) }
})

const APP = 'a'.repeat(40)
const NARROW = 'n'.repeat(40)
const OTHER = 'o'.repeat(40)
const TRACE = '0af7651916cd43dd8448eb211c80319c'

let root
let gate
let server
let socket

const configure = () => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  gate.configure({ home: join(root, 'home') })
  writeFileSync(join(CONFIG_DIR, 'api.json'), JSON.stringify({
    socket: join(root, 'run', 'api.sock'),
    callers: {
      app: { token: '${API_APP}', spores: ['*'], serves: ['da'] }, // eslint-disable-line no-template-curly-in-string
      other: { token: '${API_OTHER}', spores: ['*'] }, // eslint-disable-line no-template-curly-in-string
      narrow: { token: '${API_NARROW}', spores: ['beta*'] } // eslint-disable-line no-template-curly-in-string
    }
  }))
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
  writeFileSync(join(ws, 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')))
  gate = await startGate({ mo: scriptedMo(async () => answers('hello back')), name: 'api-test' })
  configure()
  const secrets = { API_APP: APP, API_NARROW: NARROW, API_OTHER: OTHER }
  const api = loadApi(join(CONFIG_DIR, 'api.json'), secrets)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MODEL: 'anthropic/claude-haiku-4-5', ...secrets }
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 })
  socket = api.socket
  server = createApiServer({ api, env })
  await new Promise(resolve => server.listen(socket, resolve))
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  await gate?.close()
  Object.assign(given, { release: null, programOf: null, prepare: null })
  rmSync(root, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
  rmSync(join(CONFIG_DIR, 'api.json'), { force: true })
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

describe('stopping a turn', () => {
  it('says nothing was running, and refuses a replyTo that is no conversation', async () => {
    const idle = await call('POST', '/v1/spores/alpha/stop', { body: { replyTo: 'telegram:main/42' } })
    expect([idle.status, idle.json()]).toEqual([200, { stopped: false, pid: null }])
    for (const replyTo of ['nowhere', 42]) {
      const refused = await call('POST', '/v1/spores/alpha/stop', { body: { replyTo } })
      expect([refused.status, refused.json().error.type]).toEqual([400, 'API_BAD_REQUEST'])
    }
  })
})

describe('flushing a spore', () => {
  it('flushes between turns for whoever the caller says asked, and is refused while a turn runs or with nobody named', async () => {
    const ws = join(root, 'home', 'alpha')
    const said = (role, content) => ({ at: '2026-10-26T00:00:00.000Z', kind: 'message', role, message: { role, content } })
    writeTranscriptEntries(ws, [said('user', 'my locker code is 4417'), said('assistant', 'noted')])

    const unnamed = await call('POST', '/v1/spores/alpha/flush', { body: {} })
    expect([unnamed.status, unnamed.json().error.type]).toEqual([400, 'FLUSH_INVALID'])

    acquireLock(ws)
    try {
      const running = await call('POST', '/v1/spores/alpha/flush', { body: { by: 'Ada' } })
      expect([running.status, running.json().error.type]).toEqual([409, 'SPORE_RUNNING'])
    } finally {
      releaseLock(ws)
    }
    expect(readTranscript(ws)).toHaveLength(2)

    const flushed = await call('POST', '/v1/spores/alpha/flush', { body: { by: 'Ada' } })
    expect([flushed.status, flushed.json()]).toEqual([200, { entryNo: 3, by: 'Ada', open: { question: null, approvals: [], jobs: [], interactions: [] } }])
    expect(readTranscript(ws).map(message => message.content)).toEqual([expect.stringMatching(/Ada flushed the conversation/)])
    expect((await call('POST', '/v1/spores/alpha/flush', { token: NARROW, body: { by: 'Ada' } })).json().error.type).toBe('NOT_A_WORKSPACE')
  })
})

describe('an approval in a place the caller serves', () => {
  const REQUEST = {
    to: 'da:thread-7',
    by: ['u1'],
    options: [{ id: 'apply', label: 'Apply' }, { id: 'cancel', label: 'Cancel', skip: true }],
    body: { default: { text: 'Apply the change?' } },
    fields: [{ id: 'reason', label: 'Why?', required: true }]
  }
  const ADA = { id: 'u1', name: 'Ada' }
  const waiting = async (token = APP) => (await call('GET', '/v1/spores/alpha/approvals?open=true', { token })).json().approvals.map(one => [one.id, one.state])
  const step = (id, name, body, token = APP) => call('POST', `/v1/spores/alpha/approvals/${id}/${name}`, { body, token })

  it('is shown, answered by someone it names and settled by that caller, and the spore is told once', async () => {
    const ws = join(root, 'home', 'alpha')
    const { approval: id } = (await call('POST', '/v1/spores/alpha/approvals', { body: REQUEST })).json()
    expect(await waiting()).toEqual([[id, 'asked']])
    expect(await waiting(OTHER)).toEqual([])

    for (const [name, body] of [['posted', { shown: {} }], ['refused', { reason: 'no' }], ['answer', { choice: 'apply', person: ADA }], ['settled', {}]]) {
      const refused = await step(id, name, body, OTHER)
      expect([name, refused.status, refused.json().error.type]).toEqual([name, 403, 'APPROVAL_NOT_SERVED'])
      expect((await step(id, name, body, NARROW)).json().error.type).toBe('NOT_A_WORKSPACE')
    }
    expect((await step(id, 'answer', { choice: 'apply', person: ADA })).json()).toEqual({ taken: false, reason: 'this question is closed' })
    expect((await step(id, 'settled', {})).json().error.type).toBe('APPROVAL_STATE')

    expect((await step(id, 'posted', { shown: { text: 'Apply the change?', buttons: ['apply', 'cancel'] }, note: 'm-1' })).json()).toEqual({ posted: true })
    expect((await step(id, 'posted', { shown: {} })).status).toBe(409)
    expect(approvalOf(ws, id)).toMatchObject({ state: 'posted', note: 'm-1', shown: { buttons: ['apply', 'cancel'] } })

    expect((await step(id, 'answer', { choice: 'apply', person: { id: 'u2', name: 'Bob' } })).json()).toEqual({ taken: false, reason: 'this is not yours to answer' })
    expect((await step(id, 'answer', { choice: 'later', person: ADA })).json()).toEqual({ taken: false, reason: 'that is not one of its choices' })
    expect((await step(id, 'answer', { choice: 'apply', person: ADA })).json()).toEqual({ taken: false, reason: 'fill in "Why?" first' })
    expect((await step(id, 'answer', { choice: 'apply', person: { id: 'u1' } })).status).toBe(400)
    expect((await step(id, 'answer', { choice: 'apply', inputs: { reason: 'checked' }, person: ADA })).json()).toEqual({ taken: true })
    expect((await step(id, 'answer', { choice: 'cancel', person: ADA })).json()).toEqual({ taken: false, reason: 'this was answered already' })
    expect(await waiting()).toEqual([[id, 'answered']])

    expect((await step(id, 'settled', { outcome: 'failed' })).status).toBe(400)
    expect((await step(id, 'settled', { outcome: 'confirmed', tell: 'It is live.' })).json()).toEqual({ settled: true, told: true })
    expect((await step(id, 'settled', { outcome: 'failed', reason: 'late' })).json()).toEqual({ settled: false, told: true })
    await call('GET', '/v1/spores/alpha/events?after=0')

    const inbox = readInbox(ws)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ approval: id, replyTo: 'da:thread-7', requestId: `approval:${id}` })
    expect(inbox[0].text).toBe('Ada chose "Apply", and the host confirmed it.\n\nWhat they filled in:\n- Why?: "checked"\n\nThe host adds:\nIt is live.')
    expect(approvalOf(ws, id)).toMatchObject({ state: 'answered', outcome: 'confirmed', told: true })
    expect(await waiting()).toEqual([])
  })

  it('ends at the caller\'s next look once its deadline passed: refused when never shown, expired when shown', async () => {
    const ws = join(root, 'home', 'alpha')
    const past = { configFile: CONFIG_FILE, now: Date.now() - 2 * 3600_000 }
    const unshown = askApproval(ws, { ...REQUEST, within: '1h' }, past).approval
    const shown = askApproval(ws, { ...REQUEST, within: '1h' }, past).approval
    postApproval(ws, shown, { shown: { text: 'Apply the change?' }, note: null })

    expect(await waiting()).toEqual([[shown, 'expired']])
    expect(approvalOf(ws, unshown)).toMatchObject({ state: 'refused', reason: 'its deadline passed before it could be shown', settledAt: expect.any(String) })
    expect((await step(unshown, 'posted', { shown: {} })).json().error.type).toBe('APPROVAL_STATE')

    expect((await step(shown, 'settled', { outcome: 'confirmed' })).status).toBe(400)
    expect((await step(shown, 'settled', {})).json()).toEqual({ settled: true, told: true })
    await call('GET', '/v1/spores/alpha/events?after=0')
    expect(readInbox(ws).map(entry => entry.text)).toEqual([expect.stringMatching(/^Nobody answered it by /)])
    expect(await waiting()).toEqual([])
  })

  it('is refused by the caller that cannot show it, and done with', async () => {
    const { approval: id } = (await call('POST', '/v1/spores/alpha/approvals', { body: REQUEST })).json()
    expect((await step(id, 'refused', {})).status).toBe(400)
    expect((await step(id, 'refused', { reason: 'the thread is closed' })).json()).toEqual({ refused: true })
    expect(approvalOf(join(root, 'home', 'alpha'), id)).toMatchObject({ state: 'refused', reason: 'the thread is closed', settledAt: expect.any(String) })
    expect(await waiting()).toEqual([])
    expect((await call('GET', '/v1/spores/alpha/approvals?open=yes')).status).toBe(400)
    const hooked = await call('POST', '/v1/spores/alpha/approvals', { body: { ...REQUEST, hook: 'kpi' } })
    expect([hooked.status, hooked.json().error]).toEqual([409, expect.objectContaining({ type: 'APPROVAL_HOOKED', detail: expect.stringMatching(/"app" serves that place/) })])
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

  const restart = async (callers = {}) => {
    const secrets = { API_APP: APP, API_NARROW: NARROW }
    writeFileSync(join(CONFIG_DIR, 'api.json'), JSON.stringify({
      socket,
      callers: {
        app: { token: '${API_APP}', spores: ['*'], ...callers.app }, // eslint-disable-line no-template-curly-in-string
        narrow: { token: '${API_NARROW}', spores: ['beta*'] } // eslint-disable-line no-template-curly-in-string
      }
    }))
    await new Promise(resolve => server.close(resolve))
    released = []
    given.release = (ws) => { released.push(ws); return { released: [1], started: true } }
    server = createApiServer({ api: loadApi(join(CONFIG_DIR, 'api.json'), secrets), env: { PATH: process.env.PATH, ...secrets } })
    await new Promise(resolve => server.listen(socket, resolve))
  }

  it('holds it from the caller, with its text, its payload first and its files, under the caller\'s trace, once per id, and releases it at once', async () => {
    await restart()
    const body = { ...sent, hop: 1, attach: [{ name: 'note.txt', mime: 'text/plain', data: Buffer.from('n').toString('base64') }] }
    const first = await call('POST', '/v1/spores/alpha/deliveries', { body, headers: { traceparent: `00-${TRACE}-b7ad6b7169203331-01` } })
    expect([first.status, first.json()]).toEqual([202, { delivery: 'doc-1', outcome: 'started', started: true }])
    expect(released).toEqual([alpha()])
    const [entry] = held()
    expect(entry).toMatchObject({ api: 'app', hop: 1, text: 'Analyse it.', requestId: 'api:app:doc-1' })
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

  const preparing = (extra = '') => writeFileSync(join(alpha(), 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')).replace('\nretain:', `\nprepare: [api:app=pdf/SPORE_PDF_PAGES]\nprepare.timeout: 30s\nprepare.attach: [4, 1MB]\n${extra}retain:`))

  it('runs the program the spore binds to the caller on its payload, reading what its reads: grant, and the delivery carries what it attached', async () => {
    const docs = join(root, 'docs')
    mkdirSync(docs)
    preparing(`reads: [docs=${docs}]\n`)
    const ran = []
    await restart()
    given.programOf = () => ({ program: '/plugins/pdf/bin/pages', reads: [] })
    given.prepare = async (asked) => {
      ran.push(asked)
      mkdirSync(join(asked.ws, asked.into), { recursive: true })
      writeFileSync(join(asked.ws, asked.into, 'pages.json'), readFileSync(asked.payload))
      return { files: [{ path: `${asked.into}/pages.json`, name: 'pages.json', mime: 'application/json', bytes: 16 }] }
    }
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
    await restart()
    given.programOf = () => ({ program: '/plugins/pdf/bin/pages', reads: [] })
    given.prepare = async (asked) => { ran.push(asked); return { files: [] } }
    await call('POST', '/v1/spores/alpha/deliveries', { body: { delivery: 'doc-2', attach: [{ name: 'payload.txt', mime: 'text/plain', data: '' }] } })
    await server.routed()
    expect(ran[0]).toMatchObject({ payload: null, reads: [] })
  })

  it('asks the spore\'s router for the caller, and holds the delivery up to the caller\'s maxWait', async () => {
    mkdirSync(join(alpha(), 'data', 'routes'), { recursive: true })
    writeFileSync(join(alpha(), 'data', 'routes', 'api-app.route.js'), 'console.log(JSON.stringify({ wait: \'3h\', summary: `report queued for ${process.argv.slice(2).join(\'|\')}` }))\n') // eslint-disable-line no-template-curly-in-string
    await restart({ app: { maxWait: '1h' } })
    expect((await call('POST', '/v1/spores/alpha/deliveries', { body: sent })).json()).toMatchObject({ outcome: 'held — timed by api-app.route.js', started: false })
    await server.routed()
    const [row] = heldIn(alpha())
    expect(row.summary).toBe('report queued for api:app||doc-1||')
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
      [{ ...sent, event: 'uploaded' }, /not event/],
      [{ ...sent, hop: -1 }, /hop is how many deliveries/],
      [{ ...sent, hop: 1.5 }, /hop is how many deliveries/],
      [{ ...sent, hop: '1' }, /hop is how many deliveries/]
    ]) {
      const refused = await call('POST', '/v1/spores/alpha/deliveries', { body })
      expect(refused.status).toBe(400)
      expect(refused.json().error.message).toMatch(why)
    }
    expect(held()).toEqual([])
  })

  it('takes no delivery while spores are paused', async () => {
    await restart()
    pauseSpores()
    try {
      expect((await call('POST', '/v1/spores/alpha/deliveries', { body: sent })).status).toBe(503)
    } finally {
      unpauseSpores()
    }
    expect(held()).toEqual([])
  })

  it('has no route for a hook', async () => {
    expect((await call('POST', '/v1/hooks/scans/deliveries', { body: sent })).status).toBe(404)
  })
})

describe('api.json', () => {
  const write = (config) => {
    const path = join(root, 'probe.json')
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

  it('tells a program on this machine where to call as one of its callers, with that caller\'s token', () => {
    const path = write({ socket: '/run/a.sock', listen: '127.0.0.1:8787', callers: { a: { token, spores: ['*'] }, b: { token: '${U}', spores: ['*'] } } }) // eslint-disable-line no-template-curly-in-string
    const both = { ...env, U: 'u'.repeat(40) }
    expect(apiCaller('b', path, both)).toEqual({ socket: '/run/a.sock', listen: { host: '127.0.0.1', port: 8787, text: '127.0.0.1:8787', shown: '127.0.0.1:8787' }, token: 'u'.repeat(40) })
    expect(() => apiCaller('c', path, both)).toThrow(/names no caller "c"/)
    expect(() => apiCaller('a', path, env)).toThrow(/\$U for b, which is not set/)
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
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], serves: ['Chat'] } } }), env)).toThrow(/serves for a that is not a list of kinds of place/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], serves: ['app'] }, b: { token, spores: ['*'], serves: ['app'] } } }), env)).toThrow(/two callers serving app/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], router: { plugin: 'pdf', name: 'pages' } } } }), env)).toThrow(/router for a, which api.json no longer binds/)
  })

  it('refuses a caller\'s maxWait and perHour on a host whose caller admits turns', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ admission: 'caller' }))
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], maxWait: '30m' } } }), env)).toThrow(/caller "a" has maxWait, and this host's caller admits its turns/)
    expect(() => loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], perHour: 2, maxWait: '1h' } } }), env)).toThrow(/caller "a" has maxWait and perHour, and/)
    expect(loadApi(write({ socket: '/run/a.sock', callers: { a: { token, spores: ['*'], perDay: 5 } } }), env).callers[0]).toMatchObject({ maxWait: null, perDay: 5, perHour: null })
  })
})
