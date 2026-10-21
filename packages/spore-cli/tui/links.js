/**
 * The `· /copy <n>` label on a code block's opening fence, made a link. It is drawn as an OSC 8
 * hyperlink — which kitty underlines on hover — so a click on it reaches pi-tui's `openUrl` with a
 * URL this module reads back into the number of the block to copy. The label's own look is
 * unchanged, and the link adds no width to the line.
 */
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui'

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
