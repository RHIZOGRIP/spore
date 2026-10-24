import { describe, it, expect, afterEach } from 'vitest'
import { createServer, request } from 'node:http'

import { listenOf, readBody } from '../src/infra/http.js'

const refused = (problem, detail) => Object.assign(new Error(problem), { detail })

describe('where a service listens', () => {
  it('is loopback on its own port when unsaid, and any address it is told', () => {
    expect(listenOf(undefined, { port: 8742, refused })).toEqual({ host: '127.0.0.1', port: 8742, text: '127.0.0.1:8742', shown: '127.0.0.1:8742' })
    expect(listenOf('[::1]:9000', { port: 8742, refused })).toEqual({ host: '::1', port: 9000, text: '[::1]:9000', shown: '[::1]:9000' })
    expect(listenOf('localhost:9000', { port: 8742, refused }).shown).toBe('localhost:9000')
    expect(listenOf('0.0.0.0:9000', { port: 8742, refused }).shown).toBe('0.0.0.0:9000 (plain HTTP, reachable beyond this machine)')
    expect(listenOf('[::]:9000', { port: 8742, refused }).shown).toBe('[::]:9000 (plain HTTP, reachable beyond this machine)')
  })

  it('refuses one it cannot read, saying what it takes', () => {
    for (const given of ['9000', ':9000', '127.0.0.1:0', '127.0.0.1:65536', 9000, '']) {
      expect(() => listenOf(given, { port: 8742, refused }), String(given)).toThrow(expect.objectContaining({ message: `listens on ${JSON.stringify(given)}`, detail: expect.stringMatching(/127\.0\.0\.1:8742 when unsaid/) }))
    }
  })
})

describe('a request body', () => {
  let server
  afterEach(() => new Promise(resolve => server.close(resolve)))

  const serving = async (most) => {
    server = createServer(async (req, res) => {
      const body = await readBody(req, res, most)
      if (body === null) return res.writeHead(413).end()
      res.writeHead(200).end(String(body.length))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }

  const post = (port, chunks, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', headers }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text, connection: res.headers.connection }))
    })
    req.on('error', (err) => { if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err) })
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })

  it('is read whole up to its bound', async () => {
    const port = await serving(10)
    expect(await post(port, ['0123456789'])).toMatchObject({ status: 200, text: '10' })
  })

  it('past its bound is answered 413 and the connection closed, whether it says its length or not', async () => {
    const port = await serving(10)
    expect(await post(port, ['0123456789', 'x'])).toMatchObject({ status: 413, connection: 'close' })
    expect(await post(port, ['x'.repeat(11)], { 'content-length': '11' })).toMatchObject({ status: 413, connection: 'close' })
  })
})
