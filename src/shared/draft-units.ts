const CHINESE_CHARACTER_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const WHITESPACE_OR_PUNCTUATION_PATTERN = /[\s\p{P}\p{S}]/gu

/** Count the visible prose unit used by chapter targets, storage, and UI. */
export function countDraftUnits(text: string): number {
  const englishWords = text.match(ENGLISH_WORD_PATTERN)?.length ?? 0
  const withoutEnglishWords = text.replace(ENGLISH_WORD_PATTERN, '')
  const chineseCharacters = withoutEnglishWords.match(CHINESE_CHARACTER_PATTERN)?.length ?? 0
  const otherCharacters = withoutEnglishWords
    .replace(CHINESE_CHARACTER_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_PATTERN, '')
    .length
  return chineseCharacters + englishWords + otherCharacters
}
