import { describe, it, expect } from 'vitest'

import { piecesOf, vectors } from '../src/memory/vectors.js'

const SOCKET = '/tmp/spore/store-test.sock'
const KEY = 'a'.repeat(64)
const EMBEDDING = 'openai/text-embedding-3-small'
const WIDTH = 4

const chunk = (line, text) => ({ text, anchor: { path: 'data/memory/notes.md', line } })

const fakeMo = ({ spec = {}, calls = [], width = WIDTH } = {}) => ({
  calls,
  use: () => ({
    info: () => ({ dimensions: WIDTH, inputTypes: { query: 'search_query', document: 'search_document' }, ...spec }),
    embed: async (input, options) => {
      calls.push({ input, options })
      return { status: 'completed', vectors: input.map(() => new Array(width).fill(0.5)), dimensions: width, cost: 0 }
    }
  })
})

const fakeStore = ({ held = [], matches = () => [] } = {}) => ({
  held: [],
  indexed: [],
  searched: [],
  async holds (dimensions, ids) {
    this.held.push({ dimensions, ids })
    return { held: ids.filter(id => held.includes(id)) }
  },
  async index (dimensions, unit, records) {
    this.indexed.push({ dimensions, unit, records })
    return { indexed: records.length }
  },
  async search (dimensions, unit, vector, topK) {
    this.searched.push({ dimensions, unit, vector, topK })
    return { matches: matches(this.held.at(-1).ids) }
  }
})

const open = (documents, { unit = 'sentence', mo = fakeMo(), store = fakeStore() } = {}) =>
  vectors(documents, { unit, socket: SOCKET, key: KEY, mo, embedding: EMBEDDING, connect: () => store })

describe('the vectors memory backend', () => {
  it('embeds only what the store does not already hold', async () => {
    const documents = [chunk(1, 'kept'), chunk(2, 'fresh')]
    const probe = fakeStore()
    await open(documents, { store: probe }).query('x')
    const [kept] = probe.held[0].ids

    const calls = []
    const store = fakeStore({ held: [kept] })
    await open(documents, { mo: fakeMo({ calls }), store }).query('x')

    expect(calls[0].input).toEqual(['fresh'])
    expect(store.indexed[0].records.map(r => r.id)).not.toContain(kept)
    expect(store.indexed[0].records).toHaveLength(1)
  })

  it('embeds only the question when every chunk is already stored', async () => {
    const documents = [chunk(1, 'kept')]
    const probe = fakeStore()
    await open(documents, { store: probe }).query('x')

    const calls = []
    const store = fakeStore({ held: probe.held[0].ids })
    await open(documents, { mo: fakeMo({ calls }), store }).query('x')

    expect(calls.map(call => call.input)).toEqual([['x']])
    expect(store.indexed).toHaveLength(0)
  })

  it('stores documents and asks queries, because the role is part of the vector', async () => {
    const calls = []
    await open([chunk(1, 'a note')], { mo: fakeMo({ calls }) }).query('what did I say')

    expect(calls[0].options).toEqual({ inputType: 'document' })
    expect(calls[1].options).toEqual({ inputType: 'query' })
  })

  it('leaves the role out for a symmetric model, which rejects it rather than ignoring it', async () => {
    const calls = []
    await open([chunk(1, 'one')], { mo: fakeMo({ spec: { inputTypes: undefined }, calls }) }).query('a question')

    expect(calls[0].options).toEqual({})
    expect(calls[1].options).toEqual({})
  })

  it('names its unit and the entry\'s width to the store', async () => {
    const store = fakeStore()
    await open([chunk(1, 'one')], { unit: 'turn', store }).query('anything')

    expect(store.indexed[0]).toMatchObject({ dimensions: WIDTH, unit: 'turn' })
    expect(store.searched[0]).toMatchObject({ dimensions: WIDTH, unit: 'turn' })
    expect(store.held[0].dimensions).toBe(WIDTH)
  })

  it('refuses vectors wider or narrower than the entry says, before storing any', async () => {
    const store = fakeStore()
    const refused = await open([chunk(1, 'one')], { mo: fakeMo({ width: 3 }), store }).query('x').catch(err => err)

    expect(refused.type).toBe('STORE_DIMENSION_MISMATCH')
    expect(store.indexed).toHaveLength(0)
  })

  it('refuses an embedding model the catalog does not know, or whose width it does not say', async () => {
    const unknown = { use: () => ({ info: () => null }) }
    await expect(open([chunk(1, 'one')], { mo: unknown }).query('x')).rejects.toMatchObject({ type: 'STORE_EMBEDDING_UNKNOWN' })
    await expect(open([chunk(1, 'one')], { mo: fakeMo({ spec: { dimensions: undefined } }) }).query('x')).rejects.toMatchObject({ type: 'STORE_WIDTH_UNKNOWN' })
  })

  it('batches at the size the entry declares', async () => {
    const calls = []
    const documents = Array.from({ length: 7 }, (_, i) => chunk(i + 1, `text ${i}`))
    await open(documents, { mo: fakeMo({ spec: { maxBatch: 3 }, calls }) }).query('x')

    expect(calls.map(call => call.input.length)).toEqual([3, 3, 1, 1])
  })

  it('splits a chunk past the model window across records rather than losing its tail', async () => {
    const calls = []
    const store = fakeStore()
    const long = 'Alpha beta. Gamma delta. Epsilon zeta. Eta theta.'
    await open([chunk(1, long), chunk(2, 'short')], { mo: fakeMo({ spec: { maxInputTokens: 10 }, calls }), store }).query('x')

    const sent = calls[0].input
    expect(sent.every(text => text.length <= 20)).toBe(true)
    expect(sent.join('')).toBe(long + 'short')
    const ids = store.indexed[0].records.map(r => r.id)
    expect(ids.filter(id => /\.\d+$/.test(id))).toHaveLength(4)
  })

  it('scores a chunk by its nearest piece, and asks wider so pieces cannot crowd chunks out', async () => {
    const documents = [chunk(1, 'Alpha beta. Gamma delta. Epsilon zeta.'), chunk(2, 'short')]
    const store = fakeStore({
      matches: ids => [
        { id: ids.find(id => id.endsWith('.2')), distance: 0.6 },
        { id: ids.find(id => id.endsWith('.0')), distance: 0.2 },
        { id: ids.at(-1), distance: 0.9 }
      ]
    })
    const scores = await open(documents, { mo: fakeMo({ spec: { maxInputTokens: 7 } }), store }).query('x')

    expect(scores[0]).toBeCloseTo(0.8)
    expect(scores[1]).toBeCloseTo(0.1)
    expect(store.searched[0].topK).toBe(4)
  })

  it('puts a match back where its chunk was, and leaves everything else at zero', async () => {
    const documents = [chunk(1, 'first'), chunk(2, 'second'), chunk(3, 'third')]
    const store = fakeStore({ matches: ids => [{ id: ids[1], distance: 0.25 }] })

    await expect(open(documents, { store }).query('anything')).resolves.toEqual([0, 0.75, 0])
  })

  it('sends one record for chunks that are the same text on the same line', async () => {
    const documents = [chunk(1, 'the same line'), chunk(1, 'the same line'), chunk(2, 'a different one')]
    const store = fakeStore()
    const index = open(documents, { store })

    await index.query('anything')

    expect(store.indexed[0].records).toHaveLength(2)
    expect(index.size).toBe(3)
  })

  it('scores every position a duplicated chunk occupies, not just the last', async () => {
    const documents = [chunk(1, 'twice over'), chunk(3, 'unrelated'), chunk(1, 'twice over')]
    const store = fakeStore({ matches: ids => [{ id: ids[0], distance: 0.25 }] })

    await expect(open(documents, { store }).query('anything')).resolves.toEqual([0.75, 0, 0.75])
  })

  it('ignores a match for a chunk that is no longer on disk', async () => {
    const store = fakeStore({ matches: () => [{ id: 'a-record-that-left', distance: 0.1 }] })

    await expect(open([chunk(1, 'first')], { store }).query('anything')).resolves.toEqual([0])
  })

  it('gives the same chunk the same record id, so re-indexing costs nothing', async () => {
    const store = fakeStore()
    await open([chunk(7, 'a stable line')], { store }).query('x')
    await open([chunk(7, 'a stable line')], { store }).query('x')

    expect(store.held[0].ids).toEqual(store.held[1].ids)
  })

  it('indexes a sentence and the turn containing it under different ids', async () => {
    const store = fakeStore()
    await open([chunk(1, 'same words twice')], { unit: 'sentence', store }).query('x')
    await open([chunk(1, 'same words twice')], { unit: 'turn', store }).query('x')

    expect(store.held[0].ids[0]).not.toBe(store.held[1].ids[0])
  })

  it('refuses to run without a store socket, rather than reaching the service itself', () => {
    expect(() => vectors([], { unit: 'sentence' })).toThrow(/no store to reach/)
  })
})

describe('dividing a chunk past the window', () => {
  it('prefers a sentence end, and rejoins to exactly the original', () => {
    const text = 'Alpha beta. Gamma delta. Epsilon zeta. Eta theta.'
    const sent = piecesOf(text, 20)

    expect(sent.join('')).toBe(text)
    expect(sent.every(piece => piece.length <= 20)).toBe(true)
    expect(sent[0]).toBe('Alpha beta. ')
  })

  it('falls to a line break when no sentence ends in the window', () => {
    const text = 'const alpha = 1\nconst bravo = 2\nconst charlie = 3\n'
    const sent = piecesOf(text, 20)

    expect(sent.join('')).toBe(text)
    expect(sent.every(piece => piece.endsWith('\n'))).toBe(true)
  })

  it('falls to a space when there is no line either', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel'
    const sent = piecesOf(text, 20)

    expect(sent.join('')).toBe(text)
    expect(sent.every(piece => piece.length <= 20)).toBe(true)
    expect(sent.slice(0, -1).every(piece => piece.endsWith(' '))).toBe(true)
  })

  it('cuts at the window only when the text offers no boundary at all', () => {
    expect(piecesOf('x'.repeat(50), 20)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)])
  })
})
