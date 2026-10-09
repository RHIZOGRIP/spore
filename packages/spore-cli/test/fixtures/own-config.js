/**
 * Every test file reads the operator's config from a directory of its own, empty unless the
 * test writes one, so no suite passes or fails by what the machine's user configured. Set
 * before any module reads it; a `spore` the tests start inherits it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const config = mkdtempSync(join(tmpdir(), 'spore-cli-config-'))
process.env.XDG_CONFIG_HOME = config

afterAll(() => rmSync(config, { recursive: true, force: true }))
