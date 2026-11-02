import { randomBytes } from 'node:crypto'

import WebSocket from 'ws'

const PROBE_MS = 5000
const REFUSED = 'refused by this spore\'s browser'

const opened = (url) => new Promise(resolve => {
  const ws = new WebSocket(url, { handshakeTimeout: PROBE_MS })
  ws.once('open', () => resolve({ ws }))
  ws.once('unexpected-response', (req, res) => {
    res.resume()
    resolve({ status: res.statusCode })
  })
  ws.once('error', err => resolve({ error: err.message }))
})

const answerTo = (ws, message) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({ error: { message: `no answer in ${PROBE_MS / 1000}s` } }), PROBE_MS)
  ws.on('message', raw => {
    const answer = JSON.parse(raw)
    if (answer.id !== message.id) return
    clearTimeout(timer)
    resolve(answer)
  })
  ws.send(JSON.stringify(message))
})

/**
 * What a spore's endpoint at `url` refuses, tried: `[{ tried, outcome, why }]`, `outcome` `refused`
 * or `crossed`. Nothing tried is something the endpoint passes, so no browser starts for it.
 */
export async function probeEndpoint (url) {
  const tried = []
  const secret = new URL(url).pathname.split('/').at(-1)
  const guessed = await opened(url.replace(secret, randomBytes(32).toString('hex')))
  if (guessed.ws) guessed.ws.terminate()
  tried.push(guessed.status === 401
    ? { tried: 'reach it without its secret', outcome: 'refused' }
    : { tried: 'reach it without its secret', outcome: 'crossed', why: guessed.ws ? 'it answered' : `${guessed.error ?? `HTTP ${guessed.status}`}, not 401` })

  const own = await opened(url)
  if (!own.ws) return [...tried, { tried: 'reach it with its secret', outcome: 'crossed', why: `nothing to probe behind it — ${own.error ?? `HTTP ${own.status}`}` }]
  const asks = [
    { tried: 'send it a method agent-browser does not use', message: { id: 1, method: 'SystemInfo.getInfo' } },
    { tried: 'open a page that is not http or https', message: { id: 2, method: 'Target.createTarget', params: { url: 'file:///' } } }
  ]
  for (const { tried: what, message } of asks) {
    const answer = await answerTo(own.ws, message)
    tried.push(answer.error?.message?.startsWith(REFUSED)
      ? { tried: what, outcome: 'refused' }
      : { tried: what, outcome: 'crossed', why: answer.error ? answer.error.message : 'the browser answered' })
  }
  own.ws.close()
  return tried
}
