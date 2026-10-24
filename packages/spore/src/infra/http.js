/**
 * What every HTTP service of the host shares: where it listens, and how it reads a request's body
 * up to a bound. A service listens on loopback unless told otherwise, and on any address it is
 * told; none of them speaks TLS, so an address beyond loopback is shown as plain HTTP.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const addressOf = (host, port) => {
  const text = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  return { host, port, text, shown: LOOPBACK.has(host) ? text : `${text} (plain HTTP, reachable beyond this machine)` }
}

/**
 * `given`, `<host>:<port>` or `[<v6>]:<port>`, as `{ host, port, text, shown }` — `shown` says when
 * it is beyond loopback; loopback on `port` when it is undefined. `refused(problem, detail)` makes
 * the error for one it cannot read.
 */
export function listenOf (given, { port, refused }) {
  if (given === undefined) return addressOf('127.0.0.1', port)
  const found = typeof given === 'string' ? /^\[?([^\]]+?)\]?:(\d+)$/.exec(given) : null
  const number = Number(found?.[2])
  if (!found || !(number > 0 && number < 65536)) {
    throw refused(`listens on ${JSON.stringify(given)}`, `listen is <host>:<port> — 127.0.0.1:${port} when unsaid, and an address beyond loopback is plain HTTP`)
  }
  return addressOf(found[1], number)
}

/**
 * The body of `request`, or null once it passes `most` bytes — a declared length past it is not
 * read at all. Past it, what is left is dropped and the connection closes once `response` is sent.
 */
export function readBody (request, response, most) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      request.removeAllListeners('data')
      request.resume()
      response.setHeader('connection', 'close')
      response.once('finish', () => request.destroy())
      resolve(null)
    }
    if (Number(request.headers['content-length']) > most) return tooLarge()
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > most) return tooLarge()
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}
