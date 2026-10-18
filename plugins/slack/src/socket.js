/**
 * Slack's Socket Mode: one WebSocket after another until `signal` aborts, each from a URL `open`
 * asks for. A connection Slack says it will close is replaced at once, and left to finish what it
 * holds; one that goes quiet — no ping, pong or message for `quietMs` — is dropped and replaced,
 * since a half-open connection otherwise looks like a quiet workspace. Each envelope is handed to
 * `onEnvelope` with its `ack`, one at a time per connection, in the order Slack sent them.
 */

import WebSocket from 'ws'

import { SporeError } from '@rhizogrip/spore'

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

export async function connect ({ open, onEnvelope, signal, log, sleep, WebSocketImpl = WebSocket, pingEveryMs = 5000, quietMs = 30_000 }) {
  let backoff = 1000
  let refused = null
  const sockets = new Set()
  const stopAll = () => { for (const socket of sockets) socket.close(1000, 'stopping') }
  signal.addEventListener('abort', stopAll, { once: true })

  try {
    while (!signal.aborted) {
      let url
      try {
        url = await open()
      } catch (err) {
        if (!err.retryable) throw err
        log(`no Socket Mode connection — ${said(err)}`)
        await sleep(err.context?.retryAfter ? err.context.retryAfter * 1000 : backoff)
        backoff = Math.min(backoff * 2, 60_000)
        continue
      }
      const ended = await new Promise((resolve) => {
        const socket = new WebSocketImpl(url)
        sockets.add(socket)
        let heard = Date.now()
        let handled = Promise.resolve()
        let done = false
        const end = (why, early) => {
          if (done) return
          done = true
          resolve({ why, early })
        }
        const alive = () => { heard = Date.now() }
        const beat = setInterval(() => {
          if (Date.now() - heard > quietMs) return socket.terminate()
          if (socket.readyState === WebSocket.OPEN) socket.ping()
        }, pingEveryMs)
        socket.on('ping', alive)
        socket.on('pong', alive)
        socket.on('message', (data) => {
          alive()
          let envelope
          try {
            envelope = JSON.parse(data.toString())
          } catch {
            return log('Slack sent something that is not JSON')
          }
          if (envelope.type === 'hello') {
            backoff = 1000
            return
          }
          if (envelope.type === 'disconnect') {
            if (envelope.reason === 'link_disabled') {
              refused = new SporeError('Slack turned Socket Mode off for this app', { type: 'SLACK_REFUSED', detail: 'link_disabled' })
              socket.close(1000, 'link disabled')
              return
            }
            return end(`is closing (${envelope.reason})`, true)
          }
          if (!envelope.envelope_id) return
          const ack = (payload) => {
            if (socket.readyState !== WebSocket.OPEN) return
            socket.send(JSON.stringify(payload === undefined ? { envelope_id: envelope.envelope_id } : { envelope_id: envelope.envelope_id, payload }))
          }
          handled = handled
            .then(() => onEnvelope({ type: envelope.type, payload: envelope.payload, ack }))
            .catch(err => log(`envelope ${envelope.envelope_id} not taken — ${said(err)}`))
        })
        socket.on('error', (err) => log(`Socket Mode connection — ${err.message}`))
        socket.on('close', (code) => {
          clearInterval(beat)
          sockets.delete(socket)
          handled.then(() => end(`closed (${code})`, false))
        })
      })
      if (signal.aborted) return
      if (refused) throw refused
      log(`Socket Mode connection ${ended.why} — connecting again`)
      if (!ended.early) {
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  } finally {
    signal.removeEventListener('abort', stopAll)
  }
}
