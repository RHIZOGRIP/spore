import { describe, it, expect } from 'vitest'

import { agentEnv } from '../src/delegation/agent-env.js'

const PARENT = {
  PATH: '/usr/bin',
  HOME: '/home/x',
  MODEL: 'anthropic/claude-haiku-4-5',
  TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  SPORE_SPAWN: '/opt/spore/bin/spawn.js',
  SPORE_SQL: '/opt/spore/bin/sql.js',
  ANTHROPIC_API_SK: 'sk-parent',
  OPENAI_API_SK: 'sk-parent',
  GEMINI_API_SK: 'sk-parent',
  BRAVE_API_SK: 'brave-parent',
  AWS_SECRET_ACCESS_KEY: 'aws-parent',
  SOME_FUTURE_PROVIDER_API_SK: 'sk-parent'
}

describe('the environment an agent is given', () => {
  it('passes on what a cell needs to run', () => {
    const env = agentEnv(PARENT)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.MODEL).toBe(PARENT.MODEL)
    expect(env.TRACEPARENT).toBe(PARENT.TRACEPARENT)
    expect(env.SPORE_SPAWN).toBe(PARENT.SPORE_SPAWN)
    expect(env.SPORE_SQL).toBe(PARENT.SPORE_SQL)
  })

  it('passes on no provider key, including one it has never heard of', () => {
    const env = agentEnv(PARENT)
    const secrets = Object.keys(env).filter(k => /_SK$|SECRET|TOKEN|PASSWORD/.test(k))
    expect(secrets).toEqual([])
  })

  // Not granted, so every program that keeps its settings there would fail on it; the
  // supervisor sets the workspace's own `home/` instead.
  it('does not hand down the host\'s home', () => {
    expect(agentEnv(PARENT).HOME).toBeUndefined()
  })

  it('names nothing it was not given', () => {
    expect(agentEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
