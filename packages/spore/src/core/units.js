/**
 * Durations and sizes as text, two ways each: a measured amount, rounded for reading, and a
 * declared bound, spelled as the `.cmk` and `config.json` write it so it can be written back.
 */

const SIZE_UNITS = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]
const DURATION_UNITS = [['h', 3_600_000], ['m', 60_000]]

export const durationText = (ms) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`

export function bytesText (bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit ? value.toFixed(1) : value}${units[unit]}`
}

/** `bytes` in the largest unit that holds it whole: `512MB`, `1GB`, `1500B`. */
export function sizeSpelling (bytes) {
  const [unit, scale] = SIZE_UNITS.find(([, scale]) => bytes % scale === 0) ?? ['B', 1]
  return `${bytes / scale}${unit}`
}

/** `ms` in the largest unit that holds it whole: `90m`, `2h`, `45s`. */
export function durationSpelling (ms) {
  const [unit, scale] = DURATION_UNITS.find(([, scale]) => ms % scale === 0) ?? ['s', 1000]
  return `${Math.round(ms / scale)}${unit}`
}
