import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { botPath, routesOf } from '@rhizogrip/spore/relay'

import { createConnector } from '../src/api.js'
import { createToken, createVerifier } from '../src/auth.js'
import { TEAMS, createAdapter, normalize } from '../src/adapter.js'
import { serve } from '../src/server.js'

const APP = '00000000-aaaa-4000-8000-000000000001'
const TENANT = '00000000-bbbb-4000-8000-000000000002'
const ALICE = '00000000-cccc-4000-8000-000000000003'
const CHANNEL = '19:general0@thread.tacv2'

let DIR
let path
const bot = (fields) => writeFileSync(path, JSON.stringify({ app: APP, tenant: TENANT, secret: '${OPS_TEAMS_SECRET}', listen: '127.0.0.1:3978', ...fields })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-teams-test-'))
  path = botPath(TEAMS, 'ops', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'teams'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot\'s people and channels', () => {
  it('read each person\'s personal chat against the spore it reaches, and each channel with its spore and who may address it', () => {
    bot({ people: { [ALICE]: 'triage', b2c3: { spore: 'ledger', details: true } }, channels: { [CHANNEL]: { spores: ['triage'], people: [ALICE, '*'], brief: true } } })
    expect(routesOf(TEAMS, path)).toEqual(new Map([
      [ALICE, { spores: ['triage'], details: false, show: null, brief: false, people: null, overhear: false }],
      ['b2c3', { spores: ['ledger'], details: true, show: null, brief: false, people: null, overhear: false }],
      [CHANNEL, { spores: ['triage'], details: false, show: null, brief: true, people: [ALICE, '*'], overhear: false }]
    ]))
    bot({ people: { [ALICE]: { spore: 'triage', brief: 'yes' } } })
    expect(() => routesOf(TEAMS, path)).toThrow(/person .* whose brief is not true or false/)
  })

  it('route a channel\'s threads by the channel', () => {
    expect(TEAMS.routeOf(`${CHANNEL};messageid=1729000000001`)).toBe(CHANNEL)
    expect(TEAMS.routeOf(ALICE)).toBe(ALICE)
  })

  it('refuse a bot without its app, its tenant, or a loopback address to listen on', () => {
    bot({ app: undefined, people: {} })
    expect(() => routesOf(TEAMS, path)).toThrow(/has no app/)
    bot({ tenant: '', people: {} })
    expect(() => routesOf(TEAMS, path)).toThrow(/has no tenant/)
    for (const listen of ['0.0.0.0:3978', '10.0.0.4:3978', '3978', '127.0.0.1:99999']) {
      bot({ listen, people: {} })
      expect(() => routesOf(TEAMS, path), listen).toThrow(expect.objectContaining({ message: expect.stringMatching(/listens on/), detail: expect.stringMatching(/^listen is a loopback address and a port/) }))
    }
    bot({ listen: '[::1]:3978', people: {} })
    expect(routesOf(TEAMS, path)).toEqual(new Map())
    bot({ secret: 'in-clear', people: {} })
    expect(() => routesOf(TEAMS, path)).toThrow(/no secret spore can read/)
  })

  it('refuse a person who is not an object id, a channel that is not a channel id, and the fields neither takes', () => {
    bot({ people: { [CHANNEL]: 'triage' } })
    expect(() => routesOf(TEAMS, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/which is not an Entra object id/), detail: expect.stringMatching(/goes under channels/) }))
    bot({ channels: { general: { spores: ['triage'], people: ['*'] } } })
    expect(() => routesOf(TEAMS, path)).toThrow(/names "general" among its channels, which is not a channel id/)
    bot({ people: { [ALICE]: { spore: 'triage', show: 'react' } } })
    expect(() => routesOf(TEAMS, path)).toThrow(expect.objectContaining({ detail: 'a person takes spore, details, brief' }))
    bot({ channels: { [CHANNEL]: { spores: ['triage'], people: ['*'], overhear: true } } })
    expect(() => routesOf(TEAMS, path)).toThrow(/gives channel .* overhear, which a channel does not take/)
    bot({})
    expect(() => routesOf(TEAMS, path)).toThrow(/has no people and no channels/)
  })

  it('refuse a channel with no spore or more than one, or without its people written out', () => {
    const channel = (entry) => bot({ channels: { [CHANNEL]: entry } })
    channel({ spores: [], people: ['*'] })
    expect(() => routesOf(TEAMS, path)).toThrow(/with no spores/)
    channel({ spores: ['triage', 'ledger'], people: ['*'] })
    expect(() => routesOf(TEAMS, path)).toThrow(/gives channel .* 2 spores/)
    channel({ spores: ['triage'] })
    expect(() => routesOf(TEAMS, path)).toThrow(/whose people are not object ids or \*/)
  })
})

describe('an activity', () => {
  const personal = (fields = {}) => ({
    type: 'message',
    id: '1:abc',
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversation: { id: 'a:1xyz', conversationType: 'personal', tenantId: TENANT },
    from: { id: '29:1alice', aadObjectId: ALICE, name: 'Alice Martin' },
    recipient: { id: `28:${APP}`, name: 'Triage' },
    text: 'hello',
    ...fields
  })
  const inChannel = (text, fields = {}) => personal({
    id: '1729000000002',
    conversation: { id: `${CHANNEL};messageid=1729000000001`, conversationType: 'channel', tenantId: TENANT },
    channelData: { channel: { id: CHANNEL, name: 'General' }, team: { id: '19:team@thread.tacv2' } },
    text,
    ...fields
  })
  const mentioning = (name) => ({ type: 'mention', mentioned: { id: `28:${APP}`, name }, text: `<at>${name}</at>` })

  it('in a personal chat is the person\'s, under an id unique to the conversation', () => {
    expect(normalize(personal())).toEqual({
      id: 'a:1xyz:1:abc',
      conversation: ALICE,
      message: '1:abc',
      person: { id: ALICE, name: 'Alice Martin', groups: [] },
      spore: null,
      where: 'a personal chat in Teams',
      shared: false,
      text: 'hello',
      command: null,
      addresses: null,
      files: 0
    })
  })

  it('in a channel is its thread\'s, reaching the spore when it mentions the bot, the mention not part of what was said', () => {
    expect(normalize(inChannel('<at>Triage</at> what failed?', { entities: [mentioning('Triage')] }))).toMatchObject({
      conversation: `${CHANNEL};messageid=1729000000001`,
      where: 'the Teams channel "General"',
      shared: true,
      text: 'what failed?',
      addresses: null
    })
    expect(normalize(inChannel('ask <at>Bob</at>', { entities: [{ type: 'mention', mentioned: { id: '29:bob', name: 'Bob' }, text: '<at>Bob</at>' }] }))).toMatchObject({ text: 'ask @Bob', addresses: [] })
  })

  it('reads a command once the mention is gone, and its markup as plain text', () => {
    expect(normalize(inChannel('<at>Triage</at> /extend wall 30m', { entities: [mentioning('Triage')] })).command).toEqual({ verb: 'extend', args: 'wall 30m' })
    expect(normalize(personal({ text: '<p>a &amp; b<br>c&nbsp;d</p>' })).text).toBe('a & b\nc d')
  })

  it('counts what came with it, leaving out the copy of the text Teams adds, and has no text when nothing was written', () => {
    expect(normalize(personal({ text: '', attachments: [{ contentType: 'image/png' }, { contentType: 'text/html' }] }))).toMatchObject({ text: null, files: 1 })
  })

  it('is refused with the line that would let it in — a person under people, a channel under channels', () => {
    expect(TEAMS.refusal(normalize(personal()), 'ops.json')).toBe(`refused Alice Martin (${ALICE}) — to allow them, add "${ALICE}": "<a spore>" to the people of ops.json`)
    expect(TEAMS.refusal(normalize(inChannel('<at>Triage</at> hi', { entities: [mentioning('Triage')] })), 'ops.json'))
      .toBe(`refused the Teams channel "General", ${CHANNEL} — to allow it, add "${CHANNEL}": { "spores": ["<a spore>"], "people": ["${ALICE}"] } to the channels of ops.json`)
  })
})

describe('the token the Bot Connector sends', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', endorsements: ['msteams'] }
  const now = 1_800_000_000_000
  const activity = { channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/' }
  const jwt = (claims = {}, header = {}, key = privateKey) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const head = part({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header })
    const body = part({ iss: 'https://api.botframework.com', aud: APP, exp: now / 1000 + 600, nbf: now / 1000 - 60, serviceurl: 'https://smba.trafficmanager.net/emea', ...claims })
    return `Bearer ${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`
  }
  const keys = (published, clock = { at: now }) => {
    const asked = []
    const fetchImpl = async (url) => {
      asked.push(url)
      if (url.endsWith('openidconfiguration')) return new Response(JSON.stringify({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' }))
      return new Response(JSON.stringify({ keys: published }))
    }
    return { asked, verify: createVerifier({ app: APP, fetchImpl, now: () => clock.at }) }
  }

  it('holds when Microsoft signed it for this bot, its channel and its service', async () => {
    expect(await keys([jwk]).verify(jwt(), activity)).toBe(null)
  })

  it('does not hold, and says why, for each thing that is not so', async () => {
    const { verify } = keys([jwk])
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect(await verify(undefined, activity)).toBe('it carries no bearer token')
    expect(await verify('Bearer not.a.jwt', activity)).toBe('its token is not a JWT')
    expect(await verify(jwt({}, { alg: 'RS384' }), activity)).toBe('its token is signed with RS384, not RS256')
    expect(await verify(jwt({}, {}, other), activity)).toBe('its token\'s signature does not hold')
    expect(await verify(jwt({ iss: 'https://sts.windows.net/x/' }), activity)).toBe('its token was issued by https://sts.windows.net/x/')
    expect(await verify(jwt({ aud: 'another-app' }), activity)).toBe('its token is for another-app, not this bot')
    expect(await verify(jwt({ exp: now / 1000 - 301 }), activity)).toBe('its token has expired')
    expect(await verify(jwt({ nbf: now / 1000 + 301 }), activity)).toBe('its token is not valid yet')
    expect(await verify(jwt({ serviceurl: 'https://elsewhere.example/' }), activity)).toBe('its token is for another serviceUrl than the activity names')
    expect(await verify(jwt(), { ...activity, channelId: 'webchat' })).toBe('key k1 is not endorsed for webchat')
  })

  it('refuses a key Microsoft does not publish, reading its keys again for one at most once a minute', async () => {
    const clock = { at: now }
    const { asked, verify } = keys([jwk], clock)
    expect(await verify(jwt({}, { kid: 'k9' }), activity)).toBe('its token names key k9, which Microsoft does not publish')
    expect(await verify(jwt({}, { kid: 'k9' }), activity)).toBe('its token names key k9, which Microsoft does not publish')
    expect(asked).toHaveLength(2)
    clock.at += 61_000
    expect(await verify(jwt({}, { kid: 'k9' }), activity)).toBe('its token names key k9, which Microsoft does not publish')
    expect(asked).toHaveLength(4)
  })
})

describe('the bot\'s own token', () => {
  it('is asked of its tenant with its app id and secret, and kept until shortly before it expires', async () => {
    const asked = []
    let at = 0
    const token = createToken({
      app: APP,
      tenant: TENANT,
      secret: 's3cret',
      now: () => at,
      fetchImpl: async (url, init) => {
        asked.push({ url, body: Object.fromEntries(init.body) })
        return new Response(JSON.stringify({ access_token: `t${asked.length}`, expires_in: 3600 }))
      }
    })
    expect(await token()).toBe('t1')
    at = 3000 * 1000
    expect(await token()).toBe('t1')
    at = 3301 * 1000
    expect(await token()).toBe('t2')
    expect(asked[0]).toEqual({
      url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      body: { grant_type: 'client_credentials', client_id: APP, client_secret: 's3cret', scope: 'https://api.botframework.com/.default' }
    })
  })

  it('is refused for good when Microsoft refuses the app or its secret', async () => {
    const token = createToken({ app: APP, tenant: TENANT, secret: 'wrong', fetchImpl: async () => new Response(JSON.stringify({ error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' }), { status: 401 }) })
    await expect(token()).rejects.toMatchObject({ type: 'TEAMS_REFUSED', detail: 'AADSTS7000215: Invalid client secret provided.', retryable: false })
  })
})

describe('the Bot Connector', () => {
  const answering = (status, body = {}, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers })

  it('posts into a conversation under the bot\'s token, its id in the path', async () => {
    const asked = []
    const connector = createConnector({
      token: async () => 'tok',
      fetchImpl: async (url, init) => {
        asked.push({ url, method: init.method, authorization: init.headers.authorization, body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ id: '1:new' }))
      }
    })
    expect(await connector.send('https://smba.trafficmanager.net/emea', `${CHANNEL};messageid=1`, { type: 'message', text: 'hi' })).toBe('1:new')
    expect(asked).toEqual([{
      url: `https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=1`)}/activities`,
      method: 'POST',
      authorization: 'Bearer tok',
      body: { type: 'message', text: 'hi' }
    }])
  })

  it('says what to try again and how long Microsoft asked to wait, and what not to', async () => {
    const send = (fetchImpl) => createConnector({ token: async () => 'tok', fetchImpl }).send('https://s/', 'a:1', {})
    await expect(send(answering(429, {}, { 'retry-after': '3' }))).rejects.toMatchObject({ type: 'TEAMS_FAILED', retryable: true, context: { status: 429, retryAfter: 3 } })
    await expect(send(answering(412))).rejects.toMatchObject({ retryable: true })
    await expect(send(answering(403, { error: { code: 'ConversationBlockedByUser', message: 'User blocked the conversation with the bot.' } })))
      .rejects.toMatchObject({ retryable: false, detail: 'User blocked the conversation with the bot.', context: { status: 403, code: 'ConversationBlockedByUser' } })
    await expect(send(async () => { throw new Error('ECONNRESET') })).rejects.toMatchObject({ retryable: true, detail: 'ECONNRESET' })
  })
})

describe('what the bot posts', () => {
  it('says its own lines in Teams\' HTML subset, escaped, and an answer in extended Markdown', async () => {
    const sent = []
    const connector = { send: async (url, conversation, activity) => { sent.push(activity); return '7' }, create: async () => ({ id: 'a:p' }) }
    const adapter = createAdapter({ connector, receive: () => {}, app: 'app', tenant: 't' })
    adapter.restore({ chats: {}, channels: {} }, () => {})
    await adapter.post('p', 'idle · 2 turns\n<b>not bold</b> & co')
    await adapter.post('p', '| a | b |\n|---|---|\n| 1 | 2 |', { markdown: true })
    expect(sent).toEqual([
      { type: 'message', text: 'idle · 2 turns<br>&lt;b&gt;not bold&lt;/b&gt; &amp; co', textFormat: 'xml' },
      { type: 'message', text: '| a | b |\n|---|---|\n| 1 | 2 |', textFormat: 'extendedmarkdown' }
    ])
  })
})

describe('the listener', () => {
  let stop
  let port
  const taken = []
  const logs = []
  const listening = async (verify, onActivity = async (activity) => { taken.push(activity) }) => {
    const controller = new AbortController()
    stop = () => controller.abort()
    const ready = new Promise(resolve => serve({ host: '127.0.0.1', port: 0, verify, onActivity, signal: controller.signal, log: (line) => logs.push(line), listening: resolve }))
    port = await ready
  }
  const post = (body, { path: at = '/api/messages', authorization = 'Bearer good' } = {}) =>
    fetch(`http://127.0.0.1:${port}${at}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

  beforeEach(() => { taken.length = 0; logs.length = 0 })
  afterEach(() => stop())

  it('answers 200 once the activity is taken, 401 to one whose token does not hold, and takes nothing else', async () => {
    await listening(async (authorization) => authorization === 'Bearer good' ? null : 'its token is for another-app, not this bot')
    expect((await post({ id: 'a1' })).status).toBe(200)
    expect((await post({ id: 'a2' }, { authorization: 'Bearer bad' })).status).toBe(401)
    expect((await post({ id: 'a3' }, { path: '/other' })).status).toBe(404)
    expect((await post('{nope')).status).toBe(400)
    expect((await post('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
    expect(taken.map(activity => activity.id)).toEqual(['a1'])
    expect(logs).toEqual(['refused an activity: its token is for another-app, not this bot'])
  })

  it('answers 500 to an activity the service could not take, and 503 when it cannot check one, so Microsoft delivers it again', async () => {
    await listening(async () => { throw Object.assign(new Error('reading the keys Microsoft signs activities with failed'), { detail: 'ENOTFOUND' }) })
    expect((await post({ id: 'a1' })).status).toBe(503)
    stop()
    await listening(async () => null, async () => { throw new Error('busy database') })
    expect((await post({ id: 'a2' })).status).toBe(500)
    expect(logs.at(-1)).toBe('activity a2 not taken — busy database')
  })

  it('answers an invoke with the body the service answers it with, and nothing else with a body', async () => {
    const pressed = { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Apply — recorded' }
    await listening(async () => null, async (activity) => activity.type === 'invoke' ? pressed : logs.length)
    const invoke = await post({ id: 'a1', type: 'invoke' })
    expect(invoke.status).toBe(200)
    expect(await invoke.json()).toEqual(pressed)
    const message = await post({ id: 'a2', type: 'message' })
    expect(message.status).toBe(200)
    expect(await message.text()).toBe('')
  })
})
