import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { serviceSecrets, turnEnv } from '../src/core/turn-env.js'

const ref = (name) => `\${${name}}`

let root
let config
let roots

const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
}
const beside = (name) => join(dirname(config), name)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spore-turn-env-'))
  config = join(root, 'config', 'config.json')
  roots = [join(root, 'node_modules')]
  write(config, { approvals: { kpi: { url: 'https://kpi.example/approve', secret: ref('KPI_SECRET') } } })
  write(beside('hooks.json'), { hooks: { build: { spore: 'ci', secret: ref('HOOK_SECRET') } } })
  write(beside('api.json'), { callers: { app: { token: ref('API_TOKEN'), spores: ['*'] } } })
  const relay = join(roots[0], 'spore-plugin-relay')
  write(join(relay, 'package.json'), {
    name: 'spore-plugin-relay',
    version: '0.1.0',
    spore: { works: '^1', services: { relay: { what: 'a relay, each bot reaching its spore', program: './bin/relay.js', instances: { dir: 'relay', ext: '.json', called: 'bot' } } } }
  })
  write(join(relay, 'bin', 'relay.js'), '')
  write(beside('relay/triage.json'), { token: ref('RELAY_TOKEN') })
  write(beside('relay/notes.md'), `not a bot: ${ref('NOT_A_BOT')}`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const launched = { PATH: '/usr/bin:/bin', OPENAI_API_SK: 'sk-1', KPI_SECRET: 'k', HOOK_SECRET: 'h', API_TOKEN: 'a', RELAY_TOKEN: 'r', NOT_A_BOT: 'n' }

describe('what a runner starts with', () => {
  it('knows the secret each of the host\'s services keeps', () => {
    expect(serviceSecrets(config, { roots })).toEqual(new Set(['HOOK_SECRET', 'API_TOKEN', 'KPI_SECRET', 'RELAY_TOKEN']))
  })

  it('is the launch environment without them, which it leaves as it was', () => {
    const given = { ...launched }
    expect(turnEnv(given, { configFile: config, roots })).toEqual({ PATH: '/usr/bin:/bin', OPENAI_API_SK: 'sk-1', NOT_A_BOT: 'n' })
    expect(given).toEqual(launched)
  })

  it('keeps a secret a source the runner may fill names', () => {
    write(beside('sources.json'), { ci: { url: 'https://ci.example', headers: { authorization: `Bearer ${ref('HOOK_SECRET')}` } } })
    write(beside('memory.json'), { url: 'https://vectors.example', headers: { key: ref('API_TOKEN') } })
    const plugins = { chat: { url: 'https://chat.example', headers: { token: ref('RELAY_TOKEN') } } }
    expect(turnEnv(launched, { configFile: config, sources: plugins, roots })).toEqual({ PATH: '/usr/bin:/bin', OPENAI_API_SK: 'sk-1', NOT_A_BOT: 'n', HOOK_SECRET: 'h', API_TOKEN: 'a', RELAY_TOKEN: 'r' })
  })

  it('reads the environment beside config.json at each start, and refuses one it cannot read', () => {
    write(beside('environment'), 'ADDED=1\nAPI_TOKEN=from-file\n')
    expect(turnEnv({ PATH: '/bin' }, { configFile: config, roots })).toEqual({ PATH: '/bin', ADDED: '1' })
    write(beside('environment'), 'ADDED=2\n')
    expect(turnEnv({ PATH: '/bin' }, { configFile: config, roots })).toEqual({ PATH: '/bin', ADDED: '2' })
    write(beside('environment'), 'export ADDED=3\n')
    expect(() => turnEnv({ PATH: '/bin' }, { configFile: config, roots })).toThrow(expect.objectContaining({ type: 'ENVIRONMENT_INVALID' }))
  })
})
