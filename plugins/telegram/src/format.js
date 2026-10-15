/**
 * Markdown, as a model writes it, in the HTML Telegram renders. Bold, italic, strikethrough, code,
 * code blocks with their language, links and quotes are Telegram's own; a heading becomes a bold
 * line, a list keeps its bullets as text, a table becomes a monospace block. Telegram refuses a
 * message holding any tag outside its small set, so everything else is escaped and shown as written.
 */

import { Lexer } from 'marked'

const LINKABLE = /^(https?:|mailto:|tg:)/i

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attribute = (text) => escape(text).replace(/"/g, '&quot;')

const plain = (tokens) => tokens.map(token => (token.tokens ? plain(token.tokens) : token.text ?? '')).join('')

function inline (tokens) {
  return tokens.map((token) => {
    if (token.type === 'strong') return `<b>${inline(token.tokens)}</b>`
    if (token.type === 'em') return `<i>${inline(token.tokens)}</i>`
    if (token.type === 'del') return `<s>${inline(token.tokens)}</s>`
    if (token.type === 'codespan') return `<code>${escape(token.text)}</code>`
    if (token.type === 'br') return '\n'
    if (token.type === 'link') return LINKABLE.test(token.href) ? `<a href="${attribute(token.href)}">${inline(token.tokens)}</a>` : inline(token.tokens)
    if (token.type === 'image') return LINKABLE.test(token.href) ? `<a href="${attribute(token.href)}">${escape(token.text || token.href)}</a>` : escape(token.text)
    if (token.type === 'text') return token.tokens ? inline(token.tokens) : escape(token.text)
    if (token.type === 'escape') return escape(token.text)
    if (token.type === 'checkbox') return token.checked ? '☑ ' : '☐ '
    return escape(token.raw)
  }).join('')
}

function list (token, depth) {
  const indent = '  '.repeat(depth)
  return token.items.map((item, i) => {
    const mark = token.ordered ? `${Number(token.start) + i}.` : '•'
    const box = item.tokens.filter(child => child.type === 'checkbox').map(child => inline([child])).join('')
    const parts = item.tokens.filter(child => child.type !== 'checkbox').map(child => (child.type === 'list' ? list(child, depth + 1) : block([child], depth + 1)))
    return `${indent}${mark} ${box}${parts.join('\n')}`
  }).join('\n')
}

function table (token) {
  const rows = [token.header, ...token.rows].map(row => row.map(cell => plain(cell.tokens)))
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)))
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd()
  return `<pre>${escape([line(rows[0]), widths.map(width => '-'.repeat(width)).join('-+-'), ...rows.slice(1).map(line)].join('\n'))}</pre>`
}

function block (tokens, depth = 0) {
  const out = []
  for (const token of tokens) {
    if (token.type === 'space') continue
    if (token.type === 'code') {
      const language = token.lang?.split(/\s/)[0]
      out.push(`<pre><code${language ? ` class="language-${attribute(language)}"` : ''}>${escape(token.text)}</code></pre>`)
    } else if (token.type === 'heading') {
      out.push(`<b>${inline(token.tokens)}</b>`)
    } else if (token.type === 'paragraph' || token.type === 'text') {
      out.push(inline(token.tokens ?? [token]))
    } else if (token.type === 'blockquote') {
      out.push(`<blockquote>${block(token.tokens, depth)}</blockquote>`)
    } else if (token.type === 'list') {
      out.push(list(token, depth))
    } else if (token.type === 'table') {
      out.push(table(token))
    } else if (token.type === 'hr') {
      out.push('──────────')
    } else {
      out.push(escape(token.raw.trimEnd()))
    }
  }
  return out.join('\n\n')
}

export const toHtml = (markdown) => block(Lexer.lex(String(markdown)))
