export const VISIBLE_CONTINUATION_VERSION = 'visible-append-v1' as const
export const CONTINUATION_VISIBLE_TAIL_CHARS = 1600
const MIN_VISIBLE_OVERLAP_CHARS = 48

function removeLeadingNonWhitespaceCharacters(text: string, count: number): string {
  if (count <= 0) return text
  let consumed = 0
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) consumed += 1
    if (consumed >= count) return text.slice(index + 1).trimStart()
  }
  return ''
}

function overlappingVisiblePrefixLength(existingText: string, addition: string): number {
  const existingTail = existingText.slice(-CONTINUATION_VISIBLE_TAIL_CHARS).replace(/\s+/gu, '')
  const additionHead = addition.slice(0, CONTINUATION_VISIBLE_TAIL_CHARS).replace(/\s+/gu, '')
  const maximum = Math.min(existingTail.length, additionHead.length)

  for (let length = maximum; length >= MIN_VISIBLE_OVERLAP_CHARS; length -= 1) {
    if (existingTail.slice(-length) === additionHead.slice(0, length)) return length
  }
  return 0
}


/** Inputs are already visible text; source artifact bytes are never modified. */
export function composeVisibleContinuation(existing: string, addition: string): string {
  const visibleExisting = existing.trim(), visibleAddition = addition.trim()
  const overlap = overlappingVisiblePrefixLength(visibleExisting, visibleAddition)
  const newVisibleText = removeLeadingNonWhitespaceCharacters(visibleAddition, overlap)
  return [visibleExisting, newVisibleText].filter(Boolean).join('\n\n').trim()
}
