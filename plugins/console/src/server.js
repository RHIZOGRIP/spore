/**
 * The console's HTTP face on a loopback address: `POST /messages` says something as a person,
 * `GET /conversations/<person>` reads their conversation back from a `seq`, as JSON or as a stream
 * of server-sent events, and `POST /approvals/<id>/answer` presses a card's button as a person.
 * Every request carries the console's token, reaches only the people its file maps, and carries
 * no `Origin`: a web page is not a program the console serves.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { SporeError, parseTraceparent } from '@rhizogrip/spore'
import { readBody } from '@rhizogrip/spore/relay'

import { isPerson } from './adapter.js'

const MOST_BYTES = 1024 * 1024
const MOST_MESSAGE_BYTES = 40 * 1024 * 1024
const MOST_TEXT = 100_000
const MOST_WAIT_S = 900
const LIMIT = 100
const MOST_LIMIT = 1000
const PING_MS = 15_000
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const CHOICE = /^[A-Za-z0-9_-]{1,32}$/
const APPROVAL = /^\/approvals\/([0-9a-f]{12})\/answer$/
const CONVERSATION = /^\/conversations\/([^/]+)$/
const ANSWERS = new Set(['reply', 'question'])

class Refused extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

const digest = (text) => createHash('sha256').update(text).digest()

async function bodyOf (request, response, most) {
  const body = await readBody(request, response, most)
  if (body === null) throw new Refused(413, `a request carries at most ${most} bytes`)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (err) {
    throw new Refused(400, `the body is not JSON — ${err.message}`)
  }
}

const numberIn = (query, field, { least = 0, most = Infinity, absent }) => {
  const raw = query.get(field)
  if (raw === null) return absent
  const value = Number(raw)
  if (!Number.isInteger(value) || value < least || value > most) throw new Refused(400, `${field} is a whole number from ${least} to ${most}`)
  return value
}

const filesOf = (files) => {
  if (files === undefined) return []
  if (!Array.isArray(files) || !files.every(file => typeof file?.name === 'string' && file.name && typeof file.data === 'string' && (file.mime === undefined || typeof file.mime === 'string'))) {
    throw new Refused(400, 'files is [{ "name": "q3.pdf", "mime": "application/pdf", "data": "<base64>" }]')
  }
  return files.map(file => ({ name: file.name, mime: file.mime ?? null, data: Buffer.from(file.data, 'base64') }))
}

/**
 * Serves until `signal` aborts, telling `listening` the port once it listens. `people()` is the
 * console file's routing, read again on every request.
 */
export function serve ({ host, port, token, file, events, people, deliver, press, signal, log, listening = () => {} }) {
  const expected = digest(`Bearer ${token}`)
  const streams = new Set()

  const mapped = (person) => {
    if (!isPerson(person)) throw new Refused(400, 'a person is an id of letters, digits, ., _, @ and -, at most 128')
    if (!people().has(person)) throw new Refused(403, `"${person}" is not among the people of ${file} — add "${person}": "<a spore>" to its people`)
  }

  const answerTo = async (person, seq, ms, aborted) => {
    const deadline = Date.now() + ms
    const seen = []
    for (;;) {
      const batch = events.after(person, seen.at(-1)?.seq ?? seq, MOST_LIMIT)
      seen.push(...batch)
      const answer = seen.find(event => ANSWERS.has(event.type) && event.answers.includes(seq))
      if (answer) return { answer, events: seen.filter(event => event.seq <= answer.seq) }
      const left = deadline - Date.now()
      if (left <= 0 || aborted.aborted) return { answer: null, events: seen }
      await events.next(person, left, aborted)
    }
  }

  const say = async (request, response, query, aborted) => {
    const wait = numberIn(query, 'wait', { most: MOST_WAIT_S, absent: 0 })
    const { person, text = null, id, files: sent, ...rest } = await bodyOf(request, response, MOST_MESSAGE_BYTES)
    const extra = Object.keys(rest)
    if (extra.length) throw new Refused(400, `a message is { "person", "text", "id", "files" } — not ${extra.join(', ')}`)
    mapped(person)
    if (typeof id !== 'string' || !ID.test(id)) throw new Refused(400, 'id is the client\'s for this message, letters, digits, ., _, : and -, at most 128: the same id twice is said once')
    if (text !== null && (typeof text !== 'string' || text.length > MOST_TEXT)) throw new Refused(400, `text is a string of at most ${MOST_TEXT} characters`)
    const files = filesOf(sent)
    if (text === null && !files.length) throw new Refused(400, 'a message has text, files or both')
    const traceparent = request.headers.traceparent ?? null
    if (traceparent !== null && !parseTraceparent(traceparent)) throw new Refused(400, 'traceparent is W3C trace context, as 00-<32 hex>-<16 hex>-01')
    const said = events.say(person, id, { text, files: files.map(file => ({ name: file.name, mime: file.mime, bytes: file.data.length })), ...(traceparent ? { traceparent } : {}) })
    if (said.event.person !== person) throw new Refused(409, `id ${id} was said as ${said.event.person}`)
    if (!said.delivered) await deliver({ event: said.event, files })
    const { seq } = said.event
    if (!wait) return { status: 200, body: { seq, repeated: said.repeated } }
    return { status: 200, body: { seq, repeated: said.repeated, ...await answerTo(person, seq, wait * 1000, aborted) } }
  }

  const read = async (request, query, person, aborted) => {
    mapped(person)
    const after = numberIn(query, 'after', { absent: Number(request.headers['last-event-id'] ?? 0) })
    if (!Number.isInteger(after) || after < 0) throw new Refused(400, 'Last-Event-ID is a seq')
    if ((request.headers.accept ?? '').includes('text/event-stream')) return { stream: { person, after } }
    const limit = numberIn(query, 'limit', { least: 1, most: MOST_LIMIT, absent: LIMIT })
    const wait = numberIn(query, 'wait', { most: MOST_WAIT_S, absent: 0 })
    let found = events.after(person, after, limit)
    if (!found.length && wait) {
      await events.next(person, wait * 1000, aborted)
      found = events.after(person, after, limit)
    }
    return { status: 200, body: { events: found, next: found.at(-1)?.seq ?? after } }
  }

  const answer = async (request, response, approval) => {
    const { choice, by, inputs = null, ...rest } = await bodyOf(request, response, MOST_BYTES)
    const extra = Object.keys(rest)
    if (extra.length) throw new Refused(400, `an answer is { "choice", "by", "inputs" } — not ${extra.join(', ')}`)
    if (typeof choice !== 'string' || !CHOICE.test(choice)) throw new Refused(400, 'choice is the id of one of the card\'s options')
    if (inputs !== null && (typeof inputs !== 'object' || Array.isArray(inputs))) throw new Refused(400, 'inputs is { "<field id>": "<text>" }')
    const card = events.cardOf(approval)
    if (!card) throw new Refused(404, `no card ${approval} was shown on this console`)
    mapped(card.person)
    mapped(by)
    const heard = await press({ card, choice, by, inputs })
    if (heard === null) throw new SporeError(`the press on ${approval} was not answered`, { type: 'CONSOLE_PRESS_UNANSWERED' })
    return heard.taken ? { status: 200, body: { taken: true, text: heard.text } } : { status: 409, body: { taken: false, reason: heard.text } }
  }

  const route = (request, response, url, aborted) => {
    if (request.method === 'POST' && url.pathname === '/messages') return say(request, response, url.searchParams, aborted)
    const conversation = CONVERSATION.exec(url.pathname)
    if (request.method === 'GET' && conversation) return read(request, url.searchParams, decodeURIComponent(conversation[1]), aborted)
    const approval = APPROVAL.exec(url.pathname)
    if (request.method === 'POST' && approval) return answer(request, response, approval[1])
    throw new Refused(404, 'the console serves POST /messages, GET /conversations/<person> and POST /approvals/<id>/answer')
  }

  const stream = (response, { person, after }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let cursor = after
    const drain = () => {
      for (let batch = events.after(person, cursor, MOST_LIMIT); batch.length; batch = events.after(person, cursor, MOST_LIMIT)) {
        for (const event of batch) response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        cursor = batch.at(-1).seq
      }
    }
    drain()
    const off = events.subscribe(person, drain)
    const ping = setInterval(() => response.write(': ping\n\n'), PING_MS)
    streams.add(response)
    response.on('close', () => {
      off()
      clearInterval(ping)
      streams.delete(response)
    })
  }

  const server = createServer(async (request, response) => {
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (request.headers.origin !== undefined) {
      log(`refused a request from a web page (${request.headers.origin})`)
      return json(403, { error: 'a request from a web page is refused' })
    }
    const given = digest(request.headers.authorization ?? '')
    if (!timingSafeEqual(given, expected)) return response.writeHead(401).end()
    const closed = new AbortController()
    response.on('close', () => closed.abort())
    const aborted = AbortSignal.any([closed.signal, signal])
    try {
      const done = await route(request, response, new URL(request.url, 'http://console'), aborted)
      if (done.stream) return stream(response, done.stream)
      json(done.status, done.body)
    } catch (err) {
      if (err instanceof Refused) return json(err.status, { error: err.message })
      log(`${request.method} ${request.url} failed — ${[err.message, err.detail].filter(Boolean).join(' — ')}`)
      json(err.type?.endsWith('_INVALID') ? 503 : 500, { error: [err.message, err.detail].filter(Boolean).join(' — ') })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new SporeError(`cannot listen on ${host}:${port}`, { type: 'CONSOLE_LISTEN_REFUSED', detail: err.message })))
    server.listen(port, host, () => {
      listening(server.address().port)
      const stop = () => {
        for (const response of streams) response.end()
        server.close(() => resolve())
        server.closeIdleConnections()
      }
      if (signal.aborted) return stop()
      signal.addEventListener('abort', stop, { once: true })
    })
  })
}
