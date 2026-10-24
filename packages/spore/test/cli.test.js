import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeSync, lstatSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, utimesSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bytesOf, CONFIG_FILE, readConfig, existing, getKey, setKey, addTo, removeFrom, recordLayout, settings, workspaceFor, containing, followingDocs, hereSnapshots } from '../src/library/config.js'
import { workspacesIn, isWorkspace } from '../src/library/discover.js'
import { define, defaultModel, defaultSporangiumPath, switchModel, edit, grantOf, list, log, pause, show, sporePaths, precursors, schedules, setDefaultModel, setSchedule, removeSchedule, sql, unpause, usage } from '../src/library/verbs.js'
import { billingOf } from 'mohdel/providers'
import { definitionWith } from '../src/core/identity-defaults.js'
import { takeSlot } from '../src/core/admission.js'
import { send } from '../src/core/send.js'
import { tick } from '../src/core/tick.js'
import { acquireLock, readInbox, appendInbox, appendTurn, releaseLock, writeTurnRecords, writeTranscriptEntries, readTranscriptEntries } from '../src/core/spore-dir.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { allowPlugin } from '../src/core/plugins.js'
import { linkGrants, openWorkspace } from '../src/core/workspace.js'
import { RUNNING, stateOf } from '../src/core/state.js'

const MODEL = 'anthropic/claude-haiku-4-5'
const DIR = resolve(tmpdir(), 'spore-cli-test')
const CONFIG = resolve(DIR, 'config.json')
const DEFAULT = defaultSporangiumPath(CONFIG)
const writeDefault = (text) => {
  mkdirSync(dirname(DEFAULT), { recursive: true })
  writeFileSync(DEFAULT, text)
}

const workspace = (path, { turns = [], precursors: names = [] } = {}) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(resolve(path, 'spore.cmk'), '---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
  if (turns.length) writeTurnRecords(path, turns.map(turn => ({ startedAt: '2026-09-27T00:00:00.000Z', ...turn })))
  if (names.length) {
    mkdirSync(resolve(path, 'precursors'), { recursive: true })
    for (const n of names) writeFileSync(resolve(path, 'precursors', `${n}.cmk`), '---\nname: x\n---\n\nx\n')
  }
  return path
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('where to look', () => {
  it('is absent until someone writes it, and says so rather than guessing', () => {
    const config = readConfig(resolve(DIR, 'nothing.json'))
    expect(config.exists).toBe(false)
    expect(config.workspaces).toEqual([])
  })

  it('refuses a file it cannot read as JSON instead of carrying on with nothing', () => {
    writeFileSync(CONFIG, 'workspaces: [oops]')
    expect(() => readConfig(CONFIG)).toThrow(/not readable JSON/)
  })

  it('refuses a workspaces that is not a list, because the field names several', () => {
    writeFileSync(CONFIG, JSON.stringify({ workspaces: '~/one' }))
    expect(() => readConfig(CONFIG)).toThrow(/not a list/)
  })

  it('has no home until one is named, because guessing where to put a workspace is worse than asking', () => {
    expect(readConfig(resolve(DIR, 'nothing.json')).home).toBe(null)
    writeFileSync(CONFIG, JSON.stringify({ workspaces: ['/one'] }))
    expect(readConfig(CONFIG).home).toBe(null)
  })

  it('refuses a home that is a list, because creating has to have one answer', () => {
    writeFileSync(CONFIG, JSON.stringify({ home: ['~/one', '~/two'] }))
    expect(() => readConfig(CONFIG)).toThrow(/not a path/)
  })

  it('refuses a key it does not read, so a typo or a stale setting is not silently ignored', () => {
    writeFileSync(CONFIG, JSON.stringify({ home: '/one', homes: '/two', turn: 3 }))
    expect(() => readConfig(CONFIG)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID', message: expect.stringMatching(/has homes, turn, which spore does not read/) }))
    writeFileSync(CONFIG, JSON.stringify(['/one']))
    expect(() => readConfig(CONFIG)).toThrow(/is not a JSON object/)
  })

  it('takes a default reply-to per spore, and refuses one that names no place', () => {
    writeFileSync(CONFIG, JSON.stringify({ replyTo: { triage: 'discord:ops/1234' } }))
    expect(readConfig(CONFIG).replyTo).toEqual({ triage: 'discord:ops/1234' })
    writeFileSync(CONFIG, JSON.stringify({ replyTo: { triage: 'ops' } }))
    expect(() => readConfig(CONFIG)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID', message: expect.stringMatching(/replyTo for triage/) }))
    writeFileSync(CONFIG, JSON.stringify({ replyTo: 'discord:ops/1234' }))
    expect(() => readConfig(CONFIG)).toThrow(/replyTo that is not a map/)
  })

  it('reports a path that is gone rather than failing, the way an unreadable note does', () => {
    const live = workspace(resolve(DIR, 'live'))
    const { live: found, missing } = existing([live, resolve(DIR, 'vanished')])
    expect(found).toEqual([live])
    expect(missing).toEqual([resolve(DIR, 'vanished')])
  })
})

describe('editing where to look', () => {
  it('creates the file on first use rather than making someone author it', () => {
    addTo('workspaces', '/one', CONFIG)
    expect(readConfig(CONFIG).workspaces).toEqual(['/one'])
  })

  it('keeps a tilde path as written, so it survives a different machine', () => {
    addTo('workspaces', '~/work/spores', CONFIG)
    expect(JSON.parse(require('node:fs').readFileSync(CONFIG, 'utf8')).workspaces).toEqual(['~/work/spores'])
    expect(readConfig(CONFIG).workspaces[0]).toMatch(/^\//)
  })

  it('resolves a relative path now, because later it would mean somewhere else', () => {
    addTo('workspaces', 'sub/dir', CONFIG)
    expect(JSON.parse(require('node:fs').readFileSync(CONFIG, 'utf8')).workspaces[0]).toMatch(/^\/.*sub\/dir$/)
  })

  it('adding the same workspace twice leaves one', () => {
    addTo('workspaces', '/one', CONFIG)
    addTo('workspaces', '/one', CONFIG)
    expect(getKey('workspaces', CONFIG).workspaces).toEqual(['/one'])
  })

  it('drops one value, or the whole key', () => {
    setKey('workspaces', '/one,/two', CONFIG)
    expect(removeFrom('workspaces', '/one', CONFIG).workspaces).toEqual(['/two'])
    expect(removeFrom('workspaces', undefined, CONFIG).workspaces).toBeUndefined()
  })

  it('sets a home the same way it stores a root, keeping the tilde and resolving the relative', () => {
    setKey('home', '~/work/spores', CONFIG)
    expect(JSON.parse(require('node:fs').readFileSync(CONFIG, 'utf8')).home).toBe('~/work/spores')
    expect(readConfig(CONFIG).home).toMatch(/^\/.*work\/spores$/)
    setKey('home', 'sub/dir', CONFIG)
    expect(JSON.parse(require('node:fs').readFileSync(CONFIG, 'utf8')).home).toMatch(/^\/.*sub\/dir$/)
  })

  it('refuses to add to a home, which is one path rather than a list', () => {
    expect(() => addTo('home', '/one', CONFIG)).toThrow(/not a list/)
  })

  it('refuses a setting it does not have, rather than writing a field nothing reads', () => {
    expect(() => setKey('colour', 'blue', CONFIG)).toThrow(/no such setting/)
    expect(() => getKey('colour', CONFIG)).toThrow(/no such setting/)
  })

  it('holds turns as a count, refusing anything that is not one', () => {
    setKey('turns', '3', CONFIG)
    expect(readConfig(CONFIG).turns).toBe(3)
    expect(() => setKey('turns', '0', CONFIG)).toThrow(/not a count/)
    expect(() => setKey('turns', 'many', CONFIG)).toThrow(/not a count/)
    expect(readConfig(CONFIG).turns).toBe(3)
  })

  it('holds the machine\'s disk bounds as sizes, as written, and leaves them to the runner when unset', () => {
    expect(bytesOf(readConfig(CONFIG), 'largestFile')).toBe(null)
    setKey('largestFile', '4GB', CONFIG)
    setKey('freeFloor', '512MB', CONFIG)
    expect(getKey('largestFile', CONFIG)).toEqual({ largestFile: '4GB' })
    expect(bytesOf(readConfig(CONFIG), 'largestFile')).toBe(4 * 1024 ** 3)
    expect(bytesOf(readConfig(CONFIG), 'freeFloor')).toBe(512 * 1024 ** 2)
    expect(() => setKey('freeFloor', 'lots', CONFIG)).toThrow(/not a size/)
    expect(() => setKey('largestFile', '0', CONFIG)).toThrow(/not a size/)
    expect(getKey('freeFloor', CONFIG)).toEqual({ freeFloor: '512MB' })
  })

  it('keeps 20 spore here snapshots per spore unless told another count', () => {
    expect(hereSnapshots(readConfig(CONFIG))).toBe(20)
    setKey('hereSnapshots', '5', CONFIG)
    expect(hereSnapshots(readConfig(CONFIG))).toBe(5)
    expect(() => setKey('hereSnapshots', '0', CONFIG)).toThrow(/not a count/)
  })

  it('contains turns unless the operator turns it off, by name', () => {
    expect(containing(readConfig(CONFIG))).toBe(true)
    setKey('contain', 'off', CONFIG)
    expect(readConfig(CONFIG).contain).toBe(false)
    expect(containing(readConfig(CONFIG))).toBe(false)
    expect(() => setKey('contain', 'no', CONFIG)).toThrow(/on or off/)
    setKey('contain', 'on', CONFIG)
    expect(containing(readConfig(CONFIG))).toBe(true)
  })

  it('leaves root documents to spore upgrade unless docs is set to follow', () => {
    expect(followingDocs(readConfig(CONFIG))).toBe(false)
    setKey('docs', 'follow', CONFIG)
    expect(readConfig(CONFIG).docs).toBe('follow')
    expect(followingDocs(readConfig(CONFIG))).toBe(true)
    expect(() => setKey('docs', 'on', CONFIG)).toThrow(/follow or kept/)
    setKey('docs', 'kept', CONFIG)
    expect(followingDocs(readConfig(CONFIG))).toBe(false)
  })

  it('says the value in effect for every setting, and whether it is the runtime\'s default', () => {
    const shown = () => Object.fromEntries(settings(CONFIG).map(({ key, value, from }) => [key, [value, from]]))
    expect(shown()).toMatchObject({ turns: [8, 'default'], modelSessions: [8, 'default'], largestFile: ['1GB', 'default'], freeFloor: ['2GB', 'default'], home: [null, 'unset'], workspaces: [[], 'unset'] })
    setKey('turns', '3', CONFIG)
    setKey('freeFloor', '512MB', CONFIG)
    expect(shown()).toMatchObject({ turns: [3, 'set'], freeFloor: ['512MB', 'set'], largestFile: ['1GB', 'default'] })
  })

  it('holds how wide a turn\'s model calls may go as a count', () => {
    setKey('modelSessions', '4', CONFIG)
    expect(readConfig(CONFIG).modelSessions).toBe(4)
    expect(() => setKey('modelSessions', '0', CONFIG)).toThrow(/not a count/)
    expect(() => setKey('modelSessions', 'wide', CONFIG)).toThrow(/not a count/)
  })

  it('holds the gate as a path, kept as written and expanded on the way out', () => {
    expect(readConfig(CONFIG).gate).toBeUndefined()
    setKey('gate', '~/run/mohdel/data.sock', CONFIG)
    expect(getKey('gate', CONFIG)).toEqual({ gate: '~/run/mohdel/data.sock' })
    expect(readConfig(CONFIG).gate).toBe(resolve(homedir(), 'run/mohdel/data.sock'))
    removeFrom('gate', undefined, CONFIG)
    expect(readConfig(CONFIG).gate).toBeUndefined()
  })

  it('survives an interrupted write by renaming into place, never half a file', () => {
    setKey('workspaces', '/one', CONFIG)
    const before = require('node:fs').readFileSync(CONFIG, 'utf8')
    expect(() => JSON.parse(before)).not.toThrow()
    expect(require('node:fs').readdirSync(DIR).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('where a workspace goes', () => {
  it('is the current directory when nothing is asked for', () => {
    expect(workspaceFor(undefined, { cwd: DIR })).toEqual({ path: DIR, named: false })
  })

  it('takes a path as a path, whatever the configuration says', () => {
    expect(workspaceFor('./sub', { cwd: DIR }).path).toBe(resolve(DIR, 'sub'))
    expect(workspaceFor('./sub', { cwd: DIR }).named).toBe(false)
    expect(workspaceFor(resolve(DIR, 'abs'), { cwd: DIR }).named).toBe(false)
  })

  it('puts a bare name in the home, which is the only field that says where to put things', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const target = workspaceFor('triage', { cwd: DIR, file: CONFIG })
    expect(target.path).toBe(resolve(DIR, 'home', 'triage'))
    expect(target.named).toBe(true)
  })

  it('refuses a name that would not survive a shell or a directory listing', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    for (const bad of ['my report', '-rf', '_leading', 'a'.repeat(65), 'two/parts'.replace('/', '\\')]) {
      expect(() => workspaceFor(bad, { cwd: DIR, file: CONFIG })).toThrow()
    }
    for (const good of ['q3.2025', 'pubmed_pilot', 'web-onboarding', 'a']) {
      expect(workspaceFor(good, { cwd: DIR, file: CONFIG }).named).toBe(true)
    }
  })

  it('refuses a home that is itself a workspace, since a spore inside one is readable to it', () => {
    setKey('home', workspace(resolve(DIR, 'home')), CONFIG)
    expect(() => workspaceFor('triage', { cwd: DIR, file: CONFIG })).toThrow(/home is itself a workspace/)
  })

  it('refuses a bare name with no home rather than picking one of the listed workspaces', () => {
    setKey('workspaces', `${resolve(DIR, 'one')},${resolve(DIR, 'two')}`, CONFIG)
    expect(() => workspaceFor('triage', { cwd: DIR, file: CONFIG })).toThrow(/no home is set/)
  })
})

// Outside /tmp and outside the repo: `openWorkspace` refuses a granted path, so a test
// that actually makes a workspace cannot use the temp directory the rest of these use.
describe('a home split by the end of each name', () => {
  let OUT
  beforeEach(() => { OUT = outsideRoot('cli-split') })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  const V4 = '85266511-69a6-4dbf-bc33-0f665bc95d21'
  const V7 = '01927b3c-8f2e-7a1b-9c4d-5e6f7a8b9c0d'

  const splitHome = (n = 3) => {
    const at = resolve(OUT, 'home')
    setKey('home', at, CONFIG)
    setKey('homeSplit', String(n), CONFIG)
    writeDefault(definitionWith(MODEL))
    return at
  }

  it('puts a spore under the last characters of its name, or under its whole name when shorter', () => {
    const home = splitHome()
    expect(workspaceFor(V4, { file: CONFIG }).path).toBe(resolve(home, 'd21', V4))
    expect(workspaceFor(V7, { file: CONFIG }).path).toBe(resolve(home, 'c0d', V7))
    expect(workspaceFor('ab', { file: CONFIG }).path).toBe(resolve(home, 'ab', 'ab'))
  })

  it('refuses a name whose end cannot name a directory', () => {
    splitHome()
    for (const bad of ['notes.md', 'a..']) expect(() => workspaceFor(bad, { file: CONFIG })).toThrow(/cannot name a directory/)
  })

  it('makes, lists, shows and takes a message for a spore one level down, and never takes the split directory for one', () => {
    const home = splitHome()
    define({ ws: V4, configFile: CONFIG })
    const ws = resolve(home, 'd21', V4)
    expect(isWorkspace(ws)).toBe(true)
    expect(isWorkspace(resolve(home, 'd21'))).toBe(false)
    expect(list({ configFile: CONFIG }).workspaces.map(row => row.ws)).toEqual([ws])
    expect(show({ ws: V4, configFile: CONFIG }).ws).toBe(ws)
    send(ws, 'hello', { start: false })
    expect(readInbox(ws).map(m => m.text)).toEqual(['hello'])
  })

  it('is kept once the home holds a spore: changing it is refused by config set and on reading', () => {
    const home = splitHome()
    define({ ws: 'abc123', configFile: CONFIG })
    expect(existsSync(resolve(home, '.spore-home'))).toBe(true)
    expect(() => setKey('homeSplit', '2', CONFIG)).toThrow(/already holds spores/)
    expect(() => removeFrom('homeSplit', undefined, CONFIG)).toThrow(/already holds spores/)
    writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(readFileSync(CONFIG, 'utf8')), homeSplit: 2 }))
    expect(() => readConfig(CONFIG)).toThrow(/laid out homeSplit 3, and .* says homeSplit 2/)
  })

  it('is recorded once by a program that makes spores itself, and then guards the home as define\'s record does', () => {
    const home = resolve(OUT, 'threads')
    mkdirSync(home, { recursive: true })
    setKey('home', home, CONFIG)
    setKey('homeSplit', '3', CONFIG)
    const record = () => JSON.parse(readFileSync(resolve(home, '.spore-home'), 'utf8'))
    recordLayout(home, 3)
    recordLayout(home, 3)
    expect(record()).toEqual({ homeSplit: 3 })
    recordLayout(home, 2)
    expect(record()).toEqual({ homeSplit: 3 })
    writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(readFileSync(CONFIG, 'utf8')), homeSplit: 2 }))
    expect(() => readConfig(CONFIG)).toThrow(/laid out homeSplit 3, and .* says homeSplit 2/)
  })

  it('cannot be set on a flat home that holds spores, and is a count from 1 to 8', () => {
    setKey('home', resolve(OUT, 'flat'), CONFIG)
    writeDefault(definitionWith(MODEL))
    define({ ws: 'one', configFile: CONFIG })
    expect(() => setKey('homeSplit', '3', CONFIG)).toThrow(/already holds spores, laid out flat/)
    setKey('home', resolve(OUT, 'fresh'), CONFIG)
    for (const bad of ['0', '9', 'x']) expect(() => setKey('homeSplit', bad, CONFIG)).toThrow(/not a count from 1 to 8/)
    setKey('homeSplit', '3', CONFIG)
    expect(readConfig(CONFIG).homeSplit).toBe(3)
  })
})

describe('defining a spore', () => {
  let OUT
  beforeEach(() => { OUT = outsideRoot('cli-create') })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  // Most of these are about what define does once a home has a default; the two that are
  // about the default itself ask for an unseeded one.
  const home = ({ seeded = true } = {}) => {
    const at = resolve(OUT, 'home')
    setKey('home', at, CONFIG)
    if (seeded) writeDefault(definitionWith(MODEL))
    return at
  }

  // Seeded and then refused: the shipped definition names no model, so the first spore
  // cannot be cut until someone says what it runs on — asked once, in the file every
  // spore inherits it from.
  it('seeds the default beside the configuration and stops, when nothing has said what a spore runs on', () => {
    home({ seeded: false })

    expect(() => define({ ws: 'one', configFile: CONFIG })).toThrow(/new spores run on your default model, and .* just seeded, names none yet/)

    expect(existsSync(DEFAULT)).toBe(true)
    expect(readFileSync(DEFAULT, 'utf8')).not.toContain('model:')
  })

  it('says a sporangium naming no model runs on the default, when it is that one that was asked for', () => {
    home({ seeded: false })
    expect(() => define({ ws: 'one', sporangium: 'commit', configFile: CONFIG })).toThrow(/spores of the commit sporangium run on your default model, and .* names none yet/)
    expect(existsSync(resolve(OUT, 'home', 'one'))).toBe(false)
  })

  it('needs no default model when the spore is given one, seeding the default all the same', () => {
    home({ seeded: false })
    const made = define({ ws: 'one', sporangium: 'commit', model: 'fake/small', configFile: CONFIG })
    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('model: fake/small')
    expect(made.seeded).toBe(DEFAULT)
    expect(readFileSync(DEFAULT, 'utf8')).not.toContain('model:')
    expect(() => define({ ws: 'two', sporangium: 'commit', configFile: CONFIG })).toThrow(/spores of the commit sporangium run on your default model, and .* names none$/)
  })

  it('sets the model new spores are cut with, in the default and nowhere else', () => {
    home({ seeded: false })
    expect(defaultModel({ configFile: CONFIG }).model).toBe(null)

    expect(setDefaultModel('fake/first', { configFile: CONFIG }).model).toBe('fake/first')
    expect(defaultModel({ configFile: CONFIG }).model).toBe('fake/first')
    setDefaultModel('fake/second', { configFile: CONFIG })
    const written = readFileSync(DEFAULT, 'utf8')
    expect(written.match(/^model:/gm)).toHaveLength(1)
    expect(written).toContain('model: fake/second')
    expect(readConfig(CONFIG).model).toBeUndefined()

    const made = define({ ws: 'one', configFile: CONFIG })
    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('model: fake/second')
  })

  it('refuses a model the definition cannot hold, and leaves the default as it was', () => {
    home()
    expect(() => setDefaultModel('no provider', { configFile: CONFIG })).toThrow(/sporangia\/default\/spore\.cmk/)
    expect(readFileSync(DEFAULT, 'utf8')).toContain(`model: ${MODEL}`)
  })

  it('cuts every spore from the default once it names one', () => {
    home()
    const made = define({ ws: 'one', configFile: CONFIG })
    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain(`model: ${MODEL}`)
    expect(readFileSync(DEFAULT, 'utf8')).toContain(`model: ${MODEL}`)
  })

  // The complaint has to name the file to edit, not the workspace that inherited the gap.
  it('names the default when it is the one that does not parse', () => {
    home()
    writeDefault('---\nname: x\n---\nbody\n')
    expect(() => define({ ws: 'one', configFile: CONFIG })).toThrow(/sporangia\/default\/spore\.cmk/)
  })

  it('cuts from the default as edited, so the shipped one is a seed and not a source', () => {
    home()
    define({ ws: 'one', configFile: CONFIG })
    writeDefault(
      '---\nname: mine\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nmine.\n')

    const made = define({ ws: 'two', configFile: CONFIG })

    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('name: mine')
  })

  it('takes a definition over the default', () => {
    home()
    const own = resolve(OUT, 'own.cmk')
    writeFileSync(own, '---\nname: own\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nown.\n')

    const made = define({ ws: 'one', definition: own, configFile: CONFIG })

    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('name: own')
    expect(made.seeded).toBe(null)
  })

  it('records one made outside home, which is what that list is for', () => {
    home()
    const away = resolve(OUT, 'elsewhere', 'agent')

    const made = define({ ws: away, configFile: CONFIG })

    expect(made.remembered).toBe(away)
    expect(readConfig(CONFIG).workspaces).toEqual([away])
  })

  it('does not record one made in home, which is already searched', () => {
    home()
    expect(define({ ws: 'one', configFile: CONFIG }).remembered).toBe(null)
    expect(readConfig(CONFIG).workspaces).toEqual([])
  })

  it('is idempotent when nothing new is said, rather than resetting an edited definition', () => {
    const at = home()
    define({ ws: 'one', configFile: CONFIG })
    writeFileSync(resolve(at, 'one', 'spore.cmk'),
      '---\nname: edited\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nedited.\n')

    const again = define({ ws: 'one', configFile: CONFIG })

    expect(again.already).toBe(true)
    expect(readFileSync(resolve(at, 'one', 'spore.cmk'), 'utf8')).toContain('name: edited')
  })

  // Defining and running are separate acts, so revising what a spore is must not cost it
  // what it has done. Editing spore.cmk by hand already worked; refusing it here would
  // only make the command worse than cp.
  it('redefines an existing spore and leaves its conversation and data alone', () => {
    const at = home()
    const made = define({ ws: 'one', configFile: CONFIG })
    writeTranscriptEntries(made.ws, [{ at: '2026-09-25T00:00:00.000Z', kind: 'message', role: 'user', message: { role: 'user', content: 'hello' } }])
    writeFileSync(resolve(made.ws, 'data', 'kept.txt'), 'work')
    const own = resolve(OUT, 'analyst.cmk')
    writeFileSync(own, '---\nname: analyst\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nanalyse.\n')

    const again = define({ ws: 'one', definition: own, configFile: CONFIG })

    expect(again.redefined).toEqual({ from: 'spore', to: 'analyst' })
    expect(readFileSync(resolve(at, 'one', 'spore.cmk'), 'utf8')).toContain('name: analyst')
    expect(readTranscriptEntries(made.ws).map(entry => entry.message.content)).toContain('hello')
    expect(readFileSync(resolve(made.ws, 'data', 'kept.txt'), 'utf8')).toBe('work')
  })

  // Not theoretical: revising short-circuited the refusal creating goes through, and wrote
  // into the shipped `spore.cmk` at the package root — which looks like a workspace
  // because the seed lives there.
  it('refuses to revise a definition inside a sandbox-granted path, as creating one is', () => {
    home()
    const own = resolve(OUT, 'other.cmk')
    writeFileSync(own, definitionWith(MODEL))
    const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    expect(() => define({ ws: runtime, definition: own, configFile: CONFIG }))
      .toThrow(/sandbox-granted path/)
  })

  it('refuses a definition that does not parse without losing the one in place', () => {
    home()
    const made = define({ ws: 'one', configFile: CONFIG })
    const bad = resolve(OUT, 'bad.cmk')
    writeFileSync(bad, '---\nname: broken\n---\n\nno limits.\n')

    expect(() => define({ ws: 'one', definition: bad, configFile: CONFIG })).toThrow(/rounds/)

    expect(readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')).toContain('name: spore')
  })

  const pluginsBeside = () => {
    const modules = resolve(OUT, 'node_modules')
    mkdirSync(resolve(modules, '@example'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, 'fixtures/plugins/docs'), resolve(modules, '@example/spore-plugin-docs'))
    mkdirSync(resolve(modules, 'spore-plugin-extra'))
    writeFileSync(resolve(modules, 'spore-plugin-extra/package.json'), JSON.stringify({ name: 'spore-plugin-extra', version: '0.1.0', spore: { works: '^1' } }))
    for (const name of ['docs', 'extra']) allowPlugin(name, [], { configFile: CONFIG, roots: [modules] })
    return [modules]
  }

  it('fills in the model and plugins of the spore.cmk it makes, and leaves the rest as written', () => {
    home()
    const roots = pluginsBeside()
    writeDefault(definitionWith(MODEL).replace('\n---', '\nplugins: [docs]\n---'))

    const made = define({ ws: 'one', model: 'fake/other', plugins: ['extra', 'docs'], configFile: CONFIG, roots })

    const written = readFileSync(resolve(made.ws, 'spore.cmk'), 'utf8')
    expect(written).toContain('model: fake/other')
    expect(written).not.toContain(`model: ${MODEL}`)
    expect(written).toContain('plugins: [docs, extra]')
    expect(precursors({ ws: made.ws, configFile: CONFIG }).precursors).toEqual(['extract', 'review', 'summarize'])
    expect(written.slice(written.indexOf('\n---'))).toBe(definitionWith(MODEL).slice(definitionWith(MODEL).indexOf('\n---')))
    expect(readFileSync(DEFAULT, 'utf8')).toContain(`model: ${MODEL}`)
  })

  it('fills in only a spore it is making', () => {
    home()
    define({ ws: 'one', configFile: CONFIG })
    const err = (() => { try { define({ ws: 'one', model: 'fake/other', configFile: CONFIG }) } catch (e) { return e } })()
    expect(err.type).toBe('DEFINE_FILLS_ONLY_NEW')
    expect(readFileSync(resolve(OUT, 'home/one/spore.cmk'), 'utf8')).toContain(`model: ${MODEL}`)
  })

  it('refuses a plugin that is not allowed, and leaves nothing behind', () => {
    home()
    expect(() => define({ ws: 'one', plugins: ['docs'], configFile: CONFIG })).toThrow(/uses plugin "docs", which is not allowed/)
    expect(existsSync(resolve(OUT, 'home/one'))).toBe(false)
  })

  it('refuses a directory to write that overlaps spore\'s own runtime, and makes nothing', () => {
    home()
    const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const err = (() => { try { define({ ws: 'one', writes: [`here=${runtime}`], configFile: CONFIG }) } catch (e) { return e } })()
    expect(err).toMatchObject({ type: 'WRITES_REFUSED', detail: expect.stringMatching(/overlaps the runtime/) })
    expect(existsSync(resolve(OUT, 'home/one'))).toBe(false)
  })

  it('leaves no directory behind when the workspace is refused', () => {
    home()
    // Under /tmp, which the sandbox grants and openWorkspace therefore refuses.
    const inside = resolve(DIR, 'refused')
    expect(() => define({ ws: inside, configFile: CONFIG })).toThrow()
    expect(existsSync(inside)).toBe(false)
  })
})

describe('editing a spore\'s definition', () => {
  const held = () => readFileSync(resolve(DIR, 'home', 'test', 'spore.cmk'), 'utf8')
  const writes = (...texts) => {
    const opened = []
    return { opened, open: (file) => { opened.push(file); writeFileSync(file, texts[opened.length - 1](readFileSync(file, 'utf8'))); return 0 } }
  }
  const asked = (...answers) => {
    const errors = []
    return { errors, again: async (error) => { errors.push(error); return answers.shift() } }
  }

  beforeEach(() => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    workspace(resolve(DIR, 'home', 'test'))
  })

  it('switches the model to one it offers, keeping the one it leaves on offer, and refuses any other', () => {
    writeFileSync(resolve(DIR, 'home', 'test', 'spore.cmk'), held().replace(/^model: .*$/m, 'model: m/a\nmodels: [m/b]'))
    expect(switchModel({ ws: 'test', model: 'm/b', configFile: CONFIG })).toMatchObject({ model: 'm/b', was: 'm/a' })
    expect(held()).toMatch(/^model: m\/b\nmodels: \[m\/a\]$/m)
    expect(show({ ws: 'test', configFile: CONFIG })).toMatchObject({ model: 'm/b', models: ['m/a'] })
    expect(switchModel({ ws: 'test', model: 'm/b', configFile: CONFIG })).toMatchObject({ model: 'm/b', was: 'm/b' })
    expect(() => switchModel({ ws: 'test', model: 'm/costly', configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'MODEL_NOT_OFFERED', detail: expect.stringMatching(/offers m\/b, m\/a/) }))
  })

  it('replaces spore.cmk with what was saved, and says what changed', async () => {
    const editor = writes(text => text.replace('wall: [1m, 2m]', 'wall: [10m, 12m]\nextend.wall: 1h').replace('you are a test.', 'you are a careful test.'))
    const result = await edit({ ws: 'test', open: editor.open, again: asked().again, configFile: CONFIG })
    expect(result.edited).toBe(true)
    expect(result.changes).toEqual(['identity — the next turn writes its prompt cache anew', 'wall [1m, 2m] → [10m, 12m]', 'extend.wall none → 1h'])
    expect(held()).toMatch(/extend\.wall: 1h/)
    expect(existsSync(dirname(editor.opened[0]))).toBe(false)
  })

  it('opens it again on a definition that does not parse, and keeps nothing it was told to drop', async () => {
    const broken = text => text.replace('rounds: [2, 3]', 'rounds: [3, 2]')
    const fixed = text => text.replace('rounds: [3, 2]', 'rounds: [4, 5]')
    const twice = writes(broken, fixed)
    const yes = asked(true)
    const result = await edit({ ws: 'test', open: twice.open, again: yes.again, configFile: CONFIG })
    expect(yes.errors[0]).toMatch(/hard rounds limit that is not past the soft one/)
    expect(result.changes).toEqual(['rounds [2 rounds, 3 rounds] → [4 rounds, 5 rounds]'])

    const before = held()
    const no = asked(false)
    const breaksAgain = text => text.replace('rounds: [4, 5]', 'rounds: [5, 4]')
    const dropped = await edit({ ws: 'test', open: writes(breaksAgain).open, again: no.again, configFile: CONFIG })
    expect(dropped).toMatchObject({ edited: false, why: 'refused' })
    expect(held()).toBe(before)
  })

  it('writes nothing when nothing changed, when the editor fails, or when the file moved underneath', async () => {
    expect(await edit({ ws: 'test', open: () => 0, again: asked().again, configFile: CONFIG })).toMatchObject({ edited: false, why: 'unchanged' })
    expect(await edit({ ws: 'test', open: () => 1, again: asked().again, configFile: CONFIG })).toMatchObject({ edited: false, why: 'editor', status: 1 })

    const meanwhile = (file) => {
      writeFileSync(file, readFileSync(file, 'utf8').replace('you are a test.', 'you are mine.'))
      writeFileSync(resolve(DIR, 'home', 'test', 'spore.cmk'), held().replace('you are a test.', 'you are theirs.'))
      return 0
    }
    const conflict = await edit({ ws: 'test', open: meanwhile, again: asked().again, configFile: CONFIG }).catch(err => err)
    expect(conflict).toMatchObject({ type: 'EDIT_CONFLICT', message: expect.stringMatching(/changed while it was being edited/) })
    const kept = conflict.detail.split('your version is ')[1]
    expect(readFileSync(kept, 'utf8')).toMatch(/you are mine\./)
    rmSync(dirname(kept), { recursive: true })
    expect(held()).toMatch(/you are theirs\./)
  })
})

describe('finding workspaces', () => {
  it('knows one by its definition, so one that never ran is still found', () => {
    const ws = workspace(resolve(DIR, 'fresh'))
    expect(isWorkspace(ws)).toBe(true)
    expect(workspacesIn(DIR)).toEqual([ws])
  })

  it('does not treat a workspace\'s own state as more workspaces', () => {
    const ws = workspace(resolve(DIR, 'w'))
    mkdirSync(resolve(ws, 'data', 'nested'), { recursive: true })
    writeFileSync(resolve(ws, 'data', 'nested', 'spore.cmk'), 'not a workspace, scratch')
    expect(workspacesIn(DIR)).toEqual([ws])
  })

  it('looks one level down and no further, so a checkout under a home costs nothing', () => {
    const deep = workspace(resolve(DIR, 'a', 'b', 'c'))
    expect(workspacesIn(DIR)).toEqual([])
    expect(workspacesIn(resolve(DIR, 'a', 'b'))).toEqual([deep])
  })

  it('finds a workspace whatever it is called, having no names it skips', () => {
    const named = ['data', 'build', 'node_modules', 'precursors'].map(n => workspace(resolve(DIR, n)))
    expect(workspacesIn(DIR).sort()).toEqual(named.sort())
  })
})

describe('the read verbs', () => {
  it('reports state and spend from the files, with no process involved', () => {
    workspace(resolve(DIR, 'root', 'done'), {
      turns: [{ stopReason: 'answer', concluded: true, ownMicros: 10_000, treeMicros: 20_000 }]
    })
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'root') }))

    const result = list({ configFile: CONFIG })

    expect(result.workspaces).toHaveLength(1)
    expect(result.workspaces[0].state).toBe('idle')
    expect(result.workspaces[0].treeUsd).toBe(0.02)
    expect(result.workspaces[0]).toMatchObject({ writes: [], definitionError: null })
  })

  it('walks the home, because it is a directory of workspaces rather than one itself', () => {
    workspace(resolve(DIR, 'home', 'made'))
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'home') }))

    const result = list({ configFile: CONFIG })

    expect(result.home).toBe(resolve(DIR, 'home'))
    expect(result.workspaces.map(row => row.ws)).toEqual([resolve(DIR, 'home', 'made')])
  })

  it('takes a listed workspace as one, rather than looking inside it', () => {
    const outside = workspace(resolve(DIR, 'elsewhere', 'agent'))
    workspace(resolve(outside, 'nested'))
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'home'), workspaces: [outside] }))

    const result = list({ configFile: CONFIG })

    expect(result.workspaces.map(row => row.ws)).toEqual([outside])
  })

  it('names the same spores as the list, in its order', () => {
    workspace(resolve(DIR, 'home', 'made'))
    const outside = workspace(resolve(DIR, 'elsewhere', 'agent'))
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'home'), workspaces: [outside, resolve(DIR, 'home', 'made'), resolve(DIR, 'vanished')] }))

    expect(sporePaths({ configFile: CONFIG })).toEqual(list({ configFile: CONFIG }).workspaces.map(row => row.ws))
    expect(sporePaths({ configFile: CONFIG })).toEqual([resolve(DIR, 'home', 'made'), outside])
  })

  it('says which listed path is gone and which is simply not a workspace', () => {
    const notOne = resolve(DIR, 'plain')
    mkdirSync(notOne, { recursive: true })
    writeFileSync(CONFIG, JSON.stringify({ workspaces: [resolve(DIR, 'vanished'), notOne] }))

    const result = list({ configFile: CONFIG })

    expect(result.missing).toEqual([
      { path: resolve(DIR, 'vanished'), why: 'gone' },
      { path: notOne, why: 'no spore.cmk, so not a workspace' }
    ])
  })

  it('does not call a home that is not there yet a path that went missing', () => {
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'later') }))

    const result = list({ configFile: CONFIG })

    expect(result.missing).toEqual([])
    expect(result.workspaces).toEqual([])
  })

  it('says how much history the last measured turn carried against its bound, and how much of it the cache served', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const over = { stopReason: 'answer', concluded: true, rounds: 9, historySent: 313_000, historyBound: 256_000, inputTokens: 2_000_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 }
    workspace(resolve(DIR, 'home', 'test'), { turns: [over] })
    workspace(resolve(DIR, 'home', 'held'), { turns: [{ ...over, historySent: 200_000 }, { stopReason: 'error', concluded: false }] })

    expect(show({ ws: 'test', configFile: CONFIG }).history).toEqual({ turnNo: 1, sent: 313_000, bound: 256_000, over: true, rounds: 9, cacheShare: 0.2 })
    expect(show({ ws: 'held', configFile: CONFIG }).history).toMatchObject({ turnNo: 1, sent: 200_000, over: false })
    const rows = Object.fromEntries(list({ configFile: CONFIG }).workspaces.map(row => [row.ws.split('/').at(-1), row.historyOver]))
    expect(rows).toEqual({ test: true, held: false })
  })

  it('names a spore the way send does, so a bare name is the one in home', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))

    expect(show({ ws: 'test', configFile: CONFIG }).ws).toBe(ws)
    expect(precursors({ ws: 'test', configFile: CONFIG }).ws).toBe(ws)
    expect(() => show({ ws: 'absent', configFile: CONFIG })).toThrow(/no spore called "absent"/)
  })

  it('reads what a spore is from its definition, without opening the workspace to do it', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    writeTranscriptEntries(ws, [{ at: '2026-09-25T00:00:00.000Z', kind: 'message', role: 'user', message: { role: 'user', content: 'hi' } }])

    const detail = show({ ws: 'test', configFile: CONFIG })

    expect(detail.name).toBe('t')
    expect(detail.tools).toEqual(['read'])
    expect(detail.limits.rounds).toEqual({ soft: 2, hard: 3 })
    expect(detail.messages).toBe(1)
    // Reading is not opening: nothing was seeded into the workspace to answer this.
    expect(existsSync(resolve(ws, 'reference.md'))).toBe(false)
  })

  // How far a turn read, which it records, is what makes this exact: anything past the last
  // one is work nobody has answered, which is the difference between idle and not started yet.
  it('counts what is waiting in the inbox, so idle and not-started-yet are not the same', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    const answered = appendInbox(ws, 'answered')
    appendInbox(ws, 'still waiting')
    writeTurnRecords(ws, [{ startedAt: 'S', stopReason: 'answer', concluded: true, ownMicros: 10_000, treeMicros: 10_000, inboxTo: answered }])

    expect(show({ ws: 'test', configFile: CONFIG }).waiting).toBe(1)
  })

  it('lines a spore up turn by turn, each with what was said to start it', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    const first = appendInbox(ws, 'do the first thing')
    const second = appendInbox(ws, 'now the second')
    appendInbox(ws, 'and one more')
    writeTurnRecords(ws, [
      { startedAt: 'S', stopReason: 'answer', concluded: true, rounds: 4, treeMicros: 30_000, workUnits: 6, endedAt: 'A', inboxTo: first },
      { startedAt: 'S', stopReason: 'soft:cost', concluded: true, rounds: 45, treeMicros: 520_000, workUnits: 92, endedAt: 'B', inboxTo: second }
    ])

    const timeline = log({ ws: 'test', configFile: CONFIG })

    expect(timeline.turns.map(t => t.asked.map(entry => entry.text))).toEqual([['do the first thing'], ['now the second']])
    expect(timeline.turns[1]).toMatchObject({ stopReason: 'soft:cost', concluded: true, rounds: 45, treeUsd: 0.52, workUnits: 92 })
    expect(timeline.waiting.map(w => w.text)).toEqual(['and one more'])
  })

  it('says why a turn that could not start failed, from its record', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    const first = appendInbox(ws, 'how many issues?')
    writeTurnRecords(ws, [
      { startedAt: 'S', stopReason: 'error', concluded: false, rounds: 0, treeMicros: 0, workUnits: 0, endedAt: 'A', inboxTo: first - 1, error: 'START_FAILED', detail: 'source "forgejo" wants $FORGEJO_TOKEN, which is not set here' }
    ])

    const [turn] = log({ ws: 'test', configFile: CONFIG }).turns

    expect(turn).toMatchObject({ stopReason: 'error', error: 'START_FAILED', detail: 'source "forgejo" wants $FORGEJO_TOKEN, which is not set here', asked: [] })
  })

  it('says what a spore takes on disk, by what holds it, and not what it only links to', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    appendInbox(ws, 'hello')
    mkdirSync(resolve(ws, 'data'), { recursive: true })
    writeFileSync(resolve(ws, 'data', 'report.md'), 'x'.repeat(5000))
    symlinkSync(resolve(DIR), resolve(ws, 'data', 'elsewhere'))

    const { disk } = show({ ws: 'test', configFile: CONFIG })
    expect(disk.data).toBe(5000)
    expect(disk.state).toBeGreaterThan(0)
    expect(disk.total).toBe(disk.state + disk.calls + disk.inbox + disk.data + disk.other)

    const [row] = list({ disk: true, configFile: CONFIG }).workspaces
    expect(row.bytes).toBe(disk.total)
    expect(list({ configFile: CONFIG }).workspaces[0].bytes).toBeUndefined()
  })

  it('reads a spore\'s records with SQL, by name, as the agent does with $SPORE_SQL', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    appendInbox(ws, 'hello')
    appendInbox(ws, 'again')

    expect(sql({ ws: 'test', configFile: CONFIG }).lines).toEqual(['approvals', 'calls', 'cells', 'events', 'held', 'inbox', 'jobs', 'limits', 'outbox', 'transcript', 'turns'])
    expect(sql({ ws: 'test', query: 'SELECT inboxNo, text FROM inbox ORDER BY inboxNo', configFile: CONFIG }).lines)
      .toEqual(['inboxNo  text', '1        hello', '2        again'])
    expect(sql({ ws: 'test', query: 'SELECT inboxNo FROM inbox', json: true, configFile: CONFIG }).lines).toEqual(['{"inboxNo":1}', '{"inboxNo":2}'])
    expect(sql({ ws: 'test', query: '.schema turns', configFile: CONFIG }).lines[0]).toMatch(/^CREATE VIEW turns AS/)
  })

  it('says a spore has recorded nothing yet, and refuses to write', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'))
    expect(() => sql({ ws: 'test', configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'SQL_NO_DATABASE' }))
    appendInbox(ws, 'hello')
    expect(() => sql({ ws: 'test', query: "INSERT INTO t_inbox (at, text) VALUES ('t', 'forged')", configFile: CONFIG })).toThrow(/readonly/)
    expect(readInbox(ws)).toHaveLength(1)
  })

  it('says in show and in log why a schedule is not firing', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    const ws = workspace(resolve(DIR, 'home', 'test'), {
      turns: [{ stopReason: 'question', concluded: true }]
    })
    mkdirSync(resolve(ws, 'schedules'))
    const then = new Date(Date.now() - 10 * 60_000)
    writeFileSync(resolve(ws, 'schedules/queue.cmk'), '---\nwhen: * * * * *\ntz: UTC\n---\n\nCheck the queue.\n')
    utimesSync(resolve(ws, 'schedules/queue.cmk'), then, then)
    writeFileSync(resolve(ws, 'schedules/broken.cmk'), '---\nwhen: sometimes\ntz: UTC\n---\nx\n')

    const shown = show({ ws: 'test', configFile: CONFIG }).schedules
    expect(shown.map(s => [s.name, s.state, s.why?.slice(0, 20)])).toEqual([
      ['broken', 'refused', 'has a when that is n'],
      ['queue', 'held', 'waiting']
    ])
    expect(shown[1].message).toBeUndefined()
    expect(log({ ws: 'test', configFile: CONFIG }).held.map(s => [s.name, s.state])).toEqual([['broken', 'refused'], ['queue', 'held']])
  })

  it('sets, lists and removes a schedule through the verbs', () => {
    const ws = workspace(resolve(DIR, 'w'))
    const hourly = '---\nwhen: 0 * * * *\ntz: UTC\n---\n\nCheck the queue.\n'

    expect(setSchedule({ ws, name: 'queue', source: hourly })).toMatchObject({ name: 'queue', path: resolve(ws, 'schedules/queue.cmk') })
    expect(readFileSync(resolve(ws, 'schedules/queue.cmk'), 'utf8')).toBe(hourly)
    expect(() => setSchedule({ ws, name: 'bad', source: '---\nwhen: 0 * * * *\n---\nx\n' })).toThrow(/no tz/)
    expect(() => setSchedule({ ws, name: '../escape', source: hourly })).toThrow(/only <name>\.cmk files/)
    expect(schedules({ ws }).schedules.map(s => [s.name, s.state])).toEqual([['queue', 'later']])

    expect(removeSchedule({ ws, name: 'queue' }).path).toBe(resolve(ws, 'schedules/queue.cmk'))
    expect(existsSync(resolve(ws, 'schedules/queue.cmk'))).toBe(false)
    expect(() => removeSchedule({ ws, name: 'queue' })).toThrow(/no schedule called "queue"/)
    expect(schedules({ ws }).schedules).toEqual([])
  })

  it('puts a number on what the clock may spend, from the declared bounds', () => {
    const ws = workspace(resolve(DIR, 'w'))
    writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8').replace('tools: [read]\n', 'tools: [read]\nschedules: [2, 6h]\n'))
    expect(show({ ws }).scheduleBound).toEqual({ count: 2, interval: 21_600_000, perDay: 8, nominalCost: 1.6 })
  })

  it('reports when the last turn ended, which is how you tell which one you were on', () => {
    setKey('home', resolve(DIR, 'home'), CONFIG)
    workspace(resolve(DIR, 'home', 'test'), {
      turns: [{ stopReason: 'answer', concluded: true, ownMicros: 10_000, treeMicros: 10_000, endedAt: '2026-09-21T10:00:00.000Z' }]
    })

    expect(show({ ws: 'test', configFile: CONFIG }).endedAt).toBe('2026-09-21T10:00:00.000Z')
  })

  it('sums work units across a workspace\'s whole life, not just its last turn', () => {
    const ws = workspace(resolve(DIR, 'w'), {
      turns: [
        { concluded: true, workUnits: 6, workUnitsOwn: 2, workUnitsChildren: 2 },
        { concluded: true, workUnits: 4, workUnitsOwn: 1, workUnitsChildren: 2 }
      ]
    })

    const result = show({ ws })

    expect(result.workUnits).toBe(10)
    expect(result).toMatchObject({ workUnitsOwn: 3, workUnitsChildren: 4 })
  })

  it('reports no units for a workspace older than the counter, rather than guessing', () => {
    const ws = workspace(resolve(DIR, 'old'), { turns: [{ concluded: true, ownMicros: 10_000 }] })
    expect(show({ ws }).workUnits).toBe(0)
  })

  it('refuses a directory that is not a workspace', () => {
    expect(() => show({ ws: DIR })).toThrow(/not a workspace/)
  })

  it('says how its model is paid for, as mohdel declares it, and nothing for a provider mohdel does not know', () => {
    const on = (model) => {
      const ws = workspace(resolve(DIR, model.replace('/', '-')))
      writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8').replace(MODEL, model))
      return ws
    }
    for (const model of ['chatgpt/some-model', 'local/some-model', MODEL]) {
      expect(grantOf(on(model)).billing).toEqual(billingOf(model))
      expect(show({ ws: on(model) }).billing).toEqual(billingOf(model))
    }
    expect(grantOf(on('nobody/some-model')).billing).toBe(null)
    expect(show({ ws: on('nobody/some-model') }).model).toBe('nobody/some-model')
  })

  it('lists what a workspace can delegate to', () => {
    const ws = workspace(resolve(DIR, 'w'), { precursors: ['review', 'extract'] })
    expect(precursors({ ws }).precursors).toEqual(['extract', 'review'])
  })
})

describe('usage, as the command reads it', () => {
  const today = new Date().toISOString().slice(0, 10)
  const spent = (micros) => ({ startedAt: `${today}T00:00:01.000Z`, stopReason: 'answer', concluded: true, settled: true, model: 'anthropic/some-model', treeMicros: micros, rounds: 1 })

  it('reads every spore of home over the last seven days, when no spore is named', () => {
    workspace(resolve(DIR, 'home', 'one'), { turns: [spent(10_000)] })
    workspace(resolve(DIR, 'home', 'two'), { turns: [spent(30_000)] })
    writeFileSync(CONFIG, JSON.stringify({ home: resolve(DIR, 'home') }))

    const result = usage({ tz: 'UTC', configFile: CONFIG })

    expect(result.ws).toBe(null)
    expect(result.days).toHaveLength(7)
    expect(result.window.until).toBe(today)
    expect(result.by.spore.map(row => [row.key, row.micros])).toEqual([['two', 30_000], ['one', 10_000]])
  })

  it('reads one spore over --days, and refuses a window given two ways', () => {
    const ws = workspace(resolve(DIR, 'one'), { turns: [spent(10_000)] })

    const result = usage({ ws, days: 3, tz: 'UTC', configFile: CONFIG })

    expect(result.ws).toBe(ws)
    expect(result.days.map(day => day.micros)).toEqual([0, 0, 10_000])
    expect(() => usage({ ws, days: 3, since: today, tz: 'UTC', configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'USAGE_INVALID' }))
    expect(() => usage({ ws, days: 0, tz: 'UTC', configFile: CONFIG })).toThrow(expect.objectContaining({ type: 'USAGE_INVALID' }))
  })
})

describe('reads, as a corpus the workspace points at', () => {
  let OUT
  beforeEach(() => { OUT = outsideRoot('cli-reads') })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  const withReads = (declared) => {
    const ws = resolve(OUT, 'ws')
    mkdirSync(ws, { recursive: true })
    writeFileSync(resolve(ws, 'spore.cmk'),
      `---\nname: r\nmodel: ${MODEL}\nreads: [${declared}]\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nr.\n`)
    return ws
  }

  it('links the corpus in under the name the definition gave it', () => {
    const corpus = resolve(OUT, 'corpus')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(resolve(corpus, 'a.txt'), 'material')
    const ws = withReads(`papers=${corpus}`)

    const opened = openWorkspace(ws)

    expect(opened.reads).toEqual([{ name: 'papers', path: corpus, missing: false }])
    expect(readFileSync(resolve(ws, 'papers', 'a.txt'), 'utf8')).toBe('material')
  })

  // A dangling name reads as a corpus the agent cannot open, with nothing to say why.
  it('drops a corpus that is not there rather than staging a broken name', () => {
    const ws = withReads(`gone=${resolve(OUT, 'nowhere')}`)
    expect(openWorkspace(ws).reads).toEqual([])
    expect(existsSync(resolve(ws, 'gone'))).toBe(false)
  })

  it('never stages over what the workspace holds under the name, only over its own link', () => {
    const corpus = resolve(OUT, 'corpus')
    const ws = resolve(OUT, 'ws')
    mkdirSync(corpus, { recursive: true })
    mkdirSync(resolve(ws, 'notes'), { recursive: true })
    writeFileSync(resolve(ws, 'notes', 'kept.txt'), 'mine')

    const [kept] = linkGrants(ws, [{ name: 'notes', path: corpus }])
    expect(kept).toMatchObject({ missing: true, error: expect.stringContaining('not a link') })
    expect(readFileSync(resolve(ws, 'notes', 'kept.txt'), 'utf8')).toBe('mine')

    rmSync(resolve(ws, 'notes'), { recursive: true })
    symlinkSync(resolve(OUT, 'elsewhere'), resolve(ws, 'notes'))
    expect(linkGrants(ws, [{ name: 'notes', path: corpus }])).toEqual([{ name: 'notes', path: corpus, missing: false }])
  })

  it('drops the link of a grant the definition no longer declares, and of one whose directory is gone', () => {
    const corpus = resolve(OUT, 'corpus')
    const gone = resolve(OUT, 'gone')
    mkdirSync(corpus, { recursive: true })
    mkdirSync(gone, { recursive: true })
    const ws = withReads(`notes=${corpus},old=${gone}`)
    openWorkspace(ws)
    expect(lstatSync(resolve(ws, 'notes')).isSymbolicLink()).toBe(true)
    symlinkSync(resolve(ws, 'data'), resolve(ws, 'inside'))

    rmSync(gone, { recursive: true })
    withReads(`old=${gone}`)
    openWorkspace(ws)

    expect(lstatSync(resolve(ws, 'notes'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(resolve(ws, 'old'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(corpus)).toBe(true)
    expect(lstatSync(resolve(ws, 'inside')).isSymbolicLink()).toBe(true)
  })
})

describe('writes, as a directory the spore works in', () => {
  let OUT
  beforeEach(() => { OUT = outsideRoot('cli-writes') })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  const withWrites = (declared) => {
    const ws = resolve(OUT, 'ws')
    mkdirSync(ws, { recursive: true })
    writeFileSync(resolve(ws, 'spore.cmk'),
      `---\nname: w\nmodel: ${MODEL}\nwrites: [${declared}]\ntools: [read, write]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nw.\n`)
    return ws
  }

  it('links the directory in, and is the same link on every opening', () => {
    const proj = resolve(OUT, 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(resolve(proj, 'README'), 'project')
    const ws = withWrites(`here=${proj}`)

    expect(openWorkspace(ws).writes).toEqual([{ name: 'here', path: proj, missing: false }])
    expect(openWorkspace(ws).writes).toEqual([{ name: 'here', path: proj, missing: false }])
    expect(readFileSync(resolve(ws, 'here', 'README'), 'utf8')).toBe('project')
    expect(openWorkspace(ws).domainRules).toMatch(/^here\/ is the directory you were opened on/)
  })

  it('refuses to open a spore whose directory cannot be staged', () => {
    const ws = withWrites(`here=${resolve(OUT, 'nowhere')}`)
    expect(openWorkspace(ws).error).toMatch(/writes here=.*cannot be staged/)
  })

  it('refuses a name the workspace uses, before anything is staged', () => {
    const proj = resolve(OUT, 'proj')
    mkdirSync(proj, { recursive: true })
    const ws = withWrites(`data=${proj}`)
    expect(openWorkspace(ws).error).toMatch(/the workspace already uses/)
  })
})

// The command is argument parsing over the library, so anything driving a spore gets the
// same answers. Two implementations of the lock race below would be two runners.
const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('send, as the library the command is built on', () => {
  let OUT
  beforeEach(() => { OUT = outsideRoot('cli-send') })
  afterEach(() => rmSync(OUT, { recursive: true, force: true }))

  const made = () => {
    setKey('home', resolve(OUT, 'home'), CONFIG)
    mkdirSync(resolve(OUT, 'home'), { recursive: true })
    writeDefault(definitionWith(MODEL))
    return define({ ws: 'one', configFile: CONFIG }).ws
  }

  const oneTurn = () => {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ turns: 1 }))
  }
  afterEach(() => rmSync(CONFIG_FILE, { force: true }))

  it('delivers the message to the inbox when it starts a turn', async () => {
    const ws = made()
    const result = send(ws, 'first', { env: { PATH: process.env.PATH } })
    expect(result.started).toBe(true)
    expect(readInbox(ws).map(m => m.text)).toEqual(['first'])
    await until(() => stateOf(ws).state !== RUNNING)
  })

  it('does not start a second runner when one already holds the lock', () => {
    const ws = made()
    acquireLock(ws)
    try {
      const result = send(ws, 'while it runs', { env: { PATH: process.env.PATH } })

      expect(result.started).toBe(false)
      expect(result.pid).toBe(null)
      // Delivered all the same: the running turn reads the inbox between rounds.
      expect(readInbox(ws).map(m => m.text)).toEqual(['while it runs'])
    } finally {
      releaseLock(ws)
    }
  })

  it('pauses every spore: stops what runs, starts nothing and says nothing, until it is unpaused', () => {
    const ws = made()
    const stopped = []
    acquireLock(ws)
    try {
      const result = pause({ why: 'maintenance', configFile: CONFIG, stopTurn: (at) => { stopped.push(at); return { stopped: true, pid: 1 } }, stopJob: () => null })
      expect(result).toMatchObject({ already: false, mark: { why: 'maintenance' }, turns: [ws], jobs: [] })
      expect(stopped).toEqual([ws])
    } finally {
      releaseLock(ws)
    }
    expect(pause({ configFile: CONFIG, stopTurn: () => { throw new Error('nothing runs') } })).toMatchObject({ already: true, mark: { why: 'maintenance' }, turns: [] })

    expect(() => send(ws, 'while paused', { env: { PATH: process.env.PATH } }))
      .toThrow(expect.objectContaining({ type: 'PAUSED' }))
    expect(readInbox(ws)).toEqual([])
    expect(tick({ configFile: CONFIG, lock: resolve(OUT, 'tick.lock') })).toMatchObject({ ran: true, paused: { why: 'maintenance' }, lines: [] })

    expect(unpause()).toMatchObject({ unpaused: true, mark: { why: 'maintenance' } })
    expect(unpause().unpaused).toBe(false)
    expect(tick({ configFile: CONFIG, lock: resolve(OUT, 'tick.lock') }).paused).toBeUndefined()
  })

  it('refuses a turn when every slot is held, and says nothing', () => {
    const ws = made()
    oneTurn()
    const held = takeSlot()
    try {
      expect(() => send(ws, 'too many', { env: { PATH: process.env.PATH } }))
        .toThrow(expect.objectContaining({ type: 'ADMISSION_FULL' }))
      expect(readInbox(ws)).toEqual([])
    } finally {
      closeSync(held.fd)
    }
  })

  it('takes a message sent again under its request id once, and starts nothing for one answered', () => {
    const ws = made()
    const opts = { requestId: 'telegram:7', env: { PATH: process.env.PATH } }
    acquireLock(ws)
    const first = send(ws, 'yes', opts)
    const again = send(ws, 'yes', opts)
    releaseLock(ws)
    expect([first.inbox, first.repeated, again.inbox, again.repeated]).toEqual([1, false, 1, true])

    appendTurn(ws, { startedAt: new Date().toISOString(), stopReason: 'answer', concluded: true, inboxTo: 1 })
    expect(send(ws, 'yes', opts)).toMatchObject({ started: false, pid: null, inbox: 1, repeated: true })
    expect(readInbox(ws).map(m => m.text)).toEqual(['yes'])
  })

  it('needs no slot to reach a turn already running', () => {
    const ws = made()
    acquireLock(ws)
    oneTurn()
    const held = takeSlot()
    try {
      expect(send(ws, 'joining', { env: { PATH: process.env.PATH } }).started).toBe(false)
      expect(readInbox(ws).map(m => m.text)).toEqual(['joining'])
    } finally {
      releaseLock(ws)
      closeSync(held.fd)
    }
  })
})
