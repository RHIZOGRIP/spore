import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** What agent-browser sends for the commands `reference.md` teaches, measured against Chrome. */
export const METHODS = new Set([
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'Browser.getVersion',
  'Browser.setDownloadBehavior',
  'DOM.describeNode',
  'DOM.enable',
  'DOM.getBoxModel',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.setFileInputFiles',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Network.enable',
  'Page.captureScreenshot',
  'Page.enable',
  'Page.getFrameTree',
  'Page.navigate',
  'Page.printToPDF',
  'Page.reload',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.runIfWaitingForDebugger',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Target.getTargets',
  'Target.setAutoAttach',
  'Target.setDiscoverTargets',
  'WebMCP.enable'
])

const pageUrl = (url) => {
  if (url === 'about:blank') return true
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

const realOf = (path) => {
  try {
    return realpathSync(path)
  } catch (err) {
    if (err.code !== 'ENOENT' || dirname(path) === path) throw err
    return join(realOf(dirname(path)), basename(path))
  }
}

/** Judged on the real path, a part not yet made taken as it would be, so a link in data/ leads nowhere else. */
const inside = (path, data) => {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  try {
    const real = realOf(resolve(path))
    const root = realOf(data)
    return real === root || real.startsWith(`${root}${sep}`)
  } catch {
    return false
  }
}

/** Why the endpoint refuses `message` for the spore whose `data/` is `data`, or null when it passes. */
export function refusalOf ({ method, params = {} }, data) {
  if (!METHODS.has(method)) return `${method} is not a method this browser takes`
  if (method === 'Page.navigate' || method === 'Target.createTarget') {
    return pageUrl(params.url) ? null : `${method} to ${params.url}: only http, https and about:blank`
  }
  if (method === 'Browser.setDownloadBehavior') {
    if (params.downloadPath === undefined && ['deny', 'default'].includes(params.behavior)) return null
    return inside(params.downloadPath, data) ? null : `downloads go only into the spore's data/, not ${params.downloadPath}`
  }
  if (method === 'DOM.setFileInputFiles') {
    const outside = (Array.isArray(params.files) ? params.files : [params.files]).filter(file => !inside(file, data))
    return outside.length ? `uploads come only from the spore's data/, not ${outside.join(', ')}` : null
  }
  return null
}
