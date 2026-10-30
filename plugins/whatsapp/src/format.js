/**
 * Markdown, as a model writes it, in WhatsApp's own markup: `*bold*`, `_italic_`, `~strike~`,
 * `` `code` ``, ```` ``` ```` blocks and `> ` quotes. A heading becomes a bold line, a list keeps
 * its bullets as text, a table becomes a monospace block, and a link shows its address after its
 * text, since WhatsApp makes a bare address a link and has no other.
 */

import { Lexer } from 'marked'

const plain = (tokens) => tokens.map(token => (token.tokens ? plain(token.tokens) : token.text ?? '')).join('')

const wrapped = (mark, text) => text.trim() ? `${mark}${text}${mark}` : text

function inline (tokens) {
  return tokens.map((token) => {
    if (token.type === 'strong') return wrapped('*', inline(token.tokens))
    if (token.type === 'em') return wrapped('_', inline(token.tokens))
    if (token.type === 'del') return wrapped('~', inline(token.tokens))
    if (token.type === 'codespan') return `\`${token.text}\``
    if (token.type === 'br') return '\n'
    if (token.type === 'link') {
      const text = inline(token.tokens)
      return text === token.href || plain(token.tokens) === token.href ? token.href : `${text} (${token.href})`
    }
    if (token.type === 'image') return token.text ? `${token.text} (${token.href})` : token.href
    if (token.type === 'text') return token.tokens ? inline(token.tokens) : token.text
    if (token.type === 'escape') return token.text
    if (token.type === 'checkbox') return token.checked ? '☑ ' : '☐ '
    return token.raw
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
  return `\`\`\`\n${[line(rows[0]), widths.map(width => '-'.repeat(width)).join('-+-'), ...rows.slice(1).map(line)].join('\n')}\n\`\`\``
}

function block (tokens, depth = 0) {
  const out = []
  for (const token of tokens) {
    if (token.type === 'space') continue
    if (token.type === 'code') {
      out.push(`\`\`\`\n${token.text}\n\`\`\``)
    } else if (token.type === 'heading') {
      out.push(wrapped('*', inline(token.tokens)))
    } else if (token.type === 'paragraph' || token.type === 'text') {
      out.push(inline(token.tokens ?? [token]))
    } else if (token.type === 'blockquote') {
      out.push(block(token.tokens, depth).split('\n').map(line => `> ${line}`).join('\n'))
    } else if (token.type === 'list') {
      out.push(list(token, depth))
    } else if (token.type === 'table') {
      out.push(table(token))
    } else if (token.type === 'hr') {
      out.push('──────────')
    } else {
      out.push(token.raw.trimEnd())
    }
  }
  return out.join('\n\n')
}

export const toWhatsApp = (markdown) => block(Lexer.lex(String(markdown)))
