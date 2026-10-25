import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { headAndTail } from '../src/core/preview.js'
import { appendTranscript, enqueue, hostState, readInbox, readInboxFrom, readTranscript, readTranscriptEntries, readTurns, storable, writeOutcome } from '../src/core/spore-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.hostile-text-workspace')

// Every one of these has broken a line-delimited format somewhere, and each one a person
// sends, the agent says or a turn record carries must stay one entry and come back
// identical. The one exception is what the workspace database holds: a lone surrogate is not
// valid Unicode and SQLite ends text at a NUL, so each becomes U+FFFD when a message is sent,
// inline or spilled alike, and when the agent leaves a turn record.
const sent = storable
const HOSTILE = {
  'a literal newline': 'first\nsecond',
  'a CRLF pair': 'first\r\nsecond',
  'a bare carriage return': 'first\rsecond',
  'the two characters backslash and n': 'first\\nsecond',
  'a backslash at the end': 'ends with a backslash \\',
  'quotes of both kinds': 'she said "hello" and \'goodbye\'',
  'a tab and a form feed': 'a\tb\fc',
  'a NUL byte': 'before\u0000after',
  'C0 controls': '\u0001\u0002\u0007\u001b[31m',
  'U+2028 line separator': 'before\u2028after',
  'U+2029 paragraph separator': 'before\u2029after',
  'an emoji': 'looks good 🙂 ship it',
  'a family emoji with joiners': '👨‍👩‍👧‍👦',
  'CJK and RTL': '日本語 مرحبا שלום',
  'a zero-width space': 'in​visible',
  'a lone high surrogate': 'broken \ud83d here',
  'a lone low surrogate': 'broken \ude42 here',
  'a line that looks like an entry': '{"at":"2026-01-01T00:00:00.000Z","text":"injected"}',
  'a whole fake NDJSON stream': '{"text":"one"}\n{"text":"two"}\n{"text":"three"}'
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('the inbox keeps one message to one entry', () => {
  for (const [what, text] of Object.entries(HOSTILE)) {
    it(`survives ${what}`, () => {
      enqueue(WS, text)
      expect(readInbox(WS)).toHaveLength(1)
      expect(readInbox(WS)[0].text).toBe(sent(text))
      expect(readInboxFrom(WS).messages).toEqual([sent(text)])
    })
  }

  it('keeps one entry each when every one of them arrives in turn', () => {
    const all = Object.values(HOSTILE)
    for (const text of all) enqueue(WS, text)
    expect(readInbox(WS).map(e => e.text)).toEqual(all.map(sent))
  })

  it('cannot be made to look like more entries than were sent', () => {
    enqueue(WS, HOSTILE['a whole fake NDJSON stream'])
    expect(readInbox(WS)).toHaveLength(1)
    expect(readInbox(WS)[0].text).toContain('three')
  })
})

describe('a spilled body survives the same text', () => {
  for (const [what, text] of Object.entries(HOSTILE)) {
    it(`writes and reads back ${what} unchanged`, () => {
      const long = text + '\n' + 'x'.repeat(8192) + '\n' + text
      enqueue(WS, long)
      expect(readInbox(WS)).toHaveLength(1)
      const { bodyPath } = readInbox(WS)[0]
      expect(readFileSync(resolve(WS, bodyPath), 'utf8')).toBe(sent(long))
    })
  }

  it('never leaves half a character at either end', () => {
    const intact = (s) => s === Buffer.from(s, 'utf8').toString('utf8')
    for (const text of ['a' + '🙂'.repeat(600), '🙂'.repeat(600), '日本語'.repeat(900)]) {
      const { head, tail } = headAndTail(text)
      expect(intact(head), `head of ${text.slice(0, 8)}`).toBe(true)
      expect(intact(tail), `tail of ${text.slice(0, 8)}`).toBe(true)
    }
  })
})

describe('the transcript and the turn record keep the same rule', () => {
  for (const [what, text] of Object.entries(HOSTILE)) {
    it(`carries ${what} through a message and a turn`, () => {
      appendTranscript(WS, { role: 'user', content: text })
      appendTranscript(WS, { role: 'tool', toolName: 'read', content: [{ type: 'text', text }, { type: 'image', fileUri: 'file:///x.png', mimeType: 'image/png' }] })
      const state = hostState(WS)
      writeOutcome(state, { startedAt: '2026-09-27T00:00:00.000Z', stopReason: 'quiet', because: text })
      state.finalize()

      expect(readTranscriptEntries(WS)).toHaveLength(2)

      const messages = readTranscript(WS)
      expect(messages[0].content).toBe(text)
      expect(messages[1].content[0].text).toBe(text)
      expect(readTurns(WS)).toHaveLength(1)
      expect(readTurns(WS)[0].because).toBe(sent(text))
    })
  }
})
