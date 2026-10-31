/**
 * Approvals: a choice the host asks named people to make in a conversation a spore is reached in,
 * counted only as a press of a button the relay posted, by one of them as the platform vouches for
 * them — so nothing a spore can do makes one, answers one or changes one. The flow is spore's and
 * the same on every platform; what is shown is the host's, a body for each platform or the default
 * one. Contract: ARCHITECTURE.md, "Approvals".
 */

import { createHmac, randomBytes } from 'node:crypto'

import { CONFIG_FILE, readConfig } from './config.js'
import { native } from '../native.js'
import { variableOf } from '../core/variables.js'
import { SporeError } from '../observability/errors.js'
import { approvalOf, recordApproval } from '../core/spore-dir.js'

export const APPROVAL_LIMITS = Object.freeze({ options: 5, label: 40, facts: 20, approvers: 50, body: 100_000, fields: 5, input: 2000, lines: 10, choices: 100 })

const FIELDS = ['to', 'by', 'options', 'body', 'within', 'calendar', 'hook', 'fields']
const OPTION_FIELDS = ['id', 'label', 'style', 'skip']
const KIND_FIELDS = { text: ['id', 'kind', 'label', 'value', 'required', 'lines'], choice: ['id', 'kind', 'label', 'choices', 'least', 'most', 'value', 'look'] }
const LOOKS = ['list', 'menu']
const DEFAULT_FIELDS = ['text', 'facts']
const CALENDAR_FIELDS = ['tz', 'days', 'holidays']
const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/
const KIND = /^[a-z][a-z0-9-]*$/
const PERSON = /^\S+$/
const STYLES = ['positive', 'destructive']
const WITHIN = '24h'
const HOOK_TIMEOUT_MS = 10_000
const HOOK_RETRIES_MS = [2000, 5000, 10_000, 20_000, 30_000]
const SHAPE = '{ "to": "telegram:main/42", "by": ["42"], "options": [{ "id": "apply", "label": "Apply" }, { "id": "cancel", "label": "Cancel" }], "body": { "default": { "text": "Apply the change?" } } }'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isLabel = (value) => isText(value) && value.length <= APPROVAL_LIMITS.label && !value.includes('\n')
const isCount = (value, least, most) => Number.isInteger(value) && value >= least && value <= most
const strays = (record, takes) => Object.keys(record).filter(key => !takes.includes(key))

const invalid = (problem, detail) => new SporeError(`the approval ${problem}`, { type: 'APPROVAL_INVALID', detail })

function checkOptions (options) {
  const detail = `options are 1 to ${APPROVAL_LIMITS.options} choices, each { "id": "apply", "label": "Apply", "style": "positive" } — an id of letters, digits, - and _, a label of at most ${APPROVAL_LIMITS.label} characters on one line, a style of positive or destructive or none, and "skip": true on one taken without the fields, as a Cancel`
  if (!Array.isArray(options) || !options.length || options.length > APPROVAL_LIMITS.options) throw invalid('offers no choices it can show', detail)
  for (const option of options) {
    const fits = isRecord(option) && !strays(option, OPTION_FIELDS).length && OPTION_ID.test(option.id ?? '') && isLabel(option.label) &&
      (option.style === undefined || STYLES.includes(option.style)) && (option.skip === undefined || typeof option.skip === 'boolean')
    if (!fits) throw invalid(`has a choice it cannot show — ${JSON.stringify(option)}`, detail)
  }
  if (new Set(options.map(option => option.id)).size !== options.length) throw invalid('offers two choices under one id', detail)
}

/** The kind of a field: `text` unless it says `choice`. */
export const kindOf = (field) => field.kind ?? 'text'

/** How many of a choice field's choices a press may pick: `least` 0 and `most` 1 when unsaid. */
export const pickOf = (field) => ({ least: field.least ?? 0, most: field.most ?? 1 })

function fitsText (field) {
  return (field.value === undefined || (typeof field.value === 'string' && field.value.length <= APPROVAL_LIMITS.input)) &&
    (field.required === undefined || typeof field.required === 'boolean') &&
    (field.lines === undefined || isCount(field.lines, 1, APPROVAL_LIMITS.lines))
}

function fitsChoice (field) {
  const { choices } = field
  if (!Array.isArray(choices) || !choices.length || choices.length > APPROVAL_LIMITS.choices) return false
  if (!choices.every(choice => isRecord(choice) && !strays(choice, ['id', 'label']).length && OPTION_ID.test(choice.id ?? '') && isLabel(choice.label))) return false
  const ids = choices.map(choice => choice.id)
  if (new Set(ids).size !== ids.length) return false
  if (field.least !== undefined && !isCount(field.least, 0, choices.length)) return false
  if (field.most !== undefined && !isCount(field.most, 1, choices.length)) return false
  const { least, most } = pickOf(field)
  if (least > most) return false
  return (field.value === undefined || (Array.isArray(field.value) && field.value.length <= most && new Set(field.value).size === field.value.length && field.value.every(id => ids.includes(id)))) &&
    (field.look === undefined || LOOKS.includes(field.look))
}

function checkFields (fields) {
  const detail = `fields are 1 to ${APPROVAL_LIMITS.fields} things to fill in — a text, { "id": "reason", "label": "Why?", "value": "<what it starts with>", "required": true, "lines": 3 }, or a choice, { "id": "env", "kind": "choice", "label": "Where", "choices": [{ "id": "prod", "label": "Production" }, …], "least": 0, "most": 1, "value": ["prod"], "look": "list" } — ids of letters, digits, - and _, labels of at most ${APPROVAL_LIMITS.label} characters on one line, 1 to ${APPROVAL_LIMITS.choices} choices, least and most how many may be picked (0 and 1 when unsaid), look list or menu; all but id, label and choices optional`
  if (!Array.isArray(fields) || !fields.length || fields.length > APPROVAL_LIMITS.fields) throw invalid('has fields it cannot show', detail)
  for (const field of fields) {
    const takes = isRecord(field) ? KIND_FIELDS[kindOf(field)] : undefined
    const fits = takes !== undefined && !strays(field, takes).length && OPTION_ID.test(field.id ?? '') && isLabel(field.label) &&
      (kindOf(field) === 'choice' ? fitsChoice(field) : fitsText(field))
    if (!fits) throw invalid(`has a field it cannot show — ${JSON.stringify(field)}`, detail)
  }
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw invalid('has two fields under one id', detail)
}

/**
 * Why what a press filled in does not fit the approval's fields, or null: only fields it declares,
 * a text no longer than the limit, a choice some of its own choices, no more than it may pick;
 * every required text filled in and every choice picked as far as its least.
 */
export function inputsProblem (fields, inputs) {
  const declared = fields ?? []
  const given = inputs ?? {}
  for (const [id, value] of Object.entries(given)) {
    const field = declared.find(one => one.id === id)
    if (!field) return `"${id}" is not one of its fields`
    if (kindOf(field) === 'choice') {
      const ids = field.choices.map(choice => choice.id)
      if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(one => ids.includes(one))) return `"${field.label}" takes some of its own choices`
      const { most } = pickOf(field)
      if (value.length > most) return `pick at most ${most} in "${field.label}"`
    } else if (typeof value !== 'string' || value.length > APPROVAL_LIMITS.input) {
      return `"${field.label}" takes text of at most ${APPROVAL_LIMITS.input} characters`
    }
  }
  const missing = declared.filter(field => kindOf(field) === 'text' && field.required && !given[field.id]?.trim())
  if (missing.length) return `fill in ${missing.map(field => `"${field.label}"`).join(' and ')} first`
  const short = declared.find(field => kindOf(field) === 'choice' && (given[field.id]?.length ?? 0) < pickOf(field).least)
  if (short) return pickOf(short).least === 1 ? `pick one in "${short.label}" first` : `pick at least ${pickOf(short).least} in "${short.label}" first`
  return null
}

/**
 * Why `person` may not press `choice` on `approval` now, or null: it is posted and before its
 * deadline, they are among its approvers, and the choice is one of its options.
 */
export function pressProblem (approval, { choice, person }) {
  if (approval.state !== 'posted' || Date.parse(approval.until) <= Date.now()) {
    return approval.state === 'answered' ? 'this was answered already' : 'this question is closed'
  }
  if (!approval.approvers.includes(person.id)) return 'this is not yours to answer'
  if (!approval.options.some(option => option.id === choice)) return 'that is not one of its choices'
  return null
}

/**
 * A press on an approval, taken only while it is posted and before its deadline, from someone it
 * names, on one of its options, with what was filled in fitting its fields — and only the first:
 * `{ taken: true }`, or `{ taken: false, reason }` with what the person pressing is told. An
 * option that says `skip` is taken without the fields, whatever was filled in. That the platform
 * vouched for `person` is the caller's.
 */
export function answerApproval (ws, id, { choice, inputs, person }) {
  const refused = (reason) => ({ taken: false, reason })
  const approval = approvalOf(ws, id)
  if (!approval) return refused('this question is not open here')
  const problem = pressProblem(approval, { choice, person })
  if (problem) return refused(problem)
  const skips = approval.options.find(option => option.id === choice).skip === true
  const filled = skips ? null : inputs
  const unfit = skips ? null : inputsProblem(approval.fields, filled)
  if (unfit) return refused(unfit)
  const taken = native.answerApproval(ws, id, choice, filled === null ? undefined : JSON.stringify(filled), person.id, person.name)
  return taken ? { taken: true } : refused('this was answered already')
}

/** A body checked as far as the core reads it: keyed by platform kind or `default`, which the core renders. */
function checkBody (body) {
  const detail = 'body is keyed by platform, as { "teams": <an Adaptive Card>, "telegram": { "html": "…" }, "default": { "text": "…", "facts": [["label", "value"]] } } — default is shown where no platform\'s own is given'
  if (!isRecord(body) || !Object.keys(body).length) throw invalid('shows nothing', detail)
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'default' && !KIND.test(key)) throw invalid(`has a body for "${key}", which is no platform`, detail)
    if (!isRecord(value)) throw invalid(`has a body for ${key} that is not an object`, detail)
  }
  if (JSON.stringify(body).length > APPROVAL_LIMITS.body) throw invalid(`has a body over ${APPROVAL_LIMITS.body} characters`, 'what a platform shows of one message is smaller than that')
  const shown = body.default
  if (shown === undefined) return
  const facts = shown.facts
  const fits = !strays(shown, DEFAULT_FIELDS).length && (shown.text !== undefined || facts !== undefined) &&
    (shown.text === undefined || isText(shown.text)) &&
    (facts === undefined || (Array.isArray(facts) && facts.length <= APPROVAL_LIMITS.facts &&
      facts.every(fact => Array.isArray(fact) && fact.length === 2 && isText(fact[0]) && typeof fact[1] === 'string')))
  if (!fits) throw invalid('has a default body it cannot show', `default is { "text": "<markdown>", "facts": [["<label>", "<value>"], …] }, either or both, at most ${APPROVAL_LIMITS.facts} facts`)
}

function checkCalendar (calendar) {
  const fits = isRecord(calendar) && !strays(calendar, CALENDAR_FIELDS).length && typeof calendar.tz === 'string' &&
    ['days', 'holidays'].every(field => calendar[field] === undefined || (Array.isArray(calendar[field]) && calendar[field].every(item => typeof item === 'string')))
  if (!fits) throw invalid('has a calendar it cannot read', 'calendar is { "tz": "Europe/Paris", "days": ["mon", "tue", "wed", "thu", "fri"], "holidays": ["2026-12-25"] }, tz required')
}

function checked (request, config) {
  if (!isRecord(request)) throw invalid('is not a JSON object', `an approval is ${SHAPE}`)
  const extra = strays(request, FIELDS)
  if (extra.length) throw invalid(`has ${extra.join(', ')}, which an approval does not take`, `it takes ${FIELDS.join(', ')}`)
  const { to, by, options, body, within, calendar, hook, fields } = request
  const problem = typeof to === 'string' ? native.replyToProblem(to) : `got ${JSON.stringify(to)}`
  if (problem || to === 'terminal') throw invalid('is asked nowhere it can be answered', `to is the conversation it is asked in, as telegram:main/42 — ${problem ?? 'a terminal has no button to press'}`)
  if (!Array.isArray(by) || !by.length || by.length > APPROVAL_LIMITS.approvers || !by.every(id => typeof id === 'string' && PERSON.test(id)) || new Set(by).size !== by.length) {
    throw invalid('names no one who may answer it', `by lists who may, by the id their bot file knows them by, as ["42"] — 1 to ${APPROVAL_LIMITS.approvers} people, each once`)
  }
  checkOptions(options)
  checkBody(body)
  if (within !== undefined && typeof within !== 'string') throw invalid('has a within that is not text', 'within is a duration, as 2h, or working days, as 2wd')
  if (calendar !== undefined) checkCalendar(calendar)
  if (fields !== undefined) checkFields(fields)
  if (hook !== undefined && !(typeof hook === 'string' && isRecord(config.approvals) && Object.hasOwn(config.approvals, hook))) {
    throw invalid(`calls a hook ${config.file} does not name — ${JSON.stringify(hook)}`, 'approvals in config.json names each hook, as "approvals": { "kpi": { "url": "https://…", "secret": "${KPI_HOOK_SECRET}" } }') // eslint-disable-line no-template-curly-in-string
  }
  return request
}

/**
 * An approval asked in the spore at `ws`: written down for the relay of the place it names to
 * post, its deadline computed now. Answers its id and when it stops waiting.
 *
 * @returns {{ approval: string, until: string }}
 */
export function askApproval (ws, request, { configFile = CONFIG_FILE, now = Date.now() } = {}) {
  const { to, by, options, body, within = WITHIN, calendar, hook, fields } = checked(request, readConfig(configFile))
  const deadline = JSON.parse(native.approvalDeadline(now, within, calendar?.tz, calendar?.days, calendar?.holidays))
  if (deadline.error) throw invalid(deadline.error, 'within is a duration, as 2h, or working days with a calendar, as "within": "2wd", "calendar": { "tz": "Europe/Paris" }')
  const id = randomBytes(6).toString('hex')
  const until = new Date(deadline.until).toISOString()
  recordApproval(ws, {
    id,
    at: new Date(now).toISOString(),
    place: to,
    approvers: by,
    options,
    body,
    within,
    ...(calendar ? { calendar } : {}),
    until,
    ...(hook ? { hook } : {}),
    ...(fields ? { fields } : {})
  })
  return { approval: id, until }
}

const hookFailed = (name, why) => new SporeError(`the approval hook "${name}" failed`, { type: 'APPROVAL_HOOK_FAILED', detail: why })

async function answerOf (name, response) {
  const text = await response.text()
  if (!text.trim()) return {}
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    throw hookFailed(name, `it answered ${response.status} with what is not JSON`)
  }
  const fits = isRecord(answer) && !strays(answer, ['body', 'tell']).length &&
    (answer.body === undefined || isRecord(answer.body)) && (answer.tell === undefined || typeof answer.tell === 'string')
  if (!fits) throw hookFailed(name, 'it answered what spore cannot read — { "body": { … }, "tell": "…" }, either or both')
  if (answer.body !== undefined) {
    try {
      checkBody(answer.body)
    } catch (err) {
      throw hookFailed(name, `it answered a body spore cannot show — ${err.message}`)
    }
  }
  return answer
}

/**
 * Tells the host's hook `name` how an approval ended, signed: `x-spore-signature` is
 * `sha256=<hex>`, the HMAC-SHA256 under its secret of `<x-spore-timestamp>.<body>`. A network
 * failure or a 5xx is tried again for about a minute; anything else, or running out of tries, is
 * `APPROVAL_HOOK_FAILED`. Answers what the hook said: `{ body?, tell? }`.
 */
export async function callApprovalHook (name, payload, { configFile = CONFIG_FILE, env, sleep, signal, fetchImpl = fetch, retriesMs = HOOK_RETRIES_MS }) {
  const hook = readConfig(configFile).approvals?.[name]
  if (!hook) throw hookFailed(name, `${configFile} no longer names it`)
  const variable = variableOf(hook.secret)
  const secret = env[variable]
  if (!secret) throw hookFailed(name, `its secret is $${variable}, which is not set — it goes in environment beside config.json`)
  const body = JSON.stringify(payload)
  for (let tried = 0; ; tried++) {
    const at = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')
    let failure
    try {
      const response = await fetchImpl(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-spore-timestamp': at, 'x-spore-signature': `sha256=${signature}` },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)])
      })
      if (response.ok) return await answerOf(name, response)
      if (response.status < 500) throw hookFailed(name, `it answered ${response.status}`)
      failure = `it answered ${response.status}`
    } catch (err) {
      if (err.type === 'APPROVAL_HOOK_FAILED' || signal.aborted) throw err
      failure = `it could not be reached — ${err.message}`
    }
    if (tried >= retriesMs.length) throw hookFailed(name, `${failure}, ${tried + 1} times`)
    await sleep(retriesMs[tried])
    if (signal.aborted) throw hookFailed(name, 'the service stopped before it answered')
  }
}
