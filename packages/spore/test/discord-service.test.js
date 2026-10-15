/**
 * The Discord service against real spores: runners, the agent, confinement and the records are
 * real; Discord is a stand-in and the model's replies are scripted.
 */

import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { outbox, readInbox, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { createService } from '@rhizogrip/spore-plugin-discord/src/service.js'

const CHANNEL = '100'
const ALICE = '1'
const BOB = '2'
const ROLE = { triage: '701', ledger: '702' }

let root
let home
let ws
let ledger
let configFile
let saved
let broker
let reply
let dc
let logs
let env
let tests = 0
let messageId = 1000
const running = []

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const idle = (turns) => until(() => readTurns(ws).length === turns && stateOf(ws).state !== RUNNING)

const standIn = () => {
  const posts = []
  const created = []
  let next = 500
  let onMessage = null
  return {
    posts,
    created,
    say: (message) => onMessage(message),
    connected: () => onMessage !== null,
    channel: async (id) => ({ id, guild_id: 'g1' }),
    roles: async () => [],
    createRole: async (guild, name) => {
      created.push(name)
      return { id: ROLE[name] }
    },
    webhooks: async () => [],
    createWebhook: async () => ({ id: 'hook1', token: 'hook-token' }),
    post: async (hook, payload) => {
      next += 1
      posts.push({ op: 'post', id: String(next), ...payload })
      return { id: String(next) }
    },
    revise: async (hook, message, payload) => { posts.push({ op: 'revise', id: message, ...payload }) },
    remove: async (hook, message) => { posts.push({ op: 'remove', id: message }) },
    upload: async (hook, payload, files) => { posts.push({ op: 'upload', ...payload, files }) },
    connect: ({ onMessage: handle, signal }) => {
      onMessage = handle
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    }
  }
}

const message = ({ from = ALICE, content, roles = [], replyingTo = null, webhook = null, username = `u${from}`, attachments = [] }) => ({
  id: String(++messageId),
  channel_id: CHANNEL,
  guild_id: 'g1',
  author: { id: from, username },
  member: webhook ? undefined : { roles: [] },
  content,
  mention_roles: roles,
  attachments,
  webhook_id: webhook,
  referenced_message: replyingTo
})

const start = () => {
  const controller = new AbortController()
  const service = createService({
    discord: dc,
    me: { id: '900', username: 'sporebot' },
    botFile: join(root, 'discord', 'ops.json'),
    statePath: saved,
    env,
    log: (line) => logs.push(line),
    configFile,
    sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    followEveryMs: 100
  })
  const done = service.run(controller.signal)
  const handle = { done, stop: async () => { controller.abort(); await done } }
  running.push(handle)
  return handle
}

const channels = (entry, avatars) => {
  mkdirSync(join(root, 'discord'), { recursive: true })
  writeFileSync(join(root, 'discord', 'ops.json'), JSON.stringify({ token: '${DISCORD_BOT_TOKEN}', channels: { [CHANNEL]: entry }, ...(avatars ? { avatars } : {}) })) // eslint-disable-line no-template-curly-in-string
}
const defaultReplyTo = (place) => {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ replyTo: { triage: place } }))
}
const posted = () => dc.posts.filter(p => p.op === 'post')

beforeEach(async () => {
  root = outsideRoot('discord-service')
  home = join(root, 'home')
  ws = join(home, 'triage')
  ledger = join(home, 'ledger')
  for (const dir of [ws, ledger]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
  }
  configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify({ home }))
  saved = join(root, 'state', 'discord.json')
  channels({ spores: ['triage', 'ledger'], humans: [ALICE] })
  logs = []
  dc = standIn()
  reply = async () => answers('hello back')
  tests += 1
  broker = createModelServer({ mo: scriptedMo((input, round, options) => reply(input, round, options)), socketPath: brokerSocketPath(`dc-service-${tests}`), limit: 10 })
  await broker.listen()
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    SPORE_MODEL_SOCKET: broker.socketPath,
    DISCORD_BOT_TOKEN: 'the-bot-token'
  }
})

afterEach(async () => {
  const test = { root, ws, ledger, broker }
  await Promise.allSettled(running.splice(0).map(handle => handle.stop()))
  for (const spore of [test.ws, test.ledger]) {
    if (stateOf(spore).state === RUNNING) stop(spore)
    await until(() => stateOf(spore).state !== RUNNING, 20_000)
  }
  await test.broker.close()
  rmSync(test.root, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
}, 30_000)

describe('a channel', () => {
  it('has its spores\' roles and its webhook as soon as the service starts, before anyone writes', async () => {
    start()
    await until(dc.connected)
    expect(dc.created.sort()).toEqual(['ledger', 'triage'])
    expect(dc.posts).toEqual([])
  })
})

describe('a message in a channel', () => {
  it('reaches the spore its role names, which answers under its own name to whoever asked', async () => {
    start()
    await until(dc.connected)
    await dc.say(message({ content: '<@&701> can you check the payouts', roles: [ROLE.triage] }))

    await until(() => posted().some(p => p.content.endsWith('hello back')))
    const [working, answer] = posted()
    expect(working).toMatchObject({ username: 'triage', content: '<@1> ↪ "@triage can you check the payouts"\nworking…', allowed_mentions: { parse: [] } })
    expect(answer).toMatchObject({ username: 'triage', content: '<@1> ↪ "@triage can you check the payouts"\nhello back', allowed_mentions: { parse: [], users: [ALICE] } })
    await until(() => dc.posts.some(p => p.op === 'remove' && p.id === working.id))

    const [said] = readInbox(ws)
    expect(said.text).toMatch(/^u1, in Discord:\n@triage can you check the payouts\n\n\[Discord channel 100, message \d+\. Nothing else said here since you last spoke — "\$SPORE_DISCORD" history 100 --before \d+ reads what was said before\.\]$/)
    expect(said.replyTo).toBe('discord:ops/100')
    expect(readInbox(ledger)).toEqual([])
  })

  it('passes on the text of a message with files, and tells whoever wrote it that the files did not go', async () => {
    start()
    await until(dc.connected)
    await dc.say(message({ content: '<@&701> what is in these', roles: [ROLE.triage], attachments: [{ filename: 'a.png' }, { filename: 'b.pdf' }] }))

    await until(() => posted().some(p => p.content.endsWith('hello back')))
    expect(readInbox(ws)[0].text).toMatch(/^u1, in Discord:\n@triage what is in these\n/)
    expect(posted().map(p => p.content)).toContain('<@1> ↪ "@triage what is in these"\nonly text reaches a spore for now: your 2 files did not reach triage')
  })

  it('shows each spore with the avatar the bot file gives it, and Discord\'s own for one it does not', async () => {
    channels({ spores: ['triage', 'ledger'], humans: [ALICE] }, { triage: 'https://forge.example/triage.png' })
    start()
    await until(dc.connected)
    await dc.say(message({ content: '<@&701> <@&702> one word each', roles: [ROLE.triage, ROLE.ledger] }))
    await until(() => posted().filter(p => p.content.endsWith('hello back')).length === 2)
    for (const post of posted().filter(p => p.username === 'triage')) expect(post.avatar_url).toBe('https://forge.example/triage.png')
    for (const post of posted().filter(p => p.username === 'ledger')) expect(post).not.toHaveProperty('avatar_url')
  })

  it('reaches no spore when it names none, and none when its author may not address them', async () => {
    start()
    await until(dc.connected)
    await dc.say(message({ content: 'morning all' }))
    await dc.say(message({ from: BOB, content: '<@&701> hi', roles: [ROLE.triage] }))
    expect(readInbox(ws)).toEqual([])
    expect(logs.some(line => line.startsWith(`refused u2 (${BOB}) in channel ${CHANNEL} — to allow them, add "${BOB}"`))).toBe(true)
    expect(dc.posts).toEqual([])
  })

  it('reaches the spore whose post it replies to, and counts what was said meanwhile', async () => {
    start()
    await until(dc.connected)
    await dc.say(message({ content: '<@&701> first', roles: [ROLE.triage] }))
    await until(() => posted().some(p => p.content.endsWith('hello back')))
    await idle(1)
    const answer = posted().find(p => p.content.endsWith('hello back'))
    const working = posted().find(p => p.content.endsWith('working…'))
    await dc.say(message({ from: 'hook1', webhook: 'hook1', username: 'triage', content: working.content }))
    await dc.say(message({ from: 'hook1', webhook: 'hook1', username: 'triage', content: answer.content }))

    await dc.say(message({ content: 'an aside' }))
    await dc.say(message({ content: 'thanks — and the totals?', replyingTo: { webhook_id: 'hook1', author: { username: 'triage' } } }))
    await idle(2)
    expect(readInbox(ws).at(-1).text).toMatch(/^u1, in Discord:\nthanks — and the totals\?\n\n\[Discord channel 100, message \d+\. 1 earlier message here since you last spoke/)
  })

  it('leaves a spore\'s post to the others alone unless the channel lets spores talk', async () => {
    start()
    await until(dc.connected)
    await dc.say(message({ from: 'hook1', webhook: 'hook1', username: 'triage', content: '<@&702> totals?', roles: [ROLE.ledger] }))
    expect(readInbox(ledger)).toEqual([])

    channels({ spores: ['triage', 'ledger'], humans: [ALICE], sporesTalk: true })
    await dc.say(message({ from: 'hook1', webhook: 'hook1', username: 'triage', content: '<@&702> totals?', roles: [ROLE.ledger] }))
    await until(() => readInbox(ledger).length === 1)
    expect(readInbox(ledger)[0].text).toMatch(/^triage \(spore\), in Discord:\n@ledger totals\?/)
  })
})

describe('turns nobody in a channel started', () => {
  it('reach the spore\'s default channel, labelled with where they came from', async () => {
    defaultReplyTo('discord:ops/100')
    start()
    await until(dc.connected)
    send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-10-07T07:00:00Z' }, env })
    await until(() => posted().some(p => p.content === 'schedule "digest"\n\nhello back'))
    expect(posted()[0]).toMatchObject({ username: 'triage', allowed_mentions: { parse: [], users: [] } })
    await until(() => outbox(ws).every(entry => entry.state === 'delivered'))
  })

  it('are refused for a channel that does not hold the spore', async () => {
    defaultReplyTo('discord:ops/999')
    start()
    await until(dc.connected)
    send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-10-07T07:00:00Z' }, env })
    await until(() => outbox(ws).some(entry => entry.state === 'refused'))
    expect(outbox(ws)[0].reason).toMatch(/^channel 999 does not hold triage/)
    expect(dc.posts).toEqual([])
  })
})
