/**
 * Media an agent may look at: what a file is.
 *
 * Contract: ARCHITECTURE.md, "Looking at a picture is a read". A file is identified by
 * its first bytes rather than its name,
 * because an agent downloads one and the extension is whatever the URL ended in — or
 * absent. The four formats below are the ones every vision model accepts.
 */

const MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
]

const starts = (buf, bytes) => bytes.every((b, i) => buf[i] === b)

export const SNIFF_BYTES = 16

export function sniffImage (buf) {
  if (!buf || buf.length < 4) return null
  for (const { mime, bytes } of MAGIC) {
    if (buf.length >= bytes.length && starts(buf, bytes)) return mime
  }
  // RIFF is a container: the four bytes at 8 say which kind, and only WEBP is an image.
  if (buf.length >= 12 && starts(buf, [0x52, 0x49, 0x46, 0x46]) &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp'
  }
  return null
}
