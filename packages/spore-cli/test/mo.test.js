import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { moHint, withMoHint } from '../src/mo.js'

const SPORE = resolve(import.meta.dirname, '../bin/spore.js')
const { mohdel } = createRequire(import.meta.url)('@rhizogrip/spore/package.json').dependencies
const HINT = `mo is a separate install: npm install -g mohdel@${mohdel}`

let dir
const path = process.env.PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spore-mo-'))
  process.env.PATH = dir
})

afterEach(() => {
  process.env.PATH = path
  rmSync(dir, { recursive: true, force: true })
})

const installMo = (mode = 0o755) => {
  writeFileSync(join(dir, 'mo'), '#!/bin/sh\n')
  chmodSync(join(dir, 'mo'), mode)
}

describe('a message naming a mo command', () => {
  it('says how to install mo where it is missing, at the mohdel spore pins', () => {
    expect(withMoHint('has no credential — mo onboard anthropic')).toBe(`has no credential — mo onboard anthropic — ${HINT}`)
  })

  it.each([
    'mo chatgpt login',
    'mo curate openai',
    'mo model instructions openai',
    'mo providers lists them',
    '"mo ls" lists your catalog'
  ])('finds the command in %s', (text) => {
    expect(moHint(text)).toBe(HINT)
  })

  it('stays as it is with mo on PATH', () => {
    installMo()
    expect(withMoHint('mo onboard anthropic')).toBe('mo onboard anthropic')
  })

  it('does not take a file that cannot run, or a directory, for mo', () => {
    installMo(0o644)
    expect(moHint('mo onboard anthropic')).toBe(HINT)
    rmSync(join(dir, 'mo'))
    mkdirSync(join(dir, 'mo'))
    expect(moHint('mo onboard anthropic')).toBe(HINT)
  })
})

describe('a message that only mentions mo', () => {
  it.each([
    'a provider set up here is set up for mo as well',
    'shared with mo and every spore',
    'demo onboard'
  ])('stays as it is: %s', (text) => {
    expect(withMoHint(text)).toBe(text)
  })
})

describe('the spore command', () => {
  const setup = () => spawnSync(process.execPath, [SPORE, 'setup'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  it('gives the install command when it names mo and mo is missing', () => {
    expect(setup().stderr).toContain(HINT)
  })

  it('does not with mo on PATH', () => {
    installMo()
    const ran = setup()
    expect(ran.stderr).toContain('mo onboard <provider>')
    expect(ran.stderr).not.toContain(HINT)
  })
})
