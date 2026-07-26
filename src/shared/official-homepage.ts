import { localize } from '../i18n/core'
import type { Locale } from '../i18n/types'

/** The only renderer-approved external destination. It is never renderer supplied. */
export const OFFICIAL_HOMEPAGE_URL = 'https://github.com/EthanYoQ/AI-Novel-Writer'

/**
 * Renderer-facing copy for a failed fixed homepage intent. Keeping this shared
 * lets the packaged qualification prove the exact user-visible fallback rather
 * than reproducing a second string outside the renderer contract.
 */
export function getOfficialHomepageOpenError(locale: Locale): string {
  return localize(
    locale,
    '无法打开官方主页，请稍后重试。',
    'Unable to open the official homepage. Please try again later.',
  )
}
