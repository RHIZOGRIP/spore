import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'

import { doctor, modelFindings } from '../src/library/doctor.js'
import { spendSoFar } from '../src/core/admission.js'
import { appendInbox, appendTurn } from '../src/core/spore-dir.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const DEFINITION = (extra = '') => `---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n${extra}---\n\nyou are a test.\n`

let root
let home
let configFile

const spore = (name, extra) => {
  mkdirSync(join(home, name), { recursive: true })
  writeFileSync(join(home, name, 'spore.cmk'), DEFINITION(extra))
}
const operator = (file, content) => writeFileSync(join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
const examine = (env = {}, abi = 6, contain = { contained: true, why: null }) => doctor({ configFile, env, abi, contain, slots: join(root, 'state', 'slots') })
const about = (findings, subject) => findings.filter(found => found.subject.includes(subject))

beforeEach(() => {
  root = outsideRoot('spore-doctor')
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  configFile = join(root, 'config.json')
  operator('config.json', { home })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('spore doctor', () => {
  it('finds nothing on a machine with one plain spore', () => {
    spore('main')
    expect(examine()).toEqual({ findings: [], needsTick: [], replies: [] })
  })

  it('stops at a config.json spore cannot read, saying why', () => {
    operator('config.json', { hme: home })
    const { findings } = examine()
    expect(findings).toEqual([expect.objectContaining({ area: 'operator', subject: configFile, severity: 'problem', problem: expect.stringMatching(/hme/) })])
  })

  it('names environment lines systemd and spore would misread, by line and never by value', () => {
    operator('environment', 'GOOD=1\nexport BAD=2\nJOINED=secret-valueOTHER_KEY=more\n# FINE=1\n')
    const { findings } = examine()
    expect(findings.map(found => found.subject)).toEqual([`${join(root, 'environment')}:2`, `${join(root, 'environment')}:3`])
    expect(findings[1].problem).toMatch(/^JOINED's value holds another assignment/)
    expect(JSON.stringify(findings)).not.toMatch(/secret-value/)
  })

  it('reports a source whose secret is unset — a problem for the spores granted it, a note otherwise', () => {
    spore('main', 'sources: [ledger]\n')
    operator('sources.json', {
      ledger: { url: 'https://ledger.invalid', headers: { authorization: 'Bearer ${LEDGER_KEY}' } }, // eslint-disable-line no-template-curly-in-string
      spare: { url: 'https://spare.invalid', headers: { 'x-key': '${SPARE_KEY}' } } // eslint-disable-line no-template-curly-in-string
    })
    const { findings } = examine()
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'problem', problem: 'source ledger wants LEDGER_KEY, which is not set — main cannot start a turn' }),
      expect.objectContaining({ severity: 'note', problem: 'source spare wants SPARE_KEY, which is not set' })
    ])
    expect(examine({ LEDGER_KEY: 'k', SPARE_KEY: 'k' }).findings).toEqual([])
    expect(examine({ LEDGER_KEY: '', SPARE_KEY: 'k' }).findings).toEqual([
      expect.objectContaining({ severity: 'problem', problem: 'source ledger wants LEDGER_KEY, which is not set — main cannot start a turn' })
    ])
  })

  it('reports a source holding a placeholder the runner would refuse', () => {
    spore('main', 'sources: [ledger]\n')
    operator('sources.json', {
      ledger: { url: 'https://ledger.invalid', headers: { 'x-spore': '{name}', 'x-place': '{ws}' } },
      spare: { url: 'https://spare.invalid', query: { spore: '{name}' } }
    })
    const { findings } = examine()
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'problem', problem: 'source ledger has {ws} in its x-place header — main cannot start a turn' }),
      expect.objectContaining({ severity: 'note', problem: 'source spare has {name} in its query' })
    ])
  })

  it('reports a spore using a plugin that is not allowed, and one allowed and not installed', () => {
    spore('main', 'plugins: [brave]\n')
    operator('config.json', { home, plugins: { ghost: { settings: {}, version: '0.1.0', dir: '/nowhere' } } })
    const { findings } = examine()
    expect(about(findings, 'main')).toEqual([expect.objectContaining({ area: 'spores', problem: expect.stringMatching(/^uses plugin brave, which is not allowed/) })])
    expect(about(findings, 'ghost')).toEqual([expect.objectContaining({ area: 'plugins', problem: 'is allowed and not installed beside spore' })])
  })

  it('reports a hook reaching a spore that does not exist, and one whose secret is unset', () => {
    spore('main')
    operator('hooks.json', { gh: { spore: ['main', 'ghost'], verify: { token: '${HOOK_TOKEN}' }, maxWait: '30m' } }) // eslint-disable-line no-template-curly-in-string
    const reached = examine({ HOOK_TOKEN: 't' })
    expect(reached.findings).toEqual([
      expect.objectContaining({ problem: 'hook gh reaches spore ghost, which does not exist' }),
      expect.objectContaining({ subject: 'main', severity: 'note', problem: 'answers to hook gh reach no one: it has no default reply-to' })
    ])
    expect(reached.needsTick).toEqual(['hook gh holds deliveries'])
    expect(examine().findings).toEqual([expect.objectContaining({ problem: expect.stringMatching(/wants \$HOOK_TOKEN, which is not set/) })])
  })

  it('says which spores need the tick timer', () => {
    spore('worker', 'jobs: [2, 1m]\n')
    expect(examine().needsTick).toEqual(['worker is granted jobs'])
  })

  it('reports a spore prepared by a plugin it may not use, and that it holds deliveries while they are prepared', () => {
    spore('main', 'prepare: [hook:scans=pdf/SPORE_PDF_PAGES]\nprepare.timeout: 30s\nprepare.attach: [2, 1MB]\n')
    const { findings, needsTick } = examine()
    expect(findings).toEqual([expect.objectContaining({ subject: 'main', problem: expect.stringMatching(/^prepares deliveries with plugin pdf, which is not allowed — every turn is refused/) })])
    expect(needsTick).toEqual(['main holds deliveries while they are prepared'])
  })

  it('reports a spore whose definition does not parse, and carries on with the rest', () => {
    spore('main', 'jobs: [2, 1m]\n')
    mkdirSync(join(home, 'broken'))
    writeFileSync(join(home, 'broken', 'spore.cmk'), '---\nname: broken\n---\n')
    const { findings, needsTick } = examine()
    expect(findings).toEqual([
      expect.objectContaining({ area: 'spores', subject: 'broken', severity: 'problem' }),
      expect.objectContaining({ subject: 'main', severity: 'note', problem: 'answers to its jobs reach no one: it has no default reply-to' })
    ])
    expect(needsTick).toEqual(['main is granted jobs'])
  })

  it('reports a sporangium of yours spore define would refuse, your default among them', () => {
    spore('main')
    const sporangium = (name, text) => {
      mkdirSync(join(root, 'sporangia', name), { recursive: true })
      writeFileSync(join(root, 'sporangia', name, 'spore.cmk'), text)
    }
    sporangium('default', DEFINITION().replace('tools: [read]', 'tools: [read, search]'))
    sporangium('mine', DEFINITION())
    mkdirSync(join(root, 'sporangia', 'empty'))
    const findings = about(examine().findings, 'sporangium')
    expect(findings).toEqual([
      expect.objectContaining({ area: 'operator', subject: 'sporangium default', severity: 'problem', problem: expect.stringMatching(/default\/spore\.cmk unknown tool "search"/), fix: 'fix it there — until then spore define is refused' }),
      expect.objectContaining({ subject: 'sporangium empty', severity: 'problem', problem: expect.stringMatching(/has no spore\.cmk/), fix: 'fix it there — until then spore define --sporangium empty is refused' })
    ])
  })

  it('says where answers nobody asked for go, and what of them is still waiting to be delivered', () => {
    spore('main', 'jobs: [2, 1m]\n')
    spore('quiet')
    operator('config.json', { home, replyTo: { main: 'telegram:main/42', quiet: 'terminal', gone: 'discord:ops/1' } })
    appendInbox(join(home, 'main'), 'hello', { replyTo: 'telegram:main/7' })
    appendTurn(join(home, 'main'), { startedAt: 't', stopReason: 'answer', concluded: true, inboxTo: 1 })
    const { findings, replies } = examine()
    expect(findings).toEqual([
      expect.objectContaining({ subject: 'quiet', severity: 'problem', problem: expect.stringMatching(/^has terminal as its default reply-to/) }),
      expect.objectContaining({ subject: configFile, severity: 'problem', problem: 'replyTo names gone, which is not a spore here' })
    ])
    expect(replies).toEqual([
      { spore: 'main', recipient: 'telegram:main/42', waiting: 0 },
      { spore: 'main', recipient: 'telegram:main/7', waiting: 1 }
    ])
  })

  it('refuses every turn on a host that cannot contain one, saying which step it refused', () => {
    const { findings } = examine({}, 6, { contained: false, why: 'cannot make the namespaces: Operation not permitted' })
    expect(findings).toEqual([expect.objectContaining({
      area: 'machine',
      subject: 'processes',
      severity: 'problem',
      problem: expect.stringMatching(/refused: .*\(cannot make the namespaces: Operation not permitted\)$/),
      fix: expect.stringMatching(/spore config set contain off/)
    })])
  })

  it('says spore refuses every turn while it runs as root', () => {
    const { findings } = doctor({ configFile, env: {}, abi: 6, contain: { contained: true, why: null }, root: true, slots: join(root, 'state', 'slots') })
    expect(findings).toEqual([expect.objectContaining({ area: 'machine', subject: 'user', severity: 'problem', problem: expect.stringMatching(/as root/) })])
  })

  it('says turns are not contained while the operator turned it off, whatever the host could do', () => {
    operator('config.json', { home, contain: false })
    expect(examine().findings).toEqual([expect.objectContaining({ area: 'machine', subject: 'processes', severity: 'note', problem: expect.stringMatching(/^turns are not contained \(contain off\)/) })])
  })

  it('says when the spores have spent a limit set on them, and nothing while they are under it', () => {
    spore('main')
    operator('config.json', { home, spendPerDay: 5 })
    expect(examine().findings).toEqual([])
    mkdirSync(join(root, 'state', 'spend'), { recursive: true })
    writeFileSync(join(root, 'state', 'spend', spendSoFar({ dir: join(root, 'state', 'slots'), config: {} }).date), '5000000')
    expect(about(examine().findings, 'spend')).toEqual([expect.objectContaining({
      area: 'operator',
      severity: 'note',
      problem: expect.stringMatching(/daily limit of \$5\.00 — no turn starts and no model call is made/),
      fix: expect.stringMatching(/spore config set spendPerDay/)
    })])
  })

  it('reports a listed workspace that is gone', () => {
    operator('config.json', { home, workspaces: [join(root, 'elsewhere')] })
    expect(examine().findings).toEqual([expect.objectContaining({ subject: join(root, 'elsewhere'), problem: 'is in workspaces and gone' })])
  })

  it('reports a kernel without Landlock, by its errno', () => {
    expect(examine({}, -constants.errno.ENOSYS).findings).toEqual([expect.objectContaining({ area: 'machine', subject: 'landlock', severity: 'problem', problem: 'is not in this kernel (ENOSYS) — every turn fails' })])
  })

  it('says when this kernel cannot keep one spore from signalling another', () => {
    expect(examine({}, 5).findings).toEqual([expect.objectContaining({ subject: 'landlock', severity: 'note', problem: expect.stringMatching(/version 5, which cannot scope signals/) })])
    expect(examine({}, 6).findings).toEqual([])
  })

  it('tells a Landlock left out at boot from one not built in', () => {
    expect(examine({}, -constants.errno.EOPNOTSUPP).findings).toEqual([expect.objectContaining({ subject: 'landlock', fix: expect.stringMatching(/lsm= boot parameter/) })])
  })
})

describe('spore doctor on the models spores name', () => {
  const READY = { inCatalog: true, priced: true, credential: true, ready: true, fix: null }
  const states = {
    'anthropic/claude-haiku-4-5': READY,
    'openai/gpt-cheap': { ...READY, priced: false, fix: 'mo model instructions openai' },
    'openrouter/x': { inCatalog: false, priced: null, credential: false, ready: false, fix: 'mo onboard openrouter' },
    'gemini/y': { ...READY, inCatalog: false, ready: false, fix: 'mo curate gemini' }
  }
  const asked = []
  const readiness = async (model) => {
    asked.push(model)
    return { model, ...states[model] }
  }
  const examine = () => modelFindings({ configFile, readiness })

  beforeEach(() => { asked.length = 0 })

  it('finds nothing when every model is ready and priced, asking once a model', async () => {
    spore('main')
    spore('side')
    expect(await examine()).toEqual([])
    expect(asked).toEqual(['anthropic/claude-haiku-4-5'])
  })

  it('reads model, models and cell-models, a model not ready a problem naming its spores and its fix', async () => {
    spore('main', 'models: [openrouter/x]\ncell-models: [low=gemini/y]\n')
    spore('side', 'models: [openrouter/x]\n')
    const findings = await examine()
    expect(asked.sort()).toEqual(['anthropic/claude-haiku-4-5', 'gemini/y', 'openrouter/x'])
    expect(findings).toEqual([
      { area: 'models', subject: 'openrouter/x', severity: 'problem', problem: expect.stringMatching(/no credential.*main, side/), fix: 'mo onboard openrouter' },
      { area: 'models', subject: 'gemini/y', severity: 'problem', problem: expect.stringMatching(/not in mohdel's catalog.*main/), fix: 'mo curate gemini' }
    ])
  })

  it('notes a model with no prices: it runs, and its calls count as $0 against the limits', async () => {
    spore('main', 'models: [openai/gpt-cheap]\n')
    expect(await examine()).toEqual([{ area: 'models', subject: 'openai/gpt-cheap', severity: 'note', problem: expect.stringMatching(/\$0, so cost and spend limits never stop them/), fix: 'mo model instructions openai' }])
  })
})

describe('spore doctor on the models spores name, on a host that names a gate', () => {
  const GATE = '/run/gate/data.sock'
  const asked = []
  const readiness = async (model) => { throw new Error(`asked mohdel here of ${model}`) }

  beforeEach(() => {
    asked.length = 0
    operator('config.json', { home, gate: GATE })
  })

  it('asks the gate\'s catalog, never this host\'s mohdel, and finds nothing when it has every model', async () => {
    spore('main', 'models: [openrouter/x]\n')
    const info = async (model, { socketPath }) => {
      asked.push([model, socketPath])
      return { model }
    }
    expect(await modelFindings({ configFile, readiness, info })).toEqual([])
    expect(asked).toEqual([['anthropic/claude-haiku-4-5', GATE], ['openrouter/x', GATE]])
  })

  it('names a model the gate has no entry for, and one whose lane it refuses, with the spores they fail', async () => {
    spore('main', 'models: [openrouter/x, openai/y:max]\n')
    const info = async (model) => {
      if (model === 'openai/y:max') throw Object.assign(new Error('openai/y takes no effort max'), { type: 'SESSION_INVALID_OUTPUT_EFFORT' })
      return model === 'openrouter/x' ? null : { model }
    }
    expect(await modelFindings({ configFile, readiness, info })).toEqual([
      { area: 'models', subject: 'openrouter/x', severity: 'problem', problem: `is not in the catalog of the gate at ${GATE}, so a turn of main on it fails`, fix: expect.stringMatching(/gate's catalog/) },
      { area: 'models', subject: 'openai/y:max', severity: 'problem', problem: expect.stringMatching(/refused by the gate — openai\/y takes no effort max — so a turn of main/), fix: expect.stringMatching(/spore\.cmk of main/) }
    ])
  })

  it('says once that the gate does not answer, and asks it nothing more', async () => {
    spore('main', 'models: [openrouter/x]\n')
    const info = async (model) => {
      asked.push(model)
      throw Object.assign(new Error(`connect ENOENT ${GATE}`), { code: 'ENOENT' })
    }
    expect(await modelFindings({ configFile, readiness, info })).toEqual([
      { area: 'models', subject: GATE, severity: 'problem', problem: expect.stringMatching(/does not answer \(connect ENOENT .*\) — every turn fails/), fix: expect.stringMatching(/start the gate/) }
    ])
    expect(asked).toEqual(['anthropic/claude-haiku-4-5'])
  })
})
