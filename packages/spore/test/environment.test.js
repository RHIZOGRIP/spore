import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadEnvironment } from '../src/library/config.js'

let dir
let config

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spore-environment-'))
  config = join(dir, 'config.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (text) => writeFileSync(join(dir, 'environment'), text)

describe('the environment beside config.json', () => {
  it('sets what it names, as systemd would read the same file', () => {
    write('# keys\nOPENAI_API_SK=sk-1\n; old style\n\nPATH="/usr/bin:/bin"\nTOKEN=\'a b\'\nEMPTY=\n')
    const env = {}
    expect(loadEnvironment(config, env).loaded).toEqual(['OPENAI_API_SK', 'PATH', 'TOKEN', 'EMPTY'])
    expect(env).toEqual({ OPENAI_API_SK: 'sk-1', PATH: '/usr/bin:/bin', TOKEN: 'a b', EMPTY: '' })
  })

  it('leaves what the process already has, so a variable given on the command line wins', () => {
    write('OPENAI_API_SK=from-file\nBRAVE_API_SK=brave\n')
    const env = { OPENAI_API_SK: 'from-shell' }
    loadEnvironment(config, env)
    expect(env).toEqual({ OPENAI_API_SK: 'from-shell', BRAVE_API_SK: 'brave' })
  })

  it('expands nothing', () => {
    write('PATH=$HOME/bin:$PATH\n')
    const env = {}
    loadEnvironment(config, env)
    expect(env.PATH).toBe('$HOME/bin:$PATH')
  })

  it('is no environment when the file is absent', () => {
    const env = {}
    expect(loadEnvironment(config, env).loaded).toEqual([])
    expect(env).toEqual({})
  })

  it('refuses a line systemd would not read, naming it', () => {
    write('OK=1\nexport TOKEN=abc\n')
    expect(() => loadEnvironment(config, {})).toThrow(/environment:2 is not KEY=value/)
  })
})
