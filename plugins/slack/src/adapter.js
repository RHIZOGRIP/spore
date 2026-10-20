/**
 * Slack for the relay (`@rhizogrip/spore/relay`): the bot file, the envelopes Socket Mode
 * delivers, and the Web API calls that answer them. A person's direct message with the bot is a
 * conversation keyed by their member id; a channel's is a thread in it, `<channel id>/<thread ts>`,
 * routed by its channel.
 */

import { SporeError } from '@rhizogrip/spore'

const FIELDS = ['token', 'app', 'team', 'people', 'channels', 'trace']
const PERSON_FIELDS = ['spore', 'details', 'brief']
const CHANNEL_FIELDS = ['spores', 'people', 'details', 'brief']
const ID = /^[A-Z0-9]+$/
const CHANNEL = /^[CG][A-Z0-9]+$/
const TEAM = /^T[A-Z0-9]+$/
const THREAD = '/'
const COMMAND = /^\/([a-z]+)(?:\s+(.+))?$/is
const SLASH = '/spore'
const PRESSED = 'spore'
const TAKEN_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast'])
const SHOWN = new Set(['section', 'header', 'divider', 'context', 'image', 'markdown', 'rich_text', 'table'])
const STYLES = { positive: 'primary', destructive: 'danger' }
const FIELDS_PER_SECTION = 10
const SHAPE = '{ "token": "${OPS_SLACK_TOKEN}", "app": "${OPS_SLACK_APP}", "team": "<team id>", "people": { "<member id>": "<spore>" }, "channels": { "<channel id>": { "spores": ["<spore>"], "people": ["<member id>"] } } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'SLACK_BOT_INVALID', detail })

const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const flags = (path, kind, id, entry) => {
  for (const name of ['details', 'brief']) {
    if (entry[name] !== undefined && typeof entry[name] !== 'boolean') throw invalid(path, `has a ${kind} ${id} whose ${name} is not true or false`)
  }
}

const strays = (path, kind, id, entry, takes) => {
  const extra = Object.keys(entry).filter(key => !takes.includes(key))
  if (!extra.length) return
  const bots = extra.filter(key => FIELDS.includes(key))
  throw invalid(path, `gives ${kind} ${id} ${extra.join(', ')}, which a ${kind} does not take`, `a ${kind} takes ${takes.join(', ')}${bots.length ? `; ${bots.join(', ')} is the bot's, beside people and channels` : ''}`)
}

/**
 * The bot's workspace and its routing: `people`, each person's direct message with the bot by
 * their member id — `"<spore>"` or `{ "spore", "details", "brief" }` — and `channels`, each by its
 * id, with its one spore and who may address it there: member ids, or `*` for everyone in the
 * channel. `details` shows the calls themselves rather than their kinds; `brief` is the bot's own,
 * for this conversation.
 */
function routes (raw, path) {
  if (typeof raw.team !== 'string' || !TEAM.test(raw.team)) throw invalid(path, 'has no team', 'team is the workspace\'s id, T…, which auth.test answers for the bot\'s token')
  if (raw.trace !== undefined && typeof raw.trace !== 'boolean') throw invalid(path, 'has a trace that is not true or false', 'trace: true writes every envelope Slack delivers to the log, as it came')
  if (raw.people === undefined && raw.channels === undefined) {
    throw invalid(path, 'has no people and no channels', `a bot is ${SHAPE} — "people": {} while you learn the ids: the log names everyone it refuses`)
  }
  const entries = (field) => {
    const value = raw[field] ?? {}
    if (!record(value)) throw invalid(path, `has ${field} that is not { "<id>": … }`)
    return Object.entries(value)
  }
  const table = new Map()
  for (const [person, entry] of entries('people')) {
    if (CHANNEL.test(person)) throw invalid(path, `names "${person}" among its people, which is a channel id`, 'a channel goes under channels')
    if (person.startsWith('D') || !ID.test(person)) throw invalid(path, `names "${person}" among its people, which is not a member id`, 'a person is their member id, U… — in their profile, under ⋮, Copy member ID')
    if (record(entry)) {
      strays(path, 'person', person, entry, PERSON_FIELDS)
      flags(path, 'person', person, entry)
    }
    const spore = record(entry) ? entry.spore : entry
    if (typeof spore !== 'string' || !spore) throw invalid(path, `maps person ${person} to something that is not a spore`, 'each person is their member id against the name of the spore they reach, or { "spore": "<name>", "details": true }')
    table.set(person, { spores: [spore], details: record(entry) && entry.details === true, show: null, brief: record(entry) ? entry.brief ?? null : null, people: null, overhear: false })
  }
  for (const [channel, entry] of entries('channels')) {
    if (!CHANNEL.test(channel)) throw invalid(path, `names "${channel}" among its channels, which is not a channel id`, 'a channel id is C…, at the bottom of the channel\'s details')
    if (!record(entry)) throw invalid(path, `has a channel ${channel} that is not { "spores": [...], "people": [...] }`)
    strays(path, 'channel', channel, entry, CHANNEL_FIELDS)
    flags(path, 'channel', channel, entry)
    if (!Array.isArray(entry.spores) || !entry.spores.length || !entry.spores.every(spore => typeof spore === 'string' && spore)) throw invalid(path, `has a channel ${channel} with no spores`)
    if (entry.spores.length > 1) throw invalid(path, `gives channel ${channel} ${entry.spores.length} spores`, 'a bot speaks in a channel as itself, so a channel has one spore — a second spore there is a second bot')
    if (!Array.isArray(entry.people) || !entry.people.every(who => who === '*' || (typeof who === 'string' && ID.test(who)))) {
      throw invalid(path, `has a channel ${channel} whose people are not member ids or *`, 'people is who may address its spore — ["<member id>", …], or ["*"] for everyone in the channel, written out')
    }
    table.set(channel, { spores: entry.spores, details: entry.details === true, show: null, brief: entry.brief ?? null, people: entry.people, overhear: false })
  }
  return table
}

const HELP = 'Anything you write to me in a direct message goes to the spore; in a channel, mention me. /spore status says what it is doing; /spore stop ends the turn it is running and sets aside what you sent that it had not read; /spore wrap [10m] asks it to wrap up. In a thread, where Slack takes no /spore, mention me and write /status, /stop or /wrap'
const EXTEND = '/spore extend wall 30m gives it more, as far as its spore.cmk allows'

export const SLACK = {
  kind: 'slack',
  label: 'Slack',
  noun: 'conversation',
  fields: FIELDS,
  credentials: ['token', 'app'],
  stateFields: ['ims'],
  sourceVariables: [],
  refusals: ['SLACK_REFUSED'],
  example: SHAPE,
  routes,
  routeOf: (conversation) => conversation.split(THREAD)[0],
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/spore extend wall 30m, /spore extend cost 1.50 or /spore extend rounds 20' },
  limits: { message: 12000, file: 0, fetch: 25 * 1024 * 1024, editEveryMs: 5000, typingEveryMs: 0 },
  can: { upload: false, remove: true, react: false, typing: false, reply: true, choose: true },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'SLACK_NO_BOT') return `mkdir -p ${file.slice(0, file.lastIndexOf('/'))} — then ${file} as ${SHAPE}`
    if (err.type === 'SLACK_REFUSED') return 'the bot token (xoxb-) is under OAuth & Permissions of your app at api.slack.com/apps, the app-level token (xapp-, with connections:write) under Basic Information, and Socket Mode is on under Socket Mode; both tokens go in environment beside config.json'
    return null
  },
  refusal: (message, botFile) => message.shared
    ? `refused ${message.where}, ${message.conversation.split(THREAD)[0]} — to allow it, add "${message.conversation.split(THREAD)[0]}": { "spores": ["<a spore>"], "people": ["${message.person.id}"] } to the channels of ${botFile}`
    : `refused ${message.person.name} (${message.person.id}) — to allow them, add "${message.person.id}": "<a spore>" to the people of ${botFile}`
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Slack's mentions in what a spore wrote — a person, a group, a whole channel — broken so they ping no one. */
const harmless = (text) => text
  .replace(/<(!(?:here|channel|everyone|subteam)|@[UW][A-Z0-9])/g, '<\u200b$1')
  .replace(/@(here|channel|everyone)\b/g, '@\u200b$1')

/**
 * Slack's markup made plain: the bot's own mentions that open the message gone, since they only
 * address it; every other person as `@name`, a channel as `#name`, a link as its text and address.
 */
async function plain (text, me, nameOf, channelOf) {
  let rest = text.replace(new RegExp(`^(?:\\s*<@${me}(?:\\|[^>]*)?>)+\\s*`), '')
  const lookup = async (pattern, of) => new Map(await Promise.all([...new Set([...rest.matchAll(pattern)].map(found => found[1]))].map(async id => [id, await of(id)])))
  const names = await lookup(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, nameOf)
  const channels = await lookup(/<#([A-Z0-9]+)(?:\|)?>/g, channelOf)
  rest = rest
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id) => `@${names.get(id)}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || channels.get(id)}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => name ?? '@group')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, (_, shown) => shown)
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, (_, name) => `@${name}`)
    .replace(/<([^>|]+)\|([^>]*)>/g, (_, url, label) => label && label !== url ? `${label} (${url})` : url)
    .replace(/<([^>]+)>/g, (_, url) => url)
  return rest.replace(/&(amp|lt|gt);/g, (entity) => ENTITIES[entity]).trim()
}

const whereOf = async (channel, channelOf) => channel.startsWith('D') ? 'a direct message on Slack' : `the Slack channel #${await channelOf(channel)}`

/**
 * What a message brought, as the relay lists files: each by the private URL Slack serves the bot,
 * or by its id alone where Slack holds its details back — a file in a Slack Connect channel —
 * so they are asked for when it is fetched.
 */
const filesOf = (event) => (event.files ?? []).map((file, i) => {
  if (file.file_access === 'check_file_info') return { name: `file-${i + 1}`, mime: null, bytes: null, ref: { id: file.id, url: null } }
  const url = file.url_private_download ?? file.url_private
  const shown = { name: file.name || `file-${i + 1}`, mime: file.mimetype || null, bytes: file.size ?? null }
  return url ? { ...shown, ref: { id: file.id, url } } : { ...shown, ref: null, why: 'Slack gave the bot no link to this file' }
})

/**
 * A direct message or a mention of the bot in a channel, as the relay takes it: one in a direct
 * message reaches the person's spore; one in a channel is its thread's, answered there.
 */
export async function normalize (event, { team, me, nameOf, zoneOf, channelOf }) {
  const direct = event.type === 'message'
  const text = (await plain(event.text ?? '', me, nameOf, channelOf)) || null
  const command = text?.match(COMMAND)
  return {
    id: `${team}/${event.channel}/${event.ts}`,
    conversation: direct ? event.user : `${event.channel}${THREAD}${event.thread_ts ?? event.ts}`,
    message: event.ts,
    person: { id: event.user, name: await nameOf(event.user), groups: [], zone: await zoneOf(event.user) },
    spore: null,
    where: await whereOf(event.channel, channelOf),
    shared: !direct,
    text,
    command: command ? { verb: command[1].toLowerCase(), args: command[2] ?? '' } : null,
    addresses: null,
    files: filesOf(event)
  }
}

/** `/spore <verb> [args]`, as a message from the person who typed it, where they typed it. */
export async function commandOf (payload, { team, nameOf, zoneOf, channelOf }) {
  const direct = payload.channel_id.startsWith('D')
  const text = payload.text.trim()
  const [verb = 'help', ...args] = text ? text.split(/\s+/) : []
  return {
    id: `${team}/${payload.channel_id}/${payload.trigger_id}`,
    conversation: direct ? payload.user_id : payload.channel_id,
    message: null,
    person: { id: payload.user_id, name: await nameOf(payload.user_id), groups: [], zone: await zoneOf(payload.user_id) },
    spore: null,
    where: await whereOf(payload.channel_id, channelOf),
    shared: !direct,
    text: `/${text || 'help'}`,
    command: { verb: verb.toLowerCase(), args: args.join(' ') },
    addresses: null,
    files: []
  }
}

/** A press on one of the relay's buttons, as the relay takes it, keyed as a message there would be. */
export async function choiceOf (payload, { nameOf, channelOf }) {
  const channel = payload.channel.id
  const direct = channel.startsWith('D')
  const thread = payload.message?.thread_ts
  return {
    conversation: direct ? payload.user.id : thread ? `${channel}${THREAD}${thread}` : channel,
    data: payload.actions.find(action => action.block_id === PRESSED)?.value ?? null,
    inputs: null,
    person: { id: payload.user.id, name: await nameOf(payload.user.id), groups: [] },
    where: await whereOf(channel, channelOf)
  }
}

/** Why a body cannot be shown in a message with the relay's buttons, or null. */
function bodyProblem (native) {
  const shape = 'a Slack body is { "blocks": [ … ], "text": "<the notification>" }, the blocks only section, header, divider, context, image, markdown, rich_text or table'
  if (Object.keys(native).some(key => key !== 'blocks' && key !== 'text') || !Array.isArray(native.blocks) || !native.blocks.length || native.blocks.length > 49) return shape
  if (native.text !== undefined && typeof native.text !== 'string') return shape
  for (const block of native.blocks) {
    if (!record(block) || !SHOWN.has(block.type)) return shape
    if (block.accessory !== undefined && block.accessory?.type !== 'image') return 'a Slack body carries no interactive element — the buttons that answer are the ones spore adds'
    if (block.type === 'context' && !block.elements?.every(element => ['image', 'mrkdwn', 'plain_text'].includes(element?.type))) return shape
  }
  return null
}

/** What an approval shows, as blocks: the host's own, or the default body — its text, then its facts, ten to a section. */
const blocksOf = ({ native, fallback }) => {
  if (native) return { blocks: structuredClone(native.blocks), text: native.text ?? 'a question for you' }
  const facts = fallback.facts ?? []
  const sections = []
  for (let i = 0; i < facts.length; i += FIELDS_PER_SECTION) {
    sections.push({ type: 'section', fields: facts.slice(i, i + FIELDS_PER_SECTION).map(([title, value]) => ({ type: 'mrkdwn', text: `*${escape(title)}*\n${escape(value)}` })) })
  }
  return {
    blocks: [...(fallback.text ? [{ type: 'markdown', text: fallback.text }] : []), ...sections],
    text: fallback.text ?? 'a question for you'
  }
}

/**
 * The live adapter. `receive({ onEnvelope, signal, log, sleep })` is the transport — Socket Mode, or a
 * test's — handing over each envelope with its `ack`. A post to a person goes to their direct
 * message with the bot, opened when there is none yet; to a channel thread, into the thread; to a
 * channel, as a new post. A note is `<channel id> <ts>`, where the post went.
 */
export function createAdapter ({ slack, receive, team, me }) {
  let kept = null
  let save = null
  const people = new Map()
  const channels = new Map()

  /** How a person shows, and the zone of the clock their profile sets — null where it sets none. */
  const personOf = async (id) => {
    if (!people.has(id)) {
      const user = await slack.user(id)
      people.set(id, { name: user.profile?.display_name || user.profile?.real_name || user.real_name || user.name, zone: user.tz ?? null })
    }
    return people.get(id)
  }
  const nameOf = async (id) => (await personOf(id)).name
  const zoneOf = async (id) => (await personOf(id)).zone

  const channelOf = async (id) => {
    if (!channels.has(id)) channels.set(id, (await slack.channel(id)).name)
    return channels.get(id)
  }
  const lookups = { team, me, nameOf, zoneOf, channelOf }

  const imOf = async (person) => {
    if (!kept.ims[person]) {
      kept.ims[person] = await slack.im(person)
      save()
    }
    return kept.ims[person]
  }

  /** The direct message a person wrote in, as Slack gave it, so the answer needs no lookup. */
  const remember = (person, channel) => {
    if (kept.ims[person] === channel) return
    kept.ims[person] = channel
    save()
  }

  const target = async (conversation) => {
    const [channel, thread = null] = conversation.split(THREAD)
    if (CHANNEL.test(channel)) return { channel, thread }
    return { channel: await imOf(conversation), thread: null }
  }

  const placeOf = (note) => {
    const at = note.indexOf(' ')
    return { channel: note.slice(0, at), ts: note.slice(at + 1) }
  }

  /** Into a conversation: a direct message as it goes, a channel's thread in the thread. */
  const into = async (conversation, body) => {
    const { channel, thread } = await target(conversation)
    const ts = await slack.post({ channel, ...body, ...(thread ? { thread_ts: thread } : {}) })
    return `${channel} ${ts}`
  }

  const press = async (payload, onChoice) => {
    if (!payload.actions?.some(action => action.block_id === PRESSED)) return
    const choice = await choiceOf(payload, lookups)
    const thread = payload.message?.thread_ts
    await onChoice({
      ...choice,
      acknowledge: async (text) => {
        if (text) await slack.ephemeral({ channel: payload.channel.id, user: payload.user.id, text: escape(text), ...(thread ? { thread_ts: thread } : {}) })
      }
    })
  }

  const event = async (one, onMessage) => {
    if (one.bot_id || one.user === me || !one.user) return
    if (one.type === 'message') {
      if (one.channel_type !== 'im' || !TAKEN_SUBTYPES.has(one.subtype)) return
      remember(one.user, one.channel)
      return onMessage(await normalize(one, lookups))
    }
    if (one.type === 'app_mention' && !one.channel.startsWith('D')) return onMessage(await normalize(one, lookups))
  }

  return {
    ...SLACK,

    restore (state, persist) {
      kept = state
      save = persist
    },

    listen: ({ onMessage, onChoice, signal, log, sleep }) => receive({
      signal,
      log,
      sleep,
      onEnvelope: async ({ type, payload, ack }) => {
        if (type === 'slash_commands') {
          ack()
          if (payload.team_id !== team) return log(`dropped a command from team ${payload.team_id}: this bot serves ${team}`)
          if (payload.command !== SLASH) return log(`dropped ${payload.command}: this bot answers ${SLASH}`)
          return onMessage(await commandOf(payload, lookups))
        }
        if (type === 'interactive') {
          if (payload.team?.id !== team) {
            ack()
            return log(`dropped a press from team ${payload.team?.id}: this bot serves ${team}`)
          }
          if (payload.type === 'block_actions') await press(payload, onChoice)
          return ack()
        }
        if (type === 'events_api') {
          if (payload.team_id !== team) {
            ack()
            return log(`dropped an event from team ${payload.team_id}: this bot serves ${team}`)
          }
          await event(payload.event, onMessage)
        }
        ack()
      }
    }),

    post: (conversation, text, { markdown = false } = {}) =>
      into(conversation, markdown ? { markdown_text: harmless(text) } : { text: escape(text) }),

    edit: async (conversation, note, text) => {
      const { channel, ts } = placeOf(note)
      await slack.update({ channel, ts, text: escape(text) })
    },

    remove: async (conversation, note) => {
      const { channel, ts } = placeOf(note)
      await slack.remove({ channel, ts })
    },

    fetch: async (ref, { most }) => {
      let url = ref.url
      if (url === null) {
        const file = await slack.file(ref.id)
        url = file.url_private_download ?? file.url_private
      }
      if (!url) throw new SporeError('the file could not be fetched', { type: 'FILE_FETCH_FAILED', detail: 'Slack gave the bot no link to it', retryable: false })
      return slack.download(url, { most })
    },

    checkBody: bodyProblem,

    /** The question as blocks, each choice a button in an actions block of the relay's own under them. */
    ask: async (conversation, shown, choices) => {
      const { blocks, text } = blocksOf(shown)
      blocks.push({
        type: 'actions',
        block_id: PRESSED,
        elements: choices.map((choice, i) => ({ type: 'button', action_id: `choice-${i}`, text: { type: 'plain_text', text: choice.label }, value: choice.data, ...(STYLES[choice.style] ? { style: STYLES[choice.style] } : {}) }))
      })
      return { note: await into(conversation, { blocks, text }), shown: { blocks, text } }
    },

    /** The question closed: replaced by `native` or `fallback`, or kept as `shown` with its buttons gone and how it ended below. */
    settle: async (conversation, note, replacement) => {
      const shown = replacement.shown
        ? { blocks: [...replacement.shown.blocks.filter(block => block.block_id !== PRESSED), { type: 'context', elements: [{ type: 'mrkdwn', text: `*${escape(replacement.outcome)}*` }] }], text: replacement.shown.text }
        : blocksOf(replacement)
      const { channel, ts } = placeOf(note)
      await slack.update({ channel, ts, ...shown })
      return shown
    }
  }
}
