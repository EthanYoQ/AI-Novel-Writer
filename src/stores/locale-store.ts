import { create, type StateCreator } from 'zustand'
import { ipc } from '../services/ipc-client'
import { localize, resolveLocale, translate, type MessageKey, type MessageParams } from '../i18n/core'
import type { Locale } from '../i18n/types'
import type { GlobalConfig } from '../shared/ipc-channels'

export interface LocaleDependencies {
  loadConfig: () => Promise<Partial<GlobalConfig>>
  saveLocale: (locale: Locale) => Promise<void>
  systemLocale: () => string | undefined
  setDocumentLanguage: (locale: Locale) => void
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
        set({ locale, ...localeReaders() })
        dependencies.setDocumentLanguage(locale)
        await dependencies.saveLocale(locale)
      },
      async toggleLocale() {
        await get().setLocale(get().locale === 'zh-CN' ? 'en-US' : 'zh-CN')
      },
    }
  }
}

const browserDependencies: LocaleDependencies = {
  loadConfig: () => ipc.invoke('config:get'),
  async saveLocale(locale) {
    const result = await ipc.invoke('config:set', { locale })
    if (!result.success) throw new Error(result.error ?? 'Failed to persist locale')
  },
  systemLocale: () => globalThis.navigator?.language,
  setDocumentLanguage(locale) {
    if (globalThis.document) globalThis.document.documentElement.lang = locale
  },
}

export const useLocaleStore = create<LocaleState>(createLocaleState(browserDependencies))
