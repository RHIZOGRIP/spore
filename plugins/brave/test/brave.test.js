import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { showPlugin } from '@rhizogrip/spore'

import { searchResults } from '../src/results.js'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_BIN = join(dirname(createRequire(join(ROOT, 'package.json')).resolve('@rhizogrip/spore/package.json')), 'bin', 'source.js')
const KEY = 'k'.repeat(64)
const FOUND = JSON.stringify({ web: { results: [{ title: 'Grundy', url: 'https://example.org/g', description: 'nim values' }] } })

let dir
let server
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function broker (answer) {
  dir = mkdtempSync('/tmp/spore-brave-')
  writeFileSync(join(dir, 'model.key'), KEY)
  const asked = []
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      asked.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  const socketPath = join(dir, 'source.sock')
  await new Promise(resolve => server.listen(socketPath, resolve))
  const search = (...words) => run(process.execPath, [join(ROOT, 'bin/search.js'), ...words], {
    cwd: dir,
    env: { PATH: process.env.PATH, SPORE_SOURCE: SOURCE_BIN, SPORE_SOURCE_SOCKET: socketPath }
  })
  return { asked, search }
}

describe('the brave plugin', () => {
  it('is a plugin spore accepts, describing its source and giving its program', () => {
    const shown = showPlugin('brave', { configFile: join(ROOT, 'no-config.json') })
    expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-brave', sources: ['brave'], programs: { SPORE_BRAVE: join(shown.dir, 'bin/search.js') } })
  })

  it('asks the brave source through $SPORE_SOURCE and prints one block per result', async () => {
    const { asked, search } = await broker({ status: 200, ok: true, contentType: 'application/json', body: FOUND })
    const { stdout } = await search('sprague', 'grundy')
    expect(asked).toEqual([{ path: '/fetch', body: { source: 'brave', params: { q: 'sprague grundy' } } }])
    expect(stdout).toBe('Grundy\nhttps://example.org/g\nnim values\n')
  })

  it('exits 1 and says why when the search did not happen', async () => {
    const { search } = await broker({ status: 429, ok: false, contentType: 'application/json', body: '{"error":"slow down"}' })
    const failed = await search('x').catch(err => err)
    expect(failed.code).toBe(1)
    expect(failed.stderr).toMatch(/search: 429 — \{"error":"slow down"\}/)
  })
})

describe('the results when the API says no', () => {
  it('fails on a non-2xx response instead of reporting nothing found', () => {
    expect(() => searchResults({ status: 429, ok: false, body: '{"error":"slow down"}' })).toThrow(/429/)
  })

  it('still returns an honest empty result when the API found nothing', () => {
    expect(searchResults({ status: 200, ok: true, body: '{"web":{"results":[]}}' })).toBe('')
  })

  it('names what answered when a 200 is not JSON', () => {
    expect(() => searchResults({ status: 200, ok: true, body: '<html><body>502 Bad Gateway</body></html>' })).toThrow(/was not JSON — <html>/)
  })

  it('refuses a 200 whose shape it does not understand, rather than calling it empty', () => {
    const answer = { status: 200, ok: true, body: '{"type":"ErrorResponse","error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}' }
    expect(() => searchResults(answer)).toThrow(/no web\.results/)
    expect(() => searchResults(answer)).toThrow(/SUBSCRIPTION_TOKEN_INVALID/)
  })
})
