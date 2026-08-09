import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { AppSkinRoot, SkinBackgroundLayer, resolveSkinBackgroundUrl } from '../App'
import EditorArea from '../components/panels/EditorArea'
import Sidebar from '../components/panels/Sidebar'
import KnowledgeOverview from '../components/pages/KnowledgeOverview'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

function imageSkinCss(): string {
  const start = css.indexOf('/* ===== 图片皮肤')
  const end = css.indexOf('/* ===== 图片皮肤结束 =====', start)
  return start >= 0 && end >= 0 ? css.slice(start, end) : ''
}

describe('App image-skin background seam', () => {
  it('emits stable high-contrast semantics on the App root for every theme and image skin', () => {
    const themes = ['light', 'galaxy', 'paper', 'dark'] as const
    const imageSkins = ['anime', 'custom'] as const

    for (const theme of themes) {
      for (const skinId of imageSkins) {
        const markup = renderToStaticMarkup(
          <AppSkinRoot theme={theme} skinId={skinId}>
            <span>content</span>
          </AppSkinRoot>,
        )

        expect(markup).toContain(`data-theme="${theme}"`)
        expect(markup).toContain(`data-skin="${skinId}"`)
        expect(markup).toContain('data-skin-readability="high-contrast"')
      }
    }

    const classicMarkup = renderToStaticMarkup(
      <AppSkinRoot theme="light" skinId="classic">
        <span>content</span>
      </AppSkinRoot>,
    )
    expect(classicMarkup).toContain('data-skin-readability="theme-default"')
  })

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

  it('exposes image-skin workspace roots through transparent panel and page semantics while preserving solid controls', () => {
    const sidebarMarkup = renderToStaticMarkup(<Sidebar />)
    const editorMarkup = renderToStaticMarkup(<EditorArea onNewProject={() => {}} />)
    const knowledgeMarkup = renderToStaticMarkup(<KnowledgeOverview />)
    const skinCss = imageSkinCss()

    expect(sidebarMarkup).toContain('skin-workspace-panel')
    expect(editorMarkup).toContain('skin-workspace-page')
    expect(knowledgeMarkup).toContain('skin-workspace-page')

    expect(skinCss).toContain('--skin-workspace-panel-surface: color-mix(in srgb, var(--color-sidebar) 56%, transparent)')
    expect(skinCss).toContain('--skin-workspace-page-surface: color-mix(in srgb, var(--skin-editor-base) 60%, transparent)')
    expect(skinCss).toContain(".app-skin-root[data-skin-readability='high-contrast'] .skin-workspace-panel")
    expect(skinCss).toContain(".app-skin-root[data-skin-readability='high-contrast'] .skin-workspace-page")
    expect(skinCss).toContain('background: var(--skin-workspace-panel-surface) !important')
    expect(skinCss).toContain('background: var(--skin-workspace-page-surface) !important')
    expect(skinCss).not.toContain("[data-skin-readability='theme-default'] .skin-workspace-panel")
    expect(skinCss).not.toContain("[data-skin-readability='theme-default'] .skin-workspace-page")

    expect(skinCss).toContain('--skin-control-surface: color-mix(in srgb, var(--color-panel) 88%, transparent)')
    expect(skinCss).toContain("[role='dialog']")
    expect(skinCss).toContain("[role='menu']")
    expect(skinCss).toContain('.skin-solid-surface')
  })

  it('keeps image-skin surfaces transparent while declaring explicit high-contrast text, border, and control tokens', () => {
    const skinCss = imageSkinCss()

    expect(skinCss).toContain('background-size: cover')
    expect(skinCss).toContain('background-position: center')
    expect(skinCss).toContain('object-fit: cover')
    expect(skinCss).toContain('object-position: center')
    expect(skinCss).toContain("[data-skin-readability='high-contrast']")
    expect(skinCss).toContain('--skin-text-primary:')
    expect(skinCss).toContain('--skin-text-secondary:')
    expect(skinCss).toContain('--skin-border:')
    expect(skinCss).toContain('--skin-control-surface:')
    expect(skinCss).toContain('--skin-control-text:')
    expect(skinCss).toContain('--skin-control-border:')
    for (const theme of ['light', 'galaxy', 'paper', 'dark']) {
      expect(skinCss).toContain(`[data-theme='${theme}'][data-skin-readability='high-contrast']`)
    }
    expect(skinCss).toContain('--color-text: var(--skin-text-primary)')
    expect(skinCss).toContain('--color-text-secondary: var(--skin-text-secondary)')
    expect(skinCss).toContain('--color-text-muted: color-mix(in srgb, var(--skin-text-secondary) 78%, var(--skin-text-primary))')
    expect(skinCss).toContain('--color-border: var(--skin-border)')
    expect(skinCss).toContain('--skin-welcome-surface: color-mix(in srgb, var(--color-bg) 64%, transparent)')
    expect(skinCss).toContain('--skin-panel-surface: color-mix(in srgb, var(--color-panel) 72%, transparent)')
    expect(skinCss).toContain('--skin-main-surface: color-mix(in srgb, var(--skin-editor-base) 78%, transparent)')
    expect(skinCss).toContain('--skin-background-scrim: color-mix(in srgb, var(--color-bg) 12%, transparent)')
    expect(skinCss).toContain("[data-skin-readability='high-contrast'] :is(\n  .writer-shell-surface,")
    expect(skinCss).toContain('color: var(--skin-text-primary)')
    expect(skinCss).toContain("[data-skin-readability='high-contrast'] .writer-panel-card")
    expect(skinCss).toContain('background: var(--skin-panel-surface) !important')
    expect(skinCss).toContain('border-color: var(--skin-border) !important')
    expect(skinCss).toContain('background-color: var(--skin-control-surface) !important')
    expect(skinCss).toContain('color: var(--skin-control-text) !important')
    expect(skinCss).toContain('border-color: var(--skin-control-border) !important')
    expect(skinCss).not.toMatch(/blur\(|opacity\s*:|crop/i)
  })

  it('keeps classic skin surfaces inside the active color theme instead of leaking the paper palette', () => {
    const writerCss = css.slice(css.indexOf('/* Writer console visual system'), css.indexOf('/* ===== 图片皮肤'))

    for (const theme of ['light', 'galaxy', 'dark']) {
      expect(writerCss).toContain(`.app-skin-root[data-skin='classic'][data-theme='${theme}']`)
    }

    for (const declaration of [
      '--writer-surface-topbar: var(--color-titlebar)',
      '--writer-surface-left-rail: var(--color-activity-bar)',
      '--writer-surface-statusbar: var(--color-statusbar)',
      '--writer-surface-project-tree: var(--color-sidebar)',
      '--writer-surface-ai-panel: var(--color-panel)',
      '--writer-surface-task-table: var(--color-panel)',
      '--writer-surface-shell: var(--color-bg)',
      '--writer-surface-card: var(--color-panel)',
      '--writer-text-primary: var(--color-text)',
    ]) {
      expect(writerCss).toContain(declaration)
    }

    for (const selector of [
      '.writer-topbar',
      '.writer-left-rail',
      '.writer-statusbar',
      '.writer-project-tree',
      '.writer-ai-panel',
      '.writer-task-table',
      '.writer-shell-surface',
      '.writer-panel-card',
    ]) {
      expect(writerCss).toContain(selector)
    }

    expect(writerCss).toContain(".app-skin-root[data-skin='classic'][data-theme='paper']")
    expect(writerCss).toContain('--writer-surface-project-tree: var(--writer-paper-200)')
    expect(writerCss).toContain('--writer-surface-topbar: linear-gradient(180deg, var(--writer-walnut-850) 0%, var(--writer-walnut-950) 100%)')
  })
})
