import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { showPlugin } from '@rhizogrip/spore'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'spore-plugin-documents-'))
const WS = join(SCRATCH, 'ws')

const installed = (name) => {
  for (let dir = ROOT; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name))) return realpathSync(join(dir, 'node_modules', name))
  }
  throw new Error(`${name} is not installed above ${ROOT}`)
}

const examples = [...readFileSync(join(ROOT, 'reference.md'), 'utf8').matchAll(/```js\n([\s\S]*?)```\n+```\n([\s\S]*?)```/g)]
  .map(([, code, output]) => ({ code, output, label: code.split('\n').find(line => line.includes(' from ')) }))

// Outside the repo, with only the links spore lays: a workspace under the checkout would
// find each library in the repo's own node_modules and prove nothing.
beforeAll(async () => {
  mkdirSync(join(WS, 'data'), { recursive: true })
  mkdirSync(join(WS, 'node_modules'))
  for (const name of MANIFEST.spore.modules) symlinkSync(installed(name), join(WS, 'node_modules', name))
  await run(process.execPath, [join(ROOT, 'test/fixtures/make-documents.mjs')], { cwd: WS })
})

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

describe('the documents plugin', () => {
  it('is a plugin spore accepts, offering each library its reference shows', () => {
    const shown = showPlugin('documents', { configFile: join(SCRATCH, 'no-config.json') })
    expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-documents', modules: MANIFEST.spore.modules, allowed: false })
    for (const name of MANIFEST.spore.modules) expect(examples.some(ex => ex.code.includes(`from '${name}'`)), name).toBe(true)
  })

  it.each(examples.map((ex, i) => [i, ex.label, ex]))('runs example %i — %s', async (i, _label, ex) => {
    const file = join(WS, 'data', `example-${i}.mjs`)
    writeFileSync(file, ex.code)
    const { stdout } = await run(process.execPath, [file], { cwd: WS })
    expect(stdout.trim()).toBe(ex.output.trim())
  }, 30000)
})
