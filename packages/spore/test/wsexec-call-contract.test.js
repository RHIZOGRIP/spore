import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail, readCall } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.exec-contract-workspace')

let exec
let wsexec
let trail

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  trail = createCallTrail(WS, { runId: 'test', state: hostState(WS) })
  const tools = shownToModel(makeTools(WS, 50000, trail).fns)
  exec = tools.wsexec
  wsexec = tools.wsexec
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('wsexec under the call contract', () => {
  it('writes stdout to the caller-named path and inlines it when short', async () => {
    const meta = JSON.parse(await exec({ command: 'echo hello', out: 'data/result.txt' }))
    expect(meta.exit).toBe(0)
    expect(readFileSync(resolve(WS, 'data/result.txt'), 'utf8')).toBe('hello\n')
    expect(meta.files.out.path).toBe('data/result.txt')
    expect(meta.files.out.content).toBe('hello\n')
    const trail = readCall(WS, 'test', meta.call)
    expect(trail.files.out.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('redirects a caller-named in to stdin, seekably', async () => {
    writeFileSync(resolve(WS, 'data/data.txt'), 'b\na\nc\n')
    const meta = JSON.parse(await exec({ command: 'sort', in: 'data/data.txt', out: 'data/sorted.txt' }))
    expect(meta.exit).toBe(0)
    expect(meta.files.out.content).toBe('a\nb\nc\n')
    expect(meta.files.in.path).toBe('data/data.txt')
  })

  it('reports a missing in before running anything', async () => {
    const result = await exec({ command: 'cat', in: 'data/absent.txt', out: 'data/o.txt' })
    expect(result).toMatch(/in not found/)
    expect(existsSync(resolve(WS, 'data/o.txt'))).toBe(false)
  })

  it('keeps stderr out of out, and surfaces the exit code', async () => {
    const meta = JSON.parse(await exec({ command: 'echo oops >&2 && exit 3', out: 'data/o.txt', err: 'data/e.txt' }))
    expect(meta.exit).toBe(3)
    expect(meta.files.out.bytes).toBe(0)
    expect(meta.files.err.content).toBe('oops\n')
  })

  it('refuses an out or err named under calls/, and still names its own streams there', async () => {
    expect(await wsexec({ command: 'echo hi', out: 'calls/mine.txt' })).toMatch(/calls\/ is the runtime's/)
    expect(await wsexec({ command: 'echo hi', out: 'data/hi.txt', err: 'calls/mine.err' })).toMatch(/calls\/ is the runtime's/)
    expect(JSON.parse(await exec({ command: 'echo hi >&2', out: 'data/o.txt' })).files.err.path).toMatch(/^calls\//)
  })

  it('auto-names stderr in the workspace, reachable and extensionless', async () => {
    const meta = JSON.parse(await exec({ command: 'echo diag >&2', out: 'data/o.txt' }))
    expect(meta.files.err.path).toBe('calls/test/0001/err')
    const trail = readCall(WS, 'test', meta.call)
    expect(trail.files.err.mime).toBe('text/plain')
    expect(meta.files.err.content).toBe('diag\n')
    expect(readFileSync(resolve(WS, 'calls/test/0001/err'), 'utf8')).toBe('diag\n')
  })

  it('reports err as null rather than an empty file it created', async () => {
    const meta = JSON.parse(await exec({ command: 'echo quiet', out: 'data/o.txt' }))
    expect(meta.files.err).toBe(null)
    expect(existsSync(resolve(WS, 'calls/test', meta.call, 'err'))).toBe(false)
    // The call's own directory stays: it still holds the record.
    expect(readCall(WS, 'test', meta.call)).not.toBe(null)
  })

  it('keeps a caller-named err even when it is empty', async () => {
    const meta = JSON.parse(await exec({ command: 'echo quiet', out: 'data/o.txt', err: 'data/e.txt' }))
    expect(meta.files.err.bytes).toBe(0)
    expect(existsSync(resolve(WS, 'data/e.txt'))).toBe(true)
  })

  it('does not truncate large output and does not inline it', async () => {
    const meta = JSON.parse(await exec({ command: 'yes abcdefgh | head -100000', out: 'data/big.txt' }))
    expect(meta.exit).toBe(0)
    expect(meta.files.out.bytes).toBe(900000)
    expect(meta.files.out.content).toBeUndefined()
    expect(readFileSync(resolve(WS, 'data/big.txt'), 'utf8').length).toBe(900000)
  })

  it('does not inline binary output', async () => {
    const meta = JSON.parse(await exec({ command: 'printf "a\\000b" > raw.bin && echo done', out: 'data/o.txt' }))
    expect(meta.exit).toBe(0)
    const bin = JSON.parse(await exec({ command: 'cat raw.bin', out: 'data/copy.bin' }))
    expect(bin.files.out.bytes).toBe(3)
    expect(bin.files.out.content).toBeUndefined()
  })

  it('records the call in the trail', async () => {
    const meta = JSON.parse(await exec({ command: 'echo x', out: 'data/o.txt' }))
    const recorded = readCall(WS, 'test', meta.call)
    expect(recorded.tool).toBe(meta.tool)
    expect(recorded.exit).toBe(meta.exit)
    expect(recorded.tool).toBe('wsexec')
    expect(recorded.command).toBe('echo x')
    expect(typeof recorded.durationMs).toBe('number')
  })

  it('names stdout itself when out is not given, and refuses dotpaths', async () => {
    const meta = JSON.parse(await wsexec({ command: 'echo x' }))
    expect(meta.exit).toBe(0)
    expect(meta.files.out.path).toMatch(/^calls\/[^/]+\/[^/]+\/out$/)
    expect(await exec({ command: 'echo x', out: 'data/.hidden/o.txt' })).toMatch(/dotfile/)
  })

  // The pattern blacklist that used to sit here refused `grep -n 'shutdown' manual.md`
  // and `node halt-analysis.js`, and stopped nothing the kernel does not already stop:
  // the root is a read path, `exec` runs read-only, and rebooting needs a capability an
  // unprivileged user does not have. What is left is the command's own judgement.
  it('runs a command the old blacklist refused, and lets it answer for itself', async () => {
    const record = JSON.parse(await wsexec({ command: 'rm -rf / ', out: 'data/o.txt' }))
    expect(record.exit).not.toBe(0)
    expect(record.files.err.content).toMatch(/dangerous|preserve-root/)
  })
})
