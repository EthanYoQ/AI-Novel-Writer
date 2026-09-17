import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 顶栏「帮助」下拉的契约。
 *
 * 它和「文件」是同一套交互：橙色按钮 → 下拉两项（新手教程 / 常见错误）。
 * 教程按钮必须排在「助手」之前（先生指定的位置），而且两项都要真的接上
 * 对应的开关 —— 只画一个菜单但点了没反应是最容易犯的错。
 */
const source = readFileSync('src/components/layout/v2/TitleBarV2.tsx', 'utf8')

describe('title bar help menu', () => {
  it('offers both the quick start guide and the common-issues panel', () => {
    expect(source).toContain("text('帮助', 'Help')")
    expect(source).toContain("text('新手教程', 'Quick start guide')")
    expect(source).toContain("text('常见错误', 'Common issues')")
    expect(source).toContain('useOnboardingStore.getState().openGuide()')
    expect(source).toContain('useHelpStore.getState().openHelp()')
  })

  it('keeps the help button immediately before the assistant button', () => {
    const helpIndex = source.indexOf('data-tour="help-menu"')
    const assistantIndex = source.indexOf("text('助手', 'Assistant')")
    expect(helpIndex).toBeGreaterThan(-1)
    expect(assistantIndex).toBeGreaterThan(-1)
    expect(helpIndex).toBeLessThan(assistantIndex)
  })

  it('closes the dropdown on an outside click and on Escape', () => {
    expect(source).toContain('setHelpMenuOpen(false)')
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain('helpMenuRef')
  })

  /**
   * 先生要求：不要固定的橙色，改成「红底白字、且随主题变化」。
   * 所以底色必须取自主题的强调色 --seal（四套主题各有取值），而不是 --warn。
   */
  it('paints the button with the theme accent instead of a fixed colour', () => {
    const css = readFileSync('src/styles/redesign/shell.css', 'utf8')
    const baseRule = css.match(/\.tb-btn\.tb-quickstart\{[^}]*\}/)?.[0] ?? ''

    expect(baseRule).toContain('background:var(--seal')
    expect(baseRule).toContain('color:#fff')
    expect(baseRule).not.toContain('var(--warn)')
  })
})
