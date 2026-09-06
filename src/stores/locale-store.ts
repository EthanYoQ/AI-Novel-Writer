import { create, type StateCreator } from 'zustand'
import { ipc } from '../services/ipc-client'
import { localize, resolveLocale, translate, type MessageKey, type MessageParams } from '../i18n/core'
import type { Locale } from '../i18n/types'
import type { GlobalConfig } from '../shared/ipc-channels'

export interface LocaleDependencies {
  loadConfig: () => Promise<Partial<GlobalConfig>>
  saveLocale: (locale: Locale) => Promise<{ success: boolean; error?: string }>
  systemLocale: () => string | undefined
  setDocumentLanguage: (locale: Locale) => void
  reportError?: (message: string, title: string) => void | Promise<void>
}

export interface LocaleState {
  locale: Locale
  initialized: boolean
  init: () => Promise<void>
  setLocale: (locale: Locale) => Promise<void>
  toggleLocale: () => Promise<void>
  t: (key: MessageKey, params?: MessageParams) => string
  text: (zhCNText: string, enUSText: string, params?: MessageParams) => string
}

export function createLocaleState(dependencies: LocaleDependencies): StateCreator<LocaleState> {
  return (set, get) => {
    // Components commonly select only `t` or `text`. Refreshing these reader
    // identities with the locale makes those subscriptions reactive while the
    // functions still resolve the latest locale when called from callbacks.
    const localeReaders = () => ({
      t: (key: MessageKey, params?: MessageParams) => translate(get().locale, key, params),
      text: (zhCNText: string, enUSText: string, params?: MessageParams) => (
        localize(get().locale, zhCNText, enUSText, params)
      ),
    })

    return {
      locale: resolveLocale(dependencies.systemLocale()),
      initialized: false,
      ...localeReaders(),
      async init() {
        const config = await dependencies.loadConfig()
        const locale = config.locale ?? resolveLocale(dependencies.systemLocale())
        dependencies.setDocumentLanguage(locale)
        set({ locale, initialized: true, ...localeReaders() })
      },
      async setLocale(locale) {
        const previousLocale = get().locale
        if (locale === previousLocale) return
        set({ locale, ...localeReaders() })
        dependencies.setDocumentLanguage(locale)
        try {
          const result = await dependencies.saveLocale(locale)
          if (!result.success) throw new Error(result.error ?? 'Failed to persist locale')
        } catch (error) {
          if (get().locale === locale) {
            set({ locale: previousLocale, ...localeReaders() })
            dependencies.setDocumentLanguage(previousLocale)
          }
          await dependencies.reportError?.(
            localize(
              previousLocale,
              `语言设置保存失败：${error instanceof Error ? error.message : String(error)}`,
              `Could not save the language setting: ${error instanceof Error ? error.message : String(error)}`,
            ),
            localize(previousLocale, '语言设置保存失败', 'Could not save language setting'),
          )
        }
      },
      async toggleLocale() {
        await get().setLocale(get().locale === 'zh-CN' ? 'en-US' : 'zh-CN')
      },
    }
  }
}

const browserDependencies: LocaleDependencies = {
  loadConfig: () => ipc.invoke('config:get'),
  saveLocale: locale => ipc.invoke('config:set', { locale }),
  systemLocale: () => globalThis.navigator?.language,
  setDocumentLanguage(locale) {
    if (globalThis.document) globalThis.document.documentElement.lang = locale
  },
  async reportError(message, title) {
    const { alertError } = await import('../components/ui/AlertDialog')
    await alertError(message, { title })
  },
}

export const useLocaleStore = create<LocaleState>(createLocaleState(browserDependencies))
