export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en-US'] as const

export type Locale = typeof SUPPORTED_LOCALES[number]
export type MessageParams = Record<string, string | number>
