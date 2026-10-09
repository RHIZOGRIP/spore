import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

// Deleting a module is easy to check for importers and easy to forget in here, so
// the map is checked against the disk rather than trusted.
describe('the published entry points', () => {
  it('all resolve to files that exist', () => {
    const missing = Object.entries(pkg.exports)
      .filter(([, target]) => !existsSync(resolve(ROOT, target)))
      .map(([name, target]) => `${name} → ${target}`)
    expect(missing).toEqual([])
  })

  // The README taught `runSpore` for an hour after it stopped being exported. A doc
  // that fails on its first line is worse than no doc.
  it('exports everything the README imports', async () => {
    const api = await import('../src/index.js')
    const md = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
    const imported = [...md.matchAll(/import \{([^}]+)\} from '@rhizogrip\/spore'/g)]
      .flatMap(match => match[1].split(',').map(name => name.trim()))
    expect(imported.length).toBeGreaterThan(0)
    expect(imported.filter(name => !(name in api))).toEqual([])
  })

  it('exports everything the root README, INTEGRATION.md and docs/library.md import', async () => {
    const api = await import('../src/index.js')
    for (const doc of ['../../README.md', '../../INTEGRATION.md', '../../docs/library.md']) {
      const md = readFileSync(resolve(ROOT, doc), 'utf8')
      const imported = [...md.matchAll(/import \{([^}]+)\} from '@rhizogrip\/spore'/g)]
        .flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean))
      expect(imported.filter(name => !(name in api)), doc).toEqual([])
    }
  })

  it('documents every export in docs/library.md, once, and nothing it does not export', async () => {
    const api = Object.keys(await import('../src/index.js')).sort()
    const entries = [...readFileSync(resolve(ROOT, '../../docs/library.md'), 'utf8').matchAll(/^### `([^`]+)`$/gm)]
      .map(match => match[1]).sort()
    expect(entries).toEqual(api)
  })
})
