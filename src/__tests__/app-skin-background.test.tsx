import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { SkinBackgroundLayer, resolveSkinBackgroundUrl } from '../App'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('App image-skin background seam', () => {
  it('renders one passive background layer and only resolves an image for image skins', () => {
    expect(resolveSkinBackgroundUrl('classic', 'blob:custom')).toBeNull()
    // The packaged app is loaded with BrowserWindow.loadFile().  An absolute
    // public path would resolve to the filesystem root instead of dist/.
    expect(resolveSkinBackgroundUrl('anime', null)).toBe('./skins/anime-night.webp')
    expect(resolveSkinBackgroundUrl('custom', 'blob:custom')).toBe('blob:custom')

    const markup = renderToStaticMarkup(<SkinBackgroundLayer skinId="anime" backgroundUrl={null} onImageError={() => {}} />)
    expect((markup.match(/aria-hidden/g) ?? [])).toHaveLength(1)
    expect(markup).toContain('data-skin-background="anime"')
    expect(markup).toContain('<img')
    expect(markup).toContain('./skins/anime-night.webp')
  })

  it('locks background framing and fixed readability surfaces without skin blur, opacity controls, or crop controls', () => {
    const start = css.indexOf('/* ===== 图片皮肤')
    const end = css.indexOf('/* ===== 图片皮肤结束 =====', start)
    const skinCss = start >= 0 && end >= 0 ? css.slice(start, end) : ''

    expect(skinCss).toContain('background-size: cover')
    expect(skinCss).toContain('background-position: center')
    expect(skinCss).toContain('object-fit: cover')
    expect(skinCss).toContain('object-position: center')
    expect(skinCss).toContain('--skin-welcome-surface: color-mix(in srgb, var(--color-bg) 84%, transparent)')
    expect(skinCss).toContain('--skin-panel-surface: color-mix(in srgb, var(--color-panel) 93%, transparent)')
    expect(skinCss).toContain('--skin-main-surface: color-mix(in srgb, var(--skin-editor-base) 98%, transparent)')
    expect(skinCss).toContain('--skin-solid-surface: var(--color-panel)')
    expect(skinCss).not.toMatch(/blur\(|opacity\s*:|crop/i)
  })
})
