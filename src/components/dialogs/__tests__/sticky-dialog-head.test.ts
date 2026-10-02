/**
 * 便利贴子菜单标头契约。
 *
 * 先生（2026-09-20）：「我发现最近制作的 AI 灵感、灵感选取、待选箱等几个子菜单，
 * 都没遵循我们一贯的子菜单标头格式！这不对，需要统一下。」
 *
 * 那条格式写在 NewProjectDialog 的注释里，也是这个项目一贯的做法：
 *   **朱砂小字眉标 → 衬线标题 → 次要色说明**，由 `PageHead` 呈现；
 *   `DialogTitle` 退回 `sr-only`，只为保住无障碍名称，不再充当视觉标题。
 *
 * 用源码断言把它焊死 —— 以后新加弹窗若又走回老写法，这里会当场红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 便利贴这一族浮层：抽卡（含「灵感选取」那一屏）与待选箱。 */
const STICKY_DIALOGS = [
  'src/components/dialogs/InspirationDrawDialog.tsx',
  'src/components/dialogs/StickyTrayDialog.tsx',
] as const

describe('便利贴子菜单标头契约', () => {
  it.each(STICKY_DIALOGS)('%s 的标头走 PageHead', (file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).toContain("import PageHead from '../ui/PageHead'")
    expect(source).toContain('<PageHead')
  })

  it.each(STICKY_DIALOGS)('%s 的 DialogHeader 带 app-dialog-head', (file) => {
    // 浮层版头靠这个类分家（v3 的紧凑铭牌就挂在它上面）。
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('<DialogHeader className="app-dialog-head">')
  })

  it.each(STICKY_DIALOGS)('%s 的 DialogTitle 只当无障碍名称', (file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('<DialogTitle className="sr-only">')
  })

  it.each(STICKY_DIALOGS)('%s 的眉标是中英混排的「KEY · 中文」', (file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).toMatch(/kicker=\{[^}]*·/)
  })
})
