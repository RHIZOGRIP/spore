/**
 * The Teams connector against real spores: the relay's conformance suite with Teams behind a
 * stand-in Bot Connector, and what is Teams' alone.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'

import { conformance } from './fixtures/relay-conformance.js'
import { answers } from './fixtures/scripted-model.js'
import { readInbox } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { SporeError } from '../src/index.js'
import { TEAMS, createAdapter } from '../../../plugins/teams/src/adapter.js'

const APP = 'app-1'
const TENANT = 'tenant-1'
const SERVICE = 'https://smba.example/teams/'
const OPS = { post: 'send', edit: 'update', remove: 'remove' }

const numberOf = (channel) => channel.slice(3, channel.indexOf('@'))

const standIn = () => {
  const waiting = []
  const sent = []
  const created = []
  const faults = []
  const delivered = new Map()
  let id = 100
  let wake = null
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  const posted = (conversation, activity) => {
    id += 1
    sent.push({ op: 'post', conversation, id: String(id), text: activity.text, answering: activity.replyToId ?? null, formatted: activity.textFormat === 'markdown' })
    return String(id)
  }
  return {
    sent,
    created,
    delivered,
    lastMessage: 0,
    push (activity) { waiting.push(activity); wake?.() },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    connector: {
      send: async (serviceUrl, conversation, activity) => {
        fault('send')
        return posted(conversation, activity)
      },
      update: async (serviceUrl, conversation, activityId, activity) => {
        fault('update')
        sent.push({ op: 'edit', conversation, id: activityId, text: activity.text })
      },
      remove: async (serviceUrl, conversation, activityId) => {
        fault('remove')
        sent.push({ op: 'remove', conversation, id: activityId })
      },
      create: async (serviceUrl, body) => {
        fault('create')
        created.push(body)
        if (!body.isGroup) return { id: `a:${body.members[0].id}` }
        const activityId = posted(`${body.channelData.channel.id};messageid=${id + 1}`, body.activity)
        return { id: sent.at(-1).conversation, activityId }
      }
    },
    async receive ({ onActivity, signal }) {
      while (!signal.aborted) {
        if (!waiting.length) {
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
          wake = null
          continue
        }
        await onActivity(waiting.shift())
      }
    }
  }
}

const inConversation = (one, conversation) => conversation.startsWith('19:') ? one.conversation.startsWith(conversation) : one.conversation === `a:${conversation}`

const said = (one) => {
  const note = `${one.conversation} ${one.id}`
  if (one.op === 'post') return { op: 'post', note, text: one.text, answering: one.answering, formatted: one.formatted }
  if (one.op === 'edit') return { op: 'edit', note, text: one.text }
  return { op: 'remove', note }
}

const harness = {
  spec: TEAMS,
  words: (text) => text,
  formats: true,
  credentials: { TRIAGE_TEAMS_SECRET: 'the-secret', OTHER_TEAMS_SECRET: 'another-secret' },
  botFile: (bot, table, fields = {}) => {
    const entries = Object.entries(table)
    const people = entries.filter(([, entry]) => !entry.shared).map(([who, { spore, details }]) => [who, details ? { spore, details } : spore])
    const channels = entries.filter(([, entry]) => entry.shared).map(([channel, { spore, details, people = [`9${numberOf(channel)}`, '*'] }]) =>
      [channel, { spores: [spore], people, ...(details ? { details } : {}) }])
    return { app: APP, tenant: TENANT, secret: `\${${bot.toUpperCase()}_TEAMS_SECRET}`, listen: '127.0.0.1:3978', people: Object.fromEntries(people), channels: Object.fromEntries(channels), ...fields }
  },
  shared: (n) => `19:${n}@thread.tacv2`,
  platform: standIn,
  adapter: (teams) => createAdapter({ connector: teams.connector, receive: (options) => teams.receive(options), app: APP, tenant: TENANT }),
  say (teams, { conversation, text, files = 0, id, shared = false, person = shared ? `9${numberOf(conversation)}` : conversation }) {
    const activity = id === undefined
      ? (() => {
          const activityId = String(++teams.lastMessage)
          const mention = shared ? '<at>Triage</at> ' : ''
          return {
            type: 'message',
            id: activityId,
            channelId: 'msteams',
            serviceUrl: SERVICE,
            conversation: shared
              ? { id: `${conversation};messageid=${activityId}`, conversationType: 'channel', tenantId: TENANT }
              : { id: `a:${conversation}`, conversationType: 'personal', tenantId: TENANT },
            from: { id: `29:${person}`, aadObjectId: person, name: `U${person} Smith` },
            recipient: { id: `28:${APP}`, name: 'Triage' },
            ...(shared
              ? {
                  channelData: { channel: { id: conversation, name: `chan ${numberOf(conversation)}` }, tenant: { id: TENANT } },
                  entities: [{ type: 'mention', mentioned: { id: `28:${APP}`, name: 'Triage' }, text: '<at>Triage</at>' }]
                }
              : {}),
            text: text === null ? '' : `${mention}${text}`,
            attachments: Array.from({ length: files }, () => ({ contentType: 'image/png' }))
          }
        })()
      : teams.delivered.get(id)
    teams.delivered.set(activity.id, activity)
    teams.push(activity)
    return {
      id: activity.id,
      message: activity.id,
      from: { name: `U${person} Smith`, id: `teams:${person}`, where: shared ? `the Teams channel "chan ${numberOf(conversation)}"` : 'a personal chat in Teams' }
    }
  },
  seen: (teams, conversation) => teams.sent.filter(one => inConversation(one, conversation)).map(said),
  fail: (teams, op, error, times) => teams.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('teams POST failed', { type: 'TEAMS_FAILED', retryable: true, detail: 'Too Many Requests', context: { status: 429, code: null, retryAfter } }),
  refused: (detail) => new SporeError('teams POST failed', { type: 'TEAMS_FAILED', retryable: false, detail, context: { status: 403, code: null, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Teams', () => {
    const CHANNEL = harness.shared(5)

    it('answers a channel message in its thread, and a turn nobody there started as a new post in the channel', async () => {
      ctx.routes({ [CHANNEL]: { spore: 'triage', shared: true } })
      ctx.defaultReplyTo(CHANNEL)
      ctx.start()
      const asked = ctx.say({ conversation: CHANNEL, text: 'hello', shared: true })
      await ctx.until(() => ctx.posted(CHANNEL, 'hello back'))
      const thread = `${CHANNEL};messageid=${asked.message}`
      expect(ctx.platform.sent.filter(one => one.op === 'post').map(one => [one.conversation, one.text])).toEqual([[thread, 'working…'], [thread, 'hello back']])
      expect(readInbox(ctx.ws)[0]).toMatchObject({ text: 'hello', replyTo: `teams:triage/${thread}` })

      await ctx.idle(1)
      ctx.replying(async () => answers('two new papers'))
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.posted(CHANNEL, 'schedule "digest"\n\ntwo new papers'))
      const post = ctx.platform.sent.find(one => one.text === 'schedule "digest"\n\ntwo new papers')
      expect(post.conversation).not.toBe(thread)
      expect(ctx.platform.created.at(-1)).toMatchObject({ isGroup: true, channelData: { channel: { id: CHANNEL }, tenant: { id: TENANT } } })
    })

    it('opens a personal chat with someone who never wrote to the bot, to reach them', async () => {
      ctx.routes({ 1: { spore: 'triage' } })
      ctx.defaultReplyTo('1')
      ctx.start()
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.posted('1', 'schedule "digest"\n\nhello back'))
      expect(ctx.platform.created).toEqual([{ bot: { id: `28:${APP}` }, members: [{ id: '1' }], channelData: { tenant: { id: TENANT } }, isGroup: false }])
    })

    it('drops an activity from another tenant, and a group chat, saying why', async () => {
      ctx.start()
      const activity = (fields) => ({ type: 'message', id: 'x1', channelId: 'msteams', serviceUrl: SERVICE, from: { aadObjectId: '1', name: 'U1' }, recipient: { id: `28:${APP}` }, text: 'hello', ...fields })
      ctx.platform.push(activity({ conversation: { id: 'a:1', conversationType: 'personal', tenantId: 'elsewhere' } }))
      ctx.platform.push(activity({ id: 'x2', conversation: { id: '19:chat@thread.v2', conversationType: 'groupChat', tenantId: TENANT } }))
      await ctx.until(() => ctx.logs.length === 2)
      expect(ctx.logs).toEqual([
        `dropped an activity from tenant elsewhere: this bot serves ${TENANT}`,
        'group chat 19:chat@thread.v2: group chats are not served yet'
      ])
      expect(readInbox(ctx.ws)).toEqual([])
      expect(ctx.platform.sent).toEqual([])
    })
  })
})
