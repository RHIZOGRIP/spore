import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sniffImage } from '../src/core/media.js'
import { parseDefinition, sizeBytes } from '../src/delegation/definition.js'
import { kernelOf } from './fixtures/collaborators.js'
import { estimateTokens } from '../src/resilience/context-guard.js'
import { makeTools } from '../src/tools/make-tools.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { createCallTrail, recorded } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { textOf } from '../src/core/message.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.images-workspace')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)])

const tools = (opts) => shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'img', state: hostState(WS) }), opts).fns)

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('what a file is, from its bytes', () => {
  it('names the four formats a vision model takes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(Buffer.from('GIF89a' + 'x'.repeat(10)))).toBe('image/gif')
  })

  it('reads the container, not the magic — a RIFF that is not WEBP is not an image', () => {
    expect(sniffImage(WAV)).toBeNull()
  })

  it('says nothing about text, or about too few bytes to tell', () => {
    expect(sniffImage(Buffer.from('hello world'))).toBeNull()
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
    expect(sniffImage(null)).toBeNull()
  })

  it('ignores the name, because a downloaded file is named by its URL', async () => {
    writeFileSync(resolve(WS, 'data/thing.txt'), PNG)
    const read = tools({ images: { count: 4, bytes: 1_000_000 } }).read
    const result = await read({ path: 'data/thing.txt' })
    expect(result.images?.[0].mimeType).toBe('image/png')
  })
})

describe('read returns the picture', () => {
  it('comes back as an image part beside the record, not as text', async () => {
    writeFileSync(resolve(WS, 'data/shot.png'), PNG)
    const read = tools({ images: { count: 4, bytes: 1_000_000 } }).read

    const result = await read({ path: 'data/shot.png' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/png')
    expect(result.images[0].fileUri.startsWith('file://')).toBe(true)
    expect(JSON.parse(result.content).mime).toBe('image/png')
    expect(JSON.parse(result.content).content).toBeUndefined()
  })

  it('refuses when the definition grants no images, and says which line is missing', async () => {
    writeFileSync(resolve(WS, 'data/shot.png'), PNG)
    const result = await tools({}).read({ path: 'data/shot.png' })
    expect(result).toMatch(/not granted images/)
    expect(result).toMatch(/images: \[count, size\]/)
  })

  it('comes back whole whatever slice is asked for, and the record says what was ignored', async () => {
    writeFileSync(resolve(WS, 'data/shot.png'), PNG)
    const read = tools({ images: { count: 4, bytes: 1_000_000 } }).read
    const sliced = await read({ path: 'data/shot.png', offset: 1, length: 1, encoding: 'utf-8', unit: 'lines' })
    expect(sliced.images).toHaveLength(1)
    expect(JSON.parse(sliced.content).ignored).toEqual(['offset', 'length', 'encoding', 'unit'])
    const blank = await read({ path: 'data/shot.png', offset: 0, length: 0, encoding: '', unit: '' })
    expect(blank.images).toHaveLength(1)
    expect(JSON.parse(blank.content).ignored).toEqual(['offset', 'length'])
    expect(JSON.parse((await read({ path: 'data/shot.png' })).content).ignored).toBeUndefined()
  })

  it('still reads text as text', async () => {
    writeFileSync(resolve(WS, 'data/notes.md'), 'plain words\n')
    const result = await tools({ images: { count: 4, bytes: 1_000_000 } }).read({ path: 'data/notes.md' })
    expect(typeof result).toBe('string')
    expect(JSON.parse(result).content).toBe('plain words\n')
  })
})

describe('the cap is per turn, and both halves of it bite', () => {
  it('stops at the count, naming what is left to do', async () => {
    for (const n of [1, 2, 3]) writeFileSync(resolve(WS, `data/${n}.png`), PNG)
    const read = tools({ images: { count: 2, bytes: 1_000_000 } }).read

    expect((await read({ path: 'data/1.png' })).images).toHaveLength(1)
    expect((await read({ path: 'data/2.png' })).images).toHaveLength(1)
    expect(await read({ path: 'data/3.png' })).toMatch(/2 image\(s\) is all this turn may look at/)
  })

  it('stops at the bytes, saying how much budget is left', async () => {
    writeFileSync(resolve(WS, 'data/a.png'), PNG)
    writeFileSync(resolve(WS, 'data/b.png'), PNG)
    const read = tools({ images: { count: 10, bytes: PNG.length + 1 } }).read

    expect((await read({ path: 'data/a.png' })).images).toHaveLength(1)
    expect(await read({ path: 'data/b.png' })).toMatch(/byte image budget left/)
  })

  it('counts nothing against a turn that was refused', async () => {
    writeFileSync(resolve(WS, 'data/big.png'), Buffer.concat([PNG, Buffer.alloc(16)]))
    writeFileSync(resolve(WS, 'data/ok.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(2)]))
    const read = tools({ images: { count: 1, bytes: PNG.length } }).read

    expect(await read({ path: 'data/big.png' })).toMatch(/byte image budget left/)
    expect((await read({ path: 'data/ok.png' })).images).toHaveLength(1)
  })
})

describe('the kernel carries it into the message', () => {
  const call = (name, args = {}) => ({ id: 'c1', name, arguments: args })

  it('builds parts when a tool returns images, and leaves text alone when it does not', async () => {
    const toolFns = {
      look: async () => recorded({ tool: 'look', exit: 0 }, [{ fileUri: 'file:///x.png', mimeType: 'image/png' }]),
      plain: async () => 'exit 0'
    }
    const [withImage] = await kernelOf({ toolCalls: [call('look')], toolFns })
    expect(Array.isArray(withImage.content)).toBe(true)
    expect(withImage.content[0]).toEqual({ type: 'text', text: JSON.stringify({ tool: 'look', exit: 0 }) })
    expect(withImage.content[1]).toEqual({ type: 'image', fileUri: 'file:///x.png', mimeType: 'image/png' })

    const [withoutImage] = await kernelOf({ toolCalls: [call('plain')], toolFns })
    expect(withoutImage.content).toBe('exit 0')
  })

  it('reads the outcome from the text half, so an image does not hide a failure', async () => {
    const seen = []
    const emitter = { emit: (type, payload) => seen.push([type, payload]), on () {} }
    const toolFns = {
      look: async () => recorded({ tool: 'look', exit: 1 }, [{ fileUri: 'file:///x.png', mimeType: 'image/png' }])
    }
    const [message] = await kernelOf({ toolCalls: [call('look')], toolFns, emitter })
    expect(textOf(message)).toBe(JSON.stringify({ tool: 'look', exit: 1 }))
    const end = seen.find(([type]) => type === 'tool_end')[1]
    expect(end.error).toBe(true)
    expect(end.images).toBe(1)
  })
})

describe('an image is not free, and the guard has to see that', () => {
  it('costs more than its zero characters', () => {
    const text = { role: 'tool', content: 'abcd' }
    const withImage = { role: 'tool', content: [{ type: 'text', text: 'abcd' }, { type: 'image', fileUri: 'file:///x.png', mimeType: 'image/png' }] }
    expect(estimateTokens([withImage])).toBeGreaterThan(estimateTokens([text]) + 100)
  })
})

describe('the definition declares what may be looked at', () => {
  const withFields = (extra) => parseDefinition(
    `---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [4, 6]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\n${extra}---\n\nIdentity.\n`,
    { knownTools: TOOL_NAMES })

  it('reads a count and a size', () => {
    expect(withFields('images: [4, 10MB]\n').images).toEqual({ count: 4, bytes: 10 * 1024 * 1024 })
  })

  it('is absent by default, which is how a definition says it cannot look', () => {
    expect(withFields('').images).toBeUndefined()
  })

  it('refuses a shape that is not a count and a size', () => {
    expect(withFields('images: 4\n').error).toMatch(/count and a size/)
    expect(withFields('images: [4]\n').error).toMatch(/count and a size/)
  })

  it('refuses a count or a size it cannot read', () => {
    expect(withFields('images: [0, 10MB]\n').error).toMatch(/images count it cannot read/)
    expect(withFields('images: [4, lots]\n').error).toMatch(/images size it cannot read/)
  })

  it('understands the sizes a person writes', () => {
    expect(sizeBytes('10MB')).toBe(10 * 1024 * 1024)
    expect(sizeBytes('512KB')).toBe(512 * 1024)
    expect(sizeBytes('2048')).toBe(2048)
    expect(sizeBytes('nope')).toBeNull()
  })
})
