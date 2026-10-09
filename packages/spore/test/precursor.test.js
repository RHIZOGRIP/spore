import { describe, it, expect } from 'vitest'

import { parseDefinition } from '../src/delegation/definition.js'
import { BACKENDS } from '../src/memory/store.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'

const parse = (src) => parseDefinition(src, { knownTools: TOOL_NAMES })

const WELL_FORMED = `---
name: summarize
model: anthropic/claude-haiku-4-5
tools: [read, exec]
rounds: [5, 7]
cost: [0.10, 0.15]
wall: [2m, 3m]
---

You summarize a document into five bullet points.

Say nothing you cannot support from the material.
`

describe('precursor format', () => {
  it('reads frontmatter and takes the body as the identity', () => {
    const p = parse(WELL_FORMED)
    expect(p.error).toBeUndefined()
    expect(p.name).toBe('summarize')
    expect(p.tools).toEqual(['read', 'exec'])
    expect(p.enzymes).toEqual([])
    expect(p.identity).toBe('You summarize a document into five bullet points.\n\nSay nothing you cannot support from the material.')
  })

  it('takes an enzyme description from the precursor that grants it, never from the binary', () => {
    const src = '---\nname: render\ntools: [exec]\nenzymes: [chart=tools/plot]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou draw charts.\n\n:::enzyme chart\nchart <in.csv> <out.png>\n  Draws a line chart.\n:::\n'
    const p = parseDefinition(src, { knownTools: TOOL_NAMES, cell: true })
    expect(p.error).toBeUndefined()
    // The name the cell calls is the framing, not the file's basename.
    expect(p.enzymes).toEqual([{ name: 'chart', path: 'tools/plot', description: 'chart <in.csv> <out.png>\n  Draws a line chart.' }])
    expect(p.identity).toBe('You draw charts.')
  })

  it('refuses a grant and a description that do not match', () => {
    const head = '---\nname: x\ntools: [exec]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n'
    const cell = (src) => parseDefinition(src, { knownTools: TOOL_NAMES, cell: true })

    expect(cell(head + 'enzymes: [tools/plot]\n---\nbody\n').error).toMatch(/grants "plot" and never describes it/)
    expect(cell(head + '---\nbody\n\n:::enzyme plot\nwhat\n:::\n').error).toMatch(/describes "plot", which it does not grant/)
    expect(cell(head + 'enzymes: [tools/plot]\n---\nbody\n\n:::enzyme plot\n:::\n').error).toMatch(/empty ":::enzyme plot" block/)
    expect(cell(head + 'enzymes: [tools/plot]\n---\nbody\n\n:::enzyme plot\nwhat\n').error).toMatch(/left open/)
  })

  it('refuses enzymes a cell could not reach, and any at all above one', () => {
    const noShell = '---\nname: x\ntools: [read]\nenzymes: [tools/plot]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\nbody\n\n:::enzyme plot\nwhat\n:::\n'
    expect(parseDefinition(noShell, { knownTools: TOOL_NAMES, cell: true }).error).toMatch(/neither exec nor wsexec/)

    const atL0 = '---\nname: x\nmodel: anthropic/claude-haiku-4-5\ntools: [exec]\nenzymes: [tools/plot]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody\n'
    expect(parse(atL0).error).toMatch(/a cell's alone — a cell is offered programs it cannot see/)
  })

  it('defaults to no tools at all', () => {
    const p = parse('---\nname: plain\nmodel: anthropic/claude-haiku-4-5\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nYou rewrite text.')
    expect(p.tools).toEqual([])
    expect(p.enzymes).toEqual([])
  })

  it('names an unknown tool and lists the real ones', () => {
    const p = parse('---\nname: x\nmodel: anthropic/claude-haiku-4-5\ntools: [raed]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody')
    expect(p.error).toMatch(/unknown tool "raed"/)
    expect(p.error).toMatch(/read, write, edit, exec, wsexec, ask, quiet/)
  })

  it('refuses a definition that declares no rounds, rather than defaulting one', () => {
    const p = parse('---\nname: x\ntools: [read]\n---\nbody')
    expect(p.error).toMatch(/declares no rounds/)
  })

  const LIMITS = ['rounds: [40, 45]', 'cost: [0.50, 0.75]', 'wall: [10m, 12m]']
  const withLimits = (over) => {
    const lines = over ? LIMITS.map(l => l.startsWith(over.split(':')[0] + ':') ? over : l) : LIMITS
    return parse(`---\nname: x\nmodel: anthropic/claude-haiku-4-5\n${lines.join('\n')}\n---\nbody`)
  }

  it('refuses a half-declared or inverted pair, in any dimension', () => {
    expect(withLimits('rounds: [40]').error).toMatch(/soft\/hard pair/)
    expect(withLimits('rounds: [40, 40]').error).toMatch(/not past the soft one/)
    expect(withLimits('cost: [0.75, 0.50]').error).toMatch(/hard cost limit that is not past/)
    expect(withLimits('wall: [12m, 10m]').error).toMatch(/hard wall limit that is not past/)
    expect(withLimits('rounds: [many, 5]').error).toMatch(/cannot read/)
    expect(withLimits('wall: [10, 12]').error).toMatch(/cannot read/)
  })

  it('reads a duration suffix into milliseconds', () => {
    expect(withLimits().limits.wall).toEqual({ soft: 600000, hard: 720000 })
    expect(withLimits('wall: [30s, 90s]').limits.wall).toEqual({ soft: 30000, hard: 90000 })
    expect(withLimits('wall: [1h, 2h]').limits.wall).toEqual({ soft: 3600000, hard: 7200000 })
  })

  it('names each limit it is missing', () => {
    expect(parse('---\nname: x\n---\nbody').error).toMatch(/declares no rounds/)
    expect(parse('---\nname: x\nrounds: [1, 2]\n---\nbody').error).toMatch(/declares no cost/)
    expect(parse('---\nname: x\nrounds: [1, 2]\ncost: [1, 2]\n---\nbody').error).toMatch(/declares no wall/)
  })

  it('asks a cell what an unfinished answer is worth, and only a cell', () => {
    const body = '---\nname: x\nmodel: anthropic/claude-haiku-4-5\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n'
    const cell = (src) => parseDefinition(src.replace('model: anthropic/claude-haiku-4-5\n', ''), { knownTools: TOOL_NAMES, cell: true })

    expect(cell(body + '---\nbody').error).toMatch(/declares no on-wrap/)
    expect(cell(body + 'on-wrap: maybe\n---\nbody').error).toMatch(/cannot read.*expected keep or discard/)
    expect(cell(body + 'on-wrap: discard\n---\nbody').onWrap).toBe('discard')
    expect(cell(body + 'on-wrap: keep\n---\nbody').onWrap).toBe('keep')

    // In the spore the wrapped answer goes to the user, so declaring a policy is a mistake
    // worth naming rather than a no-op.
    expect(parse(body + '---\nbody').onWrap).toBeUndefined()
    expect(parse(body + 'on-wrap: keep\n---\nbody').error).toMatch(/on-wrap, which is a cell's policy/)
  })

  it('refuses ask to a cell, which has no user to answer it', () => {
    const body = '---\nname: x\ntools: [read, ask]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\nbody'
    expect(parseDefinition(body, { knownTools: TOOL_NAMES, cell: true }).error).toMatch(/grants "ask"/)
  })

  // The model is configuration, so it sits with the rest of what a definition says. A
  // cell may leave it out and run on its parent's, which is a real value rather than a
  // default standing in for one.
  it('requires a root definition to say what it runs on, and lets a cell inherit', () => {
    const root = (model) => parse(`---\nname: x\n${model}rounds: [5, 7]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\n---\nbody`)
    expect(root('').error).toMatch(/declares no model/)
    expect(root('model: anthropic/claude-haiku-4-5\n').model).toBe('anthropic/claude-haiku-4-5')
    expect(root('model: two words\n').error).toMatch(/model it cannot read/)

    const cell = parseDefinition('---\nname: x\nrounds: [5, 7]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\non-wrap: keep\n---\nbody',
      { knownTools: TOOL_NAMES, cell: true })
    expect(cell.error).toBeUndefined()
    expect(cell.model).toBeUndefined()
  })

  it('rejects an unknown field rather than ignoring it', () => {
    const p = parse('---\nname: x\nweather: sunny\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody')
    expect(p.error).toMatch(/unknown field "weather"/)
  })

  it('rejects malformed frontmatter distinctly', () => {
    expect(parse('no frontmatter here').error).toMatch(/must open with a --- frontmatter block/)
    expect(parse('---\nname x\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody').error).toMatch(/needs "key: value"/)
    expect(parse('---\nname: x\nmodel: anthropic/claude-haiku-4-5\ntools: [read\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody').error).toMatch(/list is not closed/)
    expect(parse('---\nname: x\nmodel: anthropic/claude-haiku-4-5\nname: y\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody').error).toMatch(/"name" appears twice/)
  })

  it('requires a name and an identity', () => {
    expect(parse('---\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody').error).toMatch(/needs a name/)
    expect(parse('---\nname: x\nmodel: anthropic/claude-haiku-4-5\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\n   \n').error).toMatch(/has no identity/)
  })

  it('insists a list field is written as a list', () => {
    expect(parse('---\nname: x\nmodel: anthropic/claude-haiku-4-5\ntools: read\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody').error).toMatch(/"tools" must be a list/)
  })

  it('keeps TOOL_NAMES in step with the tools that can be built', () => {
    const built = makeTools('/tmp', 50000, createCallTrail('/tmp', { state: { request () {} } })).defs.map(d => d.name)
    expect([...TOOL_NAMES]).toEqual(built)
  })
})

// The depths are declared rather than defaulted for the reason the limits are: each came
// from one sweep over one dataset, and a number buried in the runtime is a number nobody
// benchmarks.
describe('long-term memory', () => {
  const withFields = (extra) => parseDefinition(
    `---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read, write]\nrounds: [4, 6]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\n${extra}---\n\nIdentity.\n`,
    { knownTools: TOOL_NAMES })

  it('reads a backend and the two depths it is queried at', () => {
    expect(withFields('memory: bm25\npush: 5\npull: 20\n').memory).toEqual({ backend: 'bm25', push: 5, pull: 20 })
  })

  it('accepts every backend the store can build, so the two lists cannot drift', () => {
    for (const backend of Object.keys(BACKENDS)) {
      const embedding = backend === 'vectors' ? 'embedding: openai/text-embedding-3-small\n' : ''
      const held = withFields(`memory: ${backend}\npush: 5\npull: 20\n${embedding}`)
      expect(held.error, `the parser refuses "${backend}", which the store builds`).toBeUndefined()
      expect(held.memory.backend).toBe(backend)
    }
  })

  it('is absent by default, which is how a definition says it keeps nothing', () => {
    expect(withFields('').memory).toBeUndefined()
  })

  it('refuses a backend that does not exist', () => {
    expect(withFields('memory: faiss\npush: 5\npull: 20\n').error).toMatch(/memory backend that does not exist/)
  })

  it('refuses memory without the depths to read it at', () => {
    expect(withFields('memory: bm25\npull: 20\n').error).toMatch(/declares memory and no push/)
  })

  it('refuses a depth that is not a count', () => {
    expect(withFields('memory: bm25\npush: half\npull: 20\n').error).toMatch(/push it cannot read/)
  })

  it('refuses depths with no store for them to read', () => {
    expect(withFields('push: 5\n').error).toMatch(/without memory/)
  })

  it('names the model that makes a vector store\'s vectors, and refuses one anywhere else', () => {
    expect(withFields('memory: vectors\npush: 5\npull: 20\nembedding: openai/text-embedding-3-small\n').memory)
      .toEqual({ backend: 'vectors', push: 5, pull: 20, embedding: 'openai/text-embedding-3-small' })
    expect(withFields('memory: vectors\npush: 5\npull: 20\n').error).toMatch(/no embedding/)
    expect(withFields('memory: bm25\npush: 5\npull: 20\nembedding: openai/text-embedding-3-small\n').error).toMatch(/embeds nothing/)
  })
})

describe('what a definition may reach', () => {
  const parseReads = (reads) => parse(`---\nname: x\nmodel: m/1\nreads: [${reads}]\nrounds: [5, 7]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\n---\nbody`)

  it('reads a corpus as name=path, and names it after the directory when told only a path', () => {
    expect(parseReads('papers=/srv/pubmed').reads).toEqual([{ name: 'papers', path: '/srv/pubmed' }])
    expect(parseReads('/srv/pubmed').reads).toEqual([{ name: 'pubmed', path: '/srv/pubmed' }])
  })

  // Nothing between a definition and the kernel runs a shell, so a tilde left alone would
  // be a directory literally called "~".
  it('expands a home-relative corpus, because no shell will', () => {
    expect(parseReads('p=~/docs').reads[0].path).toMatch(/^\/.*\/docs$/)
  })

  it('refuses two corpora under one name, which would stage one over the other', () => {
    expect(parseReads('p=/a, p=/b').error).toMatch(/two grants named "p"/)
  })

  it('grants sources by name, because a url the agent can read is one it can call', () => {
    const withSources = (list) => parse(`---\nname: x\nmodel: m/1\nsources: [${list}]\nrounds: [5, 7]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\n---\nbody`)
    expect(withSources('pubmed, crossref').sources).toEqual(['pubmed', 'crossref'])
    expect(withSources('https://example.com').error).toMatch(/source named/)
  })
})
