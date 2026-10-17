/**
 * Where the Bot Connector delivers: `POST /api/messages` on a loopback address, which the
 * operator's proxy makes the bot's public HTTPS endpoint. An activity is checked before it is
 * read, and answered 200 only once `onActivity` has it, so one the service could not take is
 * delivered again — with the body `onActivity` answers, where an invoke needs one.
 */

import { createServer } from 'node:http'

import { SporeError } from '@rhizogrip/spore'

const PATH = '/api/messages'
const MOST_BYTES = 1024 * 1024

const bodyOf = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let bytes = 0
  request.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes <= MOST_BYTES) chunks.push(chunk)
  })
  request.on('end', () => bytes > MOST_BYTES ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

/**
 * Serves until `signal` aborts, telling `listening` the port once it listens. `trace` is asked
 * for each activity that holds, and when it says so the activity goes to the log as it came.
 */
export function serve ({ host, port, verify, onActivity, signal, log, trace = () => false, listening = () => {} }) {
  const server = createServer(async (request, response) => {
    const answer = (status) => response.writeHead(status).end()
    if (request.method !== 'POST' || request.url !== PATH) return answer(404)
    let activity
    try {
      activity = JSON.parse(await bodyOf(request))
    } catch (err) {
      return answer(err.status ?? 400)
    }
    let refused
    try {
      refused = await verify(request.headers.authorization, activity)
    } catch (err) {
      log(`could not check an activity — ${err.message}${err.detail ? ` — ${err.detail}` : ''}`)
      return answer(503)
    }
    if (refused) {
      log(`refused an activity: ${refused}`)
      return answer(401)
    }
    let reply
    try {
      if (trace()) log(`activity ${activity.id}: ${JSON.stringify(activity)}`)
      reply = await onActivity(activity)
    } catch (err) {
      log(`activity ${activity.id} not taken — ${err.message}${err.detail ? ` — ${err.detail}` : ''}`)
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
