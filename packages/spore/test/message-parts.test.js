import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { textOf } from '../src/core/message.js'
import { compactIfNeeded, estimateTokens } from '../src/resilience/context-guard.js'
import { compactHistory } from '../src/resilience/compaction.js'
import { createSessionMemory } from '../src/resilience/session-memory.js'
import { silent } from '../src/observability/logger.js'
import { createLoopGuard } from '../src/resilience/loop-guard.js'
import { sanitizeTranscript } from '../src/resilience/transcript.js'

const pictures = mkdtempSync(join(tmpdir(), 'message-parts-'))
afterAll(() => rmSync(pictures, { recursive: true, force: true }))
const picture = (name) => {
  const path = join(pictures, name)
  writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  return path
}
const image = { type: 'image', fileUri: pathToFileURL(picture('page-7.jpg')).href, mimeType: 'image/jpeg' }
const parts = (text) => [{ type: 'text', text }, image]
// A tool result is kept only after the assistant message that asked for it.
const asked = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }

// Every consumer of a message's text was written when `content` was only ever a string.
// A part array answers `.length` with a part count, `.trim()` with a TypeError and `===`
// with reference identity — so two of these fail loudly and the rest fail silently, which
// is why the string path passing proves nothing about this one.
describe('a message whose content is parts', () => {
  it('reads as its text, whichever shape it is in', () => {
    expect(textOf({ content: 'plain' })).toBe('plain')
    expect(textOf({ content: parts('looked') })).toBe('looked')
    expect(textOf({ content: [image] })).toBe('')
    expect(textOf({ content: null })).toBe('')
    expect(textOf(undefined)).toBe('')
  })

  it('is measured by its characters, not its part count', () => {
    const long = 'x'.repeat(4000)
    expect(estimateTokens([{ role: 'tool', content: parts(long) }]))
      .toBeGreaterThan(estimateTokens([{ role: 'tool', content: 'xx' }]))
  })

  it('is truncated to its text when a tool result is over budget', () => {
    const messages = [asked, { role: 'tool', toolCallId: 'c1', toolName: 'read', content: parts('y'.repeat(500)) }]
    sanitizeTranscript(messages, { maxResultSize: 100 })
    expect(typeof messages[1].content).toBe('string')
    expect(messages[1].content.length).toBeLessThan(200)
    expect(messages[1].content).toMatch(/truncated/)
  })

  it('keeps its image when the text is within budget', () => {
    const messages = [asked, { role: 'tool', toolCallId: 'c1', toolName: 'read', content: parts('short') }]
    sanitizeTranscript(messages, { maxResultSize: 10000 })
    expect(messages[1].content).toEqual(parts('short'))
  })

  it('becomes a note when its picture was removed after it was looked at', () => {
    const path = picture('removed.jpg')
    const gone = { type: 'image', fileUri: pathToFileURL(path).href, mimeType: 'image/jpeg' }
    rmSync(path)
    const warned = []
    const logger = { ...silent, warn: (fields) => warned.push(fields) }
    const messages = [asked, { role: 'tool', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'looked' }, gone] }]
    sanitizeTranscript(messages, { maxResultSize: 10000, logger })
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'looked' },
      { type: 'text', text: `[a picture was looked at here: ${path}, which is no longer on disk]` }
    ])
    expect(warned).toEqual([{ path, why: 'is no longer on disk' }])
  })

  it('becomes a note when its picture can no longer be read', () => {
    const path = picture('locked.jpg')
    chmodSync(path, 0o000)
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image', fileUri: pathToFileURL(path).href, mimeType: 'image/jpeg' }] }]
    sanitizeTranscript(messages)
    expect(messages[0].content[1]).toEqual({ type: 'text', text: `[a picture was looked at here: ${path}, which can no longer be read (EACCES)]` })
  })

  it('keeps a picture that is inline rather than on disk', () => {
    const inline = { type: 'image', fileUri: 'data:image/png;base64,iVBORw==', mimeType: 'image/png' }
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'see this' }, inline] }]
    sanitizeTranscript(messages)
    expect(messages[0].content[1]).toBe(inline)
  })

  it('is compacted away like any other oversized tool result', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: parts('z'.repeat(8000)) },
      { role: 'user', content: 'and now' },
      { role: 'assistant', content: 'done' }
    ]
    compactIfNeeded(messages, { contextLimit: 1000, protectTail: 2 })
    expect(typeof messages[2].content).toBe('string')
  })

  it('does not crash the summarizer, and its text reaches the summary', async () => {
    const messages = [
      { role: 'user', content: parts('look at this') },
      { role: 'assistant', content: parts('I see a stamp'), toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: parts('exit 0') },
      { role: 'user', content: 'keep going' },
      { role: 'assistant', content: 'ok' }
    ]
    let said = null
    const model = { answer: async (prompt) => { said = prompt[1].content; return { output: 'summary' } } }
    await compactHistory(messages, { model, contextLimit: 200, onCompacted: () => {} })
    expect(said).toContain('look at this')
    expect(said).not.toContain('[object Object]')
  })

  it('does not crash session memory, which reads every role', () => {
    const memory = createSessionMemory({ logger: silent })
    expect(() => memory.extract([
      { role: 'user', content: parts('a question worth keeping') },
      { role: 'assistant', content: parts('some reasoning worth keeping around here') },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: parts('exit 0') }
    ])).not.toThrow()
    expect(memory.getFacts().some(f => f.text.includes('a question worth keeping'))).toBe(true)
  })

  // `repeat.content === outcome.content` is reference identity, so two arrays holding
  // the same bytes are never equal and the detector would quietly stop detecting.
  it('is compared by its text, so the repeat detector still sees a repeat', () => {
    const guard = createLoopGuard({})
    for (let i = 0; i < 5; i++) {
      guard.observe([{ id: 'c1', name: 'read', arguments: { path: 'data/x.png' } }])
      guard.record([{ toolName: 'read', toolCallId: 'c1', content: parts('exit 0') }])
    }
    expect(guard.stalled()).toMatchObject({ tool: 'read' })
  })
})
