/**
 * One delivery of a hook handed to each spore it names, under the hook's bounds — `perHour`,
 * `maxWait` and `perDay` — which `deliver` keeps.
 */

import { isWorkspace, readConfig, workspaceFor } from '../src/index.js'
import { deliver } from '../src/core/route.js'
import { CONFIG_FILE } from '../src/library/config.js'

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

const briefingOf = ({ name, event, delivery }) => ({ payload, headers }) => [
  `A delivery of the webhook "${name}"${event ? `, event ${event}` : ''}, delivery ${delivery}.`,
  payload ? `Its body is ${payload} in your directory.` : 'It has no body.',
  headers ? 'Its headers, without any that carry a secret, are headers.json.' : ''
].filter(Boolean).join('\n') + '\n'

export function createHookDelivery ({
  log,
  configFile = CONFIG_FILE,
  sporeOf = (name) => {
    const ws = workspaceFor(name, { config: readConfig(configFile) }).path
    return isWorkspace(ws) ? ws : null
  },
  now = Date.now,
  ...delivering
}) {
  const routing = new Set()

  const deliverTo = (hook, ws, options, stdin, heading, env) => {
    const { event, delivery } = options.hook
    const delivered = deliver({
      ws,
      said: '',
      options,
      event,
      ref: delivery,
      maxWait: hook.maxWait,
      perHour: hook.perHour,
      stdin,
      headers: 'headers.json',
      perDay: hook.perDay,
      briefing: briefingOf(options.hook),
      env,
      configFile,
      log,
      heading,
      now,
      ...delivering
    })
    routing.add(delivered.judged)
    delivered.judged.finally(() => routing.delete(delivered.judged))
    return delivered.outcome
  }

  /**
   * `options` as `send` takes them, with `hook: { name, event, delivery }` and its `requestId`;
   * `stdin` the name of the attached payload, or null for none; `unwanted(accept)` says why a spore's own `accept` drops it, or null; `env` the environment
   * the service was started with, which a turn or a cell starts from. Answers each spore's
   * outcome, `failed` for one it could not reach.
   */
  const deliverAll = ({ hook, options, stdin, unwanted, env }) => hook.spores.map(spore => {
    const { delivery, event } = options.hook
    const heading = `hook ${hook.name} → ${spore} · ${delivery}${event ? ` · ${event}` : ''}`
    const own = hook.accepts.get(spore)
    const dropped = own ? unwanted(own) : null
    if (dropped) {
      log(`${heading} · ignored — ${dropped}`)
      return { spore, outcome: `ignored — ${dropped}` }
    }
    const ws = sporeOf(spore)
    if (!ws) {
      log(`${heading} · not delivered — there is no spore "${spore}"`)
      return { spore, outcome: `not delivered — there is no spore "${spore}"`, failed: true }
    }
    try {
      const outcome = deliverTo(hook, ws, { ...options, env }, stdin, heading, env)
      log(`${heading} · ${outcome}`)
      return { spore, outcome }
    } catch (err) {
      log(`${heading} · not delivered — ${err.type ?? err.name} ${said(err)}`)
      return { spore, outcome: `not delivered — ${err.type ?? err.name} ${said(err)}`, failed: true }
    }
  })

  return { deliverAll, routed: () => Promise.all([...routing]) }
}
