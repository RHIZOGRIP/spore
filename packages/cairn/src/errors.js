export class CairnError extends Error {
  constructor (message, { type, detail } = {}) {
    super(message)
    this.name = 'CairnError'
    this.type = type
    this.detail = detail
  }
}

export function entryAt (index, check) {
  try {
    return check()
  } catch (err) {
    if (err instanceof CairnError) err.index = index
    throw err
  }
}
