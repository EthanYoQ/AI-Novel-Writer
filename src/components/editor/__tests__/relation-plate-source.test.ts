/**
 * 关系图谱 · v3 覆盖手段契约（node 环境，读得到源文件）。
 *
 * ── 这一页为什么特殊 ────────────────────────────────────────────────────────
 * 先生两次实测都否掉了 CSS 层的修复（「依然没有无感画板」「依然是圆形」）。
 * 在真 Electron 里量出来的覆盖链是：
 *
 * ```
 * ① v2 基线（只挂类名）   画布背景 = rgb(255,255,255)   节点头像圆角 = 50%
 * ② 内联（无 !important）  仍然白                       仍然 50%   ← 压不过
 * ③ 内联 + !important     透明 ✅                       0px ✅     ← 只有这条赢
 * ```
 *
 * 结论：**这一页的修复必须走 `forceImportant`**（`setProperty(..., 'important')`），
 * 因为 ② 里连「内联」都输 —— v2 锁了 `!important`，而样式表的 `!important`
 * 压过内联的普通声明。`forceImportant` 的行为本身由真渲染测试保证
 * （`force-important.browser.tsx`）；这份源码契约只盯「组件有没有真的用它」。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/components/editor/RelationMap.tsx'),
  'utf8',
)

describe('覆盖手段', () => {
  it('用共享的 forceImportant（不是自己再写一份）', () => {
    expect(source).toContain(
      "import { forceImportant } from '../layout/v2/magazine/force-important'",
    )
  })

  it('三处 v3 覆盖都走它：画布背景、节点头像、首字标记、副栏头像', () => {
    const uses = source.match(/forceImportant\(\{/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(4)
  })

  it('每一处都是「v3 才写」的三元分支 —— v2 拿到 undefined', () => {
    const branches = source.match(/magazine \? forceImportant/g) ?? []
    expect(branches.length).toBeGreaterThanOrEqual(3)
    // 唯一的例外是画布：它与自己的 ref 合并写，见下一条
    expect(source).toContain('if (magazine && element)')
  })
})

describe('具体覆盖了什么', () => {
  it('画布背景透明 —— 「无感背景」', () => {
    expect(source).toContain("setProperty('background', 'transparent', 'important')")
  })

  it('节点头像：直角 + 墨线 + 去掉投影', () => {
    expect(source).toContain("'border-radius': '0'")
    expect(source).toContain("border: '2px solid var(--ink)'")
    expect(source).toContain("'box-shadow': 'none'")
  })

  it('首字标记：直角 + 几何黑（v2 用的是 Kaiti SC 楷体，在杂志版式里格格不入）', () => {
    expect(source).toContain("'font-family': 'var(--mag-font-display)'")
  })

  it('副栏头像：直角 + 墨线，并带一枚角标（不是光秃秃一个方框）', () => {
    expect(source).toContain('className="mg-avatar-corner"')
  })
})

describe('判据', () => {
  it('走 isMagazine 判断（不是硬编码 v3）', () => {
    expect(source).toContain('const magazine = isMagazine(uiVersion)')
  })
})
