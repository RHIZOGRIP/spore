/**
 * The relay's side of approvals (ARCHITECTURE §Approvals): each approval asked in a followed spore
 * whose place is this bot's posted with buttons the relay alone makes; a press taken only on its own
 * approval's id and from someone that approval names; and each one that ended — answered, expired
 * or refused — seen through: the host's hook told, the question closed, the spore told. What is
 * left to do is read from the spore's database on every pass, so a restart carries on where the
 * last run stopped.
 */

import { answerApproval, approvalOf, approvalsIn, callApprovalHook, errorText, expireApproval, inputsProblem, postApproval, refuseApproval, send, settleApproval, SporeError } from '../index.js'

const PRESS = /^ap:([0-9a-f]{12}):([A-Za-z0-9_-]{1,32})$/
const TELL_AGAIN_MS = 30_000

export function createApprovals ({ adapter, prefix, botFile, configFile, keyOf, where, followed, delivery, environment, env, log, sleep, signal }) {
  const { kind } = adapter
  if (adapter.can.choose && typeof adapter.can.fields !== 'boolean') {
    throw new SporeError(`the ${adapter.label} adapter carries approvals without saying whether it shows fields`, { type: 'ADAPTER_INVALID', detail: 'can.fields is true or false beside can.choose' })
  }
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
    const fields = approval.fields ?? []
    const unshown = adapter.can.fields ? [] : fields.filter(field => field.required)
    if (unshown.length) return refuse(name, ws, approval, `a ${adapter.label} bot cannot show fields to fill in, and it needs ${unshown.map(field => `"${field.label}"`).join(' and ')}`)
    const choices = approval.options.map(option => ({ ...option, data: `ap:${approval.id}:${option.id}` }))
    let posted
    try {
      posted = await delivery.to(conversation, attempt => attempt(() => adapter.ask(conversation, shown, choices, { as: name, fields: adapter.can.fields ? fields : [], approval: { id: approval.id, by: approval.approvers, until: approval.until } })))
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

  /**
   * A press, as the adapter heard it: `data` from one of the relay's buttons, `person` as the
   * platform vouches for them, `inputs` what they filled in of the approval's fields. Taken only
   * on its own approval, open, in the conversation it was asked in, by someone it names, with its
   * fields filled in as they must be; acknowledged to the platform at once, and seen through after.
   */
  const choose = async ({ conversation, data, inputs = null, person, acknowledge }) => {
    const pressed = PRESS.exec(data ?? '')
    if (!pressed) {
      log(`${where(conversation)}: a press on a button this relay did not make — ${JSON.stringify(data)}`)
      return acknowledge(null)
    }
    const [, id, choice] = pressed
    let found = null
    for (const [ws, { name, conversations }] of followed()) {
      if (!conversations.has(keyOf(conversation))) continue
      const approval = approvalOf(ws, id)
      if (approval?.place.startsWith(prefix) && keyOf(conversationOf(approval)) === keyOf(conversation)) found = { ws, name, approval }
    }
    if (!found) {
      log(`${where(conversation)}: a press on approval ${id}, which no spore it reaches has asked there`)
      return acknowledge('this question is not open here')
    }
    const { ws, name, approval } = found
    if (approval.state !== 'posted' || Date.parse(approval.until) <= Date.now()) {
      return acknowledge(approval.state === 'answered' ? 'this was answered already' : 'this question is closed')
    }
    if (!approval.approvers.includes(person.id)) {
      logged(approval, name, `refused a press by ${person.name} (${person.id}) — it names ${approval.approvers.join(', ')}`)
      return acknowledge('this is not yours to answer')
    }
    const option = approval.options.find(one => one.id === choice)
    if (!option) {
      logged(approval, name, `refused a press on "${choice}", which is none of its choices`)
      return acknowledge('that is not one of its choices')
    }
    const unfit = inputsProblem(approval.fields, inputs)
    if (unfit) return acknowledge(unfit)
    if (busy.has(id) || !answerApproval(ws, id, { choice, inputs, person })) return acknowledge('this was answered already')
    busy.add(id)
    try {
      await acknowledge(`${option.label} — recorded`, { taken: true })
    } catch (err) {
      logged(approval, name, `the press was not acknowledged — ${errorText(err)}`)
    }
    seeThrough(name, ws, approvalOf(ws, id))
      .catch(err => logged(approval, name, errorText(err)))
      .finally(() => busy.delete(id))
  }

  return { pass, choose }
}
