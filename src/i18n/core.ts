import { enUS, type MessageKey } from './messages/en-US'
import { toTraditionalChinese } from '../shared/traditional-chinese'
import { zhCN } from './messages/zh-CN'
import { zhTW } from './messages/zh-TW'
import type { Locale, MessageParams } from './types'

type Catalog = Record<string, string>

export const messages: Record<Locale, Catalog> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
}

export function resolveLocale(input?: string | null): Locale {
  const tag = input?.toLowerCase().replaceAll('_', '-')
  if (tag?.startsWith('zh') && /(?:^|-)(?:tw|hk|mo|hant)(?:-|$)/u.test(tag)) return 'zh-TW'
  return tag?.startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function createTranslator(catalogs: Record<Locale, Catalog>) {
  return (locale: Locale, key: string, params: MessageParams = {}): string => {
    const template = catalogs[locale][key] ?? catalogs['en-US'][key] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
  }
}

const translateMessage = createTranslator(messages)

function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

/**
 * Localize short copy that belongs to a single component. Shared language uses
 * the keyed catalog above; colocating one-off copy keeps the catalog focused.
 */
export function localize(
  locale: Locale,
  zhCNText: string,
  enUSText: string,
  params?: MessageParams,
): string {
  const template = locale === 'en-US' ? enUSText : locale === 'zh-TW' ? toTraditionalChinese(zhCNText) : zhCNText
  return interpolate(template, params)
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return translateMessage(locale, key, params)
}

export type { Locale, MessageKey, MessageParams }
