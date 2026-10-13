import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail, readCall } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.exec-ro-workspace')

let exec
let wsexec

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'sub'), { recursive: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  writeFileSync(resolve(WS, 'data/data.txt'), 'alpha\nbeta\n')
  writeFileSync(resolve(WS, 'sub/other.txt'), 'gamma\n')
  const tools = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns)
  exec = tools.exec
  wsexec = tools.wsexec
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('exec is read-only', () => {
  it('reads the workspace and answers inline without a named out', async () => {
    const meta = JSON.parse(await exec({ command: 'find . -name "*.txt" -type f | sort' }))
    expect(meta.exit).toBe(0)
    expect(meta.files.out.content).toBe('./data/data.txt\n./sub/other.txt\n')
    expect(meta.files.out.path).toBe('calls/test/0001/out')
  })

  it('runs real grep in place of the retired builtin', async () => {
    const meta = JSON.parse(await exec({ command: 'grep -rn beta .' }))
    expect(meta.files.out.content).toMatch(/data\.txt:2:beta/)
  })

  it('reads what a plugin the spore uses ships, wherever the plugin is installed', async () => {
    const plugin = outsideRoot('exec-plugin-reads')
    try {
      writeFileSync(resolve(plugin, 'program.txt'), 'from the plugin\n')
      expect(JSON.parse(await exec({ command: `cat ${plugin}/program.txt` })).exit).not.toBe(0)

      const granted = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'plugin', state: hostState(WS) }), { pluginReads: [plugin] }).fns)
      const meta = JSON.parse(await granted.exec({ command: `cat ${plugin}/program.txt` }))
      expect(meta.exit).toBe(0)
      expect(meta.files.out.content).toBe('from the plugin\n')
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  it('cannot write to the workspace', async () => {
    const meta = JSON.parse(await exec({ command: 'echo nope > blocked.txt' }))
    expect(meta.exit).not.toBe(0)
    expect(existsSync(resolve(WS, 'blocked.txt'))).toBe(false)
    expect(meta.files.err.content).toMatch(/Permission denied/)
  })

  // Truncating a file that exists and creating one that does not are different
  // permissions, which is why this is not the test above with another name. It ran
  // `data.txt` — nothing is there, so it was a second creation test.
  it('cannot modify an existing file', async () => {
    const meta = JSON.parse(await exec({ command: 'echo overwritten > data/data.txt' }))
    expect(meta.exit).not.toBe(0)
    expect(meta.files.err.content).toMatch(/Permission denied/)
    expect(readFileSync(resolve(WS, 'data/data.txt'), 'utf8')).toBe('alpha\nbeta\n')
  })

  it('allows /dev/null, which is a sink rather than storage', async () => {
    const meta = JSON.parse(await exec({ command: 'ls missing 2>/dev/null; echo survived' }))
    expect(meta.exit).toBe(0)
    expect(meta.files.out.content).toBe('survived\n')
    expect(meta.files.err).toBe(null)
  })

  it('drops an auto-named out that stayed empty', async () => {
    const meta = JSON.parse(await exec({ command: 'true' }))
    expect(meta.files.out).toBe(null)
    expect(existsSync(resolve(WS, 'calls/test', meta.call, 'out'))).toBe(false)
    // The call's own directory stays: it still holds the record.
    expect(readCall(WS, 'test', meta.call)).not.toBe(null)
  })

  it('honours a caller-named out', async () => {
    const meta = JSON.parse(await exec({ command: 'wc -l < data/data.txt' }))
    expect(meta.files.out.content.trim()).toBe('2')
    const named = JSON.parse(await exec({ command: 'echo hi', out: 'data/kept.txt' }))
    expect(named.files.out.path).toBe('data/kept.txt')
    expect(readFileSync(resolve(WS, 'data/kept.txt'), 'utf8')).toBe('hi\n')
  })
})

describe('wsexec may write', () => {
  it('writes to the workspace where exec cannot', async () => {
    const meta = JSON.parse(await wsexec({ command: 'echo made > made.txt && echo done', out: 'data/log.txt' }))
    expect(meta.exit).toBe(0)
    expect(readFileSync(resolve(WS, 'made.txt'), 'utf8')).toBe('made\n')
    expect(meta.files.out.content).toBe('done\n')
  })

  it('names stdout itself when out is not given, as exec does', async () => {
    expect(JSON.parse(await wsexec({ command: 'echo x' })).files.out.path).toMatch(/^calls\//)
  })
})

describe('a write exec was refused', () => {
  it('says the refusal was exec\'s, when the error names a place that is writable', async () => {
    const meta = JSON.parse(await exec({ command: 'mkdir -p data/out && echo x > data/out/answers.json' }))
    expect(meta.exit).not.toBe(0)
    expect(meta.hint).toMatch(/exec is read-only/)
    expect(meta.hint).toMatch(/write, edit or wsexec/)
  })

  it('says nothing when the failure is not a refused write', async () => {
    const meta = JSON.parse(await exec({ command: 'echo nope >&2; exit 3' }))
    expect(meta.exit).toBe(3)
    expect(meta.hint).toBeUndefined()
  })

  it('says nothing when what was refused is not somewhere the agent could write', async () => {
    const meta = JSON.parse(await exec({ command: 'touch /etc/spore-probe' }))
    expect(meta.exit).not.toBe(0)
    expect(meta.hint).toBeUndefined()
  })

  it('never hints on wsexec, which can write', async () => {
    const meta = JSON.parse(await wsexec({ command: 'touch /etc/spore-probe', out: 'data/w.txt' }))
    expect(meta.exit).not.toBe(0)
    expect(meta.hint).toBeUndefined()
  })
})
