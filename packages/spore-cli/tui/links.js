/**
 * The links the terminal draws and reads back. They are OSC 8 hyperlinks, so a click reaches
 * pi-tui's `openUrl`, and they add no width to a line. The `· /copy <n>` label on a code block's
 * opening fence carries the number of the block to copy; a delivered file carries its `file:` URL,
 * which the terminal itself can open on Shift-click.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getCapabilities, hyperlink } from '@earendil-works/pi-tui'
import { bytesText, printable } from '@rhizogrip/spore'
import chalk from 'chalk'

const LABEL = /^(.*) · \/copy (\d+)$/
const SCHEME = 'spore-copy:'

/** The URL a labelled fence carries, or null for a label that names no block. */
export const copyUrl = (label) => {
  const numbered = LABEL.exec(String(label))
  return numbered ? `${SCHEME}${numbered[2]}` : null
}

/** The block number a clicked URL names, or null when the URL is not one of ours. */
export const copyNumber = (url) => {
  if (!String(url).startsWith(SCHEME)) return null
  const n = Number(String(url).slice(SCHEME.length))
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** A fence label, styled and linked when the terminal shows hyperlinks, and left alone when not. */
export const fenceLabel = (label, style) => {
  const url = copyUrl(label)
  return url && getCapabilities().hyperlinks ? hyperlink(style(label), url) : style(label)
}

/** A file the turn handed back, as a line: its full path, linked when the terminal shows hyperlinks. */
export const deliveredLine = ({ path, bytes }) => {
  const shown = chalk.cyan(printable(path))
  const linked = getCapabilities().hyperlinks ? hyperlink(shown, pathToFileURL(path).href) : shown
  return `${chalk.dim('delivered')}  ${linked}  ${chalk.dim(bytesText(bytes))}`
}

/**
 * The file a clicked link points at, a relative one read from the workspace `ws`; null for a link
 * that names no file here. An answer's links are the model's own text, so one may not parse.
 */
export const fileOf = (url, ws) => {
  try {
    const target = new URL(url, pathToFileURL(`${ws}/`))
    return target.protocol === 'file:' ? fileURLToPath(target) : null
  } catch {
    return null
  }
}
