/**
 * A secret written as `${VAR}`, as `rust/definition` reads it: `variableOf` the variable a value
 * names when it is the reference alone, `variablesIn` those a text refers to, and `fillVariables`
 * a value filled from `env` as `{ filled }` or `{ missing }`. A variable set to nothing is not set.
 */

import { native } from '../native.js'

export const variableOf = (value) => typeof value === 'string' ? native.variableOf(value) : null

export const variablesIn = (text) => native.variablesIn(text)

export const fillVariables = (value, env) => JSON.parse(native.fillVariables(value, env))
