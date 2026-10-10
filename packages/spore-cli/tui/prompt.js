import { Editor } from '@earendil-works/pi-tui'

export const PROMPT = '> '

export class PromptEditor extends Editor {
  render (width) {
    const lines = super.render(width - PROMPT.length)
    const bottom = this.renderedVisibleLineCount + 1
    const indent = ' '.repeat(PROMPT.length)
    return lines.map((line, i) => {
      if (i === 0 || i === bottom) return this.borderColor('─'.repeat(PROMPT.length)) + line
      if (i === 1 && this.scrollOffset === 0) return PROMPT + line
      return indent + line
    })
  }

  handleMouse (event) {
    return super.handleMouse({ ...event, x: Math.max(0, event.x - PROMPT.length), width: event.width - PROMPT.length })
  }
}
