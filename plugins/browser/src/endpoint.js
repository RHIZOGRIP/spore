import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { refusalOf } from './gate.js'

export const IDLE_MS = 10 * 60 * 1000
const START_MS = 30_000
const PATH_PREFIX = '/devtools/browser/'

/**
 * A spore's browser endpoint: CDP on a loopback port, answered only on the WebSocket path that
 * carries its secret, passing only what `refusalOf` lets through for the spore whose `data/` is
 * `data`. Chrome starts with the first message it passes and stops after `IDLE_MS` without a
 * message from any client, closing every client with it.
 *
 * `launch()` starts the spore's Chrome; `stopped()` is told once it has stopped, so an ephemeral
 * profile can go with it.
 */
export async function openEndpoint ({ data, launch, stopped, log }) {
  const secret = randomBytes(32).toString('hex')
  const expected = Buffer.from(`${PATH_PREFIX}${secret}`)
  const clients = new Set()
  let browser = null
  let starting = null
  let idle = null

  const disconnectAll = (code, reason) => {
    for (const ws of clients) ws.close(code, reason)
    clients.clear()
  }

  async function stopBrowser (why) {
    clearTimeout(idle)
    const chrome = browser ?? (starting && await starting)
    browser = null
    starting = null
    disconnectAll(1001, why)
    if (!chrome) return
    await chrome.stop()
    await stopped()
  }

  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      log(`idle ${IDLE_MS / 60000}m, stopping its browser`)
      stopBrowser('idle').catch(err => log(`could not stop its browser — ${err.message}`))
    }, IDLE_MS)
  }

  async function start () {
    const started = await launch({
      onExit: ({ code, signal, stderr }) => {
        log(`its browser ended on its own: code ${code}, signal ${signal}${stderr ? `\n${stderr}` : ''}`)
        browser = null
        starting = null
        clearTimeout(idle)
        disconnectAll(1011, 'the browser stopped')
        stopped().catch(err => log(`could not clear its browser — ${err.message}`))
      }
    })
    started.onEvent(event => {
      const text = JSON.stringify(event)
      for (const ws of clients) ws.send(text)
    })
    let timer
    const ready = await Promise.race([
      started.request({ method: 'Browser.getVersion' }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ error: { message: `nothing on its pipe in ${START_MS / 1000}s — is it a Chromium-based browser?` } }), START_MS) })
    ])
    clearTimeout(timer)
    if (ready.error) {
      await started.stop()
      throw new Error(`the browser did not answer — ${ready.error.message}`)
    }
    log(`started its browser (${ready.result.product}, pid ${started.pid})`)
    browser = started
    return started
  }

  async function running () {
    if (browser) return browser
    starting ??= start().catch(err => {
      log(`could not start its browser — ${err.message}`)
      starting = null
      disconnectAll(1011, 'the browser could not start')
      return null
    })
    return starting
  }

  const holdsSecret = (url) => {
    const given = Buffer.from(url ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    res.statusCode = 404
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (!holdsSecret(req.url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws)
      ws.on('close', () => clients.delete(ws))
      touch()
      ws.on('message', async raw => {
        touch()
        let message
        try {
          message = JSON.parse(raw)
        } catch {
          ws.close(1007, 'not JSON')
          return
        }
        const refused = refusalOf(message, data)
        if (refused) {
          log(`refused: ${refused}`)
          const answer = { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: `refused by this spore's browser — ${refused}` } }
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(answer))
          return
        }
        const chrome = await running()
        if (!chrome) return
        const answer = await chrome.request(message)
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...answer, id: message.id }))
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    url: `ws://127.0.0.1:${server.address().port}${PATH_PREFIX}${secret}`,
    async close () {
      await stopBrowser('the service stopped')
      await new Promise(resolve => server.close(resolve))
    }
  }
}
