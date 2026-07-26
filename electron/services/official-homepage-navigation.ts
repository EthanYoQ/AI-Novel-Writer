import { OFFICIAL_HOMEPAGE_URL } from '../../src/shared/official-homepage'

export { OFFICIAL_HOMEPAGE_URL } from '../../src/shared/official-homepage'

type OpenExternal = (url: string) => Promise<void>

interface OfficialHomepageWindowOpenHandlerOptions {
  openExternal: OpenExternal
  onOpenExternalError?: (error: unknown) => void
}

/** Matches only the one official repository URL; paths, queries, and lookalike hosts are not trusted. */
export function isOfficialHomepageUrl(url: string): boolean {
  return url === OFFICIAL_HOMEPAGE_URL
}

/**
 * Keeps popup requests out of the Electron renderer. The one exact official
 * homepage is delegated to the operating system's default browser instead.
 */
export function createOfficialHomepageWindowOpenHandler({
  openExternal,
  onOpenExternalError = () => {},
}: OfficialHomepageWindowOpenHandlerOptions) {
  return ({ url }: { url: string }) => {
    if (isOfficialHomepageUrl(url)) {
      void openExternal(OFFICIAL_HOMEPAGE_URL).catch(onOpenExternalError)
    }
    return { action: 'deny' as const }
  }
}

/** The app never lets renderer-initiated navigation replace its own main frame. */
export function preventRendererNavigation(event: { preventDefault: () => void }): void {
  event.preventDefault()
}
