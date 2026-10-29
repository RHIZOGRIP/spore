import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { CONFIG_DIR, list, show } from '@rhizogrip/spore'

/**
 * What stands between a cairn and its members, read from every spore of this user and from
 * `sources.json`: a member that cannot reach the cairn, and a spore that is not one and can. A
 * member is a spore by its workspace's name, which is what the runner sends as `{name}`. Nothing
 * is refused: a spore's grants are changed in its `spore.cmk`.
 */
export function findings ({ name, root, members, socket }) {
  const granted = `cairn-${name}`
  const dir = join(root, name)
  const found = []

  const sourcesFile = join(CONFIG_DIR, 'sources.json')
  const entry = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, 'utf8'))[granted] : undefined
  if (!entry) found.push(`${sourcesFile} describes no ${granted}, so no member can write to ${name}`)
  else if (entry.socket !== socket) found.push(`${granted} in ${sourcesFile} names the socket ${entry.socket ?? '(none)'}, and ${name} serves ${socket}`)

  const seen = new Set()
  for (const { ws } of list().workspaces) {
    const spore = basename(ws)
    let shown
    try {
      shown = show({ ws })
    } catch (err) {
      found.push(`${spore} (${ws}): its definition does not read — ${err.message}`)
      continue
    }
    const reads = shown.reads.filter(read => read.path === dir)
    const reading = reads.some(read => read.name === granted)
    const sourced = shown.sources.includes(granted)
    if (Object.hasOwn(members, spore)) {
      seen.add(spore)
      if (!reading) found.push(`${spore} is a member and reads no ${granted}=${dir}`)
      if (reads.some(read => read.name !== granted)) found.push(`${spore} reads ${dir} as ${reads.find(read => read.name !== granted).name}, not ${granted}`)
      if (!sourced) found.push(`${spore} is a member and is not granted the source ${granted}`)
      if (!shown.plugins.includes('cairn')) found.push(`${spore} is a member and its plugins: does not name cairn`)
    } else {
      if (reads.length) found.push(`${spore} reads ${dir} and is not a member of ${name}`)
      if (sourced) found.push(`${spore} is granted the source ${granted} and is not a member of ${name}`)
    }
  }
  for (const member of Object.keys(members)) {
    if (!seen.has(member)) found.push(`${member} is a member of ${name} and no spore of this user is called ${member}`)
  }
  return found
}
