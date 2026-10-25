import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { send } from '@rhizogrip/spore'

const SPORE = resolve(import.meta.dirname, '../bin/spore.js')
const spore = (...args) => spawnSync(process.execPath, [SPORE, ...args], { encoding: 'utf8', input: '' })
const piped = (input, ...args) => spawnSync(process.execPath, [SPORE, ...args], { encoding: 'utf8', input, cwd: WS })

const WS = resolve(tmpdir(), 'spore-cli-usage-sql')

describe('a command spore does not know', () => {
  it('names the one it is close to, in a line rather than the whole usage', () => {
    const typed = spore('shedules', 'ls', 'test3')
    expect(typed.status).toBe(2)
    expect(typed.stderr).toMatch(/^spore: unknown command "shedules" — did you mean schedule\?\n/)
    expect(typed.stderr.trim().split('\n')).toHaveLength(2)
  })

  it('lists them all when nothing is close, and says where a message goes', () => {
    const typed = spore('summarise this report')
    expect(typed.status).toBe(2)
    expect(typed.stderr).toMatch(/one of send, fork/)
    expect(typed.stderr).toMatch(/spore send <name> <message>/)
    expect(typed.stderr).not.toMatch(/did you mean/)
  })
})

describe('spore --version', () => {
  it('prints the version of the package it runs from', () => {
    const asked = spore('--version')
    expect(asked.status).toBe(0)
    expect(asked.stdout).toBe(`${JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')).version}\n`)
  })
})

describe('spore sql <spore> -', () => {
  beforeEach(() => {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })
    writeFileSync(resolve(WS, 'spore.cmk'), '---\nname: t\nmodel: anthropic/some-model\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
    send(WS, 'hello', { start: false })
    send(WS, 'again', { start: false })
  })
  afterEach(() => rmSync(WS, { recursive: true, force: true }))

  const QUERY = 'SELECT inboxNo, text FROM inbox ORDER BY inboxNo'

  it('reads the query from stdin, answering as the same query given as words', () => {
    const fromStdin = piped(QUERY, 'sql', WS, '-')
    expect(fromStdin.status).toBe(0)
    expect(fromStdin.stdout).toBe(spore('sql', WS, QUERY).stdout)
    expect(fromStdin.stdout).toBe('inboxNo  text\n1        hello\n2        again\n')
  })

  it('keeps --json', () => {
    const asked = piped('SELECT inboxNo FROM inbox ORDER BY inboxNo', 'sql', WS, '-', '--json')
    expect(asked.status).toBe(0)
    expect(asked.stdout).toBe('{"inboxNo":1}\n{"inboxNo":2}\n')
  })

  it('takes what a shell would act on as SQL, verbatim', () => {
    const asked = piped("SELECT 'a;$(touch x)`touch y`|&>z' AS v", 'sql', WS, '-', '--json')
    expect(asked.status).toBe(0)
    expect(asked.stdout).toBe('{"v":"a;$(touch x)`touch y`|&>z"}\n')
    for (const name of ['x', 'y', 'z']) expect(existsSync(resolve(WS, name))).toBe(false)
  })

  it('refuses an empty stdin rather than listing the views', () => {
    for (const input of ['', '\n  \n']) {
      const asked = piped(input, 'sql', WS, '-')
      expect(asked.status).toBe(2)
      expect(asked.stderr).toBe('spore: sql - read an empty query from stdin\n')
      expect(asked.stdout).toBe('')
    }
  })

  it('still lists the views with no query, and takes a query given as words', () => {
    expect(spore('sql', WS).stdout.split('\n')).toContain('inbox')
    expect(spore('sql', WS, 'SELECT', 'count(*)', 'AS', 'n', 'FROM', 'inbox', '--json').stdout).toBe('{"n":2}\n')
  })

  it('takes the words after -- as words, a dash in front or not', () => {
    const asked = spore('sql', WS, '--json', '--', 'SELECT', '-1', 'AS', 'v')
    expect(asked.status, asked.stderr).toBe(0)
    expect(asked.stdout).toBe('{"v":-1}\n')
  })
})

describe('what a verb takes', () => {
  beforeEach(() => {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })
    writeFileSync(resolve(WS, 'spore.cmk'), '---\nname: t\nmodel: anthropic/some-model\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
    send(WS, 'hello', { start: false })
  })
  afterEach(() => rmSync(WS, { recursive: true, force: true }))

  it('refuses an option it does not take, naming the ones it does, before anything runs', () => {
    const shown = spore('show', WS, '--ws', WS)
    expect(shown.status).toBe(2)
    expect(shown.stderr).toBe('spore: unknown option --ws — show takes --json\n')
    expect(shown.stdout).toBe('')

    const sent = spore('send', WS, 'hello again', '--model', 'm/b')
    expect(sent.status).toBe(2)
    expect(sent.stderr).toBe('spore: unknown option --model — send takes --attach, --request-id, --json, --debug\n')
    expect(spore('sql', WS, 'SELECT count(*) AS n FROM inbox', '--json').stdout).toBe('{"n":1}\n')

    expect(spore('service', 'log', 'tick', '--json').stderr).toBe('spore: unknown option --json — service log takes -n, --lines, -f\n')
  })

  it('refuses an argument more than it takes, and names it', () => {
    const removed = spore('rm', WS, 'b')
    expect(removed.status).toBe(2)
    expect(removed.stderr).toBe('spore: rm takes at most one argument — "b" is one too many\n')
    expect(existsSync(resolve(WS, 'spore.cmk'))).toBe(true)
  })

  it('exits 1 for a job that is not running, as stop does for a turn', () => {
    const stopped = spore('job', 'stop', WS, 'scan')
    expect(stopped.status).toBe(1)
    expect(stopped.stderr).toMatch(/^spore: no job named "scan" is running here — spore job ls /)
  })

  it('lists the jobs when given no subcommand', () => {
    const bare = piped('', 'job')
    expect(bare.status, bare.stderr).toBe(0)
    expect(bare.stdout).toBe(spore('job', 'ls', WS).stdout)
  })
})

describe('a name made of digits', () => {
  const HOME = resolve(tmpdir(), `spore-cli-usage-digits-${process.pid}`)
  const asked = (...args) => spawnSync(process.execPath, [SPORE, ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: resolve(HOME, 'config') } })
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true })
    mkdirSync(resolve(HOME, 'config', 'spore'), { recursive: true })
    mkdirSync(resolve(HOME, 'spores', '007'), { recursive: true })
    writeFileSync(resolve(HOME, 'config', 'spore', 'config.json'), JSON.stringify({ home: resolve(HOME, 'spores') }))
    writeFileSync(resolve(HOME, 'spores', '007', 'spore.cmk'), '---\nname: t\nmodel: m/a\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
  })
  afterEach(() => rmSync(HOME, { recursive: true, force: true }))

  it('is kept as written, leading zeros and all', () => {
    const shown = asked('model', '007')
    expect(shown.status, shown.stderr).toBe(0)
    expect(shown.stdout).toMatch(/^runs on m\/a\n/)
    expect(asked('model', '7').stderr).toMatch(/no spore called "7"/)
  })
})

describe('--json', () => {
  it('keeps the exit code the text would have', () => {
    const text = spore('ls')
    const json = spore('ls', '--json')
    expect(text.status).toBe(2)
    expect(json.status).toBe(2)
    expect(JSON.parse(json.stdout)).toMatchObject({ configured: false })
  })
})

describe('spore config', () => {
  const HOME = resolve(tmpdir(), `spore-cli-usage-config-${process.pid}`)
  const config = (...args) => spawnSync(process.execPath, [SPORE, 'config', ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: HOME } })
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true })
    mkdirSync(resolve(HOME, 'spore'), { recursive: true })
    writeFileSync(resolve(HOME, 'spore', 'config.json'), JSON.stringify({
      plugins: { browser: { settings: { cdp: 9222 }, version: '0.2.0', dir: '/opt/spore-plugin-browser' } },
      replyTo: { triage: 'discord:ops/1234' }
    }))
  })
  afterEach(() => rmSync(HOME, { recursive: true, force: true }))

  it('prints what it holds after a set, a map one entry a line', () => {
    const set = config('set', 'turns', '3')
    expect(set.status, set.stderr).toBe(0)
    expect(set.stdout).toBe('plugins:\n  browser 0.2.0\nreplyTo:\n  triage → discord:ops/1234\nturns: 3\n')
  })
})

describe('spore model', () => {
  const MODELS = resolve(tmpdir(), `spore-cli-usage-model-${process.pid}`)
  beforeEach(() => {
    rmSync(MODELS, { recursive: true, force: true })
    mkdirSync(MODELS, { recursive: true })
    writeFileSync(resolve(MODELS, 'spore.cmk'), '---\nname: t\nmodel: m/a\nmodels: [m/b]\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
  })
  afterEach(() => rmSync(MODELS, { recursive: true, force: true }))

  it('says what a spore runs on and may switch to, switches it, and refuses a model it does not offer', () => {
    expect(spore('model', MODELS).stdout).toBe('runs on m/a\nor: m/b — spore model <name> <model> switches from the next turn\n')
    const switched = spore('model', MODELS, 'm/b')
    expect(switched.status, switched.stderr).toBe(0)
    expect(switched.stdout).toBe('runs on m/b from the next turn — it ran on m/a\n')
    expect(readFileSync(resolve(MODELS, 'spore.cmk'), 'utf8')).toMatch(/^model: m\/b\nmodels: \[m\/a\]$/m)
    const refused = spore('model', MODELS, 'm/costly')
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/m\/costly is not a model this spore offers/)
  })
})
