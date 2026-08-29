import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/index.css')
const css = readFileSync(cssPath, 'utf8')
const root = postcss.parse(css, { from: cssPath })

type Rgb = readonly [number, number, number]

function declarationsFor(selector: ':root' | '.paper' | '.light' | '.galaxy' | '.dark'): Map<string, string> {
  const declarations = new Map<string, string>()

  root.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls((declaration: Declaration) => {
      if (/^#[0-9A-Fa-f]{6}$/.test(declaration.value)) {
        declarations.set(declaration.prop, declaration.value)
      }
    })
  })

  return declarations
}

function parseHex(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ]
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseHex(foreground))
  const backgroundLuminance = relativeLuminance(parseHex(background))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('readable theme text contrast contract', () => {
  it.each([
    ['default light', ':root'],
    ['paper', '.paper'],
    ['explicit light', '.light'],
    ['galaxy', '.galaxy'],
    ['dark', '.dark'],
  ] as const)('keeps the %s insertion caret visible on the editor surface', (_theme, selector) => {
    const declarations = declarationsFor(selector)
    const caret = declarations.get('--color-editor-caret')
    const editorSurface = declarations.get('--color-editor-bg')

    expect(caret, `${selector} --color-editor-caret`).toBeDefined()
    expect(editorSurface, `${selector} --color-editor-bg`).toBeDefined()
    expect(contrastRatio(caret!, editorSurface!)).toBeGreaterThanOrEqual(3)
  })

  it('uses the shared high-contrast caret token in the manuscript editor too', () => {
    const manuscriptCss = readFileSync(resolve(process.cwd(), 'src/components/editor/novel-editor.css'), 'utf8')
    expect(manuscriptCss).toContain('caret-color: var(--color-editor-caret, var(--color-text))')
  })

  it.each([
    ['default light', ':root'],
    ['paper', '.paper'],
    ['explicit light', '.light'],
    ['galaxy', '.galaxy'],
    ['dark', '.dark'],
  ] as const)('keeps %s category labels readable on active and raised surfaces', (_theme, selector) => {
    const declarations = declarationsFor(selector)
    const categoryTextTokens = [
      '--color-category-progress-text',
      '--color-category-review-text',
    ]

    for (const textToken of categoryTextTokens) {
      const categoryText = declarations.get(textToken)
      expect(categoryText, `${selector} ${textToken}`).toBeDefined()
      for (const surfaceToken of ['--color-active', '--color-raised']) {
        const surface = declarations.get(surfaceToken)
        expect(surface, `${selector} ${surfaceToken}`).toBeDefined()
        expect(
          contrastRatio(categoryText!, surface!),
          `${selector} ${textToken} ${categoryText} on ${surfaceToken} ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('maps category copy to the image skin high-contrast text semantic', () => {
    const highContrastBlock = css.match(/\.app-skin-root\[data-skin-readability='high-contrast'\] \{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(highContrastBlock).toContain('--color-category-progress-text: var(--skin-text-primary)')
    expect(highContrastBlock).toContain('--color-category-review-text: var(--skin-text-primary)')
  })

  it.each([
    ['default light', ':root'],
    ['paper', '.paper'],
    ['explicit light', '.light'],
  ] as const)('keeps %s information-bearing muted text at WCAG AA on content surfaces', (_theme, selector) => {
    const declarations = declarationsFor(selector)
    const mutedText = declarations.get('--color-text-muted')
    expect(mutedText).toBe('#655F55')

    for (const surfaceToken of [
      '--color-bg',
      '--color-raised',
      '--color-sidebar',
      '--color-panel',
      '--color-titlebar',
      '--color-activity-bar',
      '--color-hover',
      '--color-active',
      '--color-editor-bg',
      '--color-statusbar',
    ]) {
      const surface = declarations.get(surfaceToken)
      expect(surface, `${selector} ${surfaceToken}`).toBeDefined()
      expect(
        contrastRatio(mutedText!, surface!),
        `${selector} --color-text-muted ${mutedText} on ${surfaceToken} ${surface}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([
    ['default light', ':root', '#386042', '#8F3020', '#FFFFFF'],
    ['paper', '.paper', '#386042', '#8F3020', '#FFFFFF'],
    ['explicit light', '.light', '#386042', '#8F3020', '#FFFFFF'],
    ['galaxy', '.galaxy', '#4ade80', '#fb7185', '#0A1628'],
    ['dark', '.dark', '#89D185', '#FF8A8A', '#181818'],
  ] as const)('keeps %s success and error status copy readable on interactive agent headers', (_theme, selector, expectedSuccess, expectedError, expectedSuccessForeground) => {
    const declarations = declarationsFor(selector)
    const successText = declarations.get('--color-success-text')
    const errorText = declarations.get('--color-error-text')
    const successDecoration = declarations.get('--color-success')
    const successForeground = declarations.get('--color-success-foreground')
    const headerSurfaces = [declarations.get('--color-hover'), declarations.get('--color-active')]

    expect(successText).toBe(expectedSuccess)
    expect(errorText).toBe(expectedError)
    expect(successForeground).toBe(expectedSuccessForeground)
    expect(contrastRatio(successForeground!, successDecoration!)).toBeGreaterThanOrEqual(4.5)
    for (const surface of headerSurfaces) {
      expect(surface).toBeDefined()
      expect(contrastRatio(successText!, surface!)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(errorText!, surface!)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('does not use the decorative warning color for known information-bearing copy', () => {
    const informationalTextContracts = [
      ['src/components/layout/TitleBar.tsx', "style={{ color: hasDirty ? 'var(--color-warning)' : 'var(--color-success)' }}"],
      ['src/components/panels/BottomPanel.tsx', "style={{ color: 'var(--color-warning)' }} title={text('暂停将在当前章节完成后生效'"],
      ['src/components/panels/BottomPanel.tsx', "case 'warn':  return 'var(--color-warning)'"],
      ['src/components/ui/Badge.tsx', "text-[var(--color-warning)]"],
      ['src/components/editor/DraftEditor.tsx', "style={{ color: 'var(--color-warning)', backgroundColor: 'var(--color-hover)' }}"],
      ['src/components/editor/ArchFileViewer.tsx', "? 'var(--color-text-secondary)'\n              : 'var(--color-warning)'"],
      ['src/components/editor/ArchFileViewer.tsx', "color: 'var(--color-warning)',\n            backgroundColor: 'var(--color-editor-bg)'"],
      ['src/components/editor/WorldBuildingEditor.tsx', "? 'var(--color-warning)'\n                          : 'var(--color-text-muted)'"],
      ['src/components/editor/WorldBuildingEditor.tsx', "? 'var(--color-warning)'\n                            : 'var(--color-success)'"],
      ['src/styles/agent-tools.css', ".confirm-card-header {\n  display: flex;"],
    ] as const

    for (const [file, forbidden] of informationalTextContracts) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n?/g, '\n')
      if (file.endsWith('agent-tools.css')) {
        const headerBlock = source.match(/\.confirm-card-header \{[\s\S]*?\}/)?.[0] ?? ''
        expect(headerBlock, file).not.toContain('color: var(--color-warning)')
      } else {
        expect(source, file).not.toContain(forbidden)
      }
    }
  })

  it.each([
    ['default light', ':root', '#7A5414', '#C68A3A'],
    ['paper', '.paper', '#7A5414', '#C68A3A'],
    ['explicit light', '.light', '#7A5414', '#C68A3A'],
    ['galaxy', '.galaxy', '#fbbf24', '#fbbf24'],
    ['dark', '.dark', '#CCA700', '#CCA700'],
  ] as const)('keeps %s warning copy readable without changing the decorative warning color', (_theme, selector, expectedText, expectedDecoration) => {
    const declarations = declarationsFor(selector)
    const warningText = declarations.get('--color-warning-text')
    const warningDecoration = declarations.get('--color-warning')
    const raisedSurface = declarations.get('--color-raised')

    expect(warningText).toBe(expectedText)
    expect(warningDecoration).toBe(expectedDecoration)
    expect(raisedSurface).toBeDefined()
    expect(
      contrastRatio(warningText!, raisedSurface!),
      `${selector} --color-warning-text ${warningText} on --color-raised ${raisedSurface}`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['default light', ':root'],
    ['paper', '.paper'],
    ['explicit light', '.light'],
    ['galaxy', '.galaxy'],
    ['dark', '.dark'],
  ] as const)('keeps %s relationship-label text readable on the transparent canvas surface', (_theme, selector) => {
    const declarations = declarationsFor(selector)
    const relationshipLabel = declarations.get('--color-text-secondary')
    const canvasSurface = declarations.get('--color-bg')

    expect(relationshipLabel).toBeDefined()
    expect(canvasSurface).toBeDefined()
    expect(
      contrastRatio(relationshipLabel!, canvasSurface!),
      `${selector} --color-text-secondary ${relationshipLabel} on --color-bg ${canvasSurface}`,
    ).toBeGreaterThanOrEqual(4.5)
  })
})
