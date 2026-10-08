import { toTraditionalChinese } from './traditional-chinese'

export const WRITING_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US'] as const

export type WritingLanguage = typeof WRITING_LANGUAGES[number]

export const DEFAULT_WRITING_LANGUAGE: WritingLanguage = 'zh-CN'

export function resolveWritingLanguage(value: unknown): WritingLanguage {
  return WRITING_LANGUAGES.includes(value as WritingLanguage)
    ? value as WritingLanguage
    : DEFAULT_WRITING_LANGUAGE
}

/** Select built-in copy by project writing language without inspecting user content. */
export function writingLanguageText(
  language: WritingLanguage,
  zhCNText: string,
  enUSText: string,
): string {
  return language === 'en-US' ? enUSText : language === 'zh-TW' ? toTraditionalChinese(zhCNText) : zhCNText
}
