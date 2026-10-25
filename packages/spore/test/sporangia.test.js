import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { setKey } from '../src/library/config.js'
import { define, defaultSporangiumPath, remake, show, sporangia } from '../src/library/verbs.js'
import { definitionWith } from '../src/testing.js'
import { differingDocs, upgradeDocs } from '../src/core/plugins.js'
import { DEFAULT_SPORANGIUM, SHIPPED_SPORANGIA, knownSporangia, operatorSporangia, sporangiumOf } from '../src/core/sporangia.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { parseDefinition } from '../src/delegation/definition.js'
import { appendTurn, readTurns, statePath } from '../src/core/spore-dir.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const MODEL = 'fake/default'
const shipped = (one, file) => join(SHIPPED_SPORANGIA, one, file)

describe('the shipped sporangia', () => {
  it.each(knownSporangia())('%s parses as a template, and its precursors as cells', (one) => {
    const definition = parseDefinition(readFileSync(shipped(one, 'spore.cmk'), 'utf8'), { knownTools: TOOL_NAMES, seed: true })
    expect(definition.error).toBeUndefined()
    expect(definition.model).toBeFalsy()
    const dir = shipped(one, 'precursors')
    const precursors = existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.cmk')) : []
    for (const file of precursors) {
      const cell = parseDefinition(readFileSync(join(dir, file), 'utf8'), { knownTools: TOOL_NAMES, cell: true })
      expect(cell.error, `${one}/precursors/${file}`).toBeUndefined()
      expect(`${cell.name}.cmk`).toBe(file)
    }
  })

  it.each(knownSporangia().filter(one => existsSync(shipped(one, 'reference.md'))))('%s, giving its own reference, still covers every section and tool of the default one', (one) => {
    const own = readFileSync(shipped(one, 'reference.md'), 'utf8')
    const sections = readFileSync(shipped(DEFAULT_SPORANGIUM, 'reference.md'), 'utf8').match(/^#{2,3} .+$/gm)
    for (const heading of sections) expect(own).toContain(heading)
    for (const tool of TOOL_NAMES) expect(own).toContain(`\`${tool}\``)
  })
})

describe('making a spore from a sporangium', () => {
  let OUT
  let CONFIG
  beforeEach(() => {
    OUT = outsideRoot('sporangia')
    CONFIG = resolve(OUT, 'config.json')
    setKey('home', resolve(OUT, 'home'), CONFIG)
    mkdirSync(dirname(defaultSporangiumPath(CONFIG)), { recursive: true })
    writeFileSync(defaultSporangiumPath(CONFIG), definitionWith(MODEL))
  })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  const yours = (one, file, text) => {
    const path = join(operatorSporangia(CONFIG), one, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  it('lists each sporangium with the line it gives a person, yours over the package\'s', () => {
    yours('reviewer', 'spore.cmk', readFileSync(shipped('reviewer', 'spore.cmk'), 'utf8').replace(/^description: .*$/m, 'description: My reviews'))
    yours('broken', 'spore.cmk', '---\nname: broken\n---\n')

    const listed = sporangia({ configFile: CONFIG })

    expect(listed.map(s => s.name)).toEqual([...knownSporangia(), 'broken'].sort())
    expect(listed.find(s => s.name === 'reviewer')).toEqual({ name: 'reviewer', description: 'My reviews', error: null })
    expect(listed.find(s => s.name === 'commit').description).toMatch(/commit messages/)
    expect(listed.find(s => s.name === 'broken')).toMatchObject({ description: null, error: expect.stringContaining('broken') })
  })

  it('takes only the model from your default for a spore of another sporangium, and the whole of it for a spore of its own', () => {
    writeFileSync(defaultSporangiumPath(CONFIG), definitionWith(MODEL).replace('tools: [read,', 'tools: [search, read,'))
    const made = define({ ws: 'r', sporangium: 'perennial', configFile: CONFIG })
    expect(parseDefinition(readFileSync(join(made.ws, 'spore.cmk'), 'utf8'), { knownTools: TOOL_NAMES }).model).toBe(MODEL)
    expect(() => define({ ws: 'd', configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'DEFINITION_INVALID', message: expect.stringMatching(/default\/spore\.cmk unknown tool "search"/) }))
  })

  it('writes the directory a new spore works in into its definition, and only a new one\'s', () => {
    const proj = resolve(OUT, 'proj')
    mkdirSync(proj, { recursive: true })

    const made = define({ ws: 'w', writes: [`here=${proj}`], configFile: CONFIG })

    expect(readFileSync(join(made.ws, 'spore.cmk'), 'utf8')).toMatch(new RegExp(`^writes: \\[here=${proj}\\]$`, 'm'))
    expect(show({ ws: made.ws, configFile: CONFIG }).writes).toEqual([{ name: 'here', path: proj }])
    expect(() => define({ ws: 'w', writes: [`here=${proj}`], configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'DEFINE_FILLS_ONLY_NEW' }))
  })

  it('lays the default sporangium, then the chosen one over it, and runs on your default model', () => {
    const made = define({ ws: 'r', sporangium: 'reviewer', configFile: CONFIG })
    const ws = made.ws
    const definition = readFileSync(join(ws, 'spore.cmk'), 'utf8')
    expect(definition).toMatch(/^name: reviewer$/m)
    expect(definition).toContain(`model: ${MODEL}`)
    expect(readFileSync(join(ws, 'precursors/verify-finding.cmk'), 'utf8')).toBe(readFileSync(shipped('reviewer', 'precursors/verify-finding.cmk'), 'utf8'))
    expect(existsSync(join(ws, 'precursors/README.md'))).toBe(true)
    expect(readFileSync(join(ws, 'reference.md'), 'utf8')).toBe(readFileSync(shipped(DEFAULT_SPORANGIUM, 'reference.md'), 'utf8'))
    expect(sporangiumOf(ws)).toBe('reviewer')
    expect(show({ ws, configFile: CONFIG }).sporangium).toBe('reviewer')
    expect(made.sporangium).toBe('reviewer')
  })

  it('makes from the default sporangium when none is named, and from yours over the package\'s', () => {
    yours('reviewer', 'spore.cmk', readFileSync(shipped('reviewer', 'spore.cmk'), 'utf8').replace('\n---', '\nmodel: fake/reviewing\n---'))
    yours('reviewer', 'data/memory/me.md', 'I am the reviewer.\n')
    const plain = define({ ws: 'p', configFile: CONFIG })
    expect(sporangiumOf(plain.ws)).toBe(DEFAULT_SPORANGIUM)
    expect(readFileSync(join(plain.ws, 'spore.cmk'), 'utf8')).toContain(`model: ${MODEL}`)

    const reviewer = define({ ws: 'r', sporangium: 'reviewer', configFile: CONFIG })
    expect(readFileSync(join(reviewer.ws, 'spore.cmk'), 'utf8')).toContain('model: fake/reviewing')
    expect(readFileSync(join(reviewer.ws, 'data/memory/me.md'), 'utf8')).toBe('I am the reviewer.\n')
  })

  it('makes a commit-message writer that reads and writes nothing else, with its git hook ready to install', () => {
    const { ws } = define({ ws: 'commit', sporangium: 'commit', configFile: CONFIG })
    const definition = parseDefinition(readFileSync(join(ws, 'spore.cmk'), 'utf8'), { knownTools: TOOL_NAMES })
    expect(definition.tools).toEqual(['read'])
    expect(definition.sources).toEqual([])
    const hook = join(ws, 'data', 'prepare-commit-msg')
    expect(readFileSync(hook, 'utf8')).toMatch(/--attach "\$dir\/staged\.diff"/)
    expect(statSync(hook).mode & 0o111).not.toBe(0)
  })

  it('compares and upgrades a root document against the sporangium that gave it', () => {
    yours('custom', 'spore.cmk', definitionWith(MODEL).replace(/^name: .*$/m, 'name: custom'))
    yours('custom', 'reference.md', '# A reference of its own\n')
    const { ws } = define({ ws: 'c', sporangium: 'custom', configFile: CONFIG })
    const config = { file: CONFIG, plugins: {} }
    expect(readFileSync(join(ws, 'reference.md'), 'utf8')).toBe('# A reference of its own\n')
    expect(differingDocs(ws, { config, roots: [] })).toEqual([])

    writeFileSync(join(ws, 'reference.md'), 'edited\n')
    expect(differingDocs(ws, { config, roots: [] }).map(d => d.file)).toEqual(['reference.md'])
    upgradeDocs(ws, { config, roots: [] })
    expect(readFileSync(join(ws, 'reference.md'), 'utf8')).toBe('# A reference of its own\n')
  })

  it('refuses a sporangium that does not exist, one with no definition, and one named beside another source', () => {
    expect(() => define({ ws: 'x', sporangium: 'nope', configFile: CONFIG })).toThrow(/there is no sporangium "nope"/)
    yours('bare', 'data/notes.md', 'notes\n')
    expect(() => define({ ws: 'x', sporangium: 'bare', configFile: CONFIG })).toThrow(/has no spore.cmk/)
    expect(() => define({ ws: 'x', sporangium: 'reviewer', definition: defaultSporangiumPath(CONFIG), configFile: CONFIG })).toThrow(/comes from one place/)
    expect(existsSync(resolve(OUT, 'home/x'))).toBe(false)
  })

  it('remakes a spore whose database another version made, keeping what it can do and has made', () => {
    const { ws } = define({ ws: 'r', sporangium: 'reviewer', configFile: CONFIG })
    writeFileSync(join(ws, 'spore.cmk'), readFileSync(join(ws, 'spore.cmk'), 'utf8') + '\nEdited by hand.\n')
    mkdirSync(join(ws, 'data/memory'), { recursive: true })
    writeFileSync(join(ws, 'data/memory/me.md'), 'notes\n')
    mkdirSync(join(ws, 'home'), { recursive: true })
    writeFileSync(join(ws, 'home/.gitconfig'), '[user]\n')
    appendTurn(ws, { startedAt: 'S', stopReason: 'answer', concluded: true, endedAt: 'T' })
    const db = new DatabaseSync(statePath(ws))
    db.exec('UPDATE t_workspace SET schemaVersion = 99')
    db.close()

    const made = remake({ ws: 'r', configFile: CONFIG })
    expect(made.sporangium).toBe('reviewer')
    expect(readFileSync(join(ws, 'spore.cmk'), 'utf8')).toContain('Edited by hand.')
    expect(readFileSync(join(ws, 'data/memory/me.md'), 'utf8')).toBe('notes\n')
    expect(readFileSync(join(ws, 'home/.gitconfig'), 'utf8')).toBe('[user]\n')
    expect(existsSync(join(ws, 'precursors/verify-finding.cmk'))).toBe(true)
    expect(existsSync(join(ws, 'reference.md'))).toBe(true)
    expect(sporangiumOf(ws)).toBe('reviewer')
    expect(readTurns(ws)).toEqual([])

    expect(existsSync(join(made.aside, 'state.sqlite'))).toBe(true)
    expect(existsSync(join(made.aside, 'spore.cmk'))).toBe(false)
    expect(() => remake({ ws: 'r', configFile: CONFIG })).toThrow(/still there from an earlier remake/)
  })

  it('makes only new spores', () => {
    define({ ws: 'r', configFile: CONFIG })
    expect(() => define({ ws: 'r', sporangium: 'reviewer', configFile: CONFIG })).toThrow(/already a spore/)
  })
})
