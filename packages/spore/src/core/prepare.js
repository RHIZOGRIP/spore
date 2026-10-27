/**
 * The step that prepares a delivery nobody typed before any turn reads it: one of the `programs` of a
 * plugin the spore uses, bound to the delivery's origin by `prepare:` in the spore's definition, run
 * as the router is (`runStep`). What it writes to `out/` is attached to the delivery. Contract:
 * ARCHITECTURE.md, "Deliveries nobody typed".
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { SporeError } from '../observability/errors.js'
import { mimeOf } from './call-record.js'
import { runStep } from './router.js'
import { definitionPath } from './spore-dir.js'
import { bytesText, durationSpelling, sizeSpelling } from './units.js'
import { containing, prepareCeilingMs, readConfig } from '../library/config.js'
import { parsedDefinition } from '../delegation/definition.js'

const ATTACHED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * What prepares deliveries from `origin` in the spore at `ws`: `{ plugin, program, timeoutMs, attach,
 * reads, refused }`, `reads` its definition's read-only grants, `refused` why the step does not run
 * on this host or null — or null when its definition binds nothing to it.
 */
export function prepareFor (ws, origin, config) {
  const definition = parsedDefinition(ws)
  if (definition.error) throw new SporeError(`${definitionPath(ws)} does not parse, so what prepares its deliveries is unknown`, { type: 'DEFINITION_INVALID', detail: definition.error })
  const step = definition.prepare?.steps.find(one => one.origin === origin)
  if (!step) return null
  const ceiling = prepareCeilingMs(config)
  const refused = definition.prepare.timeout > ceiling
    ? `asks a prepare.timeout of ${durationSpelling(definition.prepare.timeout)}, more than this host's prepareCeiling of ${durationSpelling(ceiling)} — spore config set prepareCeiling ${durationSpelling(definition.prepare.timeout)}`
    : null
  return { plugin: step.plugin, program: step.program, timeoutMs: definition.prepare.timeout, attach: definition.prepare.attach, reads: definition.reads.map(grant => grant.path), refused }
}

/** What `out/` holds, checked against `attach`: `{ found: [{ name, path, bytes }] }` or `{ failed }`. */
function attachedIn (out, attach) {
  const found = []
  for (const name of readdirSync(out).sort()) {
    const path = join(out, name)
    const stat = lstatSync(path)
    if (!stat.isFile()) return { failed: `wrote out/${name}, which is not a plain file` }
    if (!ATTACHED_NAME.test(name)) return { failed: `wrote out/${JSON.stringify(name).slice(1, -1)}, a name of letters, digits, ., _ and - it is not` }
    found.push({ name, path, bytes: stat.size })
  }
  if (found.length > attach.files) return { failed: `wrote ${found.length} files, more than the ${attach.files} its spore allows` }
  const bytes = found.reduce((total, file) => total + file.bytes, 0)
  if (bytes > attach.bytes) return { failed: `wrote ${bytesText(bytes)}, more than the ${sizeSpelling(attach.bytes)} its spore allows` }
  return { found }
}

/**
 * Runs `program` on a delivery to the spore at `ws`, as `runStep` runs a step, and attaches what it
 * writes to `out/`, in its working directory, under `into` — `inbox.d/<delivery>/<program>`,
 * relative to `ws` — as file records of the delivery's entry; or `{ failed }`, saying why there is
 * none: as `runStep` does, or that it wrote what `attach` does not allow. Its arguments are the
 * origin, the event, `ref` and `headers`, empty when absent. It reads the plugin (`programReads`),
 * the delivery's own files and `reads`, and writes nothing else.
 */
export async function runPrepare ({ program, programReads, ws, delivery, payload, headers, origin, event, ref, into, timeoutMs, attach, reads, contain = containing(readConfig()) }) {
  const missing = reads.find(dir => !existsSync(dir))
  if (missing) return { failed: `could not start — ${missing}, which it is let read, is not there` }
  return runStep({
    argv: [program, origin, event ?? '', ref, headers ?? ''],
    ws,
    payload,
    reads: [...programReads, ...(delivery ? [delivery] : []), ...reads],
    timeoutMs,
    contain,
    answer: ({ out }) => {
      const checked = attachedIn(out, attach)
      if (checked.failed) return checked
      mkdirSync(join(ws, into), { recursive: true })
      return {
        files: checked.found.map(file => {
          copyFileSync(file.path, join(ws, into, file.name))
          return { path: `${into}/${file.name}`, name: file.name, mime: mimeOf(join(ws, into, file.name)), bytes: file.bytes }
        })
      }
    }
  })
}
