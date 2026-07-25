import { describe, expect, it, vi } from 'vitest'

import {
  createOfficialHomepageWindowOpenHandler,
  OFFICIAL_HOMEPAGE_URL,
  preventRendererNavigation,
} from '../official-homepage-navigation'

describe('official homepage navigation policy', () => {
  it('opens only the exact allowlisted homepage externally and always denies a new in-app window', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const handler = createOfficialHomepageWindowOpenHandler({ openExternal })

    expect(handler({ url: OFFICIAL_HOMEPAGE_URL })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(OFFICIAL_HOMEPAGE_URL)
  })

  it.each([
    `${OFFICIAL_HOMEPAGE_URL}/`,
    `${OFFICIAL_HOMEPAGE_URL}/issues/25`,
    'https://github.com/EthanYoQ/AI-Novel-Writer.evil.example',
    'https://example.com/?next=https://github.com/EthanYoQ/AI-Novel-Writer',
  ])('denies an untrusted popup URL without passing it to the system browser: %s', (url) => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const handler = createOfficialHomepageWindowOpenHandler({ openExternal })

    expect(handler({ url })).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('blocks all renderer-initiated main-frame navigations so the application stays in its own window', () => {
    const event = { preventDefault: vi.fn() }

    preventRendererNavigation(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
