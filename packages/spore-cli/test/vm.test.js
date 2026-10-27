import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SPORE = resolve(import.meta.dirname, '../bin/spore.js')
const VM_FILE = join(process.env.XDG_CONFIG_HOME, 'spore', 'vm.json')

let noLima
const spore = (...args) => spawnSync(process.execPath, [SPORE, ...args], { encoding: 'utf8', input: '', env: { ...process.env, PATH: noLima } })

beforeEach(() => {
  noLima = mkdtempSync(join(tmpdir(), 'spore-cli-path-'))
})

afterEach(() => {
  rmSync(VM_FILE, { force: true })
  rmSync(noLima, { recursive: true, force: true })
})

describe('spore vm, where spore runs on this machine', () => {
  it('says there is no vm, and succeeds', () => {
    for (const sub of ['start', 'stop']) {
      const ran = spore('vm', sub)
      expect(ran.status).toBe(0)
      expect(ran.stderr).toBe('spore: no vm — spore runs on this machine\n')
    }
  })

  it('takes start or stop', () => {
    const ran = spore('vm', 'up')
    expect(ran.status).toBe(2)
    expect(ran.stderr).toMatch(/vm takes start or stop/)
  })
})

describe('a vm named in vm.json', () => {
  beforeEach(() => mkdirSync(join(process.env.XDG_CONFIG_HOME, 'spore'), { recursive: true }))

  it('takes every command there, and says so when Lima is not installed', () => {
    writeFileSync(VM_FILE, JSON.stringify({ lima: 'spore' }))
    for (const args of [['ls'], ['send', 'main', 'hello'], ['vm', 'start']]) {
      const ran = spore(...args)
      expect(ran.status).toBe(2)
      expect(ran.stderr).toMatch(/^spore: spore runs in the vm spore, made with Lima, and limactl is not on PATH/)
    }
  })

  it('is refused when it does not parse', () => {
    writeFileSync(VM_FILE, '{ lima')
    const ran = spore('ls')
    expect(ran.status).toBe(2)
    expect(ran.stderr).toMatch(/vm\.json is not readable JSON/)
  })

  it('is refused when it names no vm', () => {
    writeFileSync(VM_FILE, '{}')
    const ran = spore('ls')
    expect(ran.status).toBe(2)
    expect(ran.stderr).toMatch(/vm\.json names no vm/)
  })
})
