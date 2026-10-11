import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { createStoreClient } from '../src/infra/store-client.js'
import { createSourceClient } from '../src/infra/source-client.js'
import { KEY_HEADER } from '../src/infra/socket-request.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'

const KEY = 'k'.repeat(64)

let server
let socketPath
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    try { unlinkSync(socketPath) } catch {}
  }
  server = null
})

const serve = async (answer) => {
  const seen = []
  socketPath = brokerSocketPath('clients')
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      seen.push({ method: req.method, path: req.url, key: req.headers[KEY_HEADER], body })
      const [status, reply] = answer(req.url, body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  return seen
}

describe('the store client', () => {
  it('sends vectors with the width and unit, and presents the tree key', async () => {
    const seen = await serve((path) => [200, path === '/search' ? { matches: [{ id: 'a', distance: 0.1 }] } : { held: [], indexed: 1 }])
    const store = createStoreClient({ socketPath, key: KEY })

    await store.holds(4, ['a'])
    await store.index(4, 'turn', [{ id: 'a', vector: [1, 0, 0, 0] }])
    const { matches } = await store.search(4, 'turn', [1, 0, 0, 0], 2)

    expect(matches).toEqual([{ id: 'a', distance: 0.1 }])
    expect(seen.map(s => [s.method, s.path])).toEqual([['POST', '/holds'], ['POST', '/index'], ['POST', '/search']])
    expect(seen.every(s => s.key === KEY)).toBe(true)
    expect(seen[2].body).toEqual({ dimensions: 4, unit: 'turn', vector: [1, 0, 0, 0], topK: 2 })
  })

  it('throws a refusal as the typed error it came as', async () => {
    await serve(() => [400, { message: 'a vector of 3 dimensions where the collection holds 4', type: 'STORE_DIMENSION_MISMATCH', severity: 'error', retryable: false }])
    const store = createStoreClient({ socketPath, key: KEY })

    await expect(store.index(4, 'turn', [{ id: 'a', vector: [1, 0, 0] }])).rejects.toMatchObject({ type: 'STORE_DIMENSION_MISMATCH' })
  })

  it('gives up on a request the turn abandons, even when the socket never answers', async () => {
    socketPath = brokerSocketPath('clients')
    server = http.createServer(() => {})
    await new Promise(resolve => server.listen(socketPath, resolve))
    const stop = new AbortController()
    const store = createStoreClient({ socketPath, key: KEY, signal: stop.signal })

    const asked = store.holds(4, ['a'])
    setTimeout(() => stop.abort(), 50)

    await expect(asked).rejects.toMatchObject({ type: 'OPERATION_CANCELLED' })
    await expect(store.holds(4, ['a'])).rejects.toMatchObject({ type: 'OPERATION_CANCELLED' })
  })

  it('says the store is unreachable when nothing listens', async () => {
    const store = createStoreClient({ socketPath: brokerSocketPath('nobody'), key: KEY })
    await expect(store.holds(4, ['a'])).rejects.toMatchObject({ type: 'BROKER_UNREACHABLE' })
  })
})

describe('the source client', () => {
  it('lists, and fetches by name', async () => {
    const seen = await serve((path) => [200, path === '/list' ? { sources: [{ name: 'pubmed', scope: {} }] } : { status: 200, ok: true, contentType: 'text/plain', bodyBase64: Buffer.from('hi').toString('base64') }])
    const source = createSourceClient({ socketPath, key: KEY })

    expect((await source.list()).sources[0].name).toBe('pubmed')
    expect((await source.fetch('pubmed', { term: 'x' })).bodyBase64).toBe(Buffer.from('hi').toString('base64'))
    expect(seen.map(s => [s.method, s.path])).toEqual([['POST', '/list'], ['POST', '/fetch']])
    expect(seen[1].body).toEqual({ source: 'pubmed', params: { term: 'x' } })
    expect(seen.every(s => s.key === KEY)).toBe(true)
  })

  it('answers $SPORE_SOURCE --list, which names no source, with what the spore was granted', async () => {
    await serve(() => [200, { sources: [{ name: 'tracker', scope: {}, methods: ['GET', 'POST'], base: 'api/v1/', paths: ['**'] }] }])
    const ws = mkdtempSync(join(tmpdir(), 'spore-source-cli-'))
    try {
      writeFileSync(join(ws, 'model.key'), KEY)
      const { stdout } = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/source.js'), '--list'], {
        cwd: ws,
        env: { PATH: process.env.PATH, SPORE_SOURCE_SOCKET: socketPath }
      })
      expect(stdout).toMatch(/^tracker\s+methods: GET, POST {2}paths: \*\* under api\/v1\//)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('writes the body to stdout for --out -, and what the call did to stderr', async () => {
    await serve(() => [200, { status: 200, ok: true, contentType: 'application/json', bodyBase64: Buffer.from('{"hits":2}').toString('base64') }])
    const ws = mkdtempSync(join(tmpdir(), 'spore-source-cli-'))
    try {
      writeFileSync(join(ws, 'model.key'), KEY)
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/source.js'), 'web', '--q', 'x', '--out', '-'], {
        cwd: ws,
        env: { PATH: process.env.PATH, SPORE_SOURCE_SOCKET: socketPath }
      })
      expect(stdout).toBe('{"hits":2}')
      expect(JSON.parse(stderr)).toEqual({ source: 'web', status: 200, ok: true, bytes: 10, out: '-' })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('writes the bytes the endpoint sent to --out, text or not', async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8])
    await serve(() => [200, { status: 200, ok: true, contentType: 'image/png', bodyBase64: image.toString('base64') }])
    const ws = mkdtempSync(join(tmpdir(), 'spore-source-cli-'))
    try {
      writeFileSync(join(ws, 'model.key'), KEY)
      const { stdout } = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/source.js'), 'pages', '--out', 'page.png'], {
        cwd: ws,
        env: { PATH: process.env.PATH, SPORE_SOURCE_SOCKET: socketPath }
      })
      expect(readFileSync(join(ws, 'page.png'))).toEqual(image)
      expect(JSON.parse(stdout)).toEqual({ source: 'pages', status: 200, ok: true, bytes: 10, out: 'page.png' })

      const piped = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/source.js'), 'pages', '--out', '-'], {
        cwd: ws,
        env: { PATH: process.env.PATH, SPORE_SOURCE_SOCKET: socketPath },
        encoding: 'buffer'
      })
      expect(piped.stdout).toEqual(image)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('passes what it is asked as written, so an id too long for a number arrives whole', async () => {
    const seen = await serve(() => [200, { status: 200, ok: true, contentType: 'application/json', bodyBase64: Buffer.from('[]').toString('base64') }])
    const ws = mkdtempSync(join(tmpdir(), 'spore-source-cli-'))
    try {
      writeFileSync(join(ws, 'model.key'), KEY)
      await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/source.js'), 'chat', '--path', '100/messages', '--before', '1234567890123456789', '--limit', '50', '--out', '-'], {
        cwd: ws,
        env: { PATH: process.env.PATH, SPORE_SOURCE_SOCKET: socketPath }
      })
      expect(seen[0].body).toEqual({ source: 'chat', params: { before: '1234567890123456789', limit: '50' }, path: '100/messages' })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('sends the method, the path and the body an API source is asked with', async () => {
    const seen = await serve(() => [200, { status: 201, ok: true, contentType: 'application/json', bodyBase64: Buffer.from('{}').toString('base64') }])
    const source = createSourceClient({ socketPath, key: KEY })
    await source.fetch('tracker', {}, { method: 'POST', path: 'projects/web/issues', body: { title: 'a bug' } })
    expect(seen[0].body).toEqual({ source: 'tracker', params: {}, method: 'POST', path: 'projects/web/issues', body: { title: 'a bug' } })
  })

  it('sends a cell\'s view with every request, and the root sends none', async () => {
    const seen = await serve(() => [200, { sources: [] }])
    const view = { sources: ['pubmed'], scopes: { pubmed: { collection: ['a'] } } }
    const cell = createSourceClient({ socketPath, key: KEY, view })

    await cell.list()
    await cell.fetch('pubmed', {})
    await createSourceClient({ socketPath, key: KEY }).list()

    expect(seen[0].body).toEqual({ view })
    expect(seen[1].body).toEqual({ source: 'pubmed', params: {}, view })
    expect(seen[2].body).toEqual({})
  })

  it('throws a refused name as the typed error it came as', async () => {
    await serve(() => [403, { message: 'this spore was not granted "other"', type: 'SOURCE_NOT_GRANTED', severity: 'error', retryable: false }])
    const source = createSourceClient({ socketPath, key: KEY })

    await expect(source.fetch('other', {})).rejects.toMatchObject({ type: 'SOURCE_NOT_GRANTED' })
  })
})
