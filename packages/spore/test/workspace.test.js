import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openWorkspace, readRules } from '../src/core/workspace.js'
import { dataDir, definitionPath } from '../src/core/spore-dir.js'
import { definitionWith } from '../src/testing.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'

const MODEL = 'anthropic/claude-haiku-4-5'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '.workspace-test')
const WS = resolve(ROOT, 'ws')

const open = (over = {}) => openWorkspace('ws', { cwd: ROOT, allowGranted: true, ...over })

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('openWorkspace', () => {
  // Opening is not making. Seeding here would put an agent in a directory nobody said
  // should hold one, and the definition carries a model the package cannot supply.
  it('refuses a directory with no definition rather than making it a workspace', () => {
    expect(open().error).toMatch(/has no spore\.cmk — spore define/)
  })

  it('gives the shipped definition the whole suite, listed in its own frontmatter', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    const opened = open()
    expect(opened.granting).toEqual([...TOOL_NAMES])
    expect(opened.identity).not.toBe('')
    expect(definitionWith(MODEL)).toContain(opened.identity)
    expect(opened.model).toBe(MODEL)
  })

  it('takes grants from the definition, so both paths read one file', () => {
    writeFileSync(definitionPath(WS), '---\nname: spore\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou answer about files.\n')
    const opened = open()
    expect(opened.granting).toEqual(['read'])
    expect(opened.identity).toBe('You answer about files.')
  })

  it('grants nothing to a definition that lists nothing, the same rule a precursor gets', () => {
    writeFileSync(definitionPath(WS), '---\nname: spore\nmodel: anthropic/claude-haiku-4-5\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou only talk.\n')
    expect(open().granting).toEqual([])
  })

  it('installs a --definition into a workspace that has none', () => {
    writeFileSync(resolve(ROOT, 'custom.cmk'), '---\nname: spore\nmodel: anthropic/claude-haiku-4-5\ntools: [read, exec]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou review.\n')
    const opened = open({ definition: 'custom.cmk' })
    expect(opened.granting).toEqual(['read', 'exec'])
    expect(existsSync(definitionPath(WS))).toBe(true)
  })

  it('refuses a --definition when the workspace already has a definition', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    writeFileSync(resolve(ROOT, 'custom.cmk'), '---\nname: spore\nmodel: anthropic/claude-haiku-4-5\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nbody\n')
    expect(open({ definition: 'custom.cmk' }).error).toMatch(/already has a definition/)
  })

  it('refuses a malformed definition rather than falling back to the default', () => {
    writeFileSync(definitionPath(WS), 'no frontmatter')
    expect(open().error).toMatch(/spore\.cmk must open with a --- frontmatter block .* delete it to start again/)
  })

  it('refuses a workspace the sandbox grants to everyone', () => {
    expect(openWorkspace('.', { cwd: '/tmp' }).error).toMatch(/sandbox-granted path/)
  })

  it('creates the data directory the agent works in', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    open()
    expect(existsSync(dataDir(WS))).toBe(true)
  })

  it('tells the agent which precursors it can spawn, and seeds none of its own', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    expect(open().rules).not.toMatch(/Sub-agents you can spawn/)
    expect(readdirSync(resolve(WS, 'precursors'))).toEqual(['README.md'])

    copyFileSync(resolve(__dirname, 'fixtures/plugins/docs/precursors/summarize.cmk'), resolve(WS, 'precursors/summarize.cmk'))
    expect(open().rules).toMatch(/- summarize \(precursors\/summarize\.cmk\)/)
  })

  it('hands over how its calls are described, from its :::call blocks, and keeps them out of the identity', () => {
    writeFileSync(definitionPath(WS), `${definitionWith(MODEL)}\n:::call contract\ntool: read\ntitle: reading the contract\ncategory: read\n:::\n`)
    const opened = open()
    expect(opened.calls).toEqual([{ name: 'contract', tools: ['read'], title: 'reading the contract', category: 'read' }])
    expect(opened.identity).not.toMatch(/:::call|reading the contract/)
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    expect(open().calls).toEqual([])
  })

  it('names the documentation of the plugins its definition uses, and of no other', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL).replace('\n---', '\nplugins: [browser]\n---'))
    mkdirSync(resolve(WS, 'plugins'))
    writeFileSync(resolve(WS, 'plugins/browser.md'), '\n# The browser: "$SPORE_BROWSER" drives the agents\' Chrome\n\nMore.\n')
    writeFileSync(resolve(WS, 'plugins/old.md'), '# A plugin it no longer uses\n')
    const opened = open()
    expect(opened.plugins).toEqual(['browser'])
    expect(opened.rules).toMatch(/- plugins\/browser\.md — The browser: "\$SPORE_BROWSER" drives the agents' Chrome/)
    expect(opened.rules).not.toMatch(/old\.md/)
  })
})

describe('what a workspace is seeded with', () => {
  // The identity carries the ordinary path; the rest has to be somewhere the agent
  // can reach, or shortening the prompt just makes it ignorant.
  it('seeds the reference, and never overwrites an edited one', () => {
    writeFileSync(definitionPath(WS), definitionWith(MODEL))
    expect(open().error).toBeUndefined()

    const reference = resolve(WS, 'reference.md')
    expect(readFileSync(reference, 'utf8')).toMatch(/workspace/)

    writeFileSync(reference, 'mine now')
    open()
    expect(readFileSync(reference, 'utf8')).toBe('mine now')
  })
})

describe('what the runtime tells an agent it has been given', () => {
  // The shipped identity points at reference.md in one line, and `--definition` replaces the
  // shipped definition — so a custom one lost the pointer while the files were still
  // being seeded. Found on a benchmark run, where nine `read` calls went hunting for
  // libraries.md in `context/` and `data/`.
  it('names the seeded files in rules, whatever identity is installed', () => {
    const cmk = resolve(ROOT, 'custom.cmk')
    writeFileSync(cmk, '---\nname: custom\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [1, 2]\nwall: [1m, 2m]\n---\nYou do one job.\n')

    const opened = open({ definition: 'custom.cmk' })
    expect(opened.error).toBeUndefined()
    expect(opened.identity).toContain('You do one job.')
    // Nothing in that identity mentions either file; the runtime says so instead.
    expect(opened.rules).toContain('reference.md')
    expect(opened.rules).toContain('libraries.md')
    expect(opened.rules).toContain('workspace root')
  })

  it('tells every identity that whoever reads its answer does not see its workspace', () => {
    const cmk = resolve(ROOT, 'custom.cmk')
    writeFileSync(cmk, '---\nname: custom\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [1, 2]\nwall: [1m, 2m]\n---\nYou do one job.\n')

    const opened = open({ definition: 'custom.cmk' })
    expect(opened.rules).toContain('Whoever reads your answer sees the answer and the files you hand back in data/out/, never your workspace')
    expect(opened.rules).toContain('Never send them to a path there')
  })
})

describe('a corpus, as the agent is told of it', () => {
  it('is named where it is linked, and where the person knows it', () => {
    const corpus = resolve(ROOT, 'notes')
    mkdirSync(corpus)
    writeFileSync(definitionPath(WS), `---\nname: spore\nmodel: ${MODEL}\ntools: [read]\nreads: [papers=${corpus}]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou read.\n`)
    expect(open().rules).toContain(`papers/ is ${realpathSync(corpus)}`)
    expect(open().rules).toContain('read it through papers/. You cannot change it.')
  })

  it('is given in the person\'s ~ when it is under their home, and only then', () => {
    expect(readRules([{ name: 'bin', path: '/home/ada/bin' }], '/home/ada')).toMatch(/^bin\/ is \/home\/ada\/bin \(~\/bin\), linked in/)
    expect(readRules([{ name: 'law', path: '/srv/law' }], '/home/ada')).toMatch(/^law\/ is \/srv\/law, linked in/)
    expect(readRules([{ name: 'adams', path: '/home/adams' }], '/home/ada')).not.toContain('~')
    expect(readRules([{ name: 'bin', path: '/home/ada/bin' }], null)).not.toContain('~')
  })
})
