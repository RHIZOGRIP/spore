/**
 * The Slack connector against real spores: the relay's conformance suite with Slack behind a
 * stand-in Web API and Socket Mode, and what is Slack's alone.
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
import { SLACK, createAdapter } from '../../../plugins/slack/src/adapter.js'

const TEAM = 'T0TEAM'
const ME = 'UBOT'
const OPS = { post: 'post', edit: 'update', remove: 'remove', fetch: 'download' }
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }

const isChannel = (conversation) => /^[CG]/.test(conversation)
const numberOf = (channel) => channel.slice(1)
const channelOf = (conversation) => isChannel(conversation) ? conversation.split('/')[0] : `D${conversation}`

/** What a person reads of a post: Markdown as written, the relay's own lines unescaped. */
const textOf = (one) => one.markdown_text ?? one.text.replace(/&(amp|lt|gt);/g, (entity) => ENTITIES[entity])

const standIn = () => {
  const waiting = []
  const sent = []
  const faults = []
  const delivered = new Map()
  const stored = new Map()
  const files = new Map()
  const downloads = []
  const opened = []
  const ephemerals = []
  const acks = []
  const infos = []
  const failures = []
  let ts = 0
  let wake = null
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  const stamp = () => `${1729000000 + ++ts}.000100`
  return {
    sent,
    delivered,
    stored,
    files,
    downloads,
    opened,
    ephemerals,
    acks,
    infos,
    failures,
    stamp,
    lastMessage: 0,
    push (envelope) { waiting.push(envelope); wake?.() },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    slack: {
      post: async (args) => {
        fault('post')
        const at = stamp()
        sent.push({ op: args.blocks ? 'ask' : 'post', at, ...args })
        return at
      },
      update: async (args) => {
        fault('update')
        sent.push({ op: args.blocks ? 'close' : 'edit', at: args.ts, ...args })
      },
      remove: async (args) => {
        fault('remove')
        sent.push({ op: 'remove', at: args.ts, ...args })
      },
      ephemeral: async (args) => { ephemerals.push(args) },
      im: async (user) => {
        opened.push(user)
        return `D${user}`
      },
      user: async (id) => ({ id, name: `u${id}`, real_name: `U${id} Smith`, profile: { display_name: '', real_name: `U${id} Smith` } }),
      file: async (id) => {
        infos.push(id)
        return files.get(id)
      },
      download: async (url, { most }) => {
        fault('download')
        downloads.push(url)
        return download(url, { most, fetchImpl: async () => new Response(stored.get(url)) })
      }
    },
    async receive ({ onEnvelope, signal }) {
      while (!signal.aborted) {
        if (!waiting.length) {
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
          wake = null
          continue
        }
        const envelope = waiting.shift()
        try {
          await onEnvelope({ type: envelope.type, payload: envelope.payload, ack: (payload) => acks.push({ id: envelope.id, payload }) })
        } catch (err) {
          failures.push({ id: envelope.id, err })
        }
      }
    }
  }
}

const said = (one) => {
  const note = `${one.channel} ${one.at}`
  if (one.op === 'post') return { op: 'post', note, text: textOf(one), answering: one.thread_ts ?? null, formatted: one.markdown_text !== undefined }
  if (one.op === 'edit') return { op: 'edit', note, text: textOf(one) }
  if (one.op === 'ask') {
    const buttons = one.blocks.find(block => block.block_id === 'spore').elements
    return { op: 'ask', note, text: JSON.stringify({ blocks: one.blocks, text: one.text }), choices: buttons.map(button => ({ label: button.text.text, data: button.value, style: button.style ?? null })) }
  }
  if (one.op === 'close') return { op: 'close', note, text: JSON.stringify({ blocks: one.blocks, text: one.text }) }
  return { op: 'remove', note }
}

const envelope = (slack, type, payload) => ({ id: `e${++slack.lastMessage}`, type, payload })

const harness = {
  spec: SLACK,
  words: (text) => text,
  formats: true,
  credentials: { TRIAGE_SLACK_TOKEN: 'xoxb-triage', TRIAGE_SLACK_APP: 'xapp-triage', OTHER_SLACK_TOKEN: 'xoxb-other', OTHER_SLACK_APP: 'xapp-other' },
  botFile: (bot, table, fields = {}) => {
    const entries = Object.entries(table)
    const people = entries.filter(([, entry]) => !entry.shared).map(([who, { spore, details, brief }]) =>
      [who, details || brief !== undefined ? { spore, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) } : spore])
    const channels = entries.filter(([, entry]) => entry.shared).map(([channel, { spore, details, brief, people = [`9${numberOf(channel)}`, '*'] }]) =>
      [channel, { spores: [spore], people, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) }])
    const variable = (field) => `\${${bot.toUpperCase()}_SLACK_${field}}`
    return { token: variable('TOKEN'), app: variable('APP'), team: TEAM, people: Object.fromEntries(people), channels: Object.fromEntries(channels), ...fields }
  },
  shared: (n) => `C${n}`,
  platform: standIn,
  adapter: (slack) => createAdapter({ slack: slack.slack, receive: (options) => slack.receive(options), team: TEAM, me: ME }),
  say (slack, { conversation, text, files = [], id, shared = false, person = shared ? `9${numberOf(conversation)}` : conversation }) {
    if (id !== undefined) {
      const again = slack.delivered.get(id)
      slack.push(again.envelope)
      return again.said
    }
    const from = { name: `U${person} Smith`, id: `slack:${person}`, where: shared ? 'a Slack channel' : 'a direct message on Slack' }
    if (!shared && text?.startsWith('/')) {
      const one = envelope(slack, 'slash_commands', { team_id: TEAM, command: '/spore', text: text.slice(1), channel_id: `D${person}`, user_id: person, trigger_id: `tr${slack.lastMessage}` })
      slack.push(one)
      const answer = { id: one.id, message: null, from }
      slack.delivered.set(one.id, { envelope: one, said: answer })
      return answer
    }
    const ts = slack.stamp()
    const listed = files.map(({ name, mime, data }, i) => {
      const url = `https://files.slack.com/files-pri/${TEAM}-F${ts}${i}/download/${name}`
      slack.stored.set(url, data)
      return { id: `F${ts}${i}`, name, mimetype: mime, size: data.length, url_private: url, url_private_download: url }
    })
    const event = shared
      ? { type: 'app_mention', channel: conversation, user: person, text: `<@${ME}> ${text ?? ''}`.trim(), ts, ...(listed.length ? { files: listed } : {}) }
      : { type: 'message', channel_type: 'im', channel: `D${person}`, user: person, text: text ?? '', ts, ...(listed.length ? { subtype: 'file_share', files: listed } : {}) }
    const one = envelope(slack, 'events_api', { team_id: TEAM, event })
    slack.push(one)
    const answer = { id: ts, message: ts, from }
    slack.delivered.set(ts, { envelope: one, said: answer })
    return answer
  },
  seen: (slack, conversation) => slack.sent.filter(one => one.channel === channelOf(conversation)).map(said),
  press (slack, { note, data, person }) {
    const [channel, ts] = note.split(' ')
    const posted = slack.sent.find(one => one.channel === channel && one.at === ts)
    const before = slack.ephemerals.length
    slack.push(envelope(slack, 'interactive', {
      type: 'block_actions',
      team: { id: TEAM },
      user: { id: person },
      channel: { id: channel },
      message: { ts, ...(posted?.thread_ts ? { thread_ts: posted.thread_ts } : {}) },
      actions: [{ type: 'button', block_id: 'spore', action_id: 'choice-0', value: data }]
    }))
    return { acknowledged: () => slack.ephemerals.slice(before).find(one => one.user === person) && { text: textOf(slack.ephemerals.slice(before).find(one => one.user === person)) } }
  },
  fail: (slack, op, error, times) => slack.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('slack chat.postMessage failed', { type: 'SLACK_FAILED', retryable: true, detail: 'ratelimited', context: { status: 429, code: 'ratelimited', retryAfter } }),
  refused: (detail) => new SporeError('slack chat.postMessage failed', { type: 'SLACK_FAILED', retryable: false, detail, context: { status: 200, code: detail, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Slack', () => {
    const CHANNEL = harness.shared(5)
    const BLOCKS = { blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Apply the change?' } }, { type: 'section', text: { type: 'mrkdwn', text: '3 files' }, accessory: { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'diff' } }], text: 'Apply the change?' }
    const asking = (body) => requestApproval({
      ws: ctx.ws,
      configFile: join(ctx.root, 'config.json'),
      request: { to: 'slack:triage/1', by: ['1'], options: [{ id: 'apply', label: 'Apply', style: 'positive' }], body }
    }).approval

    it('answers a direct message in a thread under it that also shows in the conversation, and posts its own lines plainly', async () => {
      ctx.start()
      const asked = ctx.say({ conversation: '1', text: 'hello' })
      await ctx.until(() => ctx.posted('1', 'hello back'))
      const answer = ctx.platform.sent.find(one => one.markdown_text === 'hello back')
      expect(answer).toMatchObject({ channel: 'D1', thread_ts: asked.message, reply_broadcast: true })
      expect(ctx.platform.sent.find(one => one.text === 'working…')).not.toHaveProperty('thread_ts')
    })

    it('asks an approval with its own blocks, the buttons in an actions block after them, and keeps them once answered', async () => {
      ctx.start({ approveEveryMs: 50 })
      const id = asking({ slack: BLOCKS })
      await ctx.until(() => ctx.seen('1').some(one => one.op === 'ask'))
      const asked = ctx.platform.sent.find(one => one.op === 'ask')
      expect(asked.blocks.slice(0, 2)).toEqual(BLOCKS.blocks)
      expect(asked.blocks[2]).toEqual({ type: 'actions', block_id: 'spore', elements: [{ type: 'button', action_id: 'choice-0', text: { type: 'plain_text', text: 'Apply' }, value: `ap:${id}:apply`, style: 'primary' }] })
      expect(asked.text).toBe('Apply the change?')

      const question = ctx.seen('1').find(one => one.op === 'ask')
      const pressed = harness.press(ctx.platform, { note: question.note, data: question.choices[0].data, person: '1' })
      await ctx.until(() => pressed.acknowledged())
      expect(pressed.acknowledged()).toEqual({ text: 'Apply — recorded' })
      expect(ctx.platform.ephemerals.at(-1)).toMatchObject({ channel: 'D1', user: '1' })
      await ctx.until(() => approvalOf(ctx.ws, id).told)
      const closed = ctx.platform.sent.find(one => one.op === 'close')
      expect(closed.blocks).toEqual([...BLOCKS.blocks, { type: 'context', elements: [{ type: 'mrkdwn', text: '*Apply — U1 Smith*' }] }])
    })

    it('refuses a body that answers by itself, or that is not blocks it can show', async () => {
      ctx.start({ approveEveryMs: 50 })
      const refused = [
        { blocks: [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Go' } }] }] },
        { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' }, accessory: { type: 'button', text: { type: 'plain_text', text: 'Go' } } }] },
        { blocks: [] },
        { attachments: [] }
      ].map(body => asking({ slack: body }))
      await ctx.until(() => refused.every(id => approvalOf(ctx.ws, id).settledAt))
      expect(refused.map(id => approvalOf(ctx.ws, id).reason)).toEqual([
        'a Slack body is { "blocks": [ … ], "text": "<the notification>" }, the blocks only section, header, divider, context, image, markdown, rich_text or table',
        'a Slack body carries no interactive element — the buttons that answer are the ones spore adds',
        'a Slack body is { "blocks": [ … ], "text": "<the notification>" }, the blocks only section, header, divider, context, image, markdown, rich_text or table',
        'a Slack body is { "blocks": [ … ], "text": "<the notification>" }, the blocks only section, header, divider, context, image, markdown, rich_text or table'
      ])
      expect(ctx.seen('1').some(one => one.op === 'ask')).toBe(false)
    })

    it('answers a mention in a channel in its thread, and a turn nobody there started as a new post in the channel', async () => {
      ctx.routes({ [CHANNEL]: { spore: 'triage', shared: true } })
      ctx.defaultReplyTo(CHANNEL)
      ctx.start()
      const asked = ctx.say({ conversation: CHANNEL, text: 'hello', shared: true })
      await ctx.until(() => ctx.posted(CHANNEL, 'hello back'))
      expect(ctx.platform.sent.filter(one => one.op === 'post').map(one => [one.thread_ts, textOf(one), one.reply_broadcast])).toEqual([[asked.message, 'working…', undefined], [asked.message, 'hello back', undefined]])
      expect(readInbox(ctx.ws)[0]).toMatchObject({ text: 'hello', replyTo: `slack:triage/${CHANNEL}/${asked.message}` })

      await ctx.idle(1)
      ctx.replying(async () => answers('two new papers'))
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.posted(CHANNEL, 'schedule "digest"\n\ntwo new papers'))
      expect(ctx.platform.sent.find(one => one.markdown_text === 'schedule "digest"\n\ntwo new papers')).not.toHaveProperty('thread_ts')
    })

    it('opens a direct message with someone who never wrote to the bot, to reach them', async () => {
      ctx.routes({ 1: { spore: 'triage' } })
      ctx.defaultReplyTo('1')
      ctx.start()
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.posted('1', 'schedule "digest"\n\nhello back'))
      expect(ctx.platform.opened).toEqual(['1'])
    })

    it('takes /spore at once, Slack wanting an answer within 3 seconds, and answers it in the conversation', async () => {
      ctx.start()
      const asked = ctx.say({ conversation: '1', text: '/status' })
      await ctx.until(() => ctx.posts('1').length)
      expect(ctx.platform.acks.find(one => one.id === asked.id)).toEqual({ id: asked.id, payload: undefined })
      expect(ctx.posts('1')[0].answering).toBe(null)
      expect(readInbox(ctx.ws)).toEqual([])
    })

    it('fetches a file a Slack Connect channel held back, asking Slack for it first', async () => {
      const url = 'https://files.slack.com/files-pri/T0TEAM-F9/download/q3.pdf'
      ctx.platform.stored.set(url, Buffer.from('%PDF'))
      ctx.platform.files.set('F9', { id: 'F9', name: 'q3.pdf', mimetype: 'application/pdf', size: 4, url_private_download: url })
      ctx.start()
      ctx.platform.push(envelope(ctx.platform, 'events_api', {
        team_id: TEAM,
        event: { type: 'message', channel_type: 'im', subtype: 'file_share', channel: 'D1', user: '1', text: 'this', ts: ctx.platform.stamp(), files: [{ id: 'F9', file_access: 'check_file_info' }] }
      }))
      await ctx.until(() => ctx.posted('1', 'hello back'))
      expect(ctx.platform.infos).toEqual(['F9'])
      expect(ctx.platform.downloads).toEqual([url])
      expect(readInbox(ctx.ws)[0].files.map(file => [file.name, file.bytes])).toEqual([['file-1', 4]])
    })

    it('drops, and acknowledges, what is from another workspace, from a bot, or not a message a person wrote', async () => {
      ctx.start()
      const push = (payload, type = 'events_api') => ctx.platform.push(envelope(ctx.platform, type, payload))
      const message = (fields) => ({ type: 'message', channel_type: 'im', channel: 'D1', user: '1', text: 'hello', ts: ctx.platform.stamp(), ...fields })
      push({ team_id: 'T0ELSE', event: message() })
      push({ team_id: TEAM, event: message({ bot_id: 'B1' }) })
      push({ team_id: TEAM, event: message({ user: ME }) })
      push({ team_id: TEAM, event: message({ subtype: 'message_changed' }) })
      push({ team_id: TEAM, event: { type: 'app_home_opened', user: '1' } })
      push({ type: 'view_submission', team: { id: TEAM } }, 'interactive')
      await ctx.until(() => ctx.platform.acks.length === 6)
      expect(ctx.logs).toEqual(['dropped an event from team T0ELSE: this bot serves T0TEAM'])
      expect(readInbox(ctx.ws)).toEqual([])
      expect(ctx.platform.sent).toEqual([])
    })
  })
})
