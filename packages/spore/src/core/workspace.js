/**
 * Opening a workspace: everything an entry point needs before a turn runs.
 * Contract: ARCHITECTURE.md, "The spore command".
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, resolve, sep } from 'node:path'

import { provisionModules } from '../delegation/agent-env.js'
import { describePrecursors, cellModelRules, precursorRules, seedPrecursors } from '../delegation/precursor-catalog.js'
import { parsedDefinition, parseDefinition } from '../delegation/definition.js'
import { grantedPathContaining } from '../isolation/sandbox.js'
import { TOOL_NAMES } from './tool-names.js'
import { shippedTree, sporangiumOf } from './sporangia.js'
import { dataDir, definitionPath, DEFINITION_FILE, LIBRARIES_FILE, PLUGINS_DIR, REFERENCE_FILE, ROOT_DOCS } from './spore-dir.js'

/**
 * A declared grant — a corpus it reads, a directory it writes — linked in under the name the
 * definition gave it. The link is what lets the agent name it the way it names everything
 * else; the access is Landlock's, and neither is worth anything without the other. Only a link
 * is ever replaced: anything else under that name is the workspace's own.
 *
 * A link whose target is gone is dropped rather than staged: a dangling name in the
 * workspace reads as a corpus the agent cannot open, and the report says which.
 */
export function linkGrants (ws, declared = []) {
  const staged = []
  for (const { name, path } of declared) {
    const at = resolve(ws, name)
    if (!existsSync(path)) {
      if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(at)
      staged.push({ name, path, missing: true })
      continue
    }
    try {
      const there = lstatSync(at, { throwIfNoEntry: false })
      if (there && !there.isSymbolicLink()) {
        staged.push({ name, path, missing: true, error: `${at} is the workspace's own, not a link` })
        continue
      }
      if (there) rmSync(at)
      symlinkSync(path, at)
    } catch (err) {
      staged.push({ name, path, missing: true, error: err.message })
      continue
    }
    staged.push({ name, path: realpathSync(path), missing: false })
  }
  return staged
}

/**
 * What a super cell at `ws` is granted of its spore, from `reach` as `spore-spawn --super` planned
 * it: the spore linked in at `spore/`, read with what its grants link to, and the directories it
 * writes. `spore.missing` says the spore could not be linked.
 */
export function superGrants (ws, reach) {
  const [spore] = linkGrants(ws, [{ name: 'spore', path: reach.spore }])
  return {
    spore,
    reads: [spore, ...reach.reads.map(({ name, path }) => ({ name: `spore/${name}`, path }))],
    writes: reach.writes.map(path => ({ name: `spore/${basename(path)}`, path }))
  }
}

/**
 * The links of grants the definition no longer declares. The agent cannot write the workspace
 * root, so a link there that leads out of the workspace is one a grant staged, and without the
 * grant it names a directory the agent cannot open.
 */
function unlinkUndeclared (ws, declared) {
  const names = new Set(declared.map(({ name }) => name))
  const roots = [resolve(ws), realpathSync(ws)]
  const inside = (path) => roots.some(root => path === root || path.startsWith(root + sep))
  for (const entry of readdirSync(ws, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || names.has(entry.name)) continue
    const at = resolve(ws, entry.name)
    if (!inside(resolve(ws, readlinkSync(at)))) rmSync(at)
  }
}

/**
 * The files the runtime put in the workspace, named to the agent that has to find them. A
 * definition need not point at them — `--definition` replaces the shipped one entirely — so
 * the runtime does. It belongs in `rules` because that slot already means *what you can reach
 * here*, and it is what the runtime knows and an identity's author may not.
 */
function seededRules (ws) {
  const seeded = ROOT_DOCS.filter(file => existsSync(resolve(ws, file)))
  if (!seeded.length) return ''
  return `At the workspace root: ${seeded.join(' and ')}. ` +
    `${REFERENCE_FILE} describes this runtime — what each command accepts and what it will refuse — ` +
    `and ${LIBRARIES_FILE} lists the libraries your own programs can import, with a worked example of each. ` +
    'Read the part you need rather than the whole file.'
}

/**
 * A spore given a directory to work in is opened on it: what a person calls "here" or "the
 * project" is that directory, and the workspace around it is the runtime's bookkeeping.
 */
function workRules (writes) {
  return writes.map(({ name }) =>
    `${name}/ is the directory you were opened on, and you work in it in place. When the person says ` +
    `here, this directory, the project or the code, they mean ${name}/ — not your workspace, which is your own ` +
    `bookkeeping and worth mentioning only when asked about. write and edit reach ${name}/, and wsexec runs ` +
    `commands in it (cd ${name} && …); exec only reads it.`
  ).join('\n\n')
}

// A container may run spore as a uid with no account, which has no home to name.
function accountHome () {
  try {
    return userInfo().homedir
  } catch {
    return null
  }
}

/**
 * A corpus is named in the agent's workspace, while the person names it where it is on the
 * machine — and the agent's `~` is its own home, not theirs.
 */
function readRules (reads) {
  const home = accountHome()
  return reads.map(({ name, path }) => {
    const theirs = home && (path === home || path.startsWith(`${home}/`)) ? ` (~${path.slice(home.length)})` : ''
    return `${name}/ is ${path}${theirs}, linked in for you to read. When the person names that directory or a ` +
      `file in it, read it through ${name}/. You cannot change it.`
  }).join('\n\n')
}

const ANSWER_RULES = 'Whoever reads your answer sees the answer and the files you hand back in data/out/, never your ' +
  'workspace: data/, state.sqlite, calls/ and the rest are yours alone, unless your instructions say the person ' +
  'works in them with you. Never send them to a path there — say what they need in the answer, and put a file ' +
  'they should have in data/out/. Where the place they wrote from gets no files, the answer is all they get.'

/**
 * Only the plugins the definition names, whatever else is in `plugins/`: a file left from one it
 * no longer uses describes a program this agent is not given.
 */
function pluginRules (ws, names) {
  const docs = names.map(name => `${PLUGINS_DIR}/${name}.md`).filter(file => existsSync(resolve(ws, file)))
  if (!docs.length) return ''
  const summary = (file) => (readFileSync(resolve(ws, file), 'utf8').split('\n').find(line => line.trim()) || '').replace(/^#+\s*/, '').trim()
  return ['Plugins this spore uses, each described in its own file:', ...docs.map(file => `- ${file} — ${summary(file)}`)].join('\n')
}

export function openWorkspace (dir, { cwd = process.cwd(), definition: given, allowGranted = false } = {}) {
  const ws = resolve(cwd, dir || '.')
  if (!existsSync(ws) || !statSync(ws).isDirectory()) {
    return { error: `workspace is not a directory — ${dir || '.'}` }
  }

  const granted = allowGranted ? null : grantedPathContaining(ws)
  if (granted) {
    return { error: `workspace is inside a sandbox-granted path (${granted}) — an agent there could read and write everything around it; use a directory outside the spore repo and outside /tmp` }
  }

  if (given) {
    if (existsSync(definitionPath(ws))) {
      return { error: `workspace already has a definition — ${definitionPath(ws)}` }
    }
    const source = readFileSync(resolve(cwd, given), 'utf8')
    const parsed = parseDefinition(source, { knownTools: TOOL_NAMES })
    if (parsed.error) return { error: `${given} ${parsed.error}` }
    copyFileSync(resolve(cwd, given), definitionPath(ws))
  }

  // Opening is not making. A directory with no definition is not a workspace — `spore
  // define` is what turns one into a spore, and seeding here would put an agent in a
  // directory nobody said should hold one.
  if (!existsSync(definitionPath(ws))) {
    return { error: `${ws} has no ${DEFINITION_FILE} — spore define makes a spore, and this directory is not one yet` }
  }
  mkdirSync(dataDir(ws), { recursive: true })
  const definition = parsedDefinition(ws)
  if (definition.error) {
    return { error: `${definitionPath(ws)} ${definition.error} — edit it, or delete it to start again from the shipped default` }
  }

  // The detail the identity does not carry. Costs nothing until the agent reads it,
  // which is what lets the prompt stay short without making the agent ignorant.
  provisionModules(ws)
  const reads = linkGrants(ws, definition.reads)
  const writes = linkGrants(ws, definition.writes)
  unlinkUndeclared(ws, [...definition.reads, ...definition.writes])
  const unstaged = writes.find(w => w.missing)
  if (unstaged) {
    return { error: `${definitionPath(ws)} writes ${unstaged.name}=${unstaged.path}, which cannot be staged — ${unstaged.error ?? 'it is not there'}` }
  }
  const tree = shippedTree(sporangiumOf(ws))
  for (const file of ROOT_DOCS) {
    if (existsSync(resolve(ws, file))) continue
    copyFileSync(tree.get(file), resolve(ws, file))
  }

  seedPrecursors(ws)

  const reachable = reads.filter(r => !r.missing)
  return {
    ws,
    granting: definition.tools,
    model: definition.model,
    reads: reachable,
    writes,
    sources: definition.sources,
    scopes: definition.scopes,
    limits: definition.limits,
    identity: definition.identity,
    // Reading a workspace does not tidy it. Retention deletes a live run's records
    // just as readily as a finished one's, so it belongs to whoever holds the lock.
    retain: definition.retain,
    history: definition.history ?? null,
    memory: definition.memory,
    images: definition.images,
    schedules: definition.schedules ?? null,
    dream: definition.dream ?? null,
    plugins: definition.plugins,
    calls: definition.calls ?? [],
    reasoning: definition.reasoning ?? [],
    cache: definition.cache,
    rules: [workRules(writes), readRules(reachable), ANSWER_RULES, seededRules(ws), pluginRules(ws, definition.plugins), precursorRules(describePrecursors(ws), definition.dream?.precursor), cellModelRules(definition.cellModels ?? [], definition.model)].filter(Boolean).join('\n\n')
  }
}
