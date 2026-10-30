/**
 * Microsoft Teams for the relay (`@rhizogrip/spore/relay`): the bot file, the activities the Bot
 * Connector delivers, and the Bot Connector calls that answer them. A person's personal chat with
 * the bot is a conversation keyed by their Entra object id; a channel's is a thread in it,
 * `<channel id>;messageid=<root>`, routed by its channel.
 */

import { SporeError } from '@rhizogrip/spore'
import { commandOf, escapeHtml, listenOf as listening } from '@rhizogrip/spore/relay'

const FIELDS = ['app', 'tenant', 'secret', 'listen', 'people', 'channels']
const PERSON = /^[0-9a-f][0-9a-f-]*$/i
const CHANNEL = /^19:[^\s;]+@thread\.[a-z0-9]+$/i
const THREAD = ';messageid='
const SERVICE_URL = 'https://smba.trafficmanager.net/teams/'
const CARD = 'application/vnd.microsoft.card.adaptive'
const DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info'
const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const PRESSED = 'spore'
const ANSWERING = new Set(['Action.Submit', 'Action.Execute'])
const FIELD = 'field:'
const SHAPE = '{ "app": "<app id>", "tenant": "<tenant id>", "secret": "${OPS_TEAMS_SECRET}", "people": { "<object id>": "<spore>" }, "channels": { "<channel id>": { "spores": ["<spore>"], "people": ["<object id>"] } } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'TEAMS_BOT_INVALID', detail })

const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Where the service listens, 127.0.0.1:3978 unless the bot file says: a proxy of the operator's gives it the HTTPS address the Azure Bot names. */
export const listenOf = (raw, path) => listening(raw.listen, { port: 3978, refused: (problem, detail) => invalid(path, problem, detail) })

/**
 * The bot's app and tenant, where it listens, and its routing: `people`, each person's personal
 * chat by their Entra object id — `"<spore>"` or `{ "spore", "details", "brief" }` — and `channels`,
 * each standard channel by its id, with its one spore and who may address it there: object ids, or
 * `*` for everyone in the channel. `details` shows the calls themselves rather than their kinds;
 * `brief` is the bot's own, for this conversation.
 */
const CONVERSATIONS = {
  people: {
    noun: 'person',
    id: PERSON,
    says: 'which is not an Entra object id',
    fix: 'a person is their object id in Entra ID; a channel\'s id begins 19: and goes under channels',
    called: 'their object id',
    fields: ['spore', 'details', 'brief']
  },
  channels: {
    noun: 'channel',
    id: CHANNEL,
    says: 'which is not a channel id',
    fix: 'a channel id is 19:…@thread.tacv2, from the channel\'s link in Teams',
    fields: ['spores', 'people', 'details', 'brief'],
    one: true,
    people: { id: PERSON, says: 'object ids', example: 'object id' }
  }
}

function check (raw, path) {
  for (const field of ['app', 'tenant']) {
    if (typeof raw[field] !== 'string' || !raw[field]) throw invalid(path, `has no ${field}`, `${field} is the Azure Bot's ${field === 'app' ? 'Microsoft App ID' : 'app tenant ID'}`)
  }
  listenOf(raw, path)
}

const HELP = 'Anything you write to me in a personal chat goes to the spore; in a channel, mention me. /status says what it is doing; /stop ends the turn it is running and sets aside what you sent that it had not read; /wrap [10m] asks it to wrap up; /flush starts the conversation over, forgetting nothing'
const EXTEND = '/extend wall 30m gives it more, as far as its spore.cmk allows'

export const TEAMS = {
  kind: 'teams',
  label: 'Teams',
  noun: 'conversation',
  fields: FIELDS,
  credentials: ['secret'],
  stateFields: ['chats', 'channels'],
  refusals: ['TEAMS_REFUSED', 'TEAMS_LISTEN_REFUSED'],
  example: SHAPE,
  conversations: CONVERSATIONS,
  check,
  routeOf: (conversation) => conversation.split(THREAD)[0],
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 40000, file: 0, fetch: 25 * 1024 * 1024, editEveryMs: 2500, typingEveryMs: 4000 },
  can: { upload: false, edit: true, remove: true, react: false, typing: false, choose: true, fields: true },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'TEAMS_REFUSED') return 'the app id, its tenant and a client secret come from the Azure Bot\'s app registration in Entra ID; the secret goes in environment beside config.json'
    if (err.type === 'TEAMS_LISTEN_REFUSED') return `another process holds that address — change listen in ${file}`
    return null
  },
  refusal: (message, botFile) => message.shared
    ? `refused ${message.where}, ${message.conversation.split(THREAD)[0]} — to allow it, add "${message.conversation.split(THREAD)[0]}": { "spores": ["<a spore>"], "people": ["${message.person.id}"] } to the channels of ${botFile}`
    : `refused ${message.person.name} (${message.person.id}) — to allow them, add "${message.person.id}": "<a spore>" to the people of ${botFile}`
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&nbsp;': ' ' }

const LEADING_AT = /^(?:\s|&nbsp;|<(?!at[\s>])[^>]*>)*(<at[^>]*>.*?<\/at>)/is

const unaddressed = (html, own) => {
  let rest = html
  for (let found = LEADING_AT.exec(rest); found && own.includes(found[1]); found = LEADING_AT.exec(rest)) rest = rest.slice(found[0].length)
  return rest
}

/**
 * Teams' markup made plain: the bot's own mentions that open the message gone, since they only
 * address it; every other mention, the bot's within the sentence included, as `@name`; tags dropped.
 */
const plain = (html, own) => unaddressed(html, own)
  .replace(/<at[^>]*>(.*?)<\/at>/gis, (_, name) => `@${name}`)
  .replace(/<br\s*\/?>|<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
  .replace(/\n{3,}/g, '\n\n')
  .trim()

/**
 * What an activity brought, as the relay lists files. In a personal chat a file comes as a
 * download link, which needs no token; a pasted image as a link Teams serves the bot alone, which
 * gets the bot's token only where it is the activity's own service. Anything else is listed with
 * why; a file or picture sent in a channel never comes at all, since Teams hands a bot the text alone.
 */
function filesOf (activity, personal) {
  const service = new URL(activity.serviceUrl).host
  return (activity.attachments ?? []).filter(attachment => attachment.contentType !== 'text/html').map((attachment, i) => {
    const { contentType, contentUrl, content, name } = attachment
    if (contentType === DOWNLOAD_INFO && personal && content?.downloadUrl) {
      return { name, mime: null, bytes: null, ref: { url: content.downloadUrl, withToken: false } }
    }
    if (contentType?.startsWith('image/') && contentUrl && URL.canParse(contentUrl)) {
      const known = IMAGE.exec(contentType)
      return {
        name: name ?? `image-${i + 1}${known ? `.${known[1] === 'jpeg' ? 'jpg' : known[1]}` : ''}`,
        mime: known ? contentType : null,
        bytes: null,
        ref: { url: contentUrl, withToken: new URL(contentUrl).host === service }
      }
    }
    return {
      name: name ?? `attachment-${i + 1}`,
      mime: null,
      bytes: null,
      ref: null,
      why: personal ? 'Teams does not hand a bot this kind of attachment' : 'a file in a channel does not reach a spore — send it to me in a personal chat'
    }
  })
}

/**
 * A message activity as the relay takes it, or null for none it takes: one in a personal chat
 * reaches the person's spore; one in a channel reaches the channel's when it mentions the bot,
 * and names no spore otherwise.
 */
export function normalize (activity) {
  const personal = activity.conversation.conversationType === 'personal'
  const own = (activity.entities ?? []).filter(entity => entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id).map(entity => entity.text)
  const text = plain(activity.text ?? '', own) || null
  const channel = activity.channelData?.channel
  return {
    id: `${activity.conversation.id}:${activity.id}`,
    conversation: personal ? activity.from.aadObjectId : activity.conversation.id,
    message: activity.id,
    person: { id: activity.from.aadObjectId, name: activity.from.name, groups: [], zone: activity.localTimezone ?? null },
    spore: null,
    where: personal ? 'a personal chat in Teams' : channel?.name ? `the Teams channel "${channel.name}"` : 'a Teams channel',
    shared: !personal,
    text,
    command: commandOf(text),
    addresses: personal || own.length ? null : [],
    files: filesOf(activity, personal)
  }
}

const tenantOf = (activity) => activity.conversation?.tenantId ?? activity.channelData?.tenant?.id

/** Whether anything in a card, however deep — an action set, a select action, a refresh — sends a press back to the bot. */
const answersBack = (value) => Array.isArray(value)
  ? value.some(answersBack)
  : record(value) && (ANSWERING.has(value.type) || Object.values(value).some(answersBack))

/** Whether anything in a card, however deep, is a field to fill in. */
const asksInput = (value) => Array.isArray(value)
  ? value.some(asksInput)
  : record(value) && ((typeof value.type === 'string' && value.type.startsWith('Input.')) || Object.values(value).some(asksInput))

/** An approval's field as the card's own input, under an id the press brings back. */
const inputOf = (field) => ({
  type: 'Input.Text',
  id: `${FIELD}${field.id}`,
  label: field.label,
  isMultiline: true,
  ...(field.value ? { value: field.value } : {}),
  ...(field.required ? { isRequired: true, errorMessage: `${field.label} is required` } : {})
})

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

/** The card as it was shown, the relay's buttons and fields gone and how it ended below. */
const closed = (card, outcome) => ({
  ...card,
  body: [...(card.body ?? []).filter(element => !element.type.startsWith('Input.')), { type: 'TextBlock', text: `**${outcome}**`, wrap: true }],
  actions: (card.actions ?? []).filter(action => !(record(action.data) && Object.hasOwn(action.data, PRESSED)))
})

/**
 * A press on one of the relay's buttons, as the relay takes it, from an `adaptiveCard/action`
 * invoke: what Teams merged into the action's data besides the relay's own is what the person
 * filled in, each field under its own id.
 */
export function choiceOf (activity) {
  const personal = activity.conversation.conversationType === 'personal'
  const { [PRESSED]: data = null, ...filled } = record(activity.value?.action?.data) ? activity.value.action.data : {}
  const inputs = Object.fromEntries(Object.entries(filled).map(([id, value]) => [id.startsWith(FIELD) ? id.slice(FIELD.length) : id, value]))
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

  /**
   * An answer in Teams' extended Markdown, which renders the tables and fenced code a model writes;
   * what the relay says itself in Teams' HTML subset, escaped, each line on its own — its plain
   * format runs lines together.
   */
  const activity = (text, { markdown = false, answering = null } = {}) => ({
    type: 'message',
    text: markdown ? text : escapeHtml(text).replace(/\n/g, '<br>'),
    textFormat: markdown ? 'extendedmarkdown' : 'xml',
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

    listen: ({ onMessage, onChoice, trace, signal, log }) => receive({
      signal,
      log,
      onActivity: async (one) => {
        trace(`activity ${one.id}`, one)
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

    fetch: (ref, { most }) => connector.download(ref.url, { most, withToken: ref.withToken }),

    checkBody: (native) => {
      if (native.type !== 'AdaptiveCard' || !(Number(native.version) >= 1.4)) {
        return 'a Teams body is an Adaptive Card of version 1.4 or later, as { "type": "AdaptiveCard", "version": "1.5", "body": [ … ] }'
      }
      if (answersBack(native)) return 'a Teams body carries no Action.Submit or Action.Execute, nor a refresh — the buttons that answer are the ones spore adds'
      if (asksInput(native)) return 'a Teams body carries no Input — what a person fills in is the approval\'s fields, which spore adds'
      return null
    },

    /** The question as a card, its fields under its body and each choice an `Action.Execute` under them. */
    ask: async (conversation, shown, choices, { fields }) => {
      const card = cardOf(shown)
      card.body = [...(card.body ?? []), ...fields.map(inputOf)]
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
