/**
 * A kind's shape: an object of fields, each a type name (`string`, `integer`, `boolean`, `any`), an
 * object of fields, or a one-element array of a shape. A key ending in `?` is optional; every other
 * key is required, and a key the shape does not name is refused.
 */

import { CairnError } from './errors.js'

const TYPES = new Set(['string', 'integer', 'boolean', 'any'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const fieldsOf = (shape) => Object.entries(shape).map(([key, inner]) =>
  key.endsWith('?') ? { name: key.slice(0, -1), inner, optional: true } : { name: key, inner, optional: false })

export function checkShapeDeclared (shape, at) {
  if (typeof shape === 'string') {
    if (!TYPES.has(shape)) throw new Error(`${at} is "${shape}", and a type is string, integer, boolean or any`)
    return
  }
  if (Array.isArray(shape)) {
    if (shape.length !== 1) throw new Error(`${at} is a list of one shape`)
    return checkShapeDeclared(shape[0], `${at}[]`)
  }
  if (!isObject(shape)) throw new Error(`${at} is a type, an object of fields or a list of one shape`)
  for (const { name, inner } of fieldsOf(shape)) {
    if (name === '') throw new Error(`${at} has a field with no name`)
    checkShapeDeclared(inner, `${at}.${name}`)
  }
}

const mismatch = (message, at) => new CairnError(message, { type: 'shape-mismatch', detail: at })

export function checkShape (shape, value, at) {
  if (shape === 'any') return
  if (shape === 'string') {
    if (typeof value !== 'string') throw mismatch(`${at} is a string`, at)
    return
  }
  if (shape === 'integer') {
    if (!Number.isSafeInteger(value)) throw mismatch(`${at} is an integer within ±2^53`, at)
    return
  }
  if (shape === 'boolean') {
    if (typeof value !== 'boolean') throw mismatch(`${at} is true or false`, at)
    return
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) throw mismatch(`${at} is a list`, at)
    value.forEach((item, i) => checkShape(shape[0], item, `${at}[${i}]`))
    return
  }
  if (!isObject(value)) throw mismatch(`${at} is an object`, at)
  const fields = fieldsOf(shape)
  const named = new Set(fields.map(field => field.name))
  for (const key of Object.keys(value)) {
    if (!named.has(key)) throw mismatch(`${at}.${key} is not a field of this kind`, `${at}.${key}`)
  }
  for (const { name, inner, optional } of fields) {
    if (!Object.hasOwn(value, name)) {
      if (optional) continue
      throw mismatch(`${at}.${name} is missing`, `${at}.${name}`)
    }
    checkShape(inner, value[name], `${at}.${name}`)
  }
}
