/**
 * Where Meta delivers: `/webhook` on a loopback address, which the operator's proxy makes the
 * app's public HTTPS callback. `GET` is Meta's handshake, answered with its challenge when the
 * verify token is the bot's. A `POST` is checked against the app secret's signature before it is
 * read, and answered 200 only once `onDelivery` has it, so one the service could not take is
 * delivered again.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { errorText, SporeError } from '@rhizogrip/spore'
import { readBody } from '@rhizogrip/spore/relay'

const PATH = '/webhook'
const MOST_BYTES = 4 * 1024 * 1024

const signed = (body, secret, header) => {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const given = Buffer.from(header ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Serves until `signal` aborts, telling `listening` the port once it listens. */
export function serve ({ host, port, secret, verify, onDelivery, signal, log, listening = () => {} }) {
  const server = createServer(async (request, response) => {
    const answer = (status, text) => response.writeHead(status, text === undefined ? {} : { 'content-type': 'text/plain' }).end(text)
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== PATH) return answer(404)
    if (request.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verify) {
        log('Meta checked the callback URL')
        return answer(200, url.searchParams.get('hub.challenge') ?? '')
      }
      log('refused a check of the callback URL: its verify token is not this bot\'s')
      return answer(403)
    }
    if (request.method !== 'POST') return answer(405)
    const body = await readBody(request, response, MOST_BYTES)
    if (body === null) return answer(413)
    if (!signed(body, secret, request.headers['x-hub-signature-256'])) {
      log('refused a delivery: it is not signed with this app\'s secret')
      return answer(401)
    }
    let delivery
    try {
      delivery = JSON.parse(body.toString('utf8'))
    } catch {
      return answer(400)
    }
    try {
      await onDelivery(delivery)
    } catch (err) {
      log(`a delivery not taken — ${errorText(err)}`)
      return answer(500)
    }
    answer(200)
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new SporeError(`cannot listen on ${host}:${port}`, { type: 'WHATSAPP_LISTEN_REFUSED', detail: err.message })))
    server.listen(port, host, () => {
      listening(server.address().port)
      signal.addEventListener('abort', () => server.close(() => resolve()), { once: true })
      if (signal.aborted) server.close(() => resolve())
    })
  })
}
