import { describe, expect, it, vi } from 'vitest'

import {
  GITHUB_LATEST_RELEASE_API,
  createGitHubReleaseUpdateBackend,
} from '../github-release-update-backend'

describe('GitHub latest release update backend', () => {
  it('reads only stable release metadata from the fixed repository endpoint', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.9.3',
        name: 'AI Novel Writer v0.9.3',
        body: 'Release notes',
        published_at: '2026-09-03T00:00:00.000Z',
        html_url: 'https://attacker.invalid/not-used',
      }),
    }))
    const backend = createGitHubReleaseUpdateBackend(fetcher)

    await expect(backend.checkForUpdates()).resolves.toEqual({
      updateInfo: {
        version: '0.9.3',
        releaseName: 'AI Novel Writer v0.9.3',
        releaseNotes: 'Release notes',
        releaseDate: '2026-09-03T00:00:00.000Z',
      },
    })
    expect(fetcher).toHaveBeenCalledWith(GITHUB_LATEST_RELEASE_API, expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
    }))
  })
})
