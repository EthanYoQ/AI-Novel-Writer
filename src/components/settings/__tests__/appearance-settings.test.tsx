import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import AppearanceSettings, {
  ANIME_SKIN_URL,
  CUSTOM_SKIN_REQUIREMENTS,
  getCustomSkinActionIds,
} from '../AppearanceSettings'
import { useSkinStore } from '../../../stores/skin-store'

const classicSkinState = { activeSkin: 'classic' as const, customSkin: null }

afterEach(() => {
  useSkinStore.setState({
    skinState: classicSkinState,
    backgroundUrl: null,
    notice: null,
  })
})

describe('appearance settings renderer seam', () => {
  it('renders theme controls separately from classic, anime, and custom skin cards', () => {
    const markup = renderToStaticMarkup(<AppearanceSettings />)

    expect(markup).toContain('data-theme="light"')
    expect(markup).toContain('data-theme="galaxy"')
    expect(markup).toContain('data-theme="paper"')
    expect(markup).toContain('data-theme="dark"')
    expect(markup).toContain('data-skin-card="classic"')
    expect(markup).toContain('data-skin-card="anime"')
    expect(markup).toContain('data-skin-card="custom"')
    expect(markup).toContain('data-skin-action="choose"')
    expect(markup).toContain('PNG / JPEG')
    expect(markup).toContain('20 MB')
    expect(markup).toContain('16:10')
    expect(ANIME_SKIN_URL).toBe('/skins/anime-night.webp')
  })

  it('offers choosing before an image exists, then replacement and removal after import', () => {
    expect(getCustomSkinActionIds(false)).toEqual(['choose'])
    expect(getCustomSkinActionIds(true)).toEqual(['change', 'remove'])
  })

  it('publishes the fixed custom-image constraints used by the native picker flow', () => {
    expect(CUSTOM_SKIN_REQUIREMENTS).toEqual({
      acceptedMimeTypes: ['image/png', 'image/jpeg'],
      maxBytes: 20 * 1024 * 1024,
      recommendedAspectRatio: '16:10',
    })
  })
})
