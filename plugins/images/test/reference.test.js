import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { showPlugin } from '@rhizogrip/spore'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'spore-plugin-images-'))

const installed = (name) => {
  for (let dir = ROOT; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name))) return realpathSync(join(dir, 'node_modules', name))
  }
  throw new Error(`${name} is not installed above ${ROOT}`)
}

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

describe('the images plugin', () => {
  it('is a plugin spore accepts, offering sharp', () => {
    const shown = showPlugin('images', { configFile: join(SCRATCH, 'no-config.json') })
    expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-images', modules: ['sharp'], allowed: false })
  })

  // Outside the repo, with only the link spore lays: a workspace under the checkout would
  // find sharp in the repo's own node_modules and prove nothing.
  it('runs the example its reference shows, with the output it shows', async () => {
    const ws = join(SCRATCH, 'ws')
    mkdirSync(join(ws, 'node_modules'), { recursive: true })
    symlinkSync(installed('sharp'), join(ws, 'node_modules', 'sharp'))

    const [, code, output] = readFileSync(join(ROOT, 'reference.md'), 'utf8').match(/```js\n([\s\S]*?)```\n+```\n([\s\S]*?)```/)
    writeFileSync(join(ws, 'example.mjs'), code)
    const { stdout } = await run(process.execPath, [join(ws, 'example.mjs')], { cwd: ws })
    expect(stdout.trim()).toBe(output.trim())
  }, 30000)
})
