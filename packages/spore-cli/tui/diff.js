const MOST_CELLS = 250_000
const CONTEXT = 2

const linesOf = (text) => (text === '' ? [] : String(text).replace(/\n$/, '').split('\n'))

/**
 * `before` to `after`, line by line: `{ op, text }` with op ' ', '-' or '+'. Past a size where the
 * table would be slow, the changed middle is shown removed then added, which is still true.
 */
export function lineDiff (before, after) {
  const a = linesOf(before)
  const b = linesOf(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const head = a.slice(0, start).map(text => ({ op: ' ', text }))
  const tail = a.slice(a.length - end).map(text => ({ op: ' ', text }))
  const x = a.slice(start, a.length - end)
  const y = b.slice(start, b.length - end)
  if (x.length * y.length > MOST_CELLS) {
    return [...head, ...x.map(text => ({ op: '-', text })), ...y.map(text => ({ op: '+', text })), ...tail]
  }
  const longest = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      longest[i][j] = x[i] === y[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1])
    }
  }
  const middle = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      middle.push({ op: ' ', text: x[i++] })
      j++
    } else if (i < x.length && (j === y.length || longest[i + 1][j] >= longest[i][j + 1])) {
      middle.push({ op: '-', text: x[i++] })
    } else {
      middle.push({ op: '+', text: y[j++] })
    }
  }
  return [...head, ...middle, ...tail]
}

export const counts = (diff) => ({
  added: diff.filter(line => line.op === '+').length,
  removed: diff.filter(line => line.op === '-').length
})

/** The changed lines with `CONTEXT` unchanged ones around each run; a longer gap is one `…`. */
export function hunks (diff) {
  const near = diff.map((line, at) => line.op !== ' ' || diff.slice(Math.max(0, at - CONTEXT), at + CONTEXT + 1).some(other => other.op !== ' '))
  const shown = []
  for (let at = 0; at < diff.length; at++) {
    if (near[at]) shown.push(diff[at])
    else if (shown.at(-1)?.op !== '…') shown.push({ op: '…', text: '' })
  }
  return shown
}

export function changeOf (tool) {
  const { path, old, content } = tool.args
  if (tool.name === 'edit' && typeof old === 'string' && typeof tool.args.new === 'string') {
    return { path, diff: lineDiff(old, tool.args.new), whole: false }
  }
  if (tool.name === 'write' && typeof content === 'string') {
    return { path, diff: linesOf(content).map(text => ({ op: '+', text })), whole: true }
  }
  return null
}
