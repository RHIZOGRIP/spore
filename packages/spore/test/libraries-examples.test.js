import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { PROVISIONED_MODULES, agentEnv, provisionModules } from '../src/delegation/agent-env.js'
import { writeTurnRecords } from '../src/core/spore-dir.js'
import { SHIPPED_SPORANGIA, knownSporangia } from '../src/core/sporangia.js'

const run = promisify(execFile)
const LIBRARIES = knownSporangia()
  .map(one => [one, join(SHIPPED_SPORANGIA, one, 'libraries.md')])
  .filter(([, path]) => existsSync(path))

/**
 * Every example in every sporangium's `libraries.md` is run, and its stated output has to be the output.
 * A ```js fence followed by a plain fence is one example: the code, then its stdout.
 *
 * The file the agent reads is the file under test — no generation step, so an example
 * cannot drift from what it claims. When a library changes its API under us, this is
 * what says so.
 */
function examples (markdown) {
  const found = []
  const fence = /```js\n([\s\S]*?)```\n+```\n([\s\S]*?)```/g
  for (const [, code, output] of markdown.matchAll(fence)) found.push({ code, output })
  return found
}

// Outside the repo: node resolves a bare import by walking up, so a workspace under this
// checkout would answer from spore's own node_modules and prove nothing.
let WS = null

beforeAll(async () => {
  WS = resolve(mkdtempSync(join(tmpdir(), 'spore-libraries-')), 'ws')
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  provisionModules(WS)
  writeTurnRecords(WS, [
    { startedAt: '2026-09-27T10:00:00.000Z', stopReason: 'answer', concluded: true, treeMicros: 12500 },
    { startedAt: '2026-09-27T11:00:00.000Z', stopReason: 'question', concluded: true, treeMicros: 3000 }
  ])
})

afterAll(() => {
  if (WS) rmSync(resolve(WS, '..'), { recursive: true, force: true })
})

describe.each(LIBRARIES)('the examples in the %s sporangium\'s libraries.md', (sporangium, path) => {
  const markdown = readFileSync(path, 'utf8')

  it('shows every library that is provisioned', () => {
    for (const name of PROVISIONED_MODULES) {
      // The import line, not a mention: an entry with no example is not a capability
      // the agent can use.
      expect(markdown).toMatch(new RegExp(`from '${name.replace('.', '\\.')}(/[a-z]+)?'`))
    }
  })

  it.each(examples(markdown).map((ex, i) => [i, ex.code.split('\n').find(l => l.includes('from ')) || `example ${i}`, ex]))(
    'runs example %i — %s',
    async (i, _label, ex) => {
      const file = resolve(WS, 'data', `example-${sporangium}-${i}.mjs`)
      writeFileSync(file, ex.code)
      const { stdout } = await run(process.execPath, [file], { cwd: WS, env: agentEnv(process.env) })
      expect(stdout.trim()).toBe(ex.output.trim())
    },
    30000
  )
})
