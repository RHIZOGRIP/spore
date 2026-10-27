import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { boundary } from '../src/library/probe.js'
import { containCheck } from '../src/core/command.js'
import { SLOT_DIR } from '../src/core/admission.js'
import { landlockAbi } from '../src/isolation/sandbox.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const CONTAINED = containCheck().contained
const SCOPED = landlockAbi() >= 6
const ALWAYS = ['read a file outside what it is granted', 'write outside the directory it writes', 'write a directory it may only read', 'make namespaces of its own']

let root
let configFile

const configure = (config) => writeFileSync(configFile, JSON.stringify({ home: join(root, 'home'), ...config }))
const outcomes = (tried) => Object.fromEntries(tried.boundary.map(one => [one.tried, one.outcome]))

beforeEach(() => {
  root = outsideRoot('spore-probe')
  mkdirSync(join(root, 'home'), { recursive: true })
  configFile = join(root, 'config.json')
  configure({})
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the boundary spore doctor tries', () => {
  it('refuses a turn\'s command every way out it tries, and leaves nothing of the try behind', async () => {
    const tried = await boundary({ configFile })
    const shown = outcomes(tried)
    for (const way of ALWAYS) expect(shown[way], way).toBe('refused')
    if (CONTAINED) expect(shown['see a process outside it']).toBe('refused')
    if (CONTAINED || SCOPED) expect(shown['signal a process outside it']).toBe('refused')
    expect(tried.findings).toEqual([])
    expect(readdirSync(join(dirname(SLOT_DIR), 'probe'))).toEqual([])
  })

  it('shows a process outside as crossed, and no problem, where the operator turned contain off', async () => {
    configure({ contain: false })
    const tried = await boundary({ configFile })
    expect(tried.boundary.find(one => one.tried === 'see a process outside it')).toEqual({ tried: 'see a process outside it', outcome: 'crossed', why: 'contain is off' })
    for (const way of ALWAYS) expect(outcomes(tried)[way], way).toBe('refused')
    expect(tried.findings).toEqual([])
  })

  it('tries nothing where the config cannot be read, which doctor reports', async () => {
    writeFileSync(configFile, '{ not json')
    expect(await boundary({ configFile })).toEqual({ boundary: [], findings: [] })
  })
})
