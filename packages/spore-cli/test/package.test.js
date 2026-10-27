import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const core = createRequire(import.meta.url)('@rhizogrip/spore/package.json')

describe('the published command', () => {
  it('names a binary that exists', () => {
    for (const target of Object.values(pkg.bin)) {
      expect(existsSync(resolve(ROOT, target))).toBe(true)
    }
  })

  it('depends on exactly the core it is released with', () => {
    expect(pkg.optionalDependencies['@rhizogrip/spore']).toBe(core.version)
    expect(pkg.version).toBe(core.version)
  })

  it('installs on any system, the core only where it is built for', () => {
    expect(pkg.os).toBeUndefined()
    expect(pkg.dependencies['@rhizogrip/spore']).toBeUndefined()
    expect(core.os).toEqual(['linux'])
  })
})
