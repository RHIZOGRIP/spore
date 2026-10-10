import { Markdown } from '@earendil-works/pi-tui'

/**
 * An answer as pi-tui draws it, keeping the code blocks it drew: `blocks` is each one's text
 * exactly as written, in the order shown. Labelled, each opening fence says how to copy it.
 */
export class Answer extends Markdown {
  constructor (text, theme, { labelled = false } = {}) {
    super(text, 0, 0, theme)
    this.theme = {
      ...theme,
      codeBlockBorder: (fence) => this.fence(fence),
      highlightCode: (code, lang) => this.code(code, lang)
    }
    this.base = theme
    this.labelled = labelled
    this.blocks = []
    this.inBlock = false
  }

  label (on) {
    if (on === this.labelled) return
    this.labelled = on
    this.invalidate()
  }

  render (width) {
    if (this.cachedText !== this.text || this.cachedWidth !== width) {
      this.blocks = []
      this.inBlock = false
    }
    return super.render(width)
  }

  fence (fence) {
    if (this.inBlock) {
      this.inBlock = false
      return this.base.codeBlockBorder(fence)
    }
    this.inBlock = true
    return this.base.codeBlockBorder(this.labelled ? `${fence} · /copy ${this.blocks.length + 1}` : fence)
  }

  code (text, lang) {
    this.blocks.push({ lang: lang ?? '', text })
    return text.split('\n').map(line => this.base.codeBlock(line))
  }
}
