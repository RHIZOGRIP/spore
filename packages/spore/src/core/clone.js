/**
 * Cutting a fresh spore from one that has learned something.
 *
 * Contract: ARCHITECTURE.md, "Cutting a spore from another".
 *
 * A spore accumulates two things with opposite lifetimes: a **conversation**, which is the
 * record of one exchange, and a **capability** — the precursors it authored — which is
 * what it can do. Nothing separated them, so the only way to give a fresh agent what a
 * previous one learned was to hand it the whole transcript.
 *
 * What a clone carries is what the spore can do, not what it did. `data/memory/` stays
 * behind with the transcript for that reason: memory is the record, and a successor
 * holding it is a continuation wearing a fresh face.
 *
 * **A precursor is the only unit that transfers.** A program becomes capability by being
 * granted in `enzymes`, which is how a cell reaches one and how it travels; a program
 * nothing grants is working space, and carrying it would move scratch into a fresh spore
 * under the name of an enzyme.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { PRECURSOR_DIR } from './spore-dir.js'
import { PRECURSOR_EXT, parseDefinition } from '../delegation/definition.js'
import { TOOL_NAMES } from './tool-names.js'
import { safePath } from '../isolation/safe-path.js'
import { SporeError } from '../observability/errors.js'

const incomplete = (message, detail) => new SporeError(message, { type: 'CLONE_INCOMPLETE', detail })

const outside = (rel) => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)

/**
 * The enzymes a precursor grants, each with what its `<enzyme>.with` says it needs beside
 * itself. `enzymes` is `name=path` resolved against the workspace, so precursors alone clone
 * into a spore that is refused its first spawn. What an enzyme needs cannot be read off the
 * program — an import is one kind of dependency among several — so it is declared, and a
 * declared path that is not there refuses the clone: carried without it, the enzyme would
 * work in the origin, whose cells run it from the origin's tree, and fail only in the
 * clone. Each is carried under the name it was declared by, which is the name the enzyme
 * reaches it by; a link among them is carried as a link, with what it points at. A
 * precursor that no longer parses is still carried; its grants are simply unreadable, which
 * the clone reports rather than guesses at.
 */
function grantedPrograms (from) {
  const dir = resolve(from, PRECURSOR_DIR)
  if (!existsSync(dir)) return []

  const paths = new Set()
  for (const file of readdirSync(dir).filter(f => f.endsWith(PRECURSOR_EXT))) {
    let definition
    try {
      definition = parseDefinition(readFileSync(resolve(dir, file), 'utf8'), { knownTools: TOOL_NAMES, cell: true })
    } catch {
      continue
    }
    if (definition.error) continue
    for (const entry of definition.enzymes || []) {
      for (const path of [entry.path, ...(entry.with || [])]) {
        const rel = relative(from, resolve(from, path))
        if (outside(rel)) {
          throw incomplete(`${file} grants ${entry.name}, and ${path} is outside the workspace, where a clone cannot carry it`,
            'move it into the workspace, or drop it')
        }
        let abs
        try {
          abs = safePath(from, path)
        } catch (e) {
          throw incomplete(`${file} grants ${entry.name}, and ${path} leads out of the workspace`,
            `${e.detail || e.message} A clone carries what the enzyme reads, so what it points at has to be inside.`)
        }
        if (!existsSync(abs)) {
          throw new SporeError(`${file} grants ${entry.name}, and ${path} is not there to carry`, {
            type: 'CLONE_INCOMPLETE',
            detail: path === entry.path
              ? 'the program is gone — restore it, or drop the grant'
              : `${entry.name}.with names it as something the enzyme needs — restore it, or take it out of ${entry.name}.with`
          })
        }
        paths.add(rel)
      }
    }
  }
  return [...paths].sort()
}

/**
 * Copy one spore's capability into another directory, which must already exist and which
 * `openWorkspace` has not yet seeded — `seedPrecursors` skips what is already there, so
 * carrying first is what lets an authored precursor win over the shipped one of that name.
 *
 * @returns {{ precursors: string[], programs: string[] }} what was carried, workspace-relative
 */
export function cloneCapability (from, to) {
  const precursors = resolve(from, PRECURSOR_DIR)
  const granted = grantedPrograms(from)
  // A link stays a link, relative, with what it points at carried where it was — in the
  // precursors as among the programs: a module's own imports resolve from where it really
  // is, so a link copied as its target's bytes is a different module. A link to outside the
  // workspace would carry — or dangle on — something that is not the spore's.
  const root = realpathSync(from)
  const realOf = (src) => {
    let real
    try {
      real = realpathSync(src)
    } catch {
      throw incomplete(`${relative(from, src)} is a link to nothing`, 'restore what it points at, or remove it')
    }
    if (real === root) {
      throw incomplete(`${relative(from, src)} links to the whole workspace`, 'a clone carries what an enzyme reads, not the spore that reads it')
    }
    if (!real.startsWith(root + sep)) {
      throw incomplete(`${relative(from, src)} links out of the workspace`,
        'a clone carries what an enzyme reads, so what a link points at has to be inside the workspace')
    }
    return relative(root, real)
  }
  const queue = [...(existsSync(precursors) ? [PRECURSOR_DIR] : []), ...granted]
  const present = (path) => {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }
  const linkAt = (dest, real) => {
    if (present(dest)) return
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(relative(dirname(dest), resolve(to, real)), dest)
  }
  const nestedLinks = (src, dest) => {
    if (!lstatSync(src).isSymbolicLink()) return true
    const real = realOf(src)
    linkAt(dest, real)
    queue.push(real)
    return false
  }
  // Every component is looked at, since a link may be any of them: past one, the rest of the
  // path is carried where the link really leads.
  const carry = (rel) => {
    const parts = rel.split(sep)
    for (let i = 0; i < parts.length; i++) {
      const at = parts.slice(0, i + 1).join(sep)
      if (lstatSync(resolve(from, at)).isSymbolicLink()) {
        const real = realOf(resolve(from, at))
        linkAt(resolve(to, at), real)
        queue.push(join(real, ...parts.slice(i + 1)))
        return
      }
    }
    const target = resolve(to, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(from, rel), target, { recursive: true, verbatimSymlinks: true, filter: nestedLinks })
  }
  const carried = new Set()
  while (queue.length) {
    const rel = queue.shift()
    if (carried.has(rel)) continue
    carried.add(rel)
    carry(rel)
  }

  return {
    precursors: existsSync(precursors)
      ? readdirSync(precursors).filter(f => f.endsWith(PRECURSOR_EXT)).sort()
      : [],
    programs: [...carried].filter(rel => rel !== PRECURSOR_DIR).sort()
  }
}
