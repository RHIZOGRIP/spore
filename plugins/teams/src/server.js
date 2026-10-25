/**
 * Where the Bot Connector delivers: `POST /api/messages` on a loopback address, which the
 * operator's proxy makes the bot's public HTTPS endpoint. An activity is checked before it is
 * read, and answered 200 only once `onActivity` has it, so one the service could not take is
 * delivered again — with the body `onActivity` answers, where an invoke needs one.
 */

import { createServer } from 'node:http'

import { errorText, SporeError } from '@rhizogrip/spore'
import { readBody } from '@rhizogrip/spore/relay'

const PATH = '/api/messages'
const MOST_BYTES = 1024 * 1024

/** Serves until `signal` aborts, telling `listening` the port once it listens. */
export function serve ({ host, port, verify, onActivity, signal, log, listening = () => {} }) {
  const server = createServer(async (request, response) => {
    const answer = (status) => response.writeHead(status).end()
    if (request.method !== 'POST' || request.url !== PATH) return answer(404)
    const body = await readBody(request, response, MOST_BYTES)
    if (body === null) return answer(413)
    let activity
    try {
      activity = JSON.parse(body.toString('utf8'))
    } catch {
      return answer(400)
    }
    let refused
    try {
      refused = await verify(request.headers.authorization, activity)
    } catch (err) {
      log(`could not check an activity — ${errorText(err)}`)
      return answer(503)
    }
    if (refused) {
      log(`refused an activity: ${refused}`)
      return answer(401)
    }
    let reply
    try {
      reply = await onActivity(activity)
    } catch (err) {
      log(`activity ${activity.id} not taken — ${errorText(err)}`)
      return answer(500)
    }
    if (typeof reply === 'object' && reply !== null) return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
    answer(200)
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new SporeError(`cannot listen on ${host}:${port}`, { type: 'TEAMS_LISTEN_REFUSED', detail: err.message })))
    server.listen(port, host, () => {
      listening(server.address().port)
      signal.addEventListener('abort', () => server.close(() => resolve()), { once: true })
      if (signal.aborted) server.close(() => resolve())
    })
  })
}
