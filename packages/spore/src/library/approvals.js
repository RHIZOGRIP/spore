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
import { SporeError } from '../observability/errors.js'
import { recordApproval } from '../core/spore-dir.js'

export const APPROVAL_LIMITS = Object.freeze({ options: 5, label: 40, facts: 20, approvers: 50, body: 100_000, fields: 5, input: 2000 })

const FIELDS = ['to', 'by', 'options', 'body', 'within', 'calendar', 'hook', 'fields']
const OPTION_FIELDS = ['id', 'label', 'style']
const FIELD_FIELDS = ['id', 'label', 'value', 'required']
const DEFAULT_FIELDS = ['text', 'facts']
const CALENDAR_FIELDS = ['tz', 'days', 'holidays']
const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/
const KIND = /^[a-z][a-z0-9-]*$/
const PERSON = /^\S+$/
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const STYLES = ['positive', 'destructive']
const WITHIN = '24h'
const HOOK_TIMEOUT_MS = 10_000
const HOOK_RETRIES_MS = [2000, 5000, 10_000, 20_000, 30_000]
const SHAPE = '{ "to": "telegram:main/42", "by": ["42"], "options": [{ "id": "apply", "label": "Apply" }, { "id": "cancel", "label": "Cancel" }], "body": { "default": { "text": "Apply the change?" } } }'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const strays = (record, takes) => Object.keys(record).filter(key => !takes.includes(key))

const invalid = (problem, detail) => new SporeError(`the approval ${problem}`, { type: 'APPROVAL_INVALID', detail })

function checkOptions (options) {
  const detail = `options are 1 to ${APPROVAL_LIMITS.options} choices, each { "id": "apply", "label": "Apply", "style": "positive" } — an id of letters, digits, - and _, a label of at most ${APPROVAL_LIMITS.label} characters on one line, and a style of positive or destructive or none`
  if (!Array.isArray(options) || !options.length || options.length > APPROVAL_LIMITS.options) throw invalid('offers no choices it can show', detail)
  for (const option of options) {
    const fits = isRecord(option) && !strays(option, OPTION_FIELDS).length && OPTION_ID.test(option.id ?? '') &&
      isText(option.label) && option.label.length <= APPROVAL_LIMITS.label && !option.label.includes('\n') &&
      (option.style === undefined || STYLES.includes(option.style))
    if (!fits) throw invalid(`has a choice it cannot show — ${JSON.stringify(option)}`, detail)
  }
  if (new Set(options.map(option => option.id)).size !== options.length) throw invalid('offers two choices under one id', detail)
}

function checkFields (fields) {
  const detail = `fields are 1 to ${APPROVAL_LIMITS.fields} things to fill in, each { "id": "reason", "label": "Why?", "value": "<what it starts with>", "required": true } — an id of letters, digits, - and _, a label of at most ${APPROVAL_LIMITS.label} characters on one line, value and required optional`
  if (!Array.isArray(fields) || !fields.length || fields.length > APPROVAL_LIMITS.fields) throw invalid('has fields it cannot show', detail)
  for (const field of fields) {
    const fits = isRecord(field) && !strays(field, FIELD_FIELDS).length && OPTION_ID.test(field.id ?? '') &&
      isText(field.label) && field.label.length <= APPROVAL_LIMITS.label && !field.label.includes('\n') &&
      (field.value === undefined || (typeof field.value === 'string' && field.value.length <= APPROVAL_LIMITS.input)) &&
      (field.required === undefined || typeof field.required === 'boolean')
    if (!fits) throw invalid(`has a field it cannot show — ${JSON.stringify(field)}`, detail)
  }
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw invalid('has two fields under one id', detail)
}

/**
 * Why what a press filled in does not fit the approval's fields, or null: only fields it declares,
 * each text no longer than the limit, every required one filled in.
 */
export function inputsProblem (fields, inputs) {
  const declared = fields ?? []
  const given = inputs ?? {}
  for (const [id, value] of Object.entries(given)) {
    const field = declared.find(one => one.id === id)
    if (!field) return `"${id}" is not one of its fields`
    if (typeof value !== 'string' || value.length > APPROVAL_LIMITS.input) return `"${field.label}" takes text of at most ${APPROVAL_LIMITS.input} characters`
  }
  const missing = declared.filter(field => field.required && !given[field.id]?.trim())
  return missing.length ? `fill in ${missing.map(field => `"${field.label}"`).join(' and ')} first` : null
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

/** The variables the approval hooks of `config` keep their secrets in: none of them reaches a turn. */
export const approvalHookVariables = (config) => Object.values(config.approvals ?? {}).map(hook => VARIABLE.exec(hook.secret)[1])

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
  const variable = VARIABLE.exec(hook.secret)[1]
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
