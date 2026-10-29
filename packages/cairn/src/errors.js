export class CairnError extends Error {
  constructor (message, { type, detail } = {}) {
    super(message)
    this.name = 'CairnError'
    this.type = type
    this.detail = detail
  }
}
