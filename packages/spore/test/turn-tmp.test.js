import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCallTrail } from '../src/core/call-record.js'
import { producedIn } from '../src/core/produced.js'
import { hostState, linkTurnTmp } from '../src/core/spore-dir.js'
import { makeTools } from '../src/tools/make-tools.js'
import { shownToModel } from './fixtures/as-shown.js'

const WS = resolve(dirname(fileURLToPath(import.meta.url)), '.turn-tmp-workspace')

let trail
let tools

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  trail = createCallTrail(WS, { runId: 'first', state: hostState(WS) })
  linkTurnTmp(WS, trail.root)
  tools = shownToModel(makeTools(WS, 50000, trail).fns)
})

afterEach(() => rmSync(WS, { recursive: true, force: true }))

describe("a turn's tmp/", () => {
  it('is a link to a directory of the turn\'s run, pointed afresh each turn', () => {
    expect(lstatSync(resolve(WS, 'tmp')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(resolve(WS, 'tmp'))).toBe('calls/first/tmp')
    const next = createCallTrail(WS, { runId: 'second', state: hostState(WS) })
    linkTurnTmp(WS, next.root)
    expect(readlinkSync(resolve(WS, 'tmp'))).toBe('calls/second/tmp')
    expect(existsSync(resolve(WS, 'calls/first/tmp'))).toBe(true)
  })

  it('refuses to replace a tmp/ that is not its own link', () => {
    rmSync(resolve(WS, 'tmp'))
    mkdirSync(resolve(WS, 'tmp'))
    expect(() => linkTurnTmp(WS, trail.root)).toThrow(expect.objectContaining({ type: 'WORKSPACE_TMP_TAKEN' }))
  })

  it('takes a program written, edited and run within the turn, and none of it is produced', async () => {
    const since = new Date(Date.now() - 1000).toISOString()
    expect(JSON.parse(await tools.write({ path: 'tmp/fix.sh', content: 'echo first\n' })).exit).toBe(0)
    expect(JSON.parse(await tools.edit({ path: 'tmp/fix.sh', old: 'first', new: 'second' })).exit).toBe(0)
    expect(JSON.parse(await tools.wsexec({ command: 'sh tmp/fix.sh' })).files.out.content).toBe('second\n')
    expect(readFileSync(resolve(WS, 'calls/first/tmp/fix.sh'), 'utf8')).toBe('echo second\n')
    expect(producedIn(WS, since).produced.map(file => file.path)).toEqual([])
  })

  it('is the TMPDIR of every command, and the one place exec writes', async () => {
    const tmp = resolve(WS, 'calls/first/tmp')
    expect(JSON.parse(await tools.wsexec({ command: 'echo "$TMPDIR"' })).files.out.content).toBe(`${tmp}\n`)
    expect(JSON.parse(await tools.exec({ command: 'echo kept > "$TMPDIR/spill" && cat tmp/spill' })).files.out.content).toBe('kept\n')
    expect(JSON.parse(await tools.exec({ command: 'echo no > data/x' })).exit).not.toBe(0)
    expect(existsSync(resolve(WS, 'data/x'))).toBe(false)
  })

  it('leaves the rest of calls/ to the runtime', async () => {
    expect(await tools.write({ path: 'calls/first/notes.md', content: 'x' })).toMatch(/is the runtime's/)
  })
})
