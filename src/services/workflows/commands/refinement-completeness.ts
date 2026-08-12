const MIN_REFINEMENT_COMPLETION_RATIO = 0.6
const MIN_REFINEMENT_UNITS = 200
const CHINESE_CHARACTER_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const WHITESPACE_OR_PUNCTUATION_PATTERN = /[\s\p{P}\p{S}]/gu

/** Provider-neutral prose units used only to reject a materially truncated revision. */
function countVisibleProseUnits(text: string): number {
  const englishWords = text.match(ENGLISH_WORD_PATTERN)?.length ?? 0
  const withoutEnglishWords = text.replace(ENGLISH_WORD_PATTERN, '')
  const chineseCharacters = withoutEnglishWords.match(CHINESE_CHARACTER_PATTERN)?.length ?? 0
  const otherCharacters = withoutEnglishWords
    .replace(CHINESE_CHARACTER_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_PATTERN, '')
    .length
  return chineseCharacters + englishWords + otherCharacters
}

export function assertMateriallyCompleteRevision(
  source: string,
  revision: string,
  targetUnits: number,
): void {
  const sourceUnits = countVisibleProseUnits(source)
  const revisionUnits = countVisibleProseUnits(revision)
  const boundedTarget = Number.isSafeInteger(targetUnits) && targetUnits > 0
    ? Math.min(sourceUnits, targetUnits)
    : sourceUnits
  const minimumUnits = Math.min(
    sourceUnits,
    Math.max(MIN_REFINEMENT_UNITS, Math.floor(boundedTarget * MIN_REFINEMENT_COMPLETION_RATIO)),
  )
  if (revisionUnits < minimumUnits) {
    throw new Error('修稿结果明显短于原稿，可能仍不完整，结果未被保存。请重试或缩短本次修稿范围。')
  }
}
