/**
 * The store: what the workspace makes retrievable, and what comes back.
 *
 * Every number these tests pin came from `bench/longmemeval` rather than from taste, so
 * they are written to hold the *behaviour* the measurements argued for — sentence-sized
 * push, turn-sized pull expanded through its anchors, both sources in one index, and
 * reinforcement surviving IDF's habit of punishing it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openStore, RECALL_BUDGET_TOKENS } from '../src/memory/store.js'
import { chunksOf, expand, SENTENCE, TURN } from '../src/memory/chunks.js'
import { bm25 } from '../src/memory/bm25.js'
import { appendCompaction, appendTranscript, hostState, isTranscriptAnchor, readEvents, readTranscript, readTranscriptEntries, readTurns } from '../src/core/spore-dir.js'
import { runSpore } from '../src/core/spore-run.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.memory-store-workspace')

const note = (path, body) => {
  mkdirSync(dirname(resolve(WS, path)), { recursive: true })
  writeFileSync(resolve(WS, path), body)
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('what a workspace makes retrievable', () => {
  it('indexes the notes and the conversation together', () => {
    note('data/memory/person.md', '# Person\n\nOwns a Sony A7R IV and a 24-70mm lens for photography.\n')
    appendTranscript(WS, { role: 'user', content: 'I bought a Gitzo GT3543LS tripod last week.' })

    const texts = chunksOf(WS, SENTENCE).map(chunk => chunk.text)
    expect(texts.some(t => t.includes('Sony A7R IV'))).toBe(true)
    expect(texts.some(t => t.includes('Gitzo'))).toBe(true)
  })

  // A fact the agent neglected to write down is still reachable in the record, which is
  // what stops curation being a single point of loss.
  it('reaches a fact that was said but never written down', async () => {
    note('data/memory/person.md', '# Person\n\nLikes photography.\n')
    appendTranscript(WS, { role: 'user', content: 'My sister Marguerite lives in Lisbon and teaches violin.' })

    const [hit] = await openStore(WS).push('where does Marguerite live', 3)
    expect(hit.text).toMatch(/Marguerite/)
    expect(isTranscriptAnchor(WS, hit.anchor)).toBe(true)
  })

  it('anchors every chunk to a path and a position', () => {
    note('data/memory/person.md', '# Person\n\nOwns a Sony A7R IV and a 24-70mm lens for photography.\n')
    const [chunk] = chunksOf(WS, SENTENCE)
    expect(chunk.anchor.path).toBe('data/memory/person.md')
    expect(Number.isInteger(chunk.anchor.line)).toBe(true)
  })

  // This was a twenty-character floor, which also discarded `City: Oslo.` — exactly the
  // terse note the agent is told to keep. Size cannot tell a fact from a fragment.
  it('keeps a short fact and drops what is only punctuation', () => {
    note('data/memory/person.md', '# Person\n\nCity: Oslo.\n---\n\nOwns a Sony A7R IV and a 24-70mm lens for photography.\n')
    const texts = chunksOf(WS, SENTENCE).map(chunk => chunk.text)
    expect(texts).toContain('City: Oslo.')
    expect(texts.some(t => /^[-#*\s]+$/.test(t))).toBe(false)
    // A heading names a section rather than stating something, and as a chunk it is a
    // short line of pure keyword.
    expect(texts).not.toContain('# Person')
  })

  it('keeps a short thing the person said', () => {
    appendTranscript(WS, { role: 'user', content: 'My pet is Margot.' })
    expect(chunksOf(WS, SENTENCE).map(c => c.text)).toContain('My pet is Margot.')
  })

  // `/[a-z0-9']+/g` produced no terms at all for a query in another script, so a note
  // plainly stored was unreachable.
  it('finds a note written in a script without spaces', async () => {
    note('data/memory/travel.md', '# 旅行\n每年秋天去京都旅行。\n')
    const [hit] = await openStore(WS).push('京都', 3)
    expect(hit.text).toContain('京都')
  })
})

describe('following an anchor out', () => {
  it('widens a note to the section it sits under', () => {
    note('data/memory/person.md', '# Gear\n\nOwns a Sony A7R IV camera body.\nUses a 24-70mm f/2.8 lens most of the time.\n\n# Travel\n\nGoes to Portugal every spring for a fortnight.\n')
    const gear = chunksOf(WS, SENTENCE).find(chunk => chunk.text.includes('24-70mm'))
    const around = expand(WS, gear.anchor)
    expect(around).toContain('# Gear')
    expect(around).toContain('Sony A7R IV')
    expect(around).not.toContain('Portugal')
  })

  it('widens a transcript hit to the messages either side of it', () => {
    for (const content of ['first thing said', 'the middle message mentioning Lisbon', 'third thing said']) {
      appendTranscript(WS, { role: 'user', content })
    }
    const hit = chunksOf(WS, TURN).find(chunk => chunk.text.includes('Lisbon'))
    const around = expand(WS, hit.anchor)
    expect(around).toContain('first thing said')
    expect(around).toContain('third thing said')
  })
})

describe('push and pull', () => {
  const stocked = () => {
    note('data/memory/person.md', '# Gear\n\nOwns a Sony A7R IV and a Sony 24-70mm f/2.8 lens.\nWants a camera bag suitable for Sony equipment.\n\n# Travel\n\nGoes to Portugal every spring, usually to Lisbon.\n')
    appendTranscript(WS, { role: 'user', content: 'I was thinking about a Gitzo GT3543LS tripod for the landscape work.' })
  }

  it('push returns sentence-sized hits, small enough to afford unasked', async () => {
    stocked()
    const hits = await openStore(WS).push('what camera gear do I have', 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(3)
    expect(hits[0].text).toMatch(/Sony/)
    // One line, not the section around it — that is pull's job.
    expect(hits[0].text.split('\n')).toHaveLength(1)
  })

  it('pull returns the section around each hit', async () => {
    stocked()
    const [first] = await openStore(WS).pull('what camera gear do I have', 5)
    expect(first.text).toContain('# Gear')
    expect(first.anchor.path).toBe('data/memory/person.md')
  })

  it('takes the depth from the definition rather than from the runtime', async () => {
    stocked()
    const store = openStore(WS, { push: 1 })
    expect(await store.push('Sony')).toHaveLength(1)
    expect(await store.push('Sony', 2)).toHaveLength(2)
  })

  it('refuses a backend it does not have', () => {
    expect(() => openStore(WS, { backend: 'embeddings' })).toThrow(/unknown memory backend/)
  })

  it('says nothing when nothing matches', async () => {
    stocked()
    expect(await openStore(WS).push('quantum chromodynamics', 5)).toEqual([])
  })
})

// IDF punishes repetition: a term in many chunks scores lower in each of them, so a fact
// said often can rank below one said once. Ranking does not correct for it, and these
// tests say so rather than implying otherwise — the aggregation that claimed to was
// grouping by anchor, which is unique per chunk, so it never combined anything.
describe('what repetition does to a score', () => {
  it('scores each mention lower as a fact is repeated', async () => {
    const one = bm25([{ text: 'user prefers sony gear for photography' }, ...Array.from({ length: 20 }, (_, n) => ({ text: `unrelated remark number ${n} about other things` }))])
    const many = bm25([...Array.from({ length: 10 }, () => ({ text: 'user prefers sony gear for photography' })), ...Array.from({ length: 11 }, (_, n) => ({ text: `unrelated remark number ${n} about other things` }))])
    const [rare] = await one.query('sony')
    const [common] = await many.query('sony')
    expect(common).toBeLessThan(rare)
  })

  // A known limitation, pinned so that implementing reinforcement has to change this
  // test on purpose rather than pass it by accident. Both candidates are in the query,
  // which the previous version of this got wrong: it asked for `camera`, the Gitzo aside
  // does not contain that word, and the comparison was skipped.
  it('does not yet rank a much-repeated fact above a passing mention', async () => {
    note('data/memory/person.md', [
      '# May', '', 'The user mentioned their Sony camera again while planning a trip.', '',
      '# June', '', 'The user talked about the Sony camera and its lens at length.', '',
      '# July', '', 'The user is still using the Sony camera for everything.', '',
      '# Aside', '', 'The user once mentioned owning a Gitzo tripod, in passing.', ''
    ].join('\n'))

    const hits = await openStore(WS).pull('Sony Gitzo', 10)
    const gitzo = hits.findIndex(hit => hit.text.includes('Gitzo'))
    const sony = hits.findIndex(hit => hit.text.includes('Sony'))
    expect(gitzo).toBeGreaterThanOrEqual(0)
    expect(sony).toBeGreaterThanOrEqual(0)
    expect(gitzo).toBeLessThan(sony)
  })
})

// The transcript is indexed and the turn being answered is in it, so the store's best hit
// was once the question itself — measured at 16.88 against the next chunk's 2.00, a slot
// of five spent handing back what had just been asked. The current turn is excluded by
// position now, not by resemblance.
describe('memory is what was said before now', () => {
  it('does not return the question as a memory of itself', async () => {
    note('data/memory/person.md', '# Gear\n\nInterested in camera accessories and protecting photography gear.\nOwns a Sony A7R IV and a Sony 24-70mm f/2.8 lens.\n')
    const question = 'Can you suggest some accessories for my photography setup?'
    appendTranscript(WS, { role: 'user', content: question })

    const hits = await openStore(WS, { horizon: 0 }).push(question, 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(hit => isTranscriptAnchor(WS, hit.anchor))).toBe(false)
    expect(hits[0].text).toMatch(/accessories/)
  })

  it('excludes the live turn however it is worded', async () => {
    note('data/memory/person.md', '# Gear\n\nInterested in camera accessories and protecting photography gear.\n')
    const question = 'Can you suggest some accessories for my photography setup?'
    // The runtime prefixes a date, so the turn is not textually the question. Position
    // does not care.
    appendTranscript(WS, { role: 'user', content: `Today is 2023/05/30 (Tue) 05:04. ${question}` })

    const hits = await openStore(WS, { horizon: 0 }).pull(question, 5)
    expect(hits.some(hit => isTranscriptAnchor(WS, hit.anchor))).toBe(false)
    expect(hits[0].text).toContain('accessories')
  })

  // The veto that used to do this job suppressed any hit whose text contained the query,
  // so a good specific search lost the only answer: `project release password` is a
  // prefix of the note stating it.
  it('answers a query that is a prefix of the fact it is looking for', async () => {
    note('data/memory/secrets.md', '# Ops\nProject release password is marigold.\n')
    const [hit] = await openStore(WS).push('project release password', 3)
    expect(hit.text).toContain('marigold')
  })

  it('still returns an earlier turn that merely resembles the question', async () => {
    appendTranscript(WS, { role: 'user', content: 'I bought a Sony A7R IV last spring and have used it since.' })
    const hits = await openStore(WS).push('what did I buy last spring', 5)
    expect(isTranscriptAnchor(WS, hits[0].anchor)).toBe(true)
  })
})

// Long-term memory is exactly what short-term no longer holds. A turn still in context is
// already in front of the model; it becomes the store's when it is evicted.
describe('the store holds what has left the context', () => {
  const conversation = () => {
    appendTranscript(WS, { role: 'user', content: 'Long ago I bought a Sony A7R IV for landscape photography.' })
    appendTranscript(WS, { role: 'user', content: 'Later I added a Gitzo GT3543LS tripod to the kit.' })
    appendTranscript(WS, { role: 'user', content: 'Today I am asking about Sony accessories and tripods.' })
  }

  it('indexes evicted turns and not the ones still in context', async () => {
    conversation()
    // The first two turns have been evicted; the third is live.
    const hits = await openStore(WS, { horizon: 2 }).push('Sony tripod', 5)
    const lines = hits.map(hit => hit.text)
    expect(lines.some(line => line.includes('A7R IV'))).toBe(true)
    expect(lines.some(line => line.includes('Gitzo'))).toBe(true)
    expect(lines.some(line => line.includes('Today I am asking'))).toBe(false)
  })

  it('cannot answer a question with the question, whatever the query', async () => {
    conversation()
    const live = 'Today I am asking about Sony accessories and tripods.'
    const hits = await openStore(WS, { horizon: 2 }).push(live, 5)
    expect(hits.every(hit => !hit.text.includes('Today I am asking'))).toBe(true)
  })

  it('takes the new horizon when it is opened again after turns are evicted', async () => {
    conversation()
    expect((await openStore(WS, { horizon: 1 }).push('Gitzo tripod', 5)).some(hit => hit.text.includes('Gitzo'))).toBe(false)
    expect((await openStore(WS, { horizon: 2 }).push('Gitzo tripod', 5)).some(hit => hit.text.includes('Gitzo'))).toBe(true)
  })

  it('holds the notes whatever the horizon, since they are never in context', async () => {
    note('data/memory/music.md', '# Music\n\nPlays the violin on Tuesday evenings with a quartet.\n')
    const [hit] = await openStore(WS, { horizon: 0 }).push('violin quartet', 3)
    expect(hit.text).toMatch(/violin/)
  })
})

// The wiring: a turn with memory declared surfaces what it should, in front of what was
// said, and a turn without it is untouched.
describe('recall reaching a turn', () => {
  const seen = []
  const answering = {
    use: () => ({
      answer: async (input) => {
        seen.push(input.at(-1).content)
        return { status: 'completed', output: 'done' }
      }
    })
  }

  const run = async (over = {}) => {
    const state = hostState(WS)
    try {
      return await runSpore({
        prompt: 'What camera accessories would suit me?',
        workspace: WS,
        identity: 'You are a spore under test.',
        modelId: 'fake/model',
        limits: { rounds: { soft: 4, hard: 6 } },
        mo: answering,
        state,
        ...over
      })
    } finally {
      state.finalize()
    }
  }

  beforeEach(() => {
    seen.length = 0
    note('data/memory/person.md', '# Gear\nInterested in camera accessories and protecting photography gear.\nOwns a Sony A7R IV.\n')
  })

  it('puts what surfaced in front of the turn, marked as not said now', async () => {
    await run({ memory: { push: 3 } })
    const sent = seen.at(-1)
    expect(sent).toMatch(/not said now/)
    expect(sent).toMatch(/accessories/)
    // Recall first, the question after it.
    expect(sent.indexOf('Recalled')).toBeLessThan(sent.indexOf('What camera accessories would suit me?'))
  })

  // A floor cannot be chosen without knowing how good the hits recall actually surfaces are,
  // and nothing recorded that. The turn record is where it belongs: the bench already reads
  // them, and a distribution over one run beats a run per candidate threshold.
  it('writes the scores it surfaced into the turn record', async () => {
    await run({ memory: { push: 3 } })

    const turn = readTurns(WS).at(-1)
    expect(turn.recall.length).toBeGreaterThan(0)
    expect(turn.recall.every(score => score > 0)).toBe(true)
    expect(turn.recall).toEqual([...turn.recall].sort((a, b) => b - a))
  })

  it('surfaces nothing when no hit clears the floor, and says so by staying silent', async () => {
    await run({ memory: { push: 3, floor: 1000 } })

    expect(seen.at(-1)).toBe('What camera accessories would suit me?')
    expect(readTurns(WS).at(-1).recall).toEqual([])
  })

  it('carries the anchor, which is provenance and the way down', async () => {
    await run({ memory: { push: 3 } })
    expect(seen.at(-1)).toMatch(/\(data\/memory\/person\.md:\d+\)/)
  })

  // A backend that reaches a service can fail where BM25 cannot. Losing the turn over it
  // would be worse than answering without recall, and a run has to be able to tell the
  // two apart rather than read a rate limit as a worse mechanism.
  it('answers the turn when the store cannot be reached, and says the recall was lost', async () => {
    const result = await run({ memory: { backend: 'vectors', push: 3, pull: 5 } })

    expect(result.output).toBe('done')
    expect(seen.at(-1)).toBe('What camera accessories would suit me?')
    expect(readEvents(WS, { event: 'recall' })).toMatchObject([{ hits: 0, failed: 'STORE_UNCONFIGURED' }])
  })

  // A store that takes the connection and never answers, which is what a hung vector store looks
  // like from the agent: only the turn's own signal can end the wait.
  const silentStore = async () => {
    const socketPath = brokerSocketPath('silent-store')
    const held = new Set()
    const server = createServer((conn) => { held.add(conn); conn.on('error', () => {}) })
    await new Promise(resolve => server.listen(socketPath, resolve))
    return {
      socketPath,
      close: () => new Promise(resolve => {
        for (const conn of held) conn.destroy()
        server.close(() => { try { unlinkSync(socketPath) } catch {} resolve() })
      })
    }
  }
  const embedding = 'e/small'
  const embedsToo = {
    use: (id) => id === embedding
      ? { info: () => ({ dimensions: 2 }), embed: async (input) => ({ vectors: input.map(() => [1, 0]), dimensions: 2, cost: 0 }) }
      : answering.use(id)
  }
  const recalling = { backend: 'vectors', push: 3, pull: 5, embedding }

  it('ends a turn stuck in recall when it is cancelled, without reporting memory as failed', async () => {
    const store = await silentStore()
    const stop = new AbortController()
    try {
      setTimeout(() => stop.abort(), 100)
      const result = await run({
        mo: embedsToo,
        memory: recalling,
        storeSocket: store.socketPath,
        signal: stop.signal
      })
      expect(result.stopReason).toBe('cancelled')
      expect(readEvents(WS, { event: 'recall' })).toEqual([])
      expect(seen).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('ends a turn stuck in recall at its hard wall', async () => {
    const store = await silentStore()
    try {
      const result = await run({
        mo: embedsToo,
        memory: recalling,
        storeSocket: store.socketPath,
        limits: { rounds: { soft: 4, hard: 6 }, wall: { soft: 100, hard: 200 } }
      })
      expect(result.stopReason).toBe('hard:wall')
      expect(seen).toEqual([])
    } finally {
      await store.close()
    }
  })

  // Recall reaches the model and is never written down. The transcript is what the store
  // indexes, so a recalled line persisted as user speech becomes evidence of itself: the
  // note is deleted, the fact returns from the record it wrote itself into, and every
  // recall of it adds another copy that outranks the original.
  it('does not write recall into the record as something the user said', async () => {
    await run({ memory: { push: 3 } })
    const persisted = readTranscript(WS).filter(m => m.role === 'user').map(m => m.content)
    expect(persisted).toEqual(['What camera accessories would suit me?'])
    expect(persisted.join('')).not.toMatch(/Recalled/)
    // …while the model did see it.
    expect(seen.at(-1)).toMatch(/Recalled/)
  })

  it('cannot resurrect a note that has been deleted', async () => {
    await run({ memory: { push: 3 } })
    rmSync(resolve(WS, 'data/memory/person.md'), { force: true })

    // What the user actually said is still there and should be — that is the record
    // working. What must not be there is the note, which now exists nowhere.
    const hits = await openStore(WS, { push: 5 }).push('camera accessories photography', 5)
    expect(hits.every(hit => !hit.text.includes('protecting photography gear'))).toBe(true)
    expect(hits.every(hit => !hit.text.includes('Recalled'))).toBe(true)
  })

  it('leaves the turn alone when the definition declares no memory', async () => {
    await run()
    expect(seen.at(-1)).toBe('What camera accessories would suit me?')
  })

  it('leaves the turn alone when nothing surfaces', async () => {
    await run({ prompt: 'quantum chromodynamics', memory: { push: 3 } })
    expect(seen.at(-1)).toBe('quantum chromodynamics')
  })
})

// `data/` is the working directory: grep output, listings, half-finished scratch. Indexed
// wholesale, one of five push slots went to a `data/scan.txt` holding a line of grep output
// that quoted the note it was displacing.
describe('memory is a place, not everything written', () => {
  it('reads the memory directory and leaves the scratch alone', async () => {
    note('data/memory/person.md', '# Gear\nOwns a Sony A7R IV and a Sony 24-70mm lens.\n')
    note('data/scan.txt', 'data/memory/person.md:2:- Owns a Sony A7R IV and a Sony 24-70mm lens.\n')
    note('data/ls.txt', 'person.md\nscan.txt\nnotes.md\n')

    const hits = await openStore(WS).push('Sony lens', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(hit => hit.anchor.path.startsWith('data/memory/'))).toBe(true)
  })

  // The conversation is the second source and is indexed whatever the agent filed where.
  it('still reads the record, which is not under data/ at all', async () => {
    appendTranscript(WS, { role: 'user', content: 'My sister Marguerite teaches violin in Lisbon.' })
    const [hit] = await openStore(WS).push('who teaches violin', 3)
    expect(isTranscriptAnchor(WS, hit.anchor)).toBe(true)
  })
})

// A tool message's content is a call record — JSON, and for `read` a verbatim copy of a
// file already indexed in its own right. It came back as `{"tool":"read","call":"0003",…}`
// in a slot a sentence should have had.
describe('the trail is not the conversation', () => {
  it('indexes what was said and not what the plumbing recorded', async () => {
    appendTranscript(WS, { role: 'user', content: 'I use a Gitzo tripod for landscape photography.' })
    appendTranscript(WS, {
      role: 'tool',
      toolName: 'read',
      content: JSON.stringify({ tool: 'read', call: '0003', path: 'data/memory/person.md', content: 'I use a Gitzo tripod for landscape photography.' })
    })
    const hits = await openStore(WS).push('Gitzo tripod', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(hit => !hit.text.includes('"tool":"read"'))).toBe(true)
  })
})

// `push` bounds the count of hits and nothing bounded their size. A sentence is whatever
// lies between two full stops, so a note written without one is a single hit of any
// length — measured at 31,025 tokens of messages against a 2,000-token window, after
// history compaction had already run and could no longer help.
describe('what recall may weigh', () => {
  const long = (n) => 'travel ' + 'kyoto autumn holidays '.repeat(n)

  it('bounds a single enormous hit and keeps it useful', async () => {
    note('data/memory/big.md', long(5600))
    const [hit] = await openStore(WS, { push: 1 }).push('travel holidays', 1)
    expect(Math.ceil(hit.text.length / 4)).toBeLessThanOrEqual(RECALL_BUDGET_TOKENS)
    expect(hit.truncated).toBe(true)
    expect(hit.text).toMatch(/travel/)
    // Cut, not dropped: the anchor still leads to the whole thing.
    expect(hit.anchor.path).toBe('data/memory/big.md')
  })

  it('bounds the whole block, not just each hit', async () => {
    for (let n = 0; n < 6; n++) note(`data/memory/n${n}.md`, long(900))
    const hits = await openStore(WS, { push: 6 }).push('travel holidays', 6)
    const total = hits.reduce((n, hit) => n + Math.ceil(hit.text.length / 4), 0)
    expect(total).toBeLessThanOrEqual(RECALL_BUDGET_TOKENS)
  })

  it('leaves ordinary hits exactly as they are', async () => {
    note('data/memory/person.md', '# Gear\nOwns a Sony A7R IV and a Sony 24-70mm lens.\n')
    const [hit] = await openStore(WS, { push: 3 }).push('Sony lens', 3)
    expect(hit.truncated).toBeUndefined()
    expect(hit.text).toBe('Owns a Sony A7R IV and a Sony 24-70mm lens.')
  })
})

// An anchor is advertised as the way down, and it addressed nothing the `read` tool could
// use: note lines were zero-based against read's one-based offsets, and transcript
// anchors counted non-compaction messages rather than transcript entries. Following one
// landed on a heading, or on the wrong message entirely.
describe('anchors address what read reads', () => {
  const reader = async () => {
    const { makeTools } = await import('../src/tools/make-tools.js')
    const { createCallTrail } = await import('../src/core/call-record.js')
    return shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'anchor', state: hostState(WS) })).fns).read
  }

  it('lands on the note line the hit came from', async () => {
    note('data/memory/person.md', '# Gear\nOwns a Sony A7R IV camera body.\nUses a Gitzo GT3543LS tripod for landscapes.\n')
    const [hit] = await openStore(WS).push('Gitzo tripod landscapes', 3)
    const read = await reader()
    const meta = JSON.parse(await read({ path: hit.anchor.path, offset: hit.anchor.line, length: 1 }))
    expect(meta.content.trim()).toBe(hit.text)
  })

  it('lands on the message the hit came from, past a compaction entry', async () => {
    const { createCompactionEntry } = await import('../src/resilience/compaction.js')
    appendTranscript(WS, { role: 'user', content: 'I bought a Gitzo GT3543LS tripod last spring.' })
    appendCompaction(WS, createCompactionEntry('[earlier conversations are no longer in context]', 1))
    appendTranscript(WS, { role: 'user', content: 'My sister Marguerite teaches violin in Lisbon.' })

    const [hit] = await openStore(WS).push('who teaches violin', 3)
    expect(isTranscriptAnchor(WS, hit.anchor)).toBe(true)
    const entry = readTranscriptEntries(WS).find(e => e.entryNo === hit.anchor.line)
    expect(entry.kind).toBe('message')
    expect(entry.message.content).toBe('My sister Marguerite teaches violin in Lisbon.')
  })

  it('carries who said it and when', async () => {
    appendTranscript(WS, { role: 'user', content: 'I am flying to Oslo next Thursday.' })
    const [hit] = await openStore(WS).push('flying to Oslo', 3)
    expect(hit.role).toBe('user')
    expect(hit.when).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const { recallBlock } = await import('../src/memory/recall.js')
    const block = recallBlock([hit])
    expect(block).toMatch(/user on \d{4}-\d{2}-\d{2}: I am flying to Oslo next Thursday\./)
  })

  it('says nothing about a speaker for a note, which has none', async () => {
    note('data/memory/person.md', '# Gear\nOwns a Sony A7R IV camera body.\n')
    const [hit] = await openStore(WS).push('Sony camera body', 3)
    const { recallBlock } = await import('../src/memory/recall.js')
    expect(recallBlock([hit])).toMatch(/^- Owns a Sony A7R IV camera body\. \(data\/memory\/person\.md:2\)$/m)
  })
})

// A dangling symlink under `data/memory/` threw ENOENT out of the scanner, before the
// turn's own error handling existed: an ordinary question died with no terminal record
// and nothing saying why — and the agent could not run to repair the file stopping it.
describe('a note that cannot be read', () => {
  const broken = () => {
    note('data/memory/good.md', '# Gear\nOwns a Sony A7R IV camera body.\n')
    symlinkSync(resolve(WS, 'data/memory/gone.md'), resolve(WS, 'data/memory/import.md'))
  }

  it('does not stop the notes that can', async () => {
    broken()
    const store = openStore(WS, { push: 3 })
    const [hit] = await store.push('Sony camera', 3)
    expect(hit.text).toBe('Owns a Sony A7R IV camera body.')
    expect(store.unreadable).toEqual([{ path: 'data/memory/import.md', why: 'ENOENT' }])
  })

  it('does not stop the turn, which still records how it ended', async () => {
    broken()
    const answering = { use: () => ({ answer: async () => ({ status: 'completed', output: 'answered anyway' }) }) }
    const state = hostState(WS)
    const result = await runSpore({
      prompt: 'What camera do I own?',
      workspace: WS,
      identity: 'You are a spore under test.',
      modelId: 'fake/model',
      limits: { rounds: { soft: 4, hard: 6 } },
      mo: answering,
      memory: { push: 3 },
      state
    })
    state.finalize()
    expect(result.output).toBe('answered anyway')
    expect(readTurns(WS)).toHaveLength(1)
  })
})
