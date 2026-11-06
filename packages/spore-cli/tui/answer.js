import { Markdown } from '@earendil-works/pi-tui'

/**
 * An answer as pi-tui draws it, keeping the code blocks it drew: `codeBlocks` is each one's text
 * exactly as written, in the order shown. Labelled, each opening fence says how to copy it.
 * It reads them line by line through `codeBlock` because pi-tui remembers what `highlightCode`
 * returned, so that hook is not called again on a later pass.
 */
export class Answer extends Markdown {
  constructor (text, theme, { labelled = false } = {}) {
    super(text, 0, 0, theme)
    this.theme = {
      ...theme,
      codeBlockBorder: (fence) => this.fence(fence),
      codeBlock: (line) => this.codeLine(line)
    }
    this.base = theme
    this.labelled = labelled
    this.codeBlocks = []
    this.opened = null
  }

  label (on) {
    if (on === this.labelled) return
    this.labelled = on
    this.invalidate()
  }

  render (width) {
    if (this.cachedText !== this.text || this.cachedWidth !== width) {
      this.codeBlocks = []
      this.opened = null
    }
    return super.render(width)
  }

  fence (fence) {
    if (this.opened) {
      this.codeBlocks.push({ lang: this.opened.lang, text: this.opened.lines.join('\n') })
      this.opened = null
      return this.base.codeBlockBorder(fence)
    }
    this.opened = { lang: fence.replace(/^`+/, ''), lines: [] }
    return this.base.codeBlockBorder(this.labelled ? `${fence} · /copy ${this.codeBlocks.length + 1}` : fence)
  }

  codeLine (line) {
    this.opened.lines.push(line)
    return this.base.codeBlock(line)
  }
}
