/**
 * Microsoft Teams for the relay (`@rhizogrip/spore/relay`): the bot file, the activities the Bot
 * Connector delivers, and the Bot Connector calls that answer them. A person's personal chat with
 * the bot is a conversation keyed by their Entra object id; a channel's is a thread in it,
 * `<channel id>;messageid=<root>`, routed by its channel.
 */

import { SporeError } from '@rhizogrip/spore'

const FIELDS = ['app', 'tenant', 'secret', 'listen', 'people', 'channels']
const PERSON_FIELDS = ['spore', 'details', 'brief']
const CHANNEL_FIELDS = ['spores', 'people', 'details', 'brief']
const PERSON = /^[0-9a-f][0-9a-f-]*$/i
const CHANNEL = /^19:[^\s;]+@thread\.[a-z0-9]+$/i
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const THREAD = ';messageid='
const COMMAND = /^\/([a-z]+)(?:\s+(.+))?$/is
const SERVICE_URL = 'https://smba.trafficmanager.net/teams/'
const CARD = 'application/vnd.microsoft.card.adaptive'
const PRESSED = 'spore'
const ANSWERING = new Set(['Action.Submit', 'Action.Execute'])
const SHAPE = '{ "app": "<app id>", "tenant": "<tenant id>", "secret": "${OPS_TEAMS_SECRET}", "listen": "127.0.0.1:3978", "people": { "<object id>": "<spore>" }, "channels": { "<channel id>": { "spores": ["<spore>"], "people": ["<object id>"] } } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'TEAMS_BOT_INVALID', detail })

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

/** Where the service listens, `<loopback host>:<port>`: the operator's proxy is what faces Microsoft. */
export function listenOf (raw, path) {
  const found = /^(.+):(\d+)$/.exec(raw.listen ?? '')
  const host = found?.[1].replace(/^\[(.*)\]$/, '$1')
  if (!found || !LOOPBACK.has(host) || Number(found[2]) > 65535) {
    throw invalid(path, `listens on ${JSON.stringify(raw.listen)}`, 'listen is a loopback address and a port, as 127.0.0.1:3978 — a proxy of yours gives it the public HTTPS address the Azure Bot names')
  }
  return { host, port: Number(found[2]) }
}

/**
 * The bot's app and tenant, where it listens, and its routing: `people`, each person's personal
 * chat by their Entra object id — `"<spore>"` or `{ "spore", "details", "brief" }` — and `channels`,
 * each standard channel by its id, with its one spore and who may address it there: object ids, or
 * `*` for everyone in the channel. `details` shows the calls themselves rather than their kinds;
 * `brief` is the bot's own, for this conversation.
 */
function routes (raw, path) {
  for (const field of ['app', 'tenant']) {
    if (typeof raw[field] !== 'string' || !raw[field]) throw invalid(path, `has no ${field}`, `${field} is the Azure Bot's ${field === 'app' ? 'Microsoft App ID' : 'app tenant ID'}`)
  }
  listenOf(raw, path)
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
    if (!PERSON.test(person)) throw invalid(path, `names "${person}" among its people, which is not an Entra object id`, 'a person is their object id in Entra ID; a channel\'s id begins 19: and goes under channels')
    if (record(entry)) {
      strays(path, 'person', person, entry, PERSON_FIELDS)
      flags(path, 'person', person, entry)
    }
    const spore = record(entry) ? entry.spore : entry
    if (typeof spore !== 'string' || !spore) throw invalid(path, `maps person ${person} to something that is not a spore`, 'each person is their object id against the name of the spore they reach, or { "spore": "<name>", "details": true }')
    table.set(person, { spores: [spore], details: record(entry) && entry.details === true, show: null, brief: record(entry) ? entry.brief ?? null : null, people: null, overhear: false })
  }
  for (const [channel, entry] of entries('channels')) {
    if (!CHANNEL.test(channel)) throw invalid(path, `names "${channel}" among its channels, which is not a channel id`, 'a channel id is 19:…@thread.tacv2, from the channel\'s link in Teams')
    if (!record(entry)) throw invalid(path, `has a channel ${channel} that is not { "spores": [...], "people": [...] }`)
    strays(path, 'channel', channel, entry, CHANNEL_FIELDS)
    flags(path, 'channel', channel, entry)
    if (!Array.isArray(entry.spores) || !entry.spores.length || !entry.spores.every(spore => typeof spore === 'string' && spore)) throw invalid(path, `has a channel ${channel} with no spores`)
    if (entry.spores.length > 1) throw invalid(path, `gives channel ${channel} ${entry.spores.length} spores`, 'a bot speaks in a channel as itself, so a channel has one spore — a second spore there is a second bot')
    if (!Array.isArray(entry.people) || !entry.people.every(who => who === '*' || (typeof who === 'string' && PERSON.test(who)))) {
      throw invalid(path, `has a channel ${channel} whose people are not object ids or *`, 'people is who may address its spore — ["<object id>", …], or ["*"] for everyone in the channel, written out')
    }
    table.set(channel, { spores: entry.spores, details: entry.details === true, show: null, brief: entry.brief ?? null, people: entry.people, overhear: false })
  }
  return table
}

const HELP = 'Anything you write to me in a personal chat goes to the spore; in a channel, mention me. /status says what it is doing; /stop ends the turn it is running and sets aside what you sent that it had not read; /wrap [10m] asks it to wrap up'
const EXTEND = '/extend wall 30m gives it more, as far as its spore.cmk allows'

export const TEAMS = {
  kind: 'teams',
  label: 'Teams',
  noun: 'conversation',
  fields: FIELDS,
  credentials: ['secret'],
  stateFields: ['chats', 'channels'],
  sourceVariables: [],
  refusals: ['TEAMS_REFUSED', 'TEAMS_LISTEN_REFUSED'],
  example: SHAPE,
  routes,
  routeOf: (conversation) => conversation.split(THREAD)[0],
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 40000, file: 0, editEveryMs: 2500, typingEveryMs: 4000 },
  can: { upload: false, remove: true, react: false, typing: false, reply: true, choose: true },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'TEAMS_NO_BOT') return `mkdir -p ${file.slice(0, file.lastIndexOf('/'))} — then ${file} as ${SHAPE}`
    if (err.type === 'TEAMS_REFUSED') return 'the app id, its tenant and a client secret come from the Azure Bot\'s app registration in Entra ID; the secret goes in environment beside config.json'
    if (err.type === 'TEAMS_LISTEN_REFUSED') return `another process holds that address — change listen in ${file}`
    return null
  },
  refusal: (message, botFile) => message.shared
    ? `refused ${message.where}, ${message.conversation.split(THREAD)[0]} — to allow it, add "${message.conversation.split(THREAD)[0]}": { "spores": ["<a spore>"], "people": ["${message.person.id}"] } to the channels of ${botFile}`
    : `refused ${message.person.name} (${message.person.id}) — to allow them, add "${message.person.id}": "<a spore>" to the people of ${botFile}`
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&nbsp;': ' ' }

/** Teams' markup made plain: the bot's own mention gone, anyone else's as `@name`, tags dropped. */
const plain = (html, own) => html
  .replace(/<at[^>]*>(.*?)<\/at>/gis, (whole, name) => own.includes(whole) ? '' : `@${name}`)
  .replace(/<br\s*\/?>|<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
  .replace(/\n{3,}/g, '\n\n')
  .trim()

/**
 * A message activity as the relay takes it, or null for none it takes: one in a personal chat
 * reaches the person's spore; one in a channel reaches the channel's when it mentions the bot,
 * and names no spore otherwise.
 */
export function normalize (activity) {
  const personal = activity.conversation.conversationType === 'personal'
  const own = (activity.entities ?? []).filter(entity => entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id).map(entity => entity.text)
  const text = plain(activity.text ?? '', own) || null
  const command = text?.match(COMMAND)
  const channel = activity.channelData?.channel
  return {
    id: `${activity.conversation.id}:${activity.id}`,
    conversation: personal ? activity.from.aadObjectId : activity.conversation.id,
    message: activity.id,
    person: { id: activity.from.aadObjectId, name: activity.from.name, groups: [] },
    spore: null,
    where: personal ? 'a personal chat in Teams' : channel?.name ? `the Teams channel "${channel.name}"` : 'a Teams channel',
    shared: !personal,
    text,
    command: command ? { verb: command[1].toLowerCase(), args: command[2] ?? '' } : null,
    addresses: personal || own.length ? null : [],
    files: (activity.attachments ?? []).filter(attachment => attachment.contentType !== 'text/html').length
  }
}

const tenantOf = (activity) => activity.conversation?.tenantId ?? activity.channelData?.tenant?.id

/** Whether anything in a card, however deep — an action set, a select action, a refresh — sends a press back to the bot. */
const answersBack = (value) => Array.isArray(value)
  ? value.some(answersBack)
  : record(value) && (ANSWERING.has(value.type) || Object.values(value).some(answersBack))

/** What an approval shows, as an Adaptive Card: the host's own, or the default body — its text, then its facts. */
const cardOf = ({ native, fallback }) => native
  ? structuredClone(native)
  : {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [
        ...(fallback.text ? [{ type: 'TextBlock', text: fallback.text, wrap: true }] : []),
        ...(fallback.facts?.length ? [{ type: 'FactSet', facts: fallback.facts.map(([title, value]) => ({ title, value })) }] : [])
      ]
    }

/** The card as it was shown, the relay's buttons gone and how it ended below. */
const closed = (card, outcome) => ({
  ...card,
  body: [...(card.body ?? []), { type: 'TextBlock', text: `**${outcome}**`, wrap: true }],
  actions: (card.actions ?? []).filter(action => !(record(action.data) && Object.hasOwn(action.data, PRESSED)))
})

/**
 * A press on one of the relay's buttons, as the relay takes it, from an `adaptiveCard/action`
 * invoke: what Teams merged into the action's data besides the relay's own is what the person
 * filled in.
 */
export function choiceOf (activity) {
  const personal = activity.conversation.conversationType === 'personal'
  const { [PRESSED]: data = null, ...inputs } = record(activity.value?.action?.data) ? activity.value.action.data : {}
  return {
    conversation: personal ? activity.from.aadObjectId : activity.conversation.id,
    data,
    inputs: Object.keys(inputs).length ? inputs : null,
    person: { id: activity.from.aadObjectId, name: activity.from.name, groups: [] },
    where: personal ? 'a personal chat in Teams' : 'a Teams channel'
  }
}

/**
 * The live adapter. `receive({ onActivity, signal, log })` is the transport — the listener, or a
 * test's — and hands over each activity already checked. A post to a person goes to the chat they
 * have with the bot, made when there is none yet; to a channel thread, into the thread; to a
 * channel, as a new post. A note is `<conversation id> <activity id>`, where the post went.
 */
export function createAdapter ({ connector, receive, app, tenant }) {
  let kept = null
  let save = null

  /** What came with an activity that says where to answer: the person's chat, or the channel's service. */
  const remember = (activity) => {
    const { serviceUrl } = activity
    if (activity.conversation.conversationType === 'personal' && activity.from.aadObjectId) {
      const was = kept.chats[activity.from.aadObjectId]
      if (was?.conversation === activity.conversation.id && was.serviceUrl === serviceUrl) return
      kept.chats[activity.from.aadObjectId] = { conversation: activity.conversation.id, serviceUrl }
      save()
    } else if (activity.channelData?.channel?.id) {
      const channel = activity.channelData.channel.id
      if (kept.channels[channel]?.serviceUrl === serviceUrl) return
      kept.channels[channel] = { serviceUrl }
      save()
    }
  }

  const serviceOf = (conversation) => conversation.startsWith('19:')
    ? kept.channels[conversation.split(THREAD)[0]]?.serviceUrl ?? SERVICE_URL
    : kept.chats[conversation]?.serviceUrl ?? SERVICE_URL

  const chatOf = async (person) => {
    if (!kept.chats[person]) {
      const made = await connector.create(SERVICE_URL, { bot: { id: `28:${app}` }, members: [{ id: person }], channelData: { tenant: { id: tenant } }, isGroup: false })
      kept.chats[person] = { conversation: made.id, serviceUrl: SERVICE_URL }
      save()
    }
    return kept.chats[person].conversation
  }

  const placeOf = (note) => {
    const at = note.lastIndexOf(' ')
    return { conversation: note.slice(0, at), id: note.slice(at + 1) }
  }

  const activity = (text, { markdown = false, answering = null } = {}) => ({
    type: 'message',
    text,
    textFormat: markdown ? 'markdown' : 'plain',
    ...(answering === null ? {} : { replyToId: answering })
  })

  /** An activity into a conversation, answering its note: a person's chat, made when there is none yet; a thread; or a new post in a channel. */
  const into = async (conversation, act) => {
    if (!conversation.startsWith('19:')) {
      const chat = await chatOf(conversation)
      return `${chat} ${await connector.send(serviceOf(conversation), chat, act)}`
    }
    if (conversation.includes(THREAD)) return `${conversation} ${await connector.send(serviceOf(conversation), conversation, act)}`
    const { replyToId, ...root } = act
    const made = await connector.create(serviceOf(conversation), { isGroup: true, channelData: { channel: { id: conversation }, tenant: { id: tenant } }, activity: root })
    return `${made.id} ${made.activityId}`
  }

  /**
   * An invoke from one of the relay's buttons handed to `onChoice`, and answered as Teams wants an
   * `adaptiveCard/action` answered: a short message, what the relay acknowledged it with.
   */
  const press = async (one, onChoice, log) => {
    const answered = (value) => ({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value })
    if (!one.from?.aadObjectId) {
      log(`a press in ${one.conversation.id} from ${one.from?.name ?? 'someone'} with no Entra object id, not taken`)
      return answered('who pressed this is not known')
    }
    let said = 'this button no longer does anything'
    await onChoice({ ...choiceOf(one), acknowledge: async (text) => { if (text) said = text } })
    return answered(said)
  }

  return {
    ...TEAMS,

    restore (state, persist) {
      kept = state
      save = persist
    },

    listen: ({ onMessage, onChoice, signal, log }) => receive({
      signal,
      log,
      onActivity: async (one) => {
        if (tenantOf(one) !== tenant) return log(`dropped an activity from tenant ${tenantOf(one)}: this bot serves ${tenant}`)
        remember(one)
        if (one.type === 'invoke' && one.name === 'adaptiveCard/action' && one.value?.trigger !== 'automatic') return press(one, onChoice, log)
        if (one.type !== 'message') return
        if (one.conversation.conversationType === 'groupChat') return log(`group chat ${one.conversation.id}: group chats are not served yet`)
        if (!one.from?.aadObjectId) return log(`a message in ${one.conversation.id} from ${one.from?.name ?? 'someone'} with no Entra object id, not taken`)
        await onMessage(normalize(one))
      }
    }),

    post: (conversation, text, { answering = null, markdown = false } = {}) => into(conversation, activity(text, { markdown, answering })),

    edit: async (conversation, note, text) => {
      const where = placeOf(note)
      await connector.update(serviceOf(conversation), where.conversation, where.id, { ...activity(text), id: where.id })
    },

    remove: async (conversation, note) => {
      const where = placeOf(note)
      await connector.remove(serviceOf(conversation), where.conversation, where.id)
    },

    checkBody: (native) => {
      if (native.type !== 'AdaptiveCard' || !(Number(native.version) >= 1.4)) {
        return 'a Teams body is an Adaptive Card of version 1.4 or later, as { "type": "AdaptiveCard", "version": "1.5", "body": [ … ] }'
      }
      if (answersBack(native)) return 'a Teams body carries no Action.Submit or Action.Execute, nor a refresh — the buttons that answer are the ones spore adds'
      return null
    },

    /** The question as a card, each choice an `Action.Execute` under it. */
    ask: async (conversation, shown, choices) => {
      const card = cardOf(shown)
      card.actions = [
        ...(card.actions ?? []),
        ...choices.map(choice => ({ type: 'Action.Execute', title: choice.label, verb: 'answer', data: { [PRESSED]: choice.data }, ...(choice.style ? { style: choice.style } : {}) }))
      ]
      return { note: await into(conversation, { type: 'message', attachments: [{ contentType: CARD, content: card }] }), shown: card }
    },

    /** The question closed: replaced by `native` or `fallback`, or kept as `shown` with how it ended below. */
    settle: async (conversation, note, replacement) => {
      const card = replacement.shown ? closed(replacement.shown, replacement.outcome) : cardOf(replacement)
      const where = placeOf(note)
      await connector.update(serviceOf(conversation), where.conversation, where.id, { type: 'message', id: where.id, attachments: [{ contentType: CARD, content: card }] })
      return card
    }
  }
}
