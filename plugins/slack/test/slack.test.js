import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { WebSocketServer } from 'ws'

import { botPath, routesOf } from '@rhizogrip/spore/relay'

import { SLACK, commandOf, createAdapter, normalize } from '../src/adapter.js'
import { createSlack } from '../src/api.js'
import { connect } from '../src/socket.js'

const TEAM = 'T0TEAM'
const ME = 'U0BOT'
const ALICE = 'U0ALICE'
const CHANNEL = 'C0GENERAL'

let DIR
let path
const bot = (fields) => writeFileSync(path, JSON.stringify({ token: '${OPS_SLACK_TOKEN}', app: '${OPS_SLACK_APP}', team: TEAM, ...fields })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-slack-test-'))
  path = botPath(SLACK, 'ops', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'slack'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot\'s people and channels', () => {
  it('read each person\'s direct message against the spore it reaches, and each channel with its spore and who may address it', () => {
    bot({ people: { [ALICE]: 'triage', W0BOB: { spore: 'ledger', details: true } }, channels: { [CHANNEL]: { spores: ['triage'], people: [ALICE, '*'], brief: true } } })
    expect(routesOf(SLACK, path)).toEqual(new Map([
      [ALICE, { spores: ['triage'], details: false, show: null, brief: false, people: null, overhear: false }],
      ['W0BOB', { spores: ['ledger'], details: true, show: null, brief: false, people: null, overhear: false }],
      [CHANNEL, { spores: ['triage'], details: false, show: null, brief: true, people: [ALICE, '*'], overhear: false }]
    ]))
  })

  it('route a channel\'s threads by the channel', () => {
    expect(SLACK.routeOf(`${CHANNEL}/1729000000.000100`)).toBe(CHANNEL)
    expect(SLACK.routeOf(ALICE)).toBe(ALICE)
  })

  it('refuse a bot without its workspace, or its tokens as variables', () => {
    bot({ team: undefined, people: {} })
    expect(() => routesOf(SLACK, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/has no team/), detail: expect.stringMatching(/auth\.test/) }))
    bot({ team: 'acme', people: {} })
    expect(() => routesOf(SLACK, path)).toThrow(/has no team/)
    bot({ app: 'xapp-in-clear', people: {} })
    expect(() => routesOf(SLACK, path)).toThrow(/no app spore can read/)
    bot({ trace: 'yes', people: {} })
    expect(() => routesOf(SLACK, path)).toThrow(/has a trace that is not true or false/)
  })

  it('refuse a channel or a direct message under people, a channel id that is not one, and the fields neither takes', () => {
    bot({ people: { [CHANNEL]: 'triage' } })
    expect(() => routesOf(SLACK, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/which is a channel id/), detail: 'a channel goes under channels' }))
    bot({ people: { D0DIRECT: 'triage' } })
    expect(() => routesOf(SLACK, path)).toThrow(/which is not a member id/)
    bot({ channels: { general: { spores: ['triage'], people: ['*'] } } })
    expect(() => routesOf(SLACK, path)).toThrow(/names "general" among its channels, which is not a channel id/)
    bot({ people: { [ALICE]: { spore: 'triage', show: 'react' } } })
    expect(() => routesOf(SLACK, path)).toThrow(expect.objectContaining({ detail: 'a person takes spore, details, brief' }))
    bot({ channels: { [CHANNEL]: { spores: ['triage', 'ledger'], people: ['*'] } } })
    expect(() => routesOf(SLACK, path)).toThrow(/gives channel .* 2 spores/)
    bot({ channels: { [CHANNEL]: { spores: ['triage'] } } })
    expect(() => routesOf(SLACK, path)).toThrow(/whose people are not member ids or \*/)
    bot({})
    expect(() => routesOf(SLACK, path)).toThrow(/has no people and no channels/)
  })
})

describe('a message', () => {
  const names = { [ALICE]: 'alice', U0CAROL: 'carol', [ME]: 'triage' }
  const nameOf = async (id) => names[id]
  const direct = (fields = {}) => ({ type: 'message', channel_type: 'im', channel: 'D0ALICE', user: ALICE, text: 'hello', ts: '1729000001.000100', ...fields })
  const mention = (text, fields = {}) => ({ type: 'app_mention', channel: CHANNEL, user: ALICE, text, ts: '1729000002.000200', ...fields })
  const read = (event) => normalize(event, { team: TEAM, me: ME, nameOf })

  it('in a direct message is the person\'s, its answer under the message it replies to', async () => {
    expect(await read(direct())).toEqual({
      id: `${TEAM}/D0ALICE/1729000001.000100`,
      conversation: ALICE,
      message: '1729000001.000100',
      person: { id: ALICE, name: 'alice', groups: [] },
      spore: null,
      where: 'a direct message on Slack',
      shared: false,
      text: 'hello',
      command: null,
      addresses: null,
      files: []
    })
    expect((await read(direct({ thread_ts: '1729000000.000100' }))).message).toBe('1729000000.000100')
  })

  it('mentioning the bot in a channel is its thread\'s, the mention that opens it not part of what was said', async () => {
    expect(await read(mention(`<@${ME}> what failed?`))).toMatchObject({ conversation: `${CHANNEL}/1729000002.000200`, message: '1729000002.000200', shared: true, where: 'a Slack channel', text: 'what failed?', addresses: null })
    expect((await read(mention(`<@${ME}> again`, { thread_ts: '1729000000.000100' }))).conversation).toBe(`${CHANNEL}/1729000000.000100`)
  })

  it('reads Slack\'s markup as plain text: people and channels by name, links with their address, a command once the mention is gone', async () => {
    expect((await read(mention(`<@${ME}> ask <@U0CAROL> and <@${ME}> in <#C0OPS|ops> about <https://example.com/a|the report> &amp; <https://example.com/b> <!here>`))).text)
      .toBe('ask @carol and @triage in #ops about the report (https://example.com/a) & https://example.com/b @here')
    expect((await read(mention(`<@${ME}> /extend wall 30m`))).command).toEqual({ verb: 'extend', args: 'wall 30m' })
  })

  it('lists what came with it by the link Slack serves the bot, and by its id where Slack holds its details back', async () => {
    const files = [
      { id: 'F1', name: 'q3.pdf', mimetype: 'application/pdf', size: 4, url_private: 'https://files.slack.com/a', url_private_download: 'https://files.slack.com/a/download' },
      { id: 'F2', file_access: 'check_file_info' },
      { id: 'F3', name: 'note.txt' }
    ]
    expect((await read(direct({ subtype: 'file_share', text: '', files }))))
      .toMatchObject({
        text: null,
        files: [
          { name: 'q3.pdf', mime: 'application/pdf', bytes: 4, ref: { id: 'F1', url: 'https://files.slack.com/a/download' } },
          { name: 'file-2', mime: null, bytes: null, ref: { id: 'F2', url: null } },
          { name: 'note.txt', ref: null, why: 'Slack gave the bot no link to this file' }
        ]
      })
  })

  it('typed as /spore is a command where it was typed', async () => {
    const typed = (fields) => commandOf({ team_id: TEAM, command: '/spore', text: 'wrap 10m', channel_id: 'D0ALICE', user_id: ALICE, trigger_id: 't1', ...fields }, { team: TEAM, nameOf })
    expect(await typed()).toMatchObject({ conversation: ALICE, message: null, shared: false, text: '/wrap 10m', command: { verb: 'wrap', args: '10m' } })
    expect(await typed({ channel_id: CHANNEL, text: '' })).toMatchObject({ conversation: CHANNEL, shared: true, command: { verb: 'help', args: '' } })
  })

  it('is refused with the line that would let it in — a person under people, a channel under channels', async () => {
    expect(SLACK.refusal(await read(direct()), 'ops.json')).toBe(`refused alice (${ALICE}) — to allow them, add "${ALICE}": "<a spore>" to the people of ops.json`)
    expect(SLACK.refusal(await read(mention(`<@${ME}> hi`)), 'ops.json'))
      .toBe(`refused a Slack channel, ${CHANNEL} — to allow it, add "${CHANNEL}": { "spores": ["<a spore>"], "people": ["${ALICE}"] } to the channels of ops.json`)
  })
})

describe('the Web API', () => {
  const answering = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers })

  it('posts form-encoded under the bot\'s token, and asks for a connection under the app\'s', async () => {
    const asked = []
    const slack = createSlack({
      token: 'xoxb-1',
      app: 'xapp-1',
      fetchImpl: async (url, init) => {
        asked.push({ url, authorization: init.headers.authorization, body: Object.fromEntries(init.body) })
        return new Response(JSON.stringify({ ok: true, ts: '1.2', url: 'wss://wss-primary.slack.com/link' }))
      }
    })
    expect(await slack.post({ channel: 'D1', markdown_text: '**hi**', thread_ts: '1.1', reply_broadcast: true })).toBe('1.2')
    expect(await slack.connection()).toBe('wss://wss-primary.slack.com/link')
    expect(asked).toEqual([
      { url: 'https://slack.com/api/chat.postMessage', authorization: 'Bearer xoxb-1', body: { channel: 'D1', markdown_text: '**hi**', thread_ts: '1.1', reply_broadcast: 'true' } },
      { url: 'https://slack.com/api/apps.connections.open', authorization: 'Bearer xapp-1', body: {} }
    ])
  })

  it('says what to try again and how long Slack asked to wait, what not to, and refuses a token for good', async () => {
    const post = (fetchImpl) => createSlack({ token: 't', app: 'a', fetchImpl }).post({ channel: 'C1', text: 'x' })
    await expect(post(answering(429, {}, { 'retry-after': '30' }))).rejects.toMatchObject({ type: 'SLACK_FAILED', retryable: true, context: { status: 429, code: 'ratelimited', retryAfter: 30 } })
    await expect(post(answering(200, { ok: false, error: 'internal_error' }))).rejects.toMatchObject({ retryable: true, context: { code: 'internal_error' } })
    await expect(post(answering(200, { ok: false, error: 'not_in_channel' }))).rejects.toMatchObject({ type: 'SLACK_FAILED', retryable: false, detail: 'not_in_channel — invite the bot to the channel with /invite @<the bot>' })
    await expect(post(answering(200, { ok: false, error: 'invalid_auth' }))).rejects.toMatchObject({ type: 'SLACK_REFUSED', retryable: false })
    await expect(post(answering(503, {}))).rejects.toMatchObject({ retryable: true, detail: 'HTTP 503' })
    await expect(post(async () => { throw new Error('ECONNRESET') })).rejects.toMatchObject({ retryable: true, detail: 'ECONNRESET' })
  })
})

describe('what the bot posts', () => {
  const adapterWith = (sent) => {
    const adapter = createAdapter({
      slack: { post: async (args) => { sent.push(args); return '9.9' }, im: async (user) => `D${user}` },
      receive: () => {},
      team: TEAM,
      me: ME
    })
    adapter.restore({ ims: {} }, () => {})
    return adapter
  }

  it('says its own lines escaped, and an answer as Markdown in which no one is pinged', async () => {
    const sent = []
    const adapter = adapterWith(sent)
    expect(await adapter.post(ALICE, 'idle · 2 turns\n<b> & co')).toBe('DU0ALICE 9.9')
    await adapter.post(ALICE, '| a |\n|---|\n| <!channel> @here <@U0CAROL> `<!DOCTYPE html>` |', { markdown: true, answering: '1.1' })
    expect(sent).toEqual([
      { channel: 'DU0ALICE', text: 'idle · 2 turns\n&lt;b&gt; &amp; co' },
      { channel: 'DU0ALICE', markdown_text: '| a |\n|---|\n| <\u200b!channel> @\u200bhere <\u200b@U0CAROL> `<!DOCTYPE html>` |', thread_ts: '1.1', reply_broadcast: true }
    ])
  })

  it('posts into a channel\'s thread, and as a new post in the channel itself', async () => {
    const sent = []
    const adapter = adapterWith(sent)
    await adapter.post(`${CHANNEL}/1.1`, 'hello back', { markdown: true, answering: '1.3' })
    await adapter.post(CHANNEL, 'a digest', { markdown: true })
    expect(sent).toEqual([
      { channel: CHANNEL, markdown_text: 'hello back', thread_ts: '1.1' },
      { channel: CHANNEL, markdown_text: 'a digest' }
    ])
  })
})

describe('Socket Mode', () => {
  let server
  let port
  let stop
  const logs = []
  const connections = []

  beforeEach(async () => {
    logs.length = 0
    connections.length = 0
    server = new WebSocketServer({ port: 0, autoPong: false })
    server.on('connection', (socket) => {
      const one = { socket, acks: [] }
      socket.on('message', (data) => one.acks.push(JSON.parse(data.toString())))
      connections.push(one)
      socket.send(JSON.stringify({ type: 'hello', num_connections: connections.length }))
    })
    await new Promise(resolve => server.once('listening', resolve))
    port = server.address().port
  })
  afterEach(async () => {
    stop?.()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })

  const until = async (done) => {
    const deadline = Date.now() + 5000
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waited too long')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  const run = (onEnvelope, options = {}) => {
    const controller = new AbortController()
    stop = () => controller.abort()
    let opened = 0
    return connect({
      open: async () => `ws://127.0.0.1:${port}/?n=${++opened}`,
      onEnvelope,
      signal: controller.signal,
      log: (line) => logs.push(line),
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))),
      ...options
    })
  }

  it('hands each envelope over with an ack sent once it is taken, one after another', async () => {
    const taken = []
    const done = run(async ({ type, payload, ack }) => {
      taken.push(payload.n)
      await new Promise(resolve => setTimeout(resolve, 20))
      ack(type === 'slash_commands' ? { text: 'ok' } : undefined)
    })
    await until(() => connections.length === 1)
    connections[0].socket.send(JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: { n: 1 } }))
    connections[0].socket.send(JSON.stringify({ envelope_id: 'e2', type: 'slash_commands', payload: { n: 2 } }))
    await until(() => connections[0].acks.length === 2)
    expect(taken).toEqual([1, 2])
    expect(connections[0].acks).toEqual([{ envelope_id: 'e1' }, { envelope_id: 'e2', payload: { text: 'ok' } }])
    stop()
    await done
  })

  it('opens the next connection as soon as Slack says it will close one, and the old one still acks what it holds', async () => {
    let release
    const held = new Promise(resolve => { release = resolve })
    const done = run(async ({ ack }) => {
      await held
      ack()
    })
    await until(() => connections.length === 1)
    connections[0].socket.send(JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: {} }))
    connections[0].socket.send(JSON.stringify({ type: 'disconnect', reason: 'warning' }))
    await until(() => connections.length === 2)
    release()
    await until(() => connections[0].acks.length === 1)
    expect(connections[0].acks).toEqual([{ envelope_id: 'e1' }])
    expect(logs).toContain('Socket Mode connection is closing (warning) — connecting again')
    stop()
    await done
  })

  it('drops a connection that goes quiet and opens another', async () => {
    const done = run(async ({ ack }) => ack(), { pingEveryMs: 20, quietMs: 100 })
    await until(() => connections.length === 2)
    expect(logs.some(line => /^Socket Mode connection closed \(\d+\) — connecting again$/.test(line))).toBe(true)
    stop()
    await done
  })

  it('stops for good when Slack turns Socket Mode off for the app', async () => {
    const done = run(async ({ ack }) => ack())
    await until(() => connections.length === 1)
    connections[0].socket.send(JSON.stringify({ type: 'disconnect', reason: 'link_disabled' }))
    await expect(done).rejects.toMatchObject({ type: 'SLACK_REFUSED', detail: 'link_disabled' })
  })

  it('waits out a connection Slack will not give for now, and stops on one it refuses', async () => {
    let asked = 0
    const refusing = Object.assign(new Error('slack apps.connections.open failed'), { type: 'SLACK_REFUSED', retryable: false })
    const done = run(async () => {}, {
      open: async () => {
        asked += 1
        if (asked === 1) throw Object.assign(new Error('slack apps.connections.open failed'), { retryable: true, context: { retryAfter: null } })
        throw refusing
      }
    })
    await expect(done).rejects.toBe(refusing)
    expect(asked).toBe(2)
  })
})
