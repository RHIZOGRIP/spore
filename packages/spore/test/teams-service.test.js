/**
 * The Teams connector against real spores: the relay's conformance suite with Teams behind a
 * stand-in Bot Connector, and what is Teams' alone.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { answers } from './fixtures/scripted-model.js'
import { approvalOf, readInbox } from '../src/core/spore-dir.js'
import { requestApproval } from '../src/library/verbs.js'
import { send } from '../src/core/send.js'
import { SporeError } from '../src/index.js'
import { download } from '../src/relay/download.js'
import { TEAMS, createAdapter } from '../../../plugins/teams/src/adapter.js'

const APP = 'app-1'
const TENANT = 'tenant-1'
const SERVICE = 'https://smba.example/teams/'
const OPS = { post: 'send', edit: 'update', remove: 'remove', fetch: 'download' }

const numberOf = (channel) => channel.slice(3, channel.indexOf('@'))

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }

/** What a person reads of an activity's text: Teams' HTML subset read back to lines, extended Markdown as written. */
const textOf = (activity) => {
  if (activity.textFormat === 'extendedmarkdown') return activity.text
  expect(activity.textFormat).toBe('xml')
  return activity.text.replace(/<br>/g, '\n').replace(/&(amp|lt|gt);/g, (entity) => ENTITIES[entity])
}

const standIn = () => {
  const waiting = []
  const sent = []
  const created = []
  const faults = []
  const delivered = new Map()
  const stored = new Map()
  const downloads = []
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
    if (activity.attachments) sent.push({ op: 'ask', conversation, id: String(id), card: activity.attachments[0].content })
    else sent.push({ op: 'post', conversation, id: String(id), text: textOf(activity), answering: activity.replyToId ?? null, formatted: activity.textFormat === 'extendedmarkdown' })
    return String(id)
  }
  return {
    sent,
    created,
    delivered,
    stored,
    downloads,
    replies: new Map(),
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
        if (activity.attachments) sent.push({ op: 'close', conversation, id: activityId, card: activity.attachments[0].content })
        else sent.push({ op: 'edit', conversation, id: activityId, text: textOf(activity) })
      },
      remove: async (serviceUrl, conversation, activityId) => {
        fault('remove')
        sent.push({ op: 'remove', conversation, id: activityId })
      },
      download: async (url, { most, withToken = false }) => {
        fault('download')
        downloads.push({ url, withToken })
        return download(url, { most, fetchImpl: async () => new Response(stored.get(url)) })
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
        const activity = waiting.shift()
        const reply = await onActivity(activity)
        if (reply) this.replies.set(activity.id, reply)
      }
    }
  }
}

const inConversation = (one, conversation) => conversation.startsWith('19:') ? one.conversation.startsWith(conversation) : one.conversation === `a:${conversation}`

const said = (one) => {
  const note = `${one.conversation} ${one.id}`
  if (one.op === 'post') return { op: 'post', note, text: one.text, answering: one.answering, formatted: one.formatted }
  if (one.op === 'edit') return { op: 'edit', note, text: one.text }
  if (one.op === 'ask') return { op: 'ask', note, text: JSON.stringify(one.card), choices: one.card.actions.filter(action => action.data?.spore).map(action => ({ label: action.title, data: action.data.spore, style: action.style ?? null })) }
  if (one.op === 'close') return { op: 'close', note, text: JSON.stringify(one.card) }
  return { op: 'remove', note }
}

const harness = {
  spec: TEAMS,
  words: (text) => text,
  formats: true,
  credentials: { TRIAGE_TEAMS_SECRET: 'the-secret', OTHER_TEAMS_SECRET: 'another-secret' },
  botFile: (bot, table, fields = {}) => {
    const entries = Object.entries(table)
    const people = entries.filter(([, entry]) => !entry.shared).map(([who, { spore, details, brief }]) =>
      [who, details || brief !== undefined ? { spore, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) } : spore])
    const channels = entries.filter(([, entry]) => entry.shared).map(([channel, { spore, details, brief, people = [`9${numberOf(channel)}`, '*'] }]) =>
      [channel, { spores: [spore], people, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) }])
    return { app: APP, tenant: TENANT, secret: `\${${bot.toUpperCase()}_TEAMS_SECRET}`, listen: '127.0.0.1:3978', people: Object.fromEntries(people), channels: Object.fromEntries(channels), ...fields }
  },
  shared: (n) => `19:${n}@thread.tacv2`,
  platform: standIn,
  adapter: (teams) => createAdapter({ connector: teams.connector, receive: (options) => teams.receive(options), app: APP, tenant: TENANT }),
  say (teams, { conversation, text, files = [], id, shared = false, person = shared ? `9${numberOf(conversation)}` : conversation }) {
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
            attachments: files.map(({ name, data }, i) => {
              const downloadUrl = `https://contoso.sharepoint.com/download/${activityId}/${i}/${name}`
              teams.stored.set(downloadUrl, data)
              return { contentType: 'application/vnd.microsoft.teams.file.download.info', name, content: { downloadUrl, fileType: name.split('.').pop() } }
            })
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
  press (teams, { note, data, person, inputs = {} }) {
    const conversation = note.slice(0, note.lastIndexOf(' '))
    const shared = conversation.startsWith('19:')
    const id = String(++teams.lastMessage)
    teams.push({
      type: 'invoke',
      name: 'adaptiveCard/action',
      id,
      channelId: 'msteams',
      serviceUrl: SERVICE,
      conversation: { id: conversation, conversationType: shared ? 'channel' : 'personal', tenantId: TENANT },
      from: { id: `29:${person}`, aadObjectId: person, name: `U${person} Smith` },
      recipient: { id: `28:${APP}`, name: 'Triage' },
      value: { action: { type: 'Action.Execute', verb: 'answer', data: { ...inputs, spore: data } }, trigger: 'manual' }
    })
    return { acknowledged: () => teams.replies.has(id) ? { text: teams.replies.get(id).value } : undefined }
  },
  fail: (teams, op, error, times) => teams.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('teams POST failed', { type: 'TEAMS_FAILED', retryable: true, detail: 'Too Many Requests', context: { status: 429, code: null, retryAfter } }),
  refused: (detail) => new SporeError('teams POST failed', { type: 'TEAMS_FAILED', retryable: false, detail, context: { status: 403, code: null, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Teams', () => {
    const CHANNEL = harness.shared(5)
    const CARD = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Apply the change?' }, { type: 'Input.Text', id: 'comment' }], actions: [{ type: 'Action.OpenUrl', title: 'Preview', url: 'https://example.com/preview' }] }
    const asking = (body) => requestApproval({
      ws: ctx.ws,
      configFile: join(ctx.root, 'config.json'),
      request: { to: 'teams:triage/1', by: ['1'], options: [{ id: 'apply', label: 'Apply', style: 'positive' }], body }
    }).approval

    it('asks an approval on its own card, its buttons after the card\'s, and hands on what was filled in with the press', async () => {
      ctx.start({ approveEveryMs: 50 })
      const id = asking({ teams: CARD })
      await ctx.until(() => ctx.seen('1').some(one => one.op === 'ask'))
      const question = ctx.seen('1').find(one => one.op === 'ask')
      const card = ctx.platform.sent.find(one => one.op === 'ask').card
      expect(card.body).toEqual(CARD.body)
      expect(card.actions).toEqual([CARD.actions[0], { type: 'Action.Execute', title: 'Apply', verb: 'answer', data: { spore: `ap:${id}:apply` }, style: 'positive' }])

      const pressed = harness.press(ctx.platform, { note: question.note, data: question.choices[0].data, person: '1', inputs: { comment: 'looks right' } })
      await ctx.until(() => pressed.acknowledged())
      expect(ctx.platform.replies.get([...ctx.platform.replies.keys()].at(-1))).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Apply — recorded' })
      await ctx.until(() => approvalOf(ctx.ws, id).told)
      expect(approvalOf(ctx.ws, id)).toMatchObject({ state: 'answered', inputs: { comment: 'looks right' } })
      const closed = ctx.platform.sent.find(one => one.op === 'close').card
      expect(closed.actions).toEqual([CARD.actions[0]])
      expect(closed.body.at(-1)).toEqual({ type: 'TextBlock', text: '**Apply — U1 Smith**', wrap: true })
    })

    it('fetches a file sent in a personal chat by its link, and an image pasted there with the bot\'s token', async () => {
      const sent = 'https://contoso.sharepoint.com/download/q3.pdf'
      const pasted = `${SERVICE}v3/attachments/i1/views/original`
      ctx.platform.stored.set(sent, Buffer.from('%PDF'))
      ctx.platform.stored.set(pasted, Buffer.from('PNG'))
      ctx.start()
      ctx.platform.push({
        type: 'message',
        id: 'm1',
        channelId: 'msteams',
        serviceUrl: SERVICE,
        conversation: { id: 'a:1', conversationType: 'personal', tenantId: TENANT },
        from: { id: '29:1', aadObjectId: '1', name: 'U1 Smith' },
        recipient: { id: `28:${APP}`, name: 'Triage' },
        text: 'both of these',
        attachments: [
          { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'q3.pdf', content: { downloadUrl: sent, fileType: 'pdf' } },
          { contentType: 'image/png', contentUrl: pasted }
        ]
      })
      await ctx.until(() => ctx.posted('1', 'hello back'))
      expect(ctx.platform.downloads).toEqual([{ url: sent, withToken: false }, { url: pasted, withToken: true }])
      expect(readInbox(ctx.ws)[0].files.map(file => [file.name, file.bytes])).toEqual([['q3.pdf', 4], ['image-2.png', 3]])
    })

    it('refuses a file sent in a channel, saying where it can go', async () => {
      ctx.routes({ [CHANNEL]: { spore: 'triage', shared: true } })
      ctx.start()
      ctx.say({ conversation: CHANNEL, text: 'see this', shared: true, files: [{ name: 'q3.pdf', mime: 'application/pdf', data: Buffer.from('%PDF') }] })
      await ctx.until(() => ctx.posted(CHANNEL, 'hello back'))
      expect(ctx.posted(CHANNEL, 'q3.pdf did not reach the spore: a file in a channel does not reach a spore — send it to me in a personal chat')).toBe(true)
      expect(ctx.platform.downloads).toEqual([])
    })

    it('refuses a card that answers by itself, wherever its action sits, and one older than 1.4', async () => {
      ctx.start({ approveEveryMs: 50 })
      const refused = [
        { ...CARD, body: [{ type: 'ActionSet', actions: [{ type: 'Action.Submit', title: 'Go' }] }] },
        { ...CARD, body: [{ type: 'Container', items: [], selectAction: { type: 'Action.Execute', verb: 'go' } }] },
        { ...CARD, refresh: { action: { type: 'Action.Execute', verb: 'go' }, userIds: [] } },
        { ...CARD, version: '1.2' }
      ].map(card => asking({ teams: card }))
      await ctx.until(() => refused.every(id => approvalOf(ctx.ws, id).settledAt))
      expect(refused.map(id => approvalOf(ctx.ws, id).reason)).toEqual([
        ...Array(3).fill('a Teams body carries no Action.Submit or Action.Execute, nor a refresh — the buttons that answer are the ones spore adds'),
        'a Teams body is an Adaptive Card of version 1.4 or later, as { "type": "AdaptiveCard", "version": "1.5", "body": [ … ] }'
      ])
      expect(ctx.seen('1').some(one => one.op === 'ask')).toBe(false)
    })

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

    it('tells the spore the clock the person\'s Teams says they are on, and leaves out one no zone names', async () => {
      ctx.routes({ 1: { spore: 'triage' } })
      ctx.start()
      const activity = (id, localTimezone) => ({ type: 'message', id, channelId: 'msteams', serviceUrl: SERVICE, conversation: { id: 'a:1', conversationType: 'personal', tenantId: TENANT }, from: { id: '29:1', aadObjectId: '1', name: 'U1' }, recipient: { id: `28:${APP}` }, text: 'hello', localTimezone })
      ctx.platform.push(activity('z1', 'Asia/Dubai'))
      ctx.platform.push(activity('z2', 'Nowhere/Land'))
      await ctx.until(() => readInbox(ctx.ws).length === 2)
      expect(readInbox(ctx.ws).map(entry => entry.fromZone)).toEqual(['Asia/Dubai', null])
      expect(ctx.logs.some(line => line.endsWith('U1\'s clock, "Nowhere/Land", is no time zone this Node knows — their message goes without it'))).toBe(true)
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
