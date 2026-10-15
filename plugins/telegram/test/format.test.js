import { describe, it, expect } from 'vitest'

import { toHtml } from '../src/format.js'

describe('Markdown in Telegram\'s HTML', () => {
  it('keeps what Telegram renders, and escapes the text around it', () => {
    expect(toHtml('a < b & **bold** _it_ ~~gone~~ `x<y>`')).toBe('a &lt; b &amp; <b>bold</b> <i>it</i> <s>gone</s> <code>x&lt;y&gt;</code>')
  })

  it('gives a code block its language', () => {
    expect(toHtml('```js\nif (a < b) {}\n```')).toBe('<pre><code class="language-js">if (a &lt; b) {}</code></pre>')
    expect(toHtml('```\nplain\n```')).toBe('<pre><code>plain</code></pre>')
  })

  it('links only what a link may be, and never a script', () => {
    expect(toHtml('[docs](https://e.com/?a=1&b="2")')).toBe('<a href="https://e.com/?a=1&amp;b=&quot;2&quot;">docs</a>')
    expect(toHtml('[bad](javascript:alert(1))')).toBe('bad')
  })

  it('makes a heading a bold line, and keeps a quote and its paragraphs', () => {
    expect(toHtml('# Title\n\n> quoted *it*\n\nline one\nline two')).toBe('<b>Title</b>\n\n<blockquote>quoted <i>it</i></blockquote>\n\nline one\nline two')
  })

  it('keeps a list\'s bullets, numbers, nesting and boxes as text', () => {
    expect(toHtml('- one\n- **two**\n  - nested\n- [x] done\n- [ ] todo')).toBe('• one\n• <b>two</b>\n  • nested\n• ☑ done\n• ☐ todo')
    expect(toHtml('3. three\n4. four')).toBe('3. three\n4. four')
  })

  it('sets a table in a monospace block, its columns aligned', () => {
    expect(toHtml('| a | bee |\n|---|---|\n| 1 | 2 |')).toBe('<pre>a | bee\n--+----\n1 | 2</pre>')
  })

  it('shows HTML as it was written, since Telegram refuses tags outside its own', () => {
    expect(toHtml('<b>raw</b> and <script>x<y</script>')).toBe('&lt;b&gt;raw&lt;/b&gt; and &lt;script&gt;x&lt;y&lt;/script&gt;')
  })

  it('leaves plain words as they are', () => {
    expect(toHtml('no answer · error · START_FAILED')).toBe('no answer · error · START_FAILED')
    expect(toHtml('schedule "digest"\n\ntwo new papers')).toBe('schedule "digest"\n\ntwo new papers')
  })
})
