/**
 * 「四处同步」· CSS 契约（node 环境）。
 *
 * 先生要的是：**刊头彩带定位标 / 书脊选中块 / 编辑区顶带 / 侧栏选中行**，
 * 在同一时刻指向同一个栏目色。这条链路一半在 TS（ShellV2 把当前栏目写成
 * `--mag-active-sec` / `--mag-active-pos`），一半在 CSS（四处各自去取）。
 * 这里钉住 CSS 那一半 —— 它不会抛错，只会「悄悄不生效」，所以必须测。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shell = readFileSync(
  resolve(process.cwd(), 'src/styles/magazine/mag-shell.css'),
  'utf8',
)
const shellBody = shell.replace(/\/\*[\s\S]*?\*\//g, '')

function magRule(selector: string, source = shellBody): string {
  const pattern = new RegExp(
    `html\\[data-ui='v2'\\]\\[data-mag\\]\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
  )
  return source.match(pattern)?.[1] ?? ''
}

describe('刊头彩带定位标', () => {
  it('七格各有一条落点规则 —— 用属性选择器，不用 calc（calc 实测算不出百分比）', () => {
    const expected = ['0%', '14.2857%', '28.5714%', '42.8571%', '57.1428%', '71.4285%', '85.7142%']
    expected.forEach((left, index) => {
      const rule = magRule(`[data-active-sec='${index + 1}'] .titlebar::after`)
      expect(rule).toContain(`left: ${left}`)
    })
  })

  it('定位标是一格满色块，颜色取当前栏目', () => {
    const ribbon = magRule(String.raw`.titlebar::after`)
    expect(ribbon).toContain('width: 14.2857%')
    expect(ribbon).toContain('var(--mag-active-sec, transparent)')
  })

  it('它比彩带高 2px（微微鼓起），换栏目时是「滑过去」而不是跳过去', () => {
    const ribbon = magRule(String.raw`.titlebar::after`)
    expect(ribbon).toContain('calc(var(--mag-band) + 2px)')
    expect(ribbon).toContain('left 280ms cubic-bezier(0.16, 0.84, 0.24, 1)')
  })

  it('彩带本身压淡，把满色让给定位标', () => {
    expect(magRule(String.raw`.titlebar::before`)).toContain('opacity: 0.5')
  })

  it('没有当前栏目（属性被摘掉）时定位标不显影', () => {
    expect(magRule(String.raw`.titlebar::after`)).toContain('opacity: 0')
    expect(magRule('[data-active-sec] .titlebar::after')).toContain('opacity: 1')
  })
})

describe('四处同步', () => {
  it('侧栏选中行取当前栏目色（不再是固定强调色）', () => {
    const on = magRule(String.raw`.tree-row.on`)
    expect(on).toContain('var(--mag-active-sec, var(--seal))')
  })

  it('编辑区顶带（标签栏上沿）取同一份值，且不动盒模型', () => {
    const tabbar = magRule(String.raw`.tabbar`)
    expect(tabbar).toContain('inset 0 2px 0 var(--mag-active-sec, transparent)')
  })

  it('书脊选中块仍由自己的 nth-child 取色（书脊每一格本就是它那一栏的颜色）', () => {
    expect(shellBody).toContain(".spine .sbtn:nth-child(3) { --mag-sec: var(--mag-sec-3); }")
  })
})
