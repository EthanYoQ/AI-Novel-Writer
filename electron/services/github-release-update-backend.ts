import type { UpdateBackend } from './update-service'

export const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/latest'
export const GITHUB_LATEST_RELEASE_PAGE = 'https://github.com/EthanYoQ/AI-Novel-Writer/releases/latest'

interface ReleaseResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

type ReleaseFetcher = (url: string, init?: RequestInit) => Promise<ReleaseResponse>

/** macOS uses GitHub metadata only; opening the fixed download page is a separate main-process action. */
export function createGitHubReleaseUpdateBackend(fetcher: ReleaseFetcher = fetch): UpdateBackend {
  return {
    async checkForUpdates() {
      const response = await fetcher(GITHUB_LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AI-Novel-Writer',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      let value: unknown
      try {
        value = await response.json()
      } catch {
        throw new Error('Invalid GitHub release metadata')
      }
      if (!value || typeof value !== 'object') throw new Error('Invalid GitHub release metadata')
      const release = value as Record<string, unknown>
      if (typeof release.tag_name !== 'string') throw new Error('Invalid GitHub release metadata')

      return {
        updateInfo: {
          version: release.tag_name.replace(/^v/, ''),
          ...(typeof release.name === 'string' ? { releaseName: release.name } : {}),
          ...(typeof release.body === 'string' ? { releaseNotes: release.body } : {}),
          ...(typeof release.published_at === 'string' ? { releaseDate: release.published_at } : {}),
        },
      }
    },
    downloadUpdate: async () => [],
    quitAndInstall: () => {},
  }
}
