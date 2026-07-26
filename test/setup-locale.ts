import { beforeEach } from 'vitest'

import { useLocaleStore } from '../src/stores/locale-store'

/**
 * Renderer tests assert the Chinese-first product copy by default. Keep that
 * test baseline independent from the runner's operating-system locale.
 */
export function resetTestLocale(): void {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: false })
}

beforeEach(resetTestLocale)
