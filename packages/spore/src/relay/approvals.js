/**
 * The relay's side of approvals (ARCHITECTURE §Approvals): each approval asked in a followed spore
 * whose place is this bot's posted with buttons the relay alone makes; a press taken only on its own
 * approval's id and from someone that approval names; and each one that ended — answered, expired
 * or refused — seen through: the host's hook told, the question closed, the spore told. What is
 * left to do is read from the spore's database on every pass, so a restart carries on where the
 * last run stopped.
 */

import { answerApproval, approvalOf, approvalsIn, callApprovalHook, errorText, expireApproval, postApproval, refuseApproval, send, settleApproval, SporeError } from '../index.js'
import { kindOf, pickOf, pressProblem } from '../library/approvals.js'

const PRESS = /^ap:([0-9a-f]{12}):([A-Za-z0-9_-]{1,32})$/
const TELL_AGAIN_MS = 30_000
const LOOKS = ['list', 'menu']

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isMost = (value) => value === undefined || (Number.isInteger(value) && value >= 0)

/**
 * Why an adapter's `can.fields` is not one: `{}` where it shows none, `text: true` where it shows
 * a text to fill in, and `choice: { several, list, menu }` where it shows choices — whether
 * several may be picked, and the most choices it shows as a list and as a menu, at least one.
 */
function fieldsProblem (fields) {
  if (!isRecord(fields) || !Object.keys(fields).every(key => key === 'text' || key === 'choice')) return 'can.fields is { "text": true, "choice": { "several": true, "list": 10, "menu": 25 } }, either or neither'
  if (fields.text !== undefined && fields.text !== true) return 'can.fields.text is true, or left out'
  const { choice } = fields
  if (choice === undefined) return null
  const fits = isRecord(choice) && Object.keys(choice).every(key => ['several', ...LOOKS].includes(key)) && typeof choice.several === 'boolean' &&
    isMost(choice.list) && isMost(choice.menu) && (choice.list ?? 0) + (choice.menu ?? 0) > 0
  return fits ? null : 'can.fields.choice is { "several": true or false, "list": <most choices as a list>, "menu": <most as a menu> }, a list or a menu at least'
}

export function createApprovals ({ adapter, prefix, botFile, configFile, keyOf, where, followed, delivery, environment, env, log, sleep, signal }) {
  const { kind } = adapter
  if (adapter.can.choose && typeof adapter.can.fields === 'boolean') {
    throw new SporeError(`the ${adapter.label} connector does not say which fields it shows`, { type: `${kind.toUpperCase()}_CONNECTOR_OUTDATED`, detail: `it was written before spore 1.49.0, which asks every connector carrying approvals which kinds of field it shows — upgrade the ${adapter.label} plugin` })
  }
  const unfit = adapter.can.choose ? fieldsProblem(adapter.can.fields) : null
  if (unfit) throw new SporeError(`the ${adapter.label} adapter carries approvals without saying which fields it shows`, { type: 'ADAPTER_INVALID', detail: unfit })
  const busy = new Set()
  const untold = new Map()

  const conversationOf = (approval) => approval.place.slice(prefix.length)
  const labelOf = (approval) => approval.options.find(option => option.id === approval.choice).label
  const logged = (approval, name, line) => log(`approval ${approval.id} of ${name}: ${line}`)

  const shownOf = (body) => {
    if (body[kind] !== undefined) return { native: body[kind], fallback: null }
    if (body.default !== undefined) return { native: null, fallback: body.default }
    return null
  }

  /** Once at a time per approval, in the background: whatever else this pass or a press does goes on meanwhile. */
  const run = (approval, name, work) => {
    if (busy.has(approval.id)) return
    busy.add(approval.id)
    work()
      .catch(err => logged(approval, name, errorText(err)))
      .finally(() => busy.delete(approval.id))
  }

  const payloadOf = (name, approval) => ({
    approval: approval.id,
    spore: name,
    place: approval.place,
    outcome: approval.state,
    asked: approval.at,
    until: approval.until,
    ...(approval.state === 'answered'
      ? {
          choice: { id: approval.choice, label: labelOf(approval) },
          by: { id: approval.answererId, name: approval.answererName, platform: kind },
          answeredAt: approval.answeredAt,
          ...(approval.inputs ? { inputs: approval.inputs } : {})
        }
      : {}),
    ...(approval.shown ? { shown: approval.shown } : {}),
    ...(approval.state === 'refused' ? { reason: approval.reason } : {})
  })

  const closing = (approval, outcome, reason) => {
    if (approval.state === 'expired') return 'expired — nobody answered'
    const chose = `${labelOf(approval)} — ${approval.answererName}`
    return outcome === 'failed' ? `${chose} · not confirmed: ${reason}` : chose
  }

  /** The spore told how its approval ended, once, in the conversation it was asked in. */
  const tell = (name, ws, approval) => {
    const conversation = conversationOf(approval)
    const answered = approval.state === 'answered'
    const confirmed = { confirmed: ', and the host confirmed it', failed: `, and the host did not confirm it — ${approval.reason}` }
    const line = answered
      ? `${approval.answererName} chose "${labelOf(approval)}"${confirmed[approval.outcome] ?? ''}.`
      : `Nobody answered it by ${approval.until}.`
    try {
      send(ws, approval.tell ? `${line}\n\nThe host adds:\n${approval.tell}` : line, {
        requestId: `approval:${approval.id}`,
        replyTo: approval.place,
        approval: approval.id,
        ...(answered ? { from: { name: approval.answererName, id: `${kind}:${approval.answererId}`, where: `${where(conversation)} on ${adapter.label}` } } : {}),
        env,
        configFile
      })
      untold.delete(approval.id)
    } catch (err) {
      untold.set(approval.id, Date.now() + TELL_AGAIN_MS)
      logged(approval, name, `the spore was not told how it ended yet — ${[err.type, errorText(err)].filter(Boolean).join(' ')}`)
    }
  }

  /**
   * An approval that ended seen through: the hook told and its answer taken, the question closed
   * — replaced by the body the hook answered, or kept with its buttons gone and how it ended
   * below — written down, and the spore told. A service stopping on the way leaves it for the next
   * start, which tells the hook again.
   */
  const seeThrough = async (name, ws, approval) => {
    let answer = {}
    let outcome = null
    let reason = null
    if (approval.hook) {
      try {
        answer = await callApprovalHook(approval.hook, payloadOf(name, approval), { configFile, env: environment(), sleep, signal })
        if (approval.state === 'answered') outcome = 'confirmed'
      } catch (err) {
        if (signal.aborted) return
        logged(approval, name, errorText(err))
        if (approval.state === 'answered') {
          outcome = 'failed'
          reason = errorText(err)
        }
      }
    }
    let replaced = null
    if (approval.state !== 'refused') {
      const conversation = conversationOf(approval)
      const replacement = (answer.body && shownOf(answer.body)) ?? { shown: approval.shown, outcome: closing(approval, outcome, reason) }
      const ended = {
        approval: approval.id,
        state: approval.state,
        choice: approval.choice,
        by: approval.state === 'answered' ? { id: approval.answererId, name: approval.answererName } : null,
        outcome,
        reason
      }
      try {
        replaced = await delivery.to(conversation, attempt => attempt(() => adapter.settle(conversation, approval.note, replacement, { ended })))
      } catch (err) {
        if (signal.aborted) return
        logged(approval, name, `the question in ${where(conversation)} was not closed — ${errorText(err)}`)
      }
    }
    if (!settleApproval(ws, approval.id, { outcome, reason, replaced, tell: answer.tell ?? null })) return
    if (approval.state !== 'refused') tell(name, ws, approvalOf(ws, approval.id))
  }

  /**
   * What of an approval's fields this platform shows, each choice with its `least`, `most` and
   * `value` filled in and the look it is shown as — its own, or a list where the list holds its
   * choices and a menu otherwise — or why it cannot be
   * posted here. A text it cannot show is left out unless it is required; a choice it cannot show
   * refuses the approval, as leaving it out would change what the answer means.
   */
  const drawnOf = (approval) => {
    const drawn = []
    const needed = []
    for (const field of approval.fields ?? []) {
      if (kindOf(field) === 'text') {
        if (adapter.can.fields.text) drawn.push(field)
        else if (field.required) needed.push(field)
        continue
      }
      const can = adapter.can.fields.choice
      const count = field.choices.length
      if (!can) return { problem: `a ${adapter.label} bot cannot show choices to pick from, and it needs "${field.label}"` }
      if (pickOf(field).most > 1 && !can.several) return { problem: `a ${adapter.label} bot lets one choice be picked at most, and "${field.label}" lets ${pickOf(field).most} be` }
      const look = (field.look ? [field.look] : LOOKS).find(one => (can[one] ?? 0) >= count)
      if (!look) return { problem: `a ${adapter.label} bot cannot show the ${count} choices of "${field.label}"${field.look ? ` as a ${field.look}` : ''}` }
      drawn.push({ ...field, ...pickOf(field), value: field.value ?? [], look })
    }
    if (needed.length) return { problem: `a ${adapter.label} bot cannot show fields to fill in, and it needs ${needed.map(field => `"${field.label}"`).join(' and ')}` }
    return { fields: drawn }
  }

  const refuse = (name, ws, approval, reason) => {
    logged(approval, name, `refused — ${reason}`)
    if (refuseApproval(ws, approval.id, reason)) return seeThrough(name, ws, approvalOf(ws, approval.id))
  }

  const post = async (name, ws, conversations, approval) => {
    const conversation = conversationOf(approval)
    if (!conversations.has(keyOf(conversation))) return refuse(name, ws, approval, `${where(conversation)} does not reach this spore through ${botFile}`)
    if (!adapter.can.choose) return refuse(name, ws, approval, `a ${adapter.label} bot cannot ask for an approval yet`)
    if (Date.parse(approval.until) <= Date.now()) return refuse(name, ws, approval, 'its deadline passed before it could be posted')
    const shown = shownOf(approval.body)
    if (!shown) return refuse(name, ws, approval, `it has no body for ${adapter.label} and no default`)
    const problem = shown.native === null ? null : adapter.checkBody(shown.native)
    if (problem) return refuse(name, ws, approval, problem)
    const { fields, problem: unshowable } = drawnOf(approval)
    if (unshowable) return refuse(name, ws, approval, unshowable)
    const choices = approval.options.map(option => ({ ...option, data: `ap:${approval.id}:${option.id}` }))
    let posted
    try {
      posted = await delivery.to(conversation, attempt => attempt(() => adapter.ask(conversation, shown, choices, { as: name, fields, approval: { id: approval.id, by: approval.approvers, until: approval.until } })))
    } catch (err) {
      if (err.retryable || signal.aborted) return logged(approval, name, `not posted yet — ${errorText(err)}`)
      return refuse(name, ws, approval, `${adapter.label} refused it — ${errorText(err)}`)
    }
    postApproval(ws, approval.id, posted)
  }

  /** One look at every followed spore's approvals of this bot: what each still needs, started. */
  const pass = () => {
    for (const [ws, { name, conversations }] of followed()) {
      let open
      try {
        open = approvalsIn(ws, { open: true })
      } catch (err) {
        log(`${ws}: its approvals could not be read — ${errorText(err)}`)
        continue
      }
      for (const approval of open) {
        if (!approval.place.startsWith(prefix)) continue
        if (approval.state === 'asked') run(approval, name, () => post(name, ws, conversations, approval))
        else if (approval.settledAt !== null) {
          if ((untold.get(approval.id) ?? 0) <= Date.now()) run(approval, name, async () => tell(name, ws, approval))
        } else if (approval.state !== 'posted') {
          run(approval, name, () => seeThrough(name, ws, approval))
        } else if (Date.parse(approval.until) <= Date.now()) {
          run(approval, name, async () => {
            if (expireApproval(ws, approval.id)) await seeThrough(name, ws, approvalOf(ws, approval.id))
          })
        }
      }
    }
  }

  /** The approval a press in `conversation` is on, by the id its button carries: `{ ws, name, approval, choice }`, or null. */
  const pressedOn = (conversation, data) => {
    const pressed = PRESS.exec(data ?? '')
    if (!pressed) return null
    const [, id, choice] = pressed
    let found = null
    for (const [ws, { name, conversations }] of followed()) {
      if (!conversations.has(keyOf(conversation))) continue
      const approval = approvalOf(ws, id)
      if (approval?.place.startsWith(prefix) && keyOf(conversationOf(approval)) === keyOf(conversation)) found = { ws, name, approval, choice }
    }
    return found
  }

  /**
   * What a press is to fill in before it answers, for a platform that shows the fields only once
   * a button is pressed: `{ option, fields }`, the option pressed and the approval's fields as
   * posted — none for an option that skips them — where the press may go on, or null where it may
   * not, which the press itself, handed to `choose`, is then told. It takes nothing and says
   * nothing: the answer, or its refusal, is the press `choose` hears after.
   */
  const form = ({ conversation, data, person }) => {
    const found = pressedOn(conversation, data)
    if (!found || busy.has(found.approval.id) || pressProblem(found.approval, { choice: found.choice, person })) return null
    const option = found.approval.options.find(one => one.id === found.choice)
    if (option.skip) return { option, fields: [] }
    const drawn = drawnOf(found.approval)
    return drawn.problem ? null : { option, fields: drawn.fields }
  }

  /**
   * A press, as the adapter heard it: `data` from one of the relay's buttons, `person` as the
   * platform vouches for them, `inputs` what they filled in of the approval's fields. Taken only
   * on its own approval, open, in the conversation it was asked in, by someone it names, with its
   * fields filled in as they must be; acknowledged to the platform at once, and seen through after.
   */
  const choose = async ({ conversation, data, inputs = null, person, acknowledge }) => {
    const found = pressedOn(conversation, data)
    if (!found) {
      const pressed = PRESS.exec(data ?? '')
      log(pressed
        ? `${where(conversation)}: a press on approval ${pressed[1]}, which no spore it reaches has asked there`
        : `${where(conversation)}: a press on a button this relay did not make — ${JSON.stringify(data)}`)
      return acknowledge(pressed ? 'this question is not open here' : null)
    }
    const { ws, name, approval, choice } = found
    const { id } = approval
    if (busy.has(id)) return acknowledge('this was answered already')
    const answer = answerApproval(ws, id, { choice, inputs, person })
    if (!answer.taken) {
      logged(approval, name, `refused a press by ${person.name} (${person.id}) on "${choice}" — ${answer.reason}`)
      return acknowledge(answer.reason)
    }
    busy.add(id)
    const option = approval.options.find(one => one.id === choice)
    try {
      await acknowledge(`${option.label} — recorded`, { taken: true })
    } catch (err) {
      logged(approval, name, `the press was not acknowledged — ${errorText(err)}`)
    }
    seeThrough(name, ws, approvalOf(ws, id))
      .catch(err => logged(approval, name, errorText(err)))
      .finally(() => busy.delete(id))
  }

  return { pass, choose, form }
}
