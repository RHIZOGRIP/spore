import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { showPlugin } from '@rhizogrip/spore'
import { credentialOf, readBot, routesOf } from '@rhizogrip/spore/relay'

import { DISCORD } from '../src/adapter.js'
import { createDiscord, INTENTS, USER_AGENT } from '../src/api.js'
import { header, historyLines, isWorkingPost, plain } from '../src/forward.js'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_BIN = join(dirname(createRequire(join(ROOT, 'package.json')).resolve('@rhizogrip/spore/package.json')), 'bin', 'source.js')

let dir
let server
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'spore-discord-')) })
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

async function broker (answer) {
  writeFileSync(join(dir, 'model.key'), 'k'.repeat(64))
  const asked = []
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      asked.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  const socketPath = join(dir, 'source.sock')
  await new Promise(resolve => server.listen(socketPath, resolve))
  const history = (...args) => run(process.execPath, [join(ROOT, 'bin/discord.js'), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, SPORE_SOURCE: SOURCE_BIN, SPORE_SOURCE_SOCKET: socketPath }
  })
  return { asked, history }
}

describe('the discord plugin', () => {
  it('is a plugin spore accepts, describing its source, giving its program and offering its service', () => {
    const shown = showPlugin('discord', { configFile: join(ROOT, 'no-config.json') })
    expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-discord', sources: ['discord'], programs: { SPORE_DISCORD: join(shown.dir, 'bin/discord.js') } })
  })

  it('reads a channel\'s history through the discord source, oldest first', async () => {
    const page = [
      { id: '12', timestamp: 't2', author: { username: 'triage' }, webhook_id: 'h', content: 'on it', mentions: [], attachments: [] },
      { id: '11', timestamp: 't1', author: { username: 'alice' }, content: 'payouts?', mentions: [], attachments: [] }
    ]
    const { asked, history } = await broker({ status: 200, ok: true, contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify(page)).toString('base64') })
    const { stdout } = await history('history', '100', '--before', '13', '--limit', '2')
    expect(asked).toEqual([{ path: '/fetch', body: { source: 'discord', path: '100/messages', params: { limit: '2', before: '13' } } }])
    expect(stdout).toBe('11 t1 alice: payouts?\n12 t2 triage (webhook): on it\n')
  })

  it('refuses what is not a channel, before asking anything', async () => {
    const { asked, history } = await broker({ status: 200, ok: true, contentType: 'application/json', bodyBase64: Buffer.from('[]').toString('base64') })
    await expect(history('history', 'general')).rejects.toMatchObject({ code: 2 })
    await expect(history('history', '100', '--limit', '500')).rejects.toMatchObject({ code: 2 })
    expect(asked).toEqual([])
  })
})

const bot = (content) => {
  const path = join(dir, 'ops.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

describe('a bot file', () => {
  it('reads each channel, its spores, who may address them, whether spores talk, and how a turn shows there', () => {
    const path = bot({ token: '${DISCORD_BOT_TOKEN}', channels: { 100: { spores: ['triage'], people: ['1', 'role:2'], sporesTalk: true }, 200: { spores: ['ledger'], people: ['*'], show: 'react', details: true } } }) // eslint-disable-line no-template-curly-in-string
    expect([...routesOf(DISCORD, path)]).toEqual([
      ['100', { spores: ['triage'], details: false, show: null, people: ['1', 'role:2'], sporesTalk: true }],
      ['200', { spores: ['ledger'], details: true, show: 'react', people: ['*'], sporesTalk: false }]
    ])
    expect(credentialOf(DISCORD, path, 'token', { DISCORD_BOT_TOKEN: 'tok' })).toBe('tok')
    expect(() => credentialOf(DISCORD, path, 'token', {})).toThrow(expect.objectContaining({ type: 'DISCORD_NO_TOKEN' }))
  })

  it('gives a spore the avatar it names, and refuses one Discord could not fetch', () => {
    const channels = { 100: { spores: ['triage'], people: [] } }
    expect(readBot(DISCORD, bot({ token: '${T}', channels, avatars: { triage: 'https://forge.example/triage.png' } })).avatars).toEqual({ triage: 'https://forge.example/triage.png' }) // eslint-disable-line no-template-curly-in-string
    for (const avatars of [{ triage: 'http://forge.example/triage.png' }, { triage: '/home/me/triage.png' }, ['https://x/y.png']]) {
      expect(() => routesOf(DISCORD, bot({ token: '${T}', channels, avatars }))).toThrow(/avatars that are not/) // eslint-disable-line no-template-curly-in-string
    }
  })

  it('refuses what it cannot route, saying which channel, and where a field of the bot\'s goes', () => {
    const refused = (channels) => expect(() => routesOf(DISCORD, bot({ token: '${T}', channels }))).toThrow(expect.objectContaining({ type: 'DISCORD_BOT_INVALID' })) // eslint-disable-line no-template-curly-in-string
    refused({ general: { spores: ['triage'], people: [] } })
    refused({ 100: { spores: [], people: [] } })
    refused({ 100: { spores: ['triage'], people: ['alice'] } })
    refused({ 100: { spores: ['triage'], humans: ['1'] } })
    expect(() => routesOf(DISCORD, bot({ token: '${T}', channels: { 100: { spores: ['triage'], people: [], avatars: {} } } }))).toThrow(expect.objectContaining({ detail: 'a channel takes spores, people, sporesTalk, details, show; avatars is the bot\'s, beside channels' })) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(DISCORD, bot({ token: 'plain-token', channels: {} }))).toThrow(/no token spore can read/)
    expect(() => routesOf(DISCORD, join(dir, 'none.json'))).toThrow(expect.objectContaining({ type: 'DISCORD_NO_BOT' }))
  })
})

describe('what a channel is told', () => {
  it('opens an answer with whom it answers and the start of what they said', () => {
    expect(header('1', 'can you check\nthe payouts')).toBe('<@1> ↪ "can you check"')
    expect(header('1', 'x'.repeat(80))).toBe(`<@1> ↪ "${'x'.repeat(59)}…"`)
  })

  it('names a spore a message mentions by its role, and leaves other roles as they are', () => {
    expect(plain('<@&9> look, and tell <@&8>', { triage: '9' })).toBe('@triage look, and tell <@&8>')
  })

  it('reads history oldest first, each line its id, time, who and what, the people it mentions named', () => {
    const lines = historyLines([
      { id: '3', timestamp: 't3', author: { username: 'triage' }, webhook_id: 'h', content: '<@7> done, <@&9> knows', mentions: [{ id: '7', username: 'bob', global_name: 'Bob' }], attachments: [] },
      { id: '2', timestamp: 't2', author: { username: 'alice', global_name: 'Alice' }, content: 'see this', mentions: [], attachments: [{ filename: 'a.png' }] }
    ])
    expect(lines).toEqual(['2 t2 Alice: see this [file a.png]', '3 t3 triage (webhook): @Bob done, <@&9> knows'])
  })

  it('knows its own working posts, which are not part of the conversation', () => {
    expect(isWorkingPost(`${header('1', 'payouts?')}\nworking…`)).toBe(true)
    expect(isWorkingPost(`${header('1', 'payouts?')}\nheard you — still working…`)).toBe(true)
    expect(isWorkingPost('working…')).toBe(true)
    expect(isWorkingPost(`${header('1', 'payouts?')}\nall fine, nothing is working…ish`)).toBe(false)
  })
})

const answering = (status, body) => async () => ({ ok: status < 300, status, json: async () => body })

describe('the REST API', () => {
  it('waits as long as Discord said when it is rate limited, and does not retry a refusal', async () => {
    const limited = createDiscord('tok', { fetchImpl: answering(429, { message: 'You are being rate limited.', retry_after: 1.5 }) })
    await expect(limited.me()).rejects.toMatchObject({ type: 'DISCORD_FAILED', retryable: true, context: { status: 429, retryAfter: 1.5 } })
    const refused = createDiscord('tok', { fetchImpl: answering(403, { message: 'Missing Permissions', code: 50013 }) })
    await expect(refused.createRole('g', 'triage')).rejects.toMatchObject({ retryable: false, detail: 'Missing Permissions (50013)', context: { code: 50013 } })
  })

  it('names this version of the plugin to Discord, from the service and from the source alike', () => {
    const pkg = createRequire(import.meta.url)('../package.json')
    expect(USER_AGENT).toBe(`DiscordBot (https://github.com/RHIZOGRIP/spore, ${pkg.version})`)
    expect(pkg.spore.sources.discord.headers['User-Agent']).toBe(USER_AGENT)
  })

  it('sends the bot token, a user agent, and asks a webhook to wait for its message', async () => {
    const asked = []
    const discord = createDiscord('tok', {
      fetchImpl: async (url, init) => {
        asked.push({ url, init })
        return { ok: true, status: 200, json: async () => ({ id: 'm1' }) }
      }
    })
    await discord.post({ id: 'h', token: 'secret' }, { username: 'triage', content: 'hi' })
    expect(asked[0].url).toBe('https://discord.com/api/v10/webhooks/h/secret?wait=true')
    expect(asked[0].init.headers).toMatchObject({ authorization: 'Bot tok', 'user-agent': USER_AGENT })
    expect(JSON.parse(asked[0].init.body)).toEqual({ username: 'triage', content: 'hi' })
  })

  it('says it is typing, and puts and takes off its own reaction', async () => {
    const asked = []
    const discord = createDiscord('tok', {
      fetchImpl: async (url, init) => {
        asked.push([init.method, url.replace('https://discord.com/api/v10', '')])
        return { ok: true, status: 204, json: async () => null }
      }
    })
    await discord.typing('100')
    await discord.react('100', '7', '👨‍💻')
    await discord.unreact('100', '7', 'custom:123')
    expect(asked).toEqual([
      ['POST', '/channels/100/typing'],
      ['PUT', `/channels/100/messages/7/reactions/${encodeURIComponent('👨‍💻')}/@me`],
      ['DELETE', '/channels/100/messages/7/reactions/custom%3A123/@me']
    ])
  })
})

class FakeSocket {
  static opened = []
  constructor (url) {
    this.url = url
    this.sent = []
    this.listeners = { message: [], close: [] }
    FakeSocket.opened.push(this)
  }

  addEventListener (kind, listener) { this.listeners[kind].push(listener) }
  send (text) { this.sent.push(JSON.parse(text)) }
  close (code, reason) { setTimeout(() => this.listeners.close.forEach(listener => listener({ code, reason }))) }
  receive (payload) { this.listeners.message.forEach(listener => listener({ data: JSON.stringify(payload) })) }
}

const until = async (done) => {
  const deadline = Date.now() + 2000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('the Gateway', () => {
  beforeEach(() => { FakeSocket.opened = [] })

  it('identifies, hands over messages in order, and resumes where Discord asks it to reconnect', async () => {
    const discord = createDiscord('tok', { fetchImpl: answering(200, { url: 'wss://gateway.test' }), WebSocketImpl: FakeSocket, random: () => 0 })
    const controller = new AbortController()
    const messages = []
    const running = discord.connect({ onMessage: async (message) => { messages.push(message.id) }, signal: controller.signal, sleep: async () => {} })

    await until(() => FakeSocket.opened.length === 1)
    const first = FakeSocket.opened[0]
    expect(first.url).toBe('wss://gateway.test/?v=10&encoding=json')
    first.receive({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(first.sent[0]).toEqual({ op: 2, d: { token: 'tok', intents: INTENTS, properties: { os: 'linux', browser: 'spore', device: 'spore' } } })
    first.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.test', user: { id: 'me' } } })
    first.receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'a' } })
    first.receive({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'b' } })
    first.receive({ op: 7, d: null })

    await until(() => FakeSocket.opened.length === 2)
    const second = FakeSocket.opened[1]
    expect(second.url).toBe('wss://resume.test/?v=10&encoding=json')
    second.receive({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(second.sent[0]).toEqual({ op: 6, d: { token: 'tok', session_id: 'sess', seq: 3 } })
    expect(messages).toEqual(['a', 'b'])

    controller.abort()
    await running
  })

  it('stops for good when Discord refuses the token or an intent', async () => {
    const discord = createDiscord('tok', { fetchImpl: answering(200, { url: 'wss://gateway.test' }), WebSocketImpl: FakeSocket, random: () => 0 })
    const running = discord.connect({ onMessage: async () => {}, signal: new AbortController().signal, sleep: async () => {} })
    await until(() => FakeSocket.opened.length === 1)
    FakeSocket.opened[0].close(4014, 'Disallowed intent(s).')
    await expect(running).rejects.toMatchObject({ type: 'DISCORD_REFUSED', context: { code: 4014 } })
  })
})
