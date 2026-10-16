/**
 * The management verbs, as a library.
 *
 * The `spore` command parses arguments and prints; everything it can answer lives here, so an
 * embedder asking the same questions needs no command and gets no less. Nothing in this
 * file starts or stops anything — that stays with the run path, `send` and `runBatch`.
 * Making a workspace is here because it starts nothing: it puts files on disk and returns.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { readConfig, existing, addTo, workspaceFor, CONFIG_FILE, containing, recordLayout } from './config.js'
import { isWorkspace, sporesInHome } from './discover.js'
import { acquireLock, approvalsIn, definitionPath, DEFINITION_FILE, diskUsage, heldIn, jobsIn, PRECURSOR_DIR, readInbox, cellsSince, readTranscript, readTurns, releaseLock, runningLimits, runningReadTo, statePath, turnSummary } from '../core/spore-dir.js'
import { askApproval } from './approvals.js'
import { sqlLines } from './sql.js'
import { TOOL_NAMES } from '../core/tool-names.js'
import { cloneCapability } from '../core/clone.js'
import { openWorkspace } from '../core/workspace.js'
import { grantedPathContaining, writesRefusal } from '../isolation/sandbox.js'
import { parseDefinition, parseFrontmatter } from '../delegation/definition.js'
import { RUNNING, stateOf, stop } from '../core/state.js'
import { historyOver } from '../resilience/compaction.js'
import { paused, pauseSpores, spendSoFar, unpauseSpores } from '../core/admission.js'
import { dropSchedule, survey, writeSchedule } from '../core/schedule.js'
import { DIMENSIONS, extendTurn, limitText, wrapTurn } from '../core/limits.js'
import { progressOf, stopSupervisor } from '../core/job.js'
import { DEFAULT_DEFINITION_PATH } from '../core/identity-defaults.js'
import { DEFAULT_SPORANGIUM, SPORANGIUM_RECORD, knownSporangia, operatorSporangia, recordSporangium, sporangiumOf, sporangiumTree } from '../core/sporangia.js'
import { copyAbsent } from '../delegation/precursor-catalog.js'
import { workUnits } from '../infra/ledger.js'
import { differingDocs, pluginRoots, preparePlugins, upgradeDocs } from '../core/plugins.js'
import { SporeError } from '../observability/errors.js'
import { billingFor } from '../core/billing.js'
import { usage as usageOver } from '../core/usage.js'

export const defaultSporangiumPath = (configFile = CONFIG_FILE) => join(operatorSporangia(configFile), DEFAULT_SPORANGIUM, DEFINITION_FILE)

/**
 * The operator's default sporangium: `sporangia/default/spore.cmk` beside `config.json`, with everything
 * else the operator authors, while the home holds spores and nothing else. It is copied once
 * from the package's and is authoritative afterwards, so an upgrade cannot quietly change what
 * your spores are. It is where the model new spores run on is named, and a sporangium naming no model
 * takes it from here. A spore of another sporangium has that one's `spore.cmk`, so only the model
 * is read from this one; the whole of it is checked when a spore is made from it, and by `doctor`.
 */
export function definitionFor (configFile = CONFIG_FILE, { sporangium = DEFAULT_SPORANGIUM, needsModel = true } = {}) {
  const path = defaultSporangiumPath(configFile)
  const dir = dirname(path)
  const unset = (why) => new SporeError(why, {
    type: 'MODEL_NOT_SET',
    detail: 'spore config set model <provider>/<name>, or give this one --model, and define again — every sporangium naming no model runs on the default; "mo ls" lists your catalog'
  })
  const whose = sporangium === DEFAULT_SPORANGIUM ? 'new spores run' : `spores of the ${sporangium} sporangium run`

  // Seeded the first time, and refused then only when nothing else says what the spore runs
  // on. The shipped definition names no model — an id in a package goes stale against a live
  // catalog — so the file is put where it will answer that question from then on.
  let seeded = null
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true })
    copyFileSync(DEFAULT_DEFINITION_PATH, path)
    seeded = path
  }

  // Checked here rather than after copying, so the complaint names the file to edit
  // instead of the workspace that inherited the gap.
  let model = null
  if (sporangium === DEFAULT_SPORANGIUM) {
    const held = parseDefinition(readFileSync(path, 'utf8'), { knownTools: TOOL_NAMES, seed: true })
    if (held.error) throw new SporeError(`${path} ${held.error}`, { type: 'DEFINITION_INVALID' })
    model = held.model
  } else if (needsModel) {
    model = defaultModel({ configFile }).model
  }
  if (needsModel && !model) {
    throw unset(seeded ? `${whose} on your default model, and ${path}, just seeded, names none yet` : `${whose} on your default model, and ${path} names none`)
  }
  return { path, seeded }
}

/**
 * The model new spores are cut with: the `model:` line of the default sporangium, written in place so the
 * rest of the file stays as its author left it. The file is where the default lives; this only
 * spares editing one line of it by hand.
 */
export function setDefaultModel (model, { configFile = CONFIG_FILE } = {}) {
  const path = defaultSporangiumPath(configFile)
  const source = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(DEFAULT_DEFINITION_PATH, 'utf8')
  const next = filledIn(source, { model, plugins: [] })
  const held = parseDefinition(next, { knownTools: TOOL_NAMES })
  if (held.error) throw new SporeError(`${path} ${held.error}`, { type: 'DEFINITION_INVALID' })
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, next)
  renameSync(temporary, path)
  return { path, model: held.model }
}

/**
 * The spore at `ws` set to run on `model` from its next turn: one of what its definition offers,
 * its `model:` or one of `models:`. The model it leaves stays in `models:`, so the choice offered
 * stays the same; nothing else in the file changes.
 */
export function switchModel ({ ws, model, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const file = definitionPath(path)
  const source = readFileSync(file, 'utf8')
  const definition = parseDefinition(source, { knownTools: TOOL_NAMES })
  if (definition.error) throw new SporeError(`${file} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  const offered = [definition.model, ...(definition.models ?? [])]
  if (!offered.includes(model)) {
    throw new SporeError(`${model} is not a model this spore offers`, { type: 'MODEL_NOT_OFFERED', detail: `it offers ${offered.join(', ')} — add one to models: in its spore.cmk` })
  }
  if (model === definition.model) return { ws: path, model, was: model }
  const kept = offered.filter(one => one !== model)
  const end = source.indexOf('\n---', 3)
  const head = source.slice(0, end).split('\n').filter((line, i) => i === 0 || !line.startsWith('models:'))
  head[head.findIndex((line, i) => i > 0 && line.startsWith('model:'))] = `model: ${model}`
  head.splice(head.findIndex((line, i) => i > 0 && line.startsWith('model:')) + 1, 0, `models: [${kept.join(', ')}]`)
  const next = head.join('\n') + source.slice(end)
  const checked = parseDefinition(next, { knownTools: TOOL_NAMES })
  if (checked.error) throw new SporeError(`${file} would not parse after the switch: ${checked.error}`, { type: 'DEFINITION_INVALID' })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, next)
  renameSync(temporary, file)
  return { ws: path, model, was: definition.model }
}

export function defaultModel ({ configFile = CONFIG_FILE } = {}) {
  const path = defaultSporangiumPath(configFile)
  if (!existsSync(path)) return { path, model: null }
  const source = readFileSync(path, 'utf8')
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  const parsed = head ? parseFrontmatter(head[1]) : { error: 'must open with a --- frontmatter block' }
  if (parsed.error) throw new SporeError(`${path} ${parsed.error}`, { type: 'DEFINITION_INVALID' })
  return { path, model: parsed.fields.model ?? null }
}

const inside = (path, home) => Boolean(home) && (path === home || path.startsWith(home + sep))

const nameOf = (file) => parseDefinition(readFileSync(file, 'utf8'), { knownTools: TOOL_NAMES }).name

/**
 * Written whole and renamed into place, for the reason the configuration is: a definition
 * half-replaced by an interrupted process is refused at the next open, and the spore is
 * gone with it.
 */
function install (source, ws) {
  const text = readFileSync(source, 'utf8')
  const definition = parseDefinition(text, { knownTools: TOOL_NAMES })
  if (definition.error) throw new SporeError(`${source} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  const target = definitionPath(ws)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, target)
  return definition.name
}

const pairText = (dimension, pair) => `[${limitText(dimension, pair.soft)}, ${limitText(dimension, pair.hard)}]`

function changesOf (was, now) {
  if (was.error) return ['replaces a definition that did not parse']
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const lines = []
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[key], now[key])) continue
    if (key === 'identity') {
      lines.push('identity — the next turn writes its prompt cache anew')
    } else if (key === 'limits') {
      for (const dimension of DIMENSIONS) {
        if (!same(was.limits[dimension], now.limits[dimension])) lines.push(`${dimension} ${pairText(dimension, was.limits[dimension])} → ${pairText(dimension, now.limits[dimension])}`)
      }
    } else if (key === 'extend') {
      for (const dimension of DIMENSIONS) {
        const [before, after] = [was.extend?.[dimension], now.extend?.[dimension]]
        if (before !== after) lines.push(`extend.${dimension} ${before ? limitText(dimension, before) : 'none'} → ${after ? limitText(dimension, after) : 'none'}`)
      }
    } else if (Array.isArray(was[key] ?? now[key])) {
      const [before, after] = [was[key] ?? [], now[key] ?? []]
      const added = after.filter(x => !before.some(y => same(x, y))).map(x => `+${x.name ?? x}`)
      const dropped = before.filter(x => !after.some(y => same(x, y))).map(x => `−${x.name ?? x}`)
      lines.push(`${key} ${[...added, ...dropped].join(' ') || 'reordered'}`)
    } else if (typeof (was[key] ?? now[key]) === 'object') {
      lines.push(`${key} changed`)
    } else {
      lines.push(`${key} ${was[key] ?? 'none'} → ${now[key] ?? 'none'}`)
    }
  }
  return lines
}

/**
 * A spore's definition edited where its owner works: a copy is handed to `open`, which returns
 * the editor's exit status, and checked before it replaces `spore.cmk` — by the rename `define`
 * installs with. A copy that does not parse goes to `again` with the parser's error, which says
 * whether to open it once more; one that is unchanged replaces nothing. A `spore.cmk` that changed
 * underneath is not overwritten, and the copy is kept for its owner to merge.
 */
export async function edit ({ ws, open, again, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const held = definitionPath(path)
  const before = readFileSync(held, 'utf8')
  const scratch = mkdtempSync(join(tmpdir(), 'spore-edit-'))
  const draft = join(scratch, DEFINITION_FILE)
  writeFileSync(draft, before)
  let keep = false
  try {
    for (;;) {
      const status = open(draft)
      if (status !== 0) return { ws: path, edited: false, why: 'editor', status }
      const text = readFileSync(draft, 'utf8')
      if (text === before) return { ws: path, edited: false, why: 'unchanged' }
      const now = parseDefinition(text, { knownTools: TOOL_NAMES })
      if (now.error) {
        if (await again(now.error)) continue
        return { ws: path, edited: false, why: 'refused', error: now.error }
      }
      if (readFileSync(held, 'utf8') !== before) {
        keep = true
        throw new SporeError(`${held} changed while it was being edited`, {
          type: 'EDIT_CONFLICT',
          detail: `nothing was written; your version is ${draft}`
        })
      }
      install(draft, path)
      return {
        ws: path,
        edited: true,
        changes: changesOf(parseDefinition(before, { knownTools: TOOL_NAMES }), now),
        running: stateOf(path).state === RUNNING
      }
    }
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Say what a spore is. Defining and running are separate acts on the same object, so this
 * both makes one and revises one: a definition given for a workspace that already has a
 * definition replaces it and leaves the conversation, the trail and `data/` alone.
 * Redefining was always possible by editing `spore.cmk` — the runtime re-reads it every
 * turn — so refusing it here would only make the command worse than `cp`.
 *
 * A name goes in `home`; a path is taken as written and remembered in `workspaces`, since
 * a spore outside home is invisible to `ls` until something says where it is.
 */
export function define ({ ws, definition, from, sporangium, model, plugins = [], writes = [], configFile = CONFIG_FILE, roots = pluginRoots() } = {}) {
  const config = readConfig(configFile)
  const filling = Boolean(model) || plugins.length > 0 || writes.length > 0
  if ([definition, from, sporangium].filter(Boolean).length > 1) {
    throw new SporeError('a definition comes from one place', {
      type: 'DEFINE_AMBIGUOUS',
      detail: '--sporangium makes it from a sporangium, --definition takes it from a file and --from from another spore; name one'
    })
  }
  const source = from ? sourceSpore(from, config) : null
  const target = workspaceFor(ws, { config })
  const answer = { ws: target.path, file: config.file, seeded: null, remembered: null, redefined: null, already: false }

  if (isWorkspace(target.path)) {
    // Revising goes through the same refusal creating does: a granted path is never a
    // spore's, whether it is being made or remade.
    const granted = grantedPathContaining(target.path)
    if (granted) {
      throw new SporeError(`${target.path} is inside a sandbox-granted path (${granted})`, {
        type: 'WORKSPACE_REFUSED',
        detail: 'a spore there could read and write everything around it; use a directory outside the spore repo and outside /tmp'
      })
    }
    const held = definitionPath(target.path)
    if (filling || sporangium) {
      throw new SporeError(`${target.path} is already a spore`, {
        type: 'DEFINE_FILLS_ONLY_NEW',
        detail: '--sporangium, --model, --plugin and a writes grant make the spore.cmk of a new spore; this one exists, so edit its spore.cmk'
      })
    }
    if (definition) {
      const was = nameOf(held)
      const now = install(resolve(definition), target.path)
      return { ...answer, definition: resolve(definition), redefined: { from: was, to: now } }
    }
    return { ...answer, already: true, definition: held }
  }

  const grown = source || definition ? null : (sporangium ?? DEFAULT_SPORANGIUM)
  const named = grown && grown !== DEFAULT_SPORANGIUM
    ? parseDefinition(readFileSync(sporangiumTree(grown, { configFile: config.file }).get(DEFINITION_FILE), 'utf8'), { knownTools: TOOL_NAMES, seed: true }).model
    : null
  const owned = grown ? definitionFor(config.file, { sporangium: grown, needsModel: !model && !named }) : null
  const tree = grown ? sporangiumTree(grown, { configFile: config.file }) : null
  const cut = source
    ? { path: definitionPath(source), seeded: null }
    : definition ? { path: resolve(definition), seeded: null } : { path: tree.get(DEFINITION_FILE), seeded: owned.seeded }
  const sporangiumName = source ? sporangiumOf(source) : (grown ?? DEFAULT_SPORANGIUM)
  const refused = writes.length
    ? writesRefusal(target.path, writes.map(grant => grant.includes('=') ? [grant.slice(0, grant.indexOf('=')), grant.slice(grant.indexOf('=') + 1)] : [basename(grant), grant]))
    : null
  if (refused) throw new SporeError(`a spore cannot be given ${writes.join(', ')}`, { type: 'WRITES_REFUSED', detail: refused })
  const made = !existsSync(target.path)
  if (made) mkdirSync(target.path, { recursive: true })

  const laid = []
  const undo = () => {
    if (made) return rmSync(target.path, { recursive: true, force: true })
    for (const file of [DEFINITION_FILE, SPORANGIUM_RECORD, ...laid]) rmSync(join(target.path, file), { force: true })
  }

  // Before `openWorkspace`, because `seedPrecursors` skips what is already there — so an
  // authored precursor wins over the shipped one of its name rather than the other way.
  let carried = null
  try {
    recordSporangium(target.path, sporangiumName)
    carried = source ? cloneCapability(source, target.path) : null
    for (const [file, from] of tree ?? []) {
      if (file !== DEFINITION_FILE && copyAbsent(from, join(target.path, file))) laid.push(file)
    }
  } catch (err) {
    undo()
    throw err
  }

  const text = readFileSync(cut.path, 'utf8')
  const asTemplate = grown ? parseDefinition(text, { knownTools: TOOL_NAMES, seed: true }) : null
  if (asTemplate?.error) {
    undo()
    throw new SporeError(`${cut.path} ${asTemplate.error}`, { type: 'DEFINITION_INVALID' })
  }
  const fill = { model: model ?? (asTemplate && !asTemplate.model ? defaultModel({ configFile: config.file }).model : null), plugins, writes }
  const written = Boolean(fill.model) || plugins.length > 0 || writes.length > 0
  if (written) writeFileSync(definitionPath(target.path), filledIn(text, fill))
  const opened = openWorkspace(target.path, written ? {} : { definition: cut.path })
  if (opened.error) {
    undo()
    throw new SporeError(opened.error, { type: 'WORKSPACE_REFUSED' })
  }
  // What `send` would copy in at the first turn, so a new spore shows it from the start.
  try {
    preparePlugins(opened.ws, { config, roots })
  } catch (err) {
    undo()
    throw err
  }

  if (target.named) recordLayout(config.home, config.homeSplit)
  let remembered = null
  if (!inside(opened.ws, config.home) && !config.workspaces.includes(opened.ws)) {
    addTo('workspaces', opened.ws, configFile)
    remembered = opened.ws
  }
  return { ...answer, ws: opened.ws, definition: cut.path, sporangium: sporangiumName, seeded: cut.seeded, remembered, cloned: source ? { from: source, ...carried } : null }
}

const REMADE_WITH = [DEFINITION_FILE, 'data', 'home', PRECURSOR_DIR, 'schedules']

/**
 * Make a spore again, in place, from the sporangium it was made from: it keeps what it can do and
 * what it has made — its definition, `data/`, `home/`, its precursors and schedules — and leaves
 * what it did, its database, trail and inbox, in `<ws>.before-remake` beside it until its owner
 * removes that. How a spore made by another development version of spore, whose database this one
 * cannot open, is brought back. The parts are moved rather than copied, so a large `data/` costs
 * nothing, and the old directory, left without a definition, is no longer a spore.
 */
export function remake ({ ws, configFile = CONFIG_FILE, roots = pluginRoots() } = {}) {
  const config = readConfig(configFile)
  const path = here(ws, configFile)
  if (stateOf(path).state === RUNNING) {
    throw new SporeError(`${path} is running`, { type: 'REMAKE_RUNNING', detail: 'spore stop it, or wait for its turn to end, then remake it' })
  }
  const aside = `${path}.before-remake`
  if (existsSync(aside)) {
    throw new SporeError(`${aside} is still there from an earlier remake`, { type: 'REMAKE_ASIDE_EXISTS', detail: 'look through it and remove it, then remake again' })
  }
  const sporangium = sporangiumOf(path)
  const tree = sporangiumTree(sporangium, { configFile: config.file })

  renameSync(path, aside)
  const moved = []
  try {
    mkdirSync(path)
    for (const part of REMADE_WITH) {
      if (!existsSync(join(aside, part))) continue
      renameSync(join(aside, part), join(path, part))
      moved.push(part)
    }
    recordSporangium(path, sporangium)
    for (const [file, from] of tree) if (file !== DEFINITION_FILE) copyAbsent(from, join(path, file))
    const opened = openWorkspace(path)
    if (opened.error) throw new SporeError(opened.error, { type: 'WORKSPACE_REFUSED' })
    preparePlugins(opened.ws, { config, roots })
  } catch (err) {
    for (const part of moved) renameSync(join(path, part), join(aside, part))
    rmSync(path, { recursive: true, force: true })
    renameSync(aside, path)
    throw err
  }
  return { ws: path, aside, sporangium, moved }
}

/**
 * The frontmatter with `model:` replaced or added, and the plugins added to any it already
 * names. Line by line, so everything else in the file stays as its author wrote it.
 */
function filledIn (source, { model, plugins, writes = [] }) {
  const end = source.indexOf('\n---', 3)
  const head = source.slice(0, end).split('\n')
  const body = source.slice(end)
  const at = (key) => head.findIndex((line, i) => i > 0 && line.startsWith(`${key}:`))
  if (model) {
    const line = `model: ${model}`
    if (at('model') > 0) head[at('model')] = line
    else head.splice(1, 0, line)
  }
  if (plugins.length) {
    let held = []
    if (at('plugins') > 0) {
      const parsed = parseFrontmatter(head[at('plugins')])
      if (parsed.error) throw new SporeError(`its plugins line ${parsed.error}`, { type: 'DEFINITION_INVALID', detail: 'plugins: [a, b]' })
      held = [].concat(parsed.fields.plugins)
    }
    const line = `plugins: [${[...new Set([...held, ...plugins])].join(', ')}]`
    if (at('plugins') > 0) head[at('plugins')] = line
    else head.push(line)
  }
  if (writes.length) {
    if (at('writes') > 0) throw new SporeError('its definition already writes a directory', { type: 'DEFINITION_INVALID', detail: 'a spore made to work in a directory is given that one grant' })
    head.push(`writes: [${writes.join(', ')}]`)
  }
  return head.join('\n') + body
}

/**
 * Every sporangium a spore can be made from, each with the line its `spore.cmk` gives a person,
 * the operator's over the package's. One that cannot be read says why rather than dropping out.
 */
export function sporangia ({ configFile = CONFIG_FILE } = {}) {
  return knownSporangia({ configFile }).map(name => {
    let file
    try {
      file = sporangiumTree(name, { configFile }).get(DEFINITION_FILE)
    } catch (err) {
      return { name, description: null, error: err.detail ? `${err.message} — ${err.detail}` : err.message }
    }
    const parsed = parseDefinition(readFileSync(file, 'utf8'), { knownTools: TOOL_NAMES, seed: true })
    if (parsed.error) return { name, description: null, error: `${file} ${parsed.error}` }
    return { name, description: parsed.description ?? null, error: null }
  })
}

/**
 * The spore a clone is cut from. Named the way every other spore argument is, and it has
 * to exist: cloning is saying what a spore is by reference, and a reference to nothing is
 * a mistyped name rather than a new definition.
 */
function sourceSpore (asked, config) {
  const found = workspaceFor(asked, { config })
  if (!isWorkspace(found.path)) {
    throw new SporeError(`there is no spore at ${found.path} to cut from`, {
      type: 'CLONE_SOURCE_MISSING',
      detail: found.named ? `no "${asked}" in ${found.home}` : 'name a spore, or a path to one'
    })
  }
  return found.path
}

/**
 * The spore a read verb is about, named the way `send` names one: a bare name is the one
 * in `home`, a path is taken as written, and nothing is the one you are standing in.
 */
const here = (ws, configFile = CONFIG_FILE) => {
  const target = workspaceFor(ws, { file: configFile })
  if (!isWorkspace(target.path)) {
    throw new SporeError(target.named
      ? `no spore called "${ws}" in ${target.home}`
      : `${target.path} is not a workspace`,
    {
      type: 'NOT_A_WORKSPACE',
      detail: target.named ? 'spore ls shows what you have' : 'a workspace is a directory holding a spore.cmk'
    })
  }
  return target.path
}

/**
 * Every workspace the configuration points at.
 *
 * `home` is a directory holding workspaces, so its subdirectories are examined. The
 * `workspaces` list names workspaces directly — the ones living outside home — so each is
 * taken as it stands. A listed path that is gone, or that turns out not to be a workspace,
 * is reported and skipped. A home that does not exist yet is where the next spore goes,
 * not a search path that broke. `disk` adds each one's size, a walk of its whole tree, which
 * a caller listing every tick leaves off.
 */
/** The directories a spore works in, or why its definition could not say. */
function worksIn (ws) {
  const parsed = parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
  return parsed.error ? { writes: [], definitionError: parsed.error } : { writes: parsed.writes.map(w => w.path), definitionError: null }
}

/**
 * The history a spore's last measured turn carried, as the provider counted its first call,
 * against the bound it was held to, and how much of what the turn sent was read from the cache.
 */
function historyOf (turn) {
  if (!turn) return null
  const sent = (turn.inputTokens ?? 0) + (turn.cacheReadTokens ?? 0) + (turn.cacheWriteTokens ?? 0)
  return {
    turnNo: turn.turnNo,
    sent: turn.historySent,
    bound: turn.historyBound,
    over: historyOver(turn.historySent, turn.historyBound),
    rounds: turn.rounds,
    cacheShare: sent ? (turn.cacheReadTokens ?? 0) / sent : null
  }
}

export function list ({ where, disk = false, configFile = CONFIG_FILE } = {}) {
  const config = where
    ? { home: resolve(where), workspaces: [], file: CONFIG_FILE, exists: true }
    : readConfig(configFile)
  const { live, missing } = existing(config.workspaces)

  const seen = new Set()
  const rows = (from, paths) => paths.flatMap(ws => {
    if (seen.has(ws)) return []
    seen.add(ws)
    const state = stateOf(ws)
    return [{ ws, from, ...state, historyOver: historyOver(state.last?.historySent, state.last?.historyBound), ...worksIn(ws), ...(disk ? { bytes: diskUsage(ws).total } : {}) }]
  })

  const home = config.home && existsSync(config.home) ? rows(config.home, sporesInHome(config.home, config.homeSplit)) : []
  const outside = live.flatMap(path => rows(path, isWorkspace(path) ? [path] : []))

  return {
    configured: config.exists,
    file: config.file,
    home: config.home,
    asked: Boolean(where),
    paused: paused(),
    spend: spendSoFar({ config }),
    contain: containing(config),
    missing: [
      ...missing.map(path => ({ path, why: 'gone' })),
      ...live.filter(path => !isWorkspace(path)).map(path => ({ path, why: 'no spore.cmk, so not a workspace' }))
    ],
    workspaces: [...home, ...outside]
  }
}

export { billingFor }

/** What `send` and `fork` print when a turn starts: the model, the tools, the limits. */
export function grantOf (ws) {
  const definition = parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) {
    throw new SporeError(`${definitionPath(ws)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  }
  return { model: definition.model, tools: definition.tools, limits: definition.limits, billing: billingFor(definition.model) }
}

/**
 * One spore in detail. Everything comes from the files it leaves behind, so a finished
 * spore answers as completely as a live one and nothing has to be running to ask.
 *
 * The definition is parsed rather than opened: `openWorkspace` seeds files and links
 * modules, which is not a reading verb's business.
 */
export function show ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const definition = parseDefinition(readFileSync(definitionPath(path), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) {
    throw new SporeError(`${definitionPath(path)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  }
  const turns = readTurns(path)
  const state = stateOf(path)
  const grant = definition.schedules ?? null
  const sum = (field) => turns.reduce((total, turn) => total + (turn[field] ?? 0), 0)
  return {
    ws: path,
    ...state,
    name: definition.name,
    description: definition.description ?? null,
    sporangium: sporangiumOf(path),
    model: definition.model,
    models: definition.models ?? [],
    cellModels: definition.cellModels ?? [],
    billing: billingFor(definition.model),
    sources: definition.sources,
    scopes: definition.scopes,
    tools: definition.tools,
    limits: definition.limits,
    extend: definition.extend ?? null,
    turnLimits: state.state === RUNNING ? runningLimits(path) : null,
    memory: definition.memory ?? null,
    reads: definition.reads,
    writes: definition.writes,
    messages: readTranscript(path).length,
    waiting: waitingIn(path, state.state === RUNNING).length,
    paused: paused(),
    held: heldIn(path).map(({ origin, releaseAt, deadline, summary }) => ({ origin, releaseAt, deadline, summary })),
    cells: cellsSince(path, { since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
    jobs: {
      grant: definition.jobs ?? null,
      running: jobsIn(path, { running: true }).map(job => ({ name: job.name, run: job.run, startedAt: job.startedAt, wallMs: job.wallMs, progress: progressOf(path, job) }))
    },
    endedAt: turns.at(-1)?.endedAt ?? null,
    history: historyOf(turns.findLast(turn => turn.historySent != null)),
    deliverables: turns.at(-1)?.deliverables ?? [],
    deliverablesMore: turns.at(-1)?.deliverablesMore ?? 0,
    workUnits: sum('workUnits'),
    workUnitsOwn: sum('workUnitsOwn'),
    workUnitsChildren: sum('workUnitsChildren'),
    precursors: precursorNames(path),
    plugins: definition.plugins,
    differs: differingDocs(path, { config: readConfig(configFile) }).map(d => d.file),
    disk: diskUsage(path),
    schedules: scheduleRows(path, { spore: state, grant }),
    // What the clock may start, from the declared bounds alone: every schedule the grant
    // allows, each firing as often as its interval allows. The turns are a true bound; the
    // money is nominal — each turn reaching `cost.hard`, which stops new model calls and pays
    // for the ones already running (ARCHITECTURE §The model broker). Arithmetic over limits, not a forecast.
    scheduleBound: grant ? boundOf(grant, definition.limits) : null
  }
}

/**
 * A spore removed, its whole workspace, under its own lock so no turn starts while it goes.
 * Refused where a bare `rm -rf` would break something silently: a spore running and, without
 * `yes`, one with recorded turns — its conversation, its records and what it made, whatever
 * they cost. Turns are checked before the lock is taken, because taking it writes over the pid
 * a crashed runner left, which is how `stateOf` tells a crash.
 */
export function remove ({ ws, yes = false, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const granted = grantedPathContaining(path)
  if (granted) {
    throw new SporeError(`${path} is inside a sandbox-granted path (${granted})`, {
      type: 'WORKSPACE_REFUSED',
      detail: 'nothing there was made by spore define: it is the checkout, or a path every sandbox is granted'
    })
  }

  const before = turnSummary(path)
  const bytes = diskUsage(path).total
  if (before.lastTurnNo && !yes) {
    throw new SporeError(`${path} has ${before.lastTurnNo} recorded turn(s) ($${(before.treeMicros / 1e6).toFixed(4)}, ${bytes} bytes)`, {
      type: 'SPORE_HAS_TURNS',
      detail: `spore rm ${ws} --yes removes it anyway`
    })
  }

  const taken = acquireLock(path)
  if (taken.error) {
    throw new SporeError(taken.error, { type: 'SPORE_RUNNING', detail: `spore stop ${ws} first` })
  }
  try {
    if (turnSummary(path).lastTurnNo !== before.lastTurnNo) {
      throw new SporeError(`${path} finished a turn while it was being removed`, {
        type: 'SPORE_RUNNING',
        detail: `spore rm ${ws} again to see what it holds now`
      })
    }
    rmSync(path, { recursive: true, force: true })
  } finally {
    releaseLock(path)
  }
  return { ws: path, turns: before.lastTurnNo, treeUsd: before.treeMicros / 1e6, bytes }
}

// Slots at least `interval` apart fit ceil(day / interval) times into a day.
const boundOf = (grant, limits) => {
  const perDay = grant.count * Math.ceil(86_400_000 / grant.interval)
  return { ...grant, perDay, nominalCost: perDay * limits.cost.hard }
}

const scheduleRows = (path, { spore, grant }) => survey(path, { spore, grant }).map(({ message, ...row }) => row)

const parsedAt = (path) => {
  const definition = parseDefinition(readFileSync(definitionPath(path), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) {
    throw new SporeError(`${definitionPath(path)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  }
  return definition
}

/** A spore's schedules and where each stands — the `schedules` of `show`, on its own. */
export function schedules ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, schedules: scheduleRows(path, { spore: stateOf(path), grant: parsedAt(path).schedules ?? null }) }
}

/**
 * Pauses every spore of this user: marks them, so no turn and no cell outside one starts, then stops every
 * running turn and every running job. The mark is written first, so nothing starts behind the
 * stops. Run again, it stops what is running and keeps the first mark. Meanwhile a person's
 * message and a webhook's delivery are refused; unread messages, what jobs said and due
 * schedules wait.
 */
export function pause ({ why, configFile = CONFIG_FILE, stopTurn = stop, stopJob = stopSupervisor } = {}) {
  const { mark, already } = pauseSpores({ why })
  const turns = []
  const stoppedJobs = []
  for (const { ws, state } of list({ configFile }).workspaces) {
    if (state === RUNNING && stopTurn(ws).stopped) turns.push(ws)
    for (const job of jobsIn(ws, { running: true })) {
      if (stopJob(job.run) !== null) stoppedJobs.push({ ws, name: job.name })
    }
  }
  return { mark, already, turns, jobs: stoppedJobs }
}

/** Lifts the pause: turns start again, and the next pass releases what was held and due. */
export function unpause () {
  const mark = paused()
  return { unpaused: unpauseSpores(), mark }
}

/** A spore's jobs, newest first, with what each running one last wrote to its `progress`. */
export function jobs ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, grant: parsedAt(path).jobs ?? null, jobs: jobsIn(path).map(job => ({ ...job, progress: progressOf(path, job) })) }
}

/** Asks a running job's supervisor to stop it; the supervisor records and says how it ended. */
export function stopJob ({ ws, name, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const job = jobsIn(path, { running: true }).find(one => one.name === name)
  if (!job) {
    throw new SporeError(`no job named "${name}" is running here`, { type: 'JOB_NOT_RUNNING', detail: `spore job ls ${path}` })
  }
  const pid = stopSupervisor(job.run)
  if (pid === null) {
    throw new SporeError(`the job "${name}" has no supervisor left to stop it`, { type: 'JOB_GONE', detail: 'it was interrupted, which the next spore tick records and says' })
  }
  return { ws: path, name, run: job.run, pid }
}

/**
 * Install a schedule in a spore, from the operator's side: parsed and checked against the
 * definition's grant before it lands, and renamed into place.
 */
export function setSchedule ({ ws, name, source, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return writeSchedule(path, name, source, { grant: parsedAt(path).schedules ?? null })
}

export function removeSchedule ({ ws, name, configFile = CONFIG_FILE } = {}) {
  return dropSchedule(here(ws, configFile), name)
}

/** An approval asked in the spore, for the relay of the place it names to post (ARCHITECTURE §Approvals). */
export function requestApproval ({ ws, request, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, ...askApproval(path, request, { configFile }) }
}

/** The spore's approvals, oldest first, each as far as it has gone. */
export function listApprovals ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, approvals: approvalsIn(path) }
}

export function extend ({ ws, dimension, amount, configFile = CONFIG_FILE } = {}) {
  return extendTurn(here(ws, configFile), dimension, amount)
}

export function wrap ({ ws, wait, configFile = CONFIG_FILE } = {}) {
  return wrapTurn(here(ws, configFile), wait)
}

const precursorNames = (ws) => {
  const dir = resolve(ws, PRECURSOR_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.cmk')).map(name => name.replace(/\.cmk$/, '')).sort()
}

/**
 * Everything said that no turn has answered. The last turn records how far it read, so
 * anything past that is work outstanding — which is the difference between a spore that is
 * idle and one that is merely not running yet.
 */
/** What no turn has read yet: a running turn has read up to its latest `inbox_read`, and consumes it only when it ends. */
const waitingIn = (ws, running) => {
  const readTo = running ? runningReadTo(ws) : null
  return readInbox(ws).filter(entry => !entry.consumed && !entry.setAside && !entry.overheard && (readTo === null || entry.inboxNo > readTo))
}

/**
 * What has happened here, one line per turn: when it ended, how, what it cost, and what
 * was said to start it. The turn records carry that last part without storing it — each
 * says which stretch of the inbox it read, `(inboxFrom, inboxTo]`, and those are exactly the
 * messages that turn answered.
 *
 * Deliberately not the answers. Those are in the transcript and are the long part; this
 * is for finding the turn you want before you go and read it.
 */
export function sql ({ ws, query = '.tables', json = false, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, lines: sqlLines(statePath(path), query, { json }) }
}

export function log ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  const definition = parseDefinition(readFileSync(definitionPath(path), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) {
    throw new SporeError(`${definitionPath(path)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  }
  const said = readInbox(path)
  const turns = readTurns(path).map(turn => ({
    endedAt: turn.endedAt,
    stopReason: turn.stopReason,
    concluded: turn.concluded,
    rounds: turn.rounds ?? 0,
    treeUsd: turn.treeUsd,
    workUnits: turn.workUnits ?? 0,
    error: turn.error ?? null,
    detail: turn.detail ?? null,
    asked: said.filter(entry => entry.inboxNo > turn.inboxFrom && entry.inboxNo <= turn.inboxTo && !entry.setAside && !entry.overheard)
  }))
  // A schedule the pass would fire and cannot, or will not fire at all, is work outstanding
  // the same way a message nobody answered is.
  const spore = stateOf(path)
  const held = survey(path, { spore, grant: definition.schedules ?? null })
    .filter(row => row.state === 'held' || row.state === 'refused')
    .map(({ message, ...row }) => row)
  return { ws: path, turns, waiting: waitingIn(path, spore.state === RUNNING), setAside: said.filter(entry => entry.setAside), held }
}

/** What a workspace can delegate to. */
export function precursors ({ ws, configFile = CONFIG_FILE } = {}) {
  const path = here(ws, configFile)
  return { ws: path, precursors: precursorNames(path) }
}

export { workUnits }

/**
 * The documentation at each spore's root brought back to what is installed. `all` is every
 * spore `list` finds.
 */
export function upgrade ({ ws, all = false, configFile = CONFIG_FILE } = {}) {
  const config = readConfig(configFile)
  const targets = all ? list({ configFile }).workspaces.map(row => row.ws) : [here(ws, configFile)]
  return { upgraded: targets.map(path => upgradeDocs(path, { config })) }
}

const DAY_MS = 86_400_000

/**
 * What one spore, or every spore `list` finds, spent over a window of local days in `tz`: the
 * last `days` up to today, or `since` to `until` (today when absent), as `usage` in
 * `core/usage.js` answers it, with `ws` the spore asked about or null for all of them.
 */
export function usage ({ ws, days, since, until, tz = Intl.DateTimeFormat().resolvedOptions().timeZone, configFile = CONFIG_FILE } = {}) {
  if (days !== undefined && since !== undefined) {
    throw new SporeError('a usage window is --days or --since, not both', { type: 'USAGE_INVALID', detail: `days ${days}, since ${since}` })
  }
  if (days !== undefined && !(Number.isInteger(days) && days >= 1)) {
    throw new SporeError('--days is a whole number of days, one or more', { type: 'USAGE_INVALID', detail: `got ${days}` })
  }
  const last = until ?? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
  const first = since ?? new Date(Date.parse(last) - ((days ?? 7) - 1) * DAY_MS).toISOString().slice(0, 10)
  if (ws) {
    const path = here(ws, configFile)
    return { ws: path, ...usageOver({ spores: [{ name: basename(path), ws: path }], since: first, until: last, tz }) }
  }
  const found = list({ configFile })
  if (!found.configured) {
    throw new SporeError(`no ${found.file}`, { type: 'CONFIG_MISSING', detail: 'spore config set home <dir> names where spores live, or name one spore' })
  }
  return { ws: null, ...usageOver({ spores: found.workspaces.map(row => ({ name: basename(row.ws), ws: row.ws })), since: first, until: last, tz }), spend: found.spend }
}
