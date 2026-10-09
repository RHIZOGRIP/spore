import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail, readCall, readCalls } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.write-contract-workspace')

let tools
let defs

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  const built = makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) }))
  tools = shownToModel(built.fns)
  defs = built.defs
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('write under the call contract', () => {
  it('produces the named file and records it', async () => {
    const meta = JSON.parse(await tools.write({ content: 'hello\n', path: 'data/a.txt' }))
    expect(meta.exit).toBe(0)
    expect(readFileSync(resolve(WS, 'data/a.txt'), 'utf8')).toBe('hello\n')
    expect(meta.files.out.path).toBe('data/a.txt')
    expect(meta.files.out.bytes).toBe(6)
    expect(meta.files.err).toBe(null)
  })

  // The caller supplied those bytes; returning them is a second copy in the
  // transcript for the rest of the run. The trail keeps them, the answer does not.
  it('does not read the content back to the caller that wrote it', async () => {
    const meta = JSON.parse(await tools.write({ content: 'hello\n', path: 'data/a.txt' }))
    expect(meta.files.out.content).toBeUndefined()
    const trail = readCall(WS, 'test', meta.call)
    expect(trail.files.out.content).toBe('hello\n')
  })

  it('creates parent directories', async () => {
    const meta = JSON.parse(await tools.write({ content: 'x', path: 'data/deep/nest/b.txt' }))
    expect(meta.exit).toBe(0)
    expect(readFileSync(resolve(WS, 'data/deep/nest/b.txt'), 'utf8')).toBe('x')
  })

  it('treats the replacement as text, not as a pattern', async () => {
    writeFileSync(resolve(WS, 'data/m.txt'), 'A B C')
    const meta = JSON.parse(await tools.edit({ path: 'data/m.txt', old: 'B', new: '$&' }))
    expect(meta.exit).toBe(0)
    // `$&` is the whole match in a regex replacement, which would leave the file
    // unchanged. The caller named bytes.
    expect(readFileSync(resolve(WS, 'data/m.txt'), 'utf8')).toBe('A $& C')
  })

  it('refuses an empty search rather than matching everywhere', async () => {
    writeFileSync(resolve(WS, 'data/m.txt'), 'A B C')
    expect(await tools.edit({ path: 'data/m.txt', old: '', new: 'x' })).toMatch(/old must not be empty/)
  })

  it('keeps a large file whole and out of the record', async () => {
    const big = 'q'.repeat(90000)
    const meta = JSON.parse(await tools.write({ content: big, path: 'data/big.txt' }))
    expect(meta.files.out.bytes).toBe(90000)
    expect(meta.files.out.content).toBeUndefined()
    expect(readFileSync(resolve(WS, 'data/big.txt'), 'utf8').length).toBe(90000)
  })

  it('refuses missing content rather than writing the string undefined', async () => {
    expect(await tools.write({ path: 'data/a.txt' })).toMatch(/content is required/)
    expect(existsSync(resolve(WS, 'data/a.txt'))).toBe(false)
  })

  it('requires path and refuses dotpaths', async () => {
    expect(await tools.write({ content: 'x' })).toMatch(/path is required/)
    expect(await tools.write({ content: 'x', path: 'data/.hidden/a' })).toMatch(/dotfile/)
  })

  it('refuses a path under calls/, which is the runtime\'s, and edits nothing there', async () => {
    expect(await tools.write({ content: 'x', path: 'calls/mine.txt' })).toMatch(/calls\/ is the runtime's,.* write under data\//)
    expect(existsSync(resolve(WS, 'calls/mine.txt'))).toBe(false)
  })
})

describe('edit under the call contract', () => {
  it('replaces a unique string in place and records the result', async () => {
    writeFileSync(resolve(WS, 'data/a.txt'), 'let x = 1\nlet y = 2\n')
    const meta = JSON.parse(await tools.edit({ path: 'data/a.txt', old: 'x = 1', new: 'x = 42' }))
    expect(meta.exit).toBe(0)
    expect(meta.replaced).toBe(1)
    expect(readFileSync(resolve(WS, 'data/a.txt'), 'utf8')).toBe('let x = 42\nlet y = 2\n')
    expect(meta.files.out.content).toBe('let x = 42\nlet y = 2\n')
  })

  it('refuses when old is absent or repeated, leaving the file untouched', async () => {
    writeFileSync(resolve(WS, 'data/a.txt'), 'a\na\n')
    expect(await tools.edit({ path: 'data/a.txt', old: 'zzz', new: 'q' })).toMatch(/not found in file/)
    expect(await tools.edit({ path: 'data/a.txt', old: 'a', new: 'q' })).toMatch(/found 2 times/)
    expect(readFileSync(resolve(WS, 'data/a.txt'), 'utf8')).toBe('a\na\n')
  })

  it('refuses a non-string replacement rather than writing undefined', async () => {
    writeFileSync(resolve(WS, 'data/a.txt'), 'a\n')
    expect(await tools.edit({ path: 'data/a.txt', old: 'a' })).toMatch(/must be strings/)
    expect(readFileSync(resolve(WS, 'data/a.txt'), 'utf8')).toBe('a\n')
  })

  it('reports a missing target', async () => {
    expect(await tools.edit({ path: 'data/nope.txt', old: 'a', new: 'b' })).toMatch(/not found/)
  })

  it('leaves no call record when it refuses', async () => {
    writeFileSync(resolve(WS, 'data/a.txt'), 'a\na\n')
    await tools.edit({ path: 'data/a.txt', old: 'a', new: 'q' })
    expect(readCalls(WS, 'test')).toEqual([])
  })
})

describe('errors that name the mistake', () => {
  it('tells a caller which parameter it invented', async () => {
    // This case used to assert the opposite: that `path` on a write was an invented
    // parameter. It was the naming that was wrong — a tool acting on a file takes
    // `path`, and only a stream goes to `out`.
    expect(await tools.write({ file: 'data/a.txt', content: 'x' }))
      .toBe('error: unexpected parameter "file" — this tool takes content, path, err')
    expect(await tools.exec({ command: 'true', outt: 'x' }))
      .toMatch(/unexpected parameter "outt" — this tool takes command, out, in, err, timeout/)
  })

  it('still asks for out when nothing stray was passed', async () => {
    expect(await tools.wsexec({ command: 'true' })).toMatch(/out is required/)
  })

  it('keeps timings, hashes and mime out of what the caller sees', async () => {
    const meta = JSON.parse(await tools.write({ content: 'hi', path: 'data/a.txt' }))
    expect(meta.files.out).toEqual({ path: 'data/a.txt', bytes: 2 })
    expect(meta.startedAt).toBeUndefined()
    expect(meta.files.out.hash).toBeUndefined()
    expect(meta.files.out.mime).toBeUndefined()
    expect(typeof meta.durationMs).toBe('number')
  })

  it('still writes the whole record to disk', async () => {
    const meta = JSON.parse(await tools.write({ content: 'hi', path: 'data/a.txt' }))
    const trail = readCall(WS, 'test', meta.call)
    expect(trail.call).toBe('0001')
    expect(typeof trail.durationMs).toBe('number')
    expect(trail.files.out.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(trail.files.out.mime).toBe('text/plain')
    expect(meta.exit).toBe(trail.exit)
  })
})

// Two vocabularies, and the line between them is what a call is doing rather than what
// the record calls the bytes. Agents passed `path` to `write` and `edit` and were told
// they had invented a parameter; the same confusion put `args.path` into session
// memory's write summary, where it read every write as `wrote ?`.
describe('what a file argument is called', () => {
  const schema = (name) => defs.find(d => d.name === name).parameters

  it('names the file `path` wherever a tool acts on one', () => {
    for (const name of ['read', 'write', 'edit']) {
      expect(Object.keys(schema(name).properties)).toContain('path')
      expect(Object.keys(schema(name).properties)).not.toContain('out')
    }
  })

  it('keeps `out` for the tools that redirect a stream into a file', () => {
    for (const name of ['exec', 'wsexec']) {
      expect(Object.keys(schema(name).properties)).toContain('out')
      expect(Object.keys(schema(name).properties)).not.toContain('path')
    }
  })
})

// Measured on a memory benchmark: twelve of twelve instances put a *message* in `err`
// ("Could not save notes"), because that is what the word invites even though the schema
// says "workspace path". `path` had a sentence for that mistake; `err` was the one target
// never checked against the islands, so it reached `openSync` and came back as a raw
// `EACCES` quoting an absolute host path.
describe('err names a file, and says so when it does not', () => {
  it('refuses a message in err with an explanation rather than an EACCES', async () => {
    const result = await tools.write({ path: 'data/notes.md', content: 'x', err: 'Could not save notes' })
    expect(result).toMatch(/err is where the failure message is written, not the message itself/)
    expect(result).not.toMatch(/EACCES/)
  })

  it('still accepts an err path under the islands', async () => {
    const meta = JSON.parse(await tools.write({ path: 'data/notes.md', content: 'x', err: 'data/w.err' }))
    expect(meta.exit).toBe(0)
  })
})
