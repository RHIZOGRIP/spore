/**
 * What each thing spore and its host name may be called, as `rust/definition` rules it:
 * `NAMES.<kind>` is `{ pattern, says }`, the pattern a RegExp and `says` the rule in words, for
 * `spore`, `schedule`, `job`, `hook`, `caller`, `bot`, `sporangium`, `approval`, `plugin`,
 * `precursor`, and `variable` for an environment variable.
 */

import { native } from '../native.js'

export const NAMES = Object.fromEntries(Object.entries(JSON.parse(native.nameRules()))
  .map(([kind, { pattern, says }]) => [kind, { pattern: new RegExp(pattern), says }]))
