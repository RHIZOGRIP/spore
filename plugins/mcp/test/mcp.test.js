import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { showPlugin } from '@rhizogrip/spore'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP = join(ROOT, 'bin/mcp.js')
const SERVER = join(ROOT, 'test/fixtures/server.mjs')

let ws
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'spore-plugin-mcp-'))
  mkdirSync(join(ws, 'data'))
  writeFileSync(join(ws, 'data/mcp.json'), JSON.stringify({
    fixture: { command: process.execPath, args: [SERVER] },
    broken: { command: join(ws, 'no-such-server') }
  }))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const mcp = (...args) => promisify(execFile)(process.execPath, [MCP, ...args], { cwd: ws }).catch(err => err)

describe('the mcp plugin', () => {
  it('is a plugin spore accepts, giving its program', () => {
    const shown = showPlugin('mcp', { configFile: join(ws, 'no-config.json') })
    expect(shown).toMatchObject({ package: '@rhizogrip/spore-plugin-mcp', programs: { SPORE_MCP: join(shown.dir, 'bin/mcp.js') } })
  })

  it('lists the servers, and each tool with its first line', async () => {
    expect((await mcp('--list')).stdout).toMatch(/^fixture\s+\S*node \S*server\.mjs$/m)
    const { stdout } = await mcp('fixture', '--tools')
    expect(stdout).toMatch(/^echo\s+Says back what it was given\.$/m)
    expect(stdout).not.toMatch(/A second line/)
  })

  it('describes a tool by its schema, and refuses one the server does not have', async () => {
    const described = JSON.parse((await mcp('fixture', '--describe', 'weather')).stdout)
    expect(described.inputSchema.properties.city.type).toBe('string')
    expect(described.outputSchema.properties.celsius.type).toBe('number')
    const missing = await mcp('fixture', '--describe', 'nothing')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/fixture has no tool nothing/)
  })

  it('writes a text result to the file and says what it wrote', async () => {
    writeFileSync(join(ws, 'data/args.json'), JSON.stringify({ text: 'hello' }))
    const { stdout } = await mcp('fixture', 'echo', '--args', 'data/args.json', '--out', 'data/echo.txt')
    expect(JSON.parse(stdout)).toEqual({ server: 'fixture', tool: 'echo', ok: true, out: 'data/echo.txt', bytes: 6, files: [] })
    expect(readFileSync(join(ws, 'data/echo.txt'), 'utf8')).toBe('hello\n')
  })

  it('writes the structured content when the server gives it, and to stdout with --out -', async () => {
    writeFileSync(join(ws, 'data/args.json'), JSON.stringify({ city: 'Muscat' }))
    const { stdout, stderr } = await mcp('fixture', 'weather', '--args', 'data/args.json', '--out', '-')
    expect(JSON.parse(stdout)).toEqual({ city: 'Muscat', celsius: 21 })
    expect(JSON.parse(stderr)).toMatchObject({ tool: 'weather', ok: true, out: '-' })
  })

  it('puts an image beside the result, and refuses one on stdout rather than drop it', async () => {
    const { stdout } = await mcp('fixture', 'pixel', '--out', 'data/pixel.txt')
    expect(JSON.parse(stdout).files).toEqual(['data/pixel.txt.1.png'])
    expect(readFileSync(join(ws, 'data/pixel.txt.1.png')).subarray(1, 4).toString()).toBe('PNG')
    const onStdout = await mcp('fixture', 'pixel', '--out', '-')
    expect(onStdout.code).toBe(1)
    expect(onStdout.stderr).toMatch(/1 part\(s\) that are not text/)
  })

  it('exits 1 on a tool that answers an error, its text in the file', async () => {
    const failed = await mcp('fixture', 'fails', '--out', 'data/fails.txt')
    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.stdout).ok).toBe(false)
    expect(readFileSync(join(ws, 'data/fails.txt'), 'utf8')).toBe('it went wrong\n')
  })

  it('refuses a server it does not know, and says why one did not start', async () => {
    const unknown = await mcp('nowhere', '--tools')
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toMatch(/no server called nowhere/)
    const broken = await mcp('broken', '--tools')
    expect(broken.code).toBe(1)
    expect(broken.stderr).toMatch(/broken did not start or answer/)
  })

  it('makes many calls in one session, one line each', async () => {
    writeFileSync(join(ws, 'data/calls.jsonl'), [
      { tool: 'echo', args: { text: 'one' }, out: 'one.txt' },
      { tool: 'fails', out: 'two.txt' },
      { tool: 'echo', args: { text: 'three' }, out: 'three.txt' }
    ].map(line => JSON.stringify(line)).join('\n'))
    mkdirSync(join(ws, 'data/out'))
    const run = await mcp('fixture', '--calls', 'data/calls.jsonl', '--out-dir', 'data/out')
    expect(run.code).toBe(1)
    expect(run.stdout.trim().split('\n').map(line => JSON.parse(line).ok)).toEqual([true, false, true])
    expect(readFileSync(join(ws, 'data/out/three.txt'), 'utf8')).toBe('three\n')
  })

  it('gives up on a request past its timeout', async () => {
    const slow = await mcp('fixture', 'slow', '--out', 'data/slow.txt', '--timeout', '1')
    expect(slow.code).toBe(1)
    expect(JSON.parse(slow.stdout)).toMatchObject({ tool: 'slow', ok: false })
    expect(existsSync(join(ws, 'data/slow.txt'))).toBe(false)
  }, 10000)
})
