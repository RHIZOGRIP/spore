import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { showPlugin } from '@rhizogrip/spore'
import { describe, expect, it } from 'vitest'

import { exitOf, run } from '../src/run.js'

const SOCKET = '/run/user/1000/sluice/spores/main/sluice.sock'

const calling = (outcome, { listed = null } = {}) => {
  const said = []
  const printed = []
  const called = []
  const code = run(outcome.argv, {
    socket: 'socket' in outcome ? outcome.socket : SOCKET,
    call: (socket, argv) => {
      called.push([socket, argv])
      if (outcome.unreachable) throw new Error('connect ENOENT')
      return outcome.status
    },
    list: (socket) => {
      called.push([socket, '--list'])
      if (listed === null) throw new Error('connect ENOENT')
      return listed
    },
    print: (text) => printed.push(text),
    say: (line) => said.push(line)
  })
  return { code, said, called, printed }
}

describe('the sluice plugin', () => {
  it('is a plugin spore accepts, giving its program, the spore its own socket, and hiding the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spore-plugin-sluice-'))
    try {
      const shown = showPlugin('sluice', { configFile: join(dir, 'no-config.json') })
      expect(shown).toMatchObject({
        package: '@rhizogrip/spore-plugin-sluice',
        programs: { SPORE_SLUICE: join(shown.dir, 'bin/sluice.js') },
        env: { SPORE_SLUICE_SOCKET: '{settings.dir}/spores/{name}/sluice.sock' },
        contain: { hide: '{settings.dir}', keep: '{settings.dir}/spores/{name}' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a call through the broker', () => {
  it('hands the whole command line to the socket and exits with the command\'s own code', () => {
    const { code, called, said } = calling({ argv: ['systemctl', '--user', 'restart', 'shop.service'], status: 3 })
    expect(called).toEqual([[SOCKET, ['systemctl', '--user', 'restart', 'shop.service']]])
    expect(code).toBe(3)
    expect(said).toEqual([])
  })

  it('exits as sluicify does when the broker refuses, and says why', () => {
    expect(exitOf(-1)).toEqual({ code: 129, said: expect.stringContaining('no rule allows') })
    expect(exitOf(-7)).toEqual({ code: 124, said: expect.stringContaining('past the time') })
    expect(exitOf(-8).code).toBe(136)
    expect(exitOf(-42)).toEqual({ code: 170, said: 'the broker refused the call (-42)' })
  })

  it('exits 2 when no broker answers, or none is named, and calls nothing without a command', () => {
    expect(calling({ argv: ['uptime'], unreachable: true })).toMatchObject({ code: 2, said: [expect.stringContaining(`${SOCKET} cannot be reached`)] })
    expect(calling({ argv: ['uptime'], socket: undefined })).toMatchObject({ code: 2, called: [], said: [expect.stringContaining('spore plugin allow sluice dir=')] })
    expect(calling({ argv: [] })).toMatchObject({ code: 2, called: [] })
  })
})

describe('what the agent may run', () => {
  it('is what the broker lists of its rules', () => {
    const listed = 'uptime\n  How long the host has been up.\n'
    expect(calling({ argv: ['--list'] }, { listed })).toMatchObject({ code: 0, called: [[SOCKET, '--list']], printed: [listed] })
  })

  it('says so when the broker cannot list them, rather than inviting a guess', () => {
    expect(calling({ argv: ['--list'] })).toMatchObject({ code: 2, said: [expect.stringContaining('ask rather than try')] })
  })
})
