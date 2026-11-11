/**
 * Text from a model or a tool, made safe to put on a terminal: no escape or control byte that
 * the terminal would act on (a cursor move, a screen clear, an OSC 52 clipboard write), and no
 * bidirectional override that would show it in another order than it reads. Newlines stay,
 * since an answer is prose; a tab becomes spaces.
 */

// C0 controls but newline and tab, DEL, the C1 block, and the bidi embeddings, overrides and
// isolates.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g

export const printable = (text) => String(text).replace(/\t/g, '  ').replace(UNPRINTABLE, '')
