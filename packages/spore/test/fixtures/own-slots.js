/**
 * Every test file takes admission slots from a directory of its own. The machine's are the
 * user's running spores', and suites run in parallel would otherwise run each other out of
 * them. Outside every sandbox grant, as the real one is, and set before any module reads it;
 * a test that spawns the `spore` command passes it on.
 */

import { rmSync } from 'node:fs'
import { afterAll } from 'vitest'

import { outsideRoot } from './outside-ws.js'

const state = outsideRoot('state')
process.env.XDG_STATE_HOME = state

afterAll(() => rmSync(state, { recursive: true, force: true }))
