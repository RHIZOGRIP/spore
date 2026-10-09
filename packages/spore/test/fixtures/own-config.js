/**
 * Every test file reads the operator's config from a directory of its own, empty unless the
 * test writes one. The machine's is the user's, and a suite that passes or fails by what
 * plugins or sporangia they configured proves nothing. Set before any module reads it; a test
 * that spawns the `spore` command passes it on.
 */

import { rmSync } from 'node:fs'
import { afterAll } from 'vitest'

import { outsideRoot } from './outside-ws.js'

const config = outsideRoot('config')
process.env.XDG_CONFIG_HOME = config

afterAll(() => rmSync(config, { recursive: true, force: true }))
