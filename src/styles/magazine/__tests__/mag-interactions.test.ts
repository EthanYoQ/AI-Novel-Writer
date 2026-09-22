/**
 * V3 交互层 · 契约测试（node 环境）。
 *
 * 这一层是按「组」接管 v2 悬停语言的地方（v2 有 95 条 :hover 规则）。
 * 三条不能丢的纪律，全部在这里钉住：
 *   ① **分家**：每条规则都必须带 `html[data-ui='v2'][data-mag]` ——
 *      少一个属性，v2 墨纸书斋的悬停就被改了（先生反复强调过三次）。
 *   ② **四件套**：扫入 / 起笔 / 中心溢满 / 下划 —— 观感全靠这四种动作，
 *      不许出现 v2 的那三种（白薄雾底色、translateY 浮动、text-decoration 下划线）。
 *   ③ **不碰布局**：只覆盖观感，不动字号、行高、内距（那些是 v2 与业务代码的契约）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const interactions = readFileSync(
  resolve(process.cwd(), 'src/styles/magazine/mag-interactions.css'),
  'utf8',
)
const v2Shell = readFileSync(
  resolve(process.cwd(), 'src/styles/redesign/shell.css'),
  'utf8',
)
const v2Panels = readFileSync(
  resolve(process.cwd(), 'src/styles/redesign/v2-panels.css'),
  'utf8',
)
const v2Settings = readFileSync(
  resolve(process.cwd(), 'src/styles/redesign/v2-settings.css'),
  'utf8',
)

/** 去掉注释后的规则文本（比对声明时不该把说明文字当代码）。 */
const body = interactions.replace(/\/\*[\s\S]*?\*\//g, '')

describe('交互层 · 分家', () => {
  it('每一条规则都带 [data-mag]（v2 一条都不匹配）', () => {
    const selectors = [...body.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .map((match) => match[2].trim())
      .filter((selector) => selector.length > 0)

    expect(selectors.length).toBeGreaterThan(10)
    const offenders = selectors.filter((selector) => !selector.includes("[data-mag]"))
    expect(offenders).toEqual([])
  })

  it('v2 基座里对应的悬停规则一个字符都没被改动', () => {
    // 这三条是这一层要接管的 v2 语言，它们必须原样留在 v2 里
    expect(v2Shell).toContain('.draft-trash:hover')
    expect(v2Panels).toContain('html[data-ui=\'v2\'] .tool-btn:hover')
    expect(v2Settings).toContain('html[data-ui=\'v2\'] .settings-link:hover')
    expect(v2Settings).toContain('transform: translateY(-2px)')
  })
})

describe('交互层 · 四件套齐全', () => {
  it('扫入：色块从左缘 scaleX(0) → 1', () => {
    expect(body).toMatch(/transform:\s*scaleX\(0\)/)
    expect(body).toMatch(/:hover::after\s*\{\s*transform:\s*scaleX\(1\)/)
  })

  it('中心溢满：方印 scale(0) → 1', () => {
    expect(body).toMatch(/transform:\s*scale\(0\)/)
    expect(body).toMatch(/:hover::before\s*\{\s*transform:\s*scale\(1\)/)
  })

  it('起笔：色标 height 0 → 100%', () => {
    expect(body).toMatch(/:hover::before\s*\{\s*height:\s*100%/)
  })

  it('下划：底线 background-size 0 → 100%', () => {
    expect(body).toContain('background-size: 0 1px')
    expect(body).toContain('background-size: 100% 1px')
  })

  it('每种动作都带缓动与时长（不是「啪」地跳变）', () => {
    const eased = body.match(/cubic-bezier\(0\.16, 0\.84, 0\.24, 1\)/g) ?? []
    // 扫入 / 溢满 / 起笔 / 下划 至少各一处
    expect(eased.length).toBeGreaterThanOrEqual(4)
  })
})

describe('交互层 · 不碰布局，也不许残留 v2 语言', () => {
  it('不写字号、行高、内距 —— 只覆盖观感', () => {
    expect(body).not.toMatch(/font-size:/)
    expect(body).not.toMatch(/line-height:/)
    expect(body).not.toMatch(/padding:/)
    expect(body).not.toMatch(/margin:/)
  })

  it('卡片组显式关掉 v2 的浮动与投影（而不是只换个颜色）', () => {
    expect(body).toMatch(/:hover\s*\{\s*transform:\s*none;\s*box-shadow:\s*none;/)
  })

  it('文字链显式关掉 v2 的下划线', () => {
    expect(body).toMatch(/text-decoration:\s*none/)
  })

  it('禁用态的图标按钮不响应悬停（点不动的东西看起来还能点是最糟的）', () => {
    expect(body).toMatch(/:disabled:hover::before\s*\{\s*transform:\s*scale\(0\)/)
  })
})
