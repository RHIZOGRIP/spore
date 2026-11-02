import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import WebSocket from 'ws'
import { definitionWith } from '@rhizogrip/spore/testing'

import { containCheck } from '@rhizogrip/spore'

import { findChromium, profileArgs, startChrome } from '../src/chrome.js'
import { IDLE_MS, openEndpoint } from '../src/endpoint.js'
import { METHODS, refusalOf } from '../src/gate.js'
import { openWindow, runningService } from '../src/open.js'
import { probeEndpoint } from '../src/probe.js'
import { grantsOf, sporesUsing } from '../src/service.js'

const ROOT = resolve(import.meta.dirname, '.browser-test')
const CHROME = resolve(import.meta.dirname, 'fixtures/chrome.js')
const SILENT = resolve(import.meta.dirname, 'fixtures/silent.js')
const BROWSE = resolve(import.meta.dirname, '../bin/browse.js')
const FAKED = { toFake: ['setTimeout', 'clearTimeout'] }
const PROFILE = join(ROOT, 'profile')
const DATA = join(ROOT, 'ws', 'data')
const open = []

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  for (const endpoint of open.splice(0)) await endpoint.close()
  rmSync(ROOT, { recursive: true, force: true })
})

async function endpoint ({ executable = CHROME } = {}) {
  const seen = { launched: 0, stopped: 0, lines: [] }
  const opened = await openEndpoint({
    data: DATA,
    log: line => seen.lines.push(line),
    stopped: async () => { seen.stopped++ },
    launch: async ({ onExit }) => {
      seen.launched++
      for (const dir of ['profile', 'home', 'cache', 'tmp']) mkdirSync(join(ROOT, dir), { recursive: true })
      return startChrome({ executable, profile: PROFILE, cache: join(ROOT, 'cache'), home: join(ROOT, 'home'), tmp: join(ROOT, 'tmp'), onExit })
    }
  })
  open.push(opened)
  return { ...opened, seen }
}

async function client (url) {
  const ws = new WebSocket(url)
  const waiting = new Map()
  const events = []
  ws.on('message', data => {
    const message = JSON.parse(data)
    if (message.id === undefined) events.push(message)
    else waiting.get(message.id)?.(message)
  })
  await once(ws, 'open')
  const call = (id, method, params = {}) => new Promise(resolve => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  return { ws, call, events, closed: once(ws, 'close').then(([code]) => code) }
}

async function refusedWith (url) {
  const ws = new WebSocket(url)
  const [, res] = await once(ws, 'unexpected-response')
  res.resume()
  return res.statusCode
}

const waitFor = async (test) => {
  for (let i = 0; i < 200 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(test()).toBe(true)
}

describe('a spore\'s browser endpoint', () => {
  it('answers only on the loopback path that carries its secret, and starts no browser for anyone else', async () => {
    const { url, seen } = await endpoint()
    const { host, pathname } = new URL(url)
    expect(host.startsWith('127.0.0.1:')).toBe(true)
    const secret = pathname.split('/').at(-1)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    expect(await refusedWith(url.replace(secret, '0'.repeat(64)))).toBe(401)
    expect(await refusedWith(url.replace(secret, secret.slice(1)))).toBe(401)
    expect(await refusedWith(`ws://${host}/devtools/browser`)).toBe(401)
    expect((await fetch(`http://${host}/json/version`)).status).toBe(404)
    expect(seen.launched).toBe(0)
  })

  it('starts one browser on a pipe for its first client, keeps each client\'s ids, and passes events to every client', async () => {
    const { url, seen } = await endpoint()
    const one = await client(url)
    const two = await client(url)

    expect(await one.call(7, 'Page.navigate', { url: 'https://example.org/' })).toEqual({ id: 7, result: { frameId: 'f1' } })
    expect(await two.call(7, 'Browser.getVersion')).toEqual({ id: 7, result: { product: 'Stand-in/1.0' } })
    await waitFor(() => two.events.length === 1)
    expect(one.events).toEqual([{ method: 'Page.frameNavigated', params: { url: 'https://example.org/' } }])
    expect(two.events).toEqual(one.events)
    expect(seen.launched).toBe(1)

    const { argv, env } = JSON.parse(readFileSync(join(PROFILE, 'launched.json'), 'utf8'))
    expect(argv).toEqual(expect.arrayContaining(['--headless', '--remote-debugging-pipe', '--password-store=basic', `--user-data-dir=${PROFILE}`]))
    expect(argv.some(arg => arg.startsWith('--remote-debugging-port'))).toBe(false)
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR'])
  })

  it('stops the browser once no client has said anything for its idle time, and starts another for the next', async () => {
    vi.useFakeTimers(FAKED)
    const { url, seen } = await endpoint()
    const first = await client(url)
    await first.call(1, 'Browser.getVersion')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000)
    await first.call(2, 'Browser.getVersion')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000)
    expect(seen.launched).toBe(1)
    expect(seen.stopped).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    expect(await first.closed).toBe(1001)
    await waitFor(() => seen.stopped === 1)

    const next = await client(url)
    expect(await next.call(1, 'Browser.getVersion')).toEqual({ id: 1, result: { product: 'Stand-in/1.0' } })
    expect(seen.launched).toBe(2)
  })

  it('closes its clients when the browser ends on its own, and says how it ended', async () => {
    const { url, seen } = await endpoint()
    const one = await client(url)
    await one.call(1, 'Browser.getVersion')
    one.ws.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://crash.invalid/' } }))
    expect(await one.closed).toBe(1011)
    expect(seen.stopped).toBe(1)
    expect(seen.lines).toContainEqual(expect.stringMatching(/ended on its own: code 3/))
  })

  it('gives up on a program that never answers on its pipe, and stops it', async () => {
    vi.useFakeTimers(FAKED)
    const { url, seen } = await endpoint({ executable: SILENT })
    const one = await client(url)
    one.ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    while (vi.getTimerCount() < 2) await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(40_000)
    vi.useRealTimers()
    expect(await one.closed).toBe(1011)
    expect(seen.lines).toContainEqual(expect.stringMatching(/could not start its browser — the browser did not answer — nothing on its pipe in 30s/))
  })

  it('stops its browser when it closes', async () => {
    const opened = await endpoint()
    const one = await client(opened.url)
    await one.call(1, 'Browser.getVersion')
    await open.pop().close()
    expect(await one.closed).toBe(1001)
    await waitFor(() => opened.seen.stopped === 1)
  })

  it('answers what it refuses itself, under the caller\'s id and session, and starts no browser for it', async () => {
    const { url, seen } = await endpoint()
    const one = await client(url)
    const fourth = new Promise(resolve => one.ws.on('message', data => { if (JSON.parse(data).id === 4) resolve(JSON.parse(data)) }))
    one.ws.send(JSON.stringify({ id: 4, sessionId: 's1', method: 'Page.navigate', params: { url: 'file:///etc/hostname' } }))
    expect(await fourth).toEqual({ id: 4, sessionId: 's1', error: { code: -32000, message: 'refused by this spore\'s browser — Page.navigate to file:///etc/hostname: only http, https and about:blank' } })
    expect(await one.call(5, 'Browser.close')).toEqual({ id: 5, error: { code: -32000, message: 'refused by this spore\'s browser — Browser.close is not a method this browser takes' } })
    expect(seen.launched).toBe(0)
    expect(seen.lines).toEqual([
      'refused: Page.navigate to file:///etc/hostname: only http, https and about:blank',
      'refused: Browser.close is not a method this browser takes'
    ])
    expect(await one.call(6, 'Browser.getVersion')).toEqual({ id: 6, result: { product: 'Stand-in/1.0' } })
    expect(seen.launched).toBe(1)
  })

  it('refuses everything the probes try, so the service\'s check finds nothing crossed, and starts no browser for them', async () => {
    const { url, seen } = await endpoint()
    expect(await probeEndpoint(url)).toEqual([
      { tried: 'reach it without its secret', outcome: 'refused' },
      { tried: 'send it a method agent-browser does not use', outcome: 'refused' },
      { tried: 'open a page that is not http or https', outcome: 'refused' }
    ])
    expect(seen.launched).toBe(0)
  })
})

describe(`a spore's browser under confine ${containCheck().contained ? '' : '(skipped: this host gives no unprivileged user namespaces) '}`, () => {
  it.skipIf(!containCheck().contained)('runs in namespaces of its own, still answering on its pipe', async () => {
    mkdirSync(join(ROOT, 'tmp'))
    mkdirSync(PROFILE)
    const exited = []
    const chrome = startChrome({
      executable: CHROME,
      profile: PROFILE,
      cache: PROFILE,
      home: PROFILE,
      tmp: join(ROOT, 'tmp'),
      confine: { writeRoot: PROFILE, writes: [join(ROOT, 'tmp')], reads: [resolve(import.meta.dirname, '..')] },
      onExit: ended => exited.push(ended)
    })
    expect(await chrome.request({ method: 'Browser.getVersion' })).toEqual({ id: 1, result: { product: 'Stand-in/1.0' } })
    const { processes } = JSON.parse(readFileSync(join(PROFILE, 'launched.json'), 'utf8'))
    expect(processes).toBeLessThan(5)
    expect(await chrome.stop()).toEqual({ code: 0, signal: null })
    expect(exited).toEqual([])
  })

  it('may write its profile, its TMPDIR, shared memory, its own /proc and the spore\'s data/, and sees nothing of the user\'s runtime directory', () => {
    const runtime = join(ROOT, 'run-user')
    mkdirSync(runtime)
    const places = { root: join(ROOT, 'state', 'main'), tmp: join(ROOT, 'scratch', 'tmp') }
    expect(grantsOf({ ws: join(ROOT, 'ws') }, places, CHROME, { XDG_RUNTIME_DIR: runtime })).toEqual({
      writeRoot: places.root,
      writes: [places.tmp, '/dev/shm', '/proc', DATA],
      reads: ['/sys', dirname(CHROME)],
      keep: [{ hide: runtime }]
    })
    expect(grantsOf({ ws: join(ROOT, 'ws') }, places, CHROME, {}).keep).toEqual([])
  })
})

describe('what a spore\'s browser takes', () => {
  const refused = (method, params) => refusalOf({ method, params }, DATA)

  it('is the methods agent-browser sends, and nothing else', () => {
    expect(METHODS.size).toBe(32)
    expect(refused('Runtime.evaluate', { expression: 'document.title' })).toBe(null)
    expect(refused('Browser.close')).toMatch(/is not a method this browser takes/)
    expect(refused('Target.exposeDevToolsProtocol')).toMatch(/is not a method this browser takes/)
    expect(refused(undefined)).toMatch(/is not a method this browser takes/)
  })

  it('opens http, https and a blank page, and no other address', () => {
    for (const url of ['https://example.org/', 'http://127.0.0.1:8080/x', 'about:blank']) {
      expect(refused('Page.navigate', { url })).toBe(null)
      expect(refused('Target.createTarget', { url })).toBe(null)
    }
    for (const url of ['file:///etc/hostname', 'chrome://settings', 'data:text/html,x', 'javascript:alert(1)', 'about:config', 'not a url', undefined]) {
      expect(refused('Page.navigate', { url })).toMatch(/only http, https and about:blank/)
    }
  })

  it('downloads into the spore\'s data/ and nowhere else, judged on where a path really leads', () => {
    mkdirSync(join(DATA, 'out'))
    symlinkSync(ROOT, join(DATA, 'away'))
    const downloadTo = (downloadPath) => refused('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true })
    expect(downloadTo(DATA)).toBe(null)
    expect(downloadTo(join(DATA, 'out'))).toBe(null)
    expect(downloadTo(join(DATA, 'not', 'made', 'yet'))).toBe(null)
    expect(downloadTo(join(DATA, 'away'))).toMatch(/downloads go only into the spore's data\//)
    expect(downloadTo(join(DATA, 'away', 'deeper'))).toMatch(/downloads go only into the spore's data\//)
    expect(downloadTo(join(DATA, '..'))).toMatch(/downloads go only into the spore's data\//)
    expect(downloadTo(`${DATA}-next`)).toMatch(/downloads go only into the spore's data\//)
    expect(downloadTo('data/out')).toMatch(/downloads go only into the spore's data\//)
    expect(downloadTo(undefined)).toMatch(/downloads go only into the spore's data\//)
    expect(refused('Browser.setDownloadBehavior', { behavior: 'deny' })).toBe(null)
  })

  it('uploads files from the spore\'s data/ and nowhere else', () => {
    writeFileSync(join(DATA, 'report.pdf'), 'x')
    writeFileSync(join(ROOT, 'outside.txt'), 'x')
    symlinkSync(join(ROOT, 'outside.txt'), join(DATA, 'link.txt'))
    expect(refused('DOM.setFileInputFiles', { backendNodeId: 12, files: [join(DATA, 'report.pdf')] })).toBe(null)
    expect(refused('DOM.setFileInputFiles', { backendNodeId: 12, files: [join(DATA, 'report.pdf'), join(ROOT, 'outside.txt')] }))
      .toBe(`uploads come only from the spore's data/, not ${join(ROOT, 'outside.txt')}`)
    expect(refused('DOM.setFileInputFiles', { backendNodeId: 12, files: [join(DATA, 'link.txt')] })).toMatch(/uploads come only from the spore's data\//)
  })
})

describe('$SPORE_BROWSER', () => {
  const browse = (sockets) => spawnSync(process.execPath, [BROWSE, 'open', 'https://example.org/'], { encoding: 'utf8', env: { PATH: process.env.PATH, SPORE_SOCKET_DIR: sockets } })

  it('says to run it with wsexec when the spore\'s socket directory cannot be read, as under exec', () => {
    const sockets = join(ROOT, 'sockets')
    mkdirSync(sockets)
    writeFileSync(join(sockets, 'browser.json'), JSON.stringify({ url: 'ws://127.0.0.1:1/devtools/browser/x' }), { mode: 0o000 })
    const ran = browse(sockets)
    expect([ran.status, ran.stderr]).toEqual([1, 'browser: run it with wsexec — exec cannot reach this spore\'s browser\n'])
  })

  it('says the spore has no browser when the service has written none for it', () => {
    const ran = browse(ROOT)
    expect(ran.status).toBe(1)
    expect(ran.stderr).toMatch(/^browser: this spore has no browser — /)
  })
})

describe('the browser the operator names', () => {
  it('is a command on the service\'s PATH or an absolute path, which says its version', () => {
    expect(findChromium(CHROME)).toEqual({ executable: CHROME, version: 'Stand-in 1.0' })
    expect(findChromium('chrome.js', `${dirname(CHROME)}:${process.env.PATH}`)).toEqual({ executable: CHROME, version: 'Stand-in 1.0' })
    expect(() => findChromium('no-such-browser', dirname(CHROME))).toThrow(/chromium is no-such-browser, which is not on the service's PATH/)
    expect(() => findChromium(resolve(import.meta.dirname, 'browser.test.js'))).toThrow(/which is not an executable file/)
  })
})

describe('the spores the service serves', () => {
  const spore = (dir, lines) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5').replace('\n---', `\n${lines}---`))
    return { ws: dir }
  }

  it('are those whose definition uses the plugin, each on the profile it chose or the default', () => {
    const lines = []
    const found = sporesUsing([
      spore(join(ROOT, 'plain'), ''),
      spore(join(ROOT, 'fresh'), 'plugins: [browser]\n'),
      spore(join(ROOT, 'kept'), 'plugins: [browser]\nbrowser.profile: persistent\n'),
      spore(join(ROOT, 'odd'), 'plugins: [browser]\nbrowser.profile: shared\n'),
      spore(join(ROOT, 'broken'), 'plugins: [browser]\nbrowser.profile: [a, b]\n'),
      spore(join(ROOT, 'other', 'fresh'), 'plugins: [browser]\n'),
      { ws: join(ROOT, 'gone') }
    ], line => lines.push(line))

    expect([...found.values()]).toEqual([
      { ws: join(ROOT, 'fresh'), name: 'fresh', profile: 'ephemeral' },
      { ws: join(ROOT, 'kept'), name: 'kept', profile: 'persistent' }
    ])
    expect(lines).toEqual([
      'odd: browser.profile is shared, which it cannot be — not served',
      `fresh: ${join(ROOT, 'other', 'fresh')} and ${join(ROOT, 'fresh')} are both called fresh, and a profile is kept by name — ${join(ROOT, 'other', 'fresh')} not served`
    ])
  })
})

describe("the operator's window on a spore's profile", () => {
  it('opens the profile, cache and home the service gives the headless browser, on the page asked for', async () => {
    const root = join(ROOT, 'kept')
    mkdirSync(join(root, 'profile'), { recursive: true })
    expect(await openWindow({ executable: CHROME, root, url: 'https://example.org/login' })).toEqual({ code: 0, signal: null })

    const { argv, env } = JSON.parse(readFileSync(join(root, 'profile', 'launched.json'), 'utf8'))
    expect(argv).toEqual([...profileArgs({ profile: join(root, 'profile'), cache: join(root, 'cache') }), 'https://example.org/login'])
    expect(env.HOME).toBe(join(root, 'home'))
  })

  it('is refused while the service runs, which its record says only while that process is still the service', async () => {
    const record = join(ROOT, 'spore-browser.json')
    expect(runningService(record)).toBe(null)

    const service = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', join(ROOT, 'bin', 'spore-browser.js')], { stdio: 'ignore' })
    await once(service, 'spawn')
    writeFileSync(record, JSON.stringify({ version: '0.4.0', spore: '1.51.0', pid: service.pid }))
    expect(runningService(record)).toBe(service.pid)

    service.kill()
    await once(service, 'exit')
    expect(runningService(record)).toBe(null)

    writeFileSync(record, JSON.stringify({ version: '0.4.0', spore: '1.51.0', pid: process.pid }))
    expect(runningService(record)).toBe(null)
  })
})
