/**
 * Every test file reads the operator's config and keeps spore's state in directories of its own,
 * empty unless the test writes there, so no suite passes or fails by what the machine's user
 * configured or ran. Set before any module reads them; a `spore` the tests start inherits them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const config = mkdtempSync(join(tmpdir(), 'spore-cairn-config-'))
const state = mkdtempSync(join(tmpdir(), 'spore-cairn-state-'))
process.env.XDG_CONFIG_HOME = config
process.env.XDG_STATE_HOME = state

afterAll(() => {
  rmSync(config, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
})
