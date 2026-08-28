export const WRITING_LANGUAGES = ['zh-CN', 'en-US'] as const

export type WritingLanguage = typeof WRITING_LANGUAGES[number]

export const DEFAULT_WRITING_LANGUAGE: WritingLanguage = 'zh-CN'

export function resolveWritingLanguage(value: unknown): WritingLanguage {
  return WRITING_LANGUAGES.includes(value as WritingLanguage)
    ? value as WritingLanguage
    : DEFAULT_WRITING_LANGUAGE
}
