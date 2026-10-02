/**
 * 肖像框 · 样式契约（node 环境，读得到源 CSS）。
 *
 * 浏览器里的真渲染测试验的是「结构对不对、功能全不全」；这里验的是
 * **CSS 里那几条不能丢的行为**（它们不像 DOM 那样有元素可查）：
 *   · 换头像入口必须是「悬停才显影」—— 平时压着头像会挡视线，一直在又太吵
 *   · 悬停的覆盖层只取当前栏目色，不引入第五种颜色
 *   · 这套记号只在 v3 生效（每条规则都带 [data-mag]）
 *   · v2 的圆头像规则一个字符都没被改动（先生：不许动 V2）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const plateCss = readFileSync(
  resolve(process.cwd(), 'src/styles/magazine/mag-plate.css'),
  'utf8',
)
const v2ShellCss = readFileSync(
  resolve(process.cwd(), 'src/styles/redesign/shell.css'),
  'utf8',
)

/**
 * 取出 mag 层某条规则的声明体。
 *
 * mag 层规则一律以 `html[data-ui='v2'][data-mag]` 开头，而且**常常是多选择器**
 * （悬停与键盘聚焦共用一档是常见写法），所以这里允许选择器后面接一个逗号再接别的
 * 选择器，最后才到 `{`。
 */
function magRule(selector: string): string {
  const pattern = new RegExp(
    `html\\[data-ui='v2'\\]\\[data-mag\\]\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
  )
  return plateCss.match(pattern)?.[1] ?? ''
}

/** 白色不算「写死的颜色」—— 反白在杂志版式里是既定的墨阶之一。 */
function withoutWhite(declarations: string): string {
  return declarations.replace(/#FFFFFF/gi, '')
}

describe('肖像框 · 入口的显隐', () => {
  it('入口平时透明，悬停或键盘聚焦时显影', () => {
    expect(magRule('.mag-plate .mp-portrait-hit')).toContain('opacity: 0')
    expect(magRule('.mag-plate .mp-portrait:hover .mp-portrait-hit')).toContain('opacity: 1')
    // 键盘用户也要看得见（focus-visible 与 hover 同一档）
    expect(magRule('.mag-plate .mp-portrait-hit:focus-visible')).toContain('opacity: 1')
  })

  it('覆盖层取当前栏目色，不写死颜色（纯白反白除外）', () => {
    const hit = magRule('.mag-plate .mp-portrait-hit')
    expect(hit).toContain('var(--mag-sec)')
    expect(withoutWhite(hit)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/)
  })

  it('角标悬停时让位给覆盖层（不叠在按钮上抢视线）', () => {
    expect(magRule('.mag-plate .mp-portrait:hover .mp-portrait-corner')).toContain('opacity: 0')
  })
})

describe('肖像框 · 杂志版式', () => {
  it('印刷品是方的：直角 + 2px 墨线外框', () => {
    const portrait = magRule('.mag-plate .mp-portrait')
    expect(portrait).toContain('border: 2px solid var(--ink)')
    expect(portrait).not.toMatch(/border-radius:\s*(?!0)/)
  })

  it('尺寸比 v2 的 75px 圆头像大一档（96px）', () => {
    expect(magRule('.mag-plate .mp-portrait')).toContain('width: 96px')
  })
})

describe('肖像框 · 不碰 V2', () => {
  it('mag 层的每一条肖像规则都带 [data-mag]（v2 下一条都不匹配）', () => {
    for (const selector of [
      '.mag-plate .mp-portrait',
      '.mag-plate .mp-portrait-hit',
      '.mag-plate .mp-portrait-corner',
    ]) {
      expect(magRule(selector)).not.toBe('')
    }
  })

  it('v2 的圆头像与它的选择器原样保留（75px / 圆形 / avatar-picker-hit）', () => {
    expect(v2ShellCss).toContain('.character-avatar-wrap{position:relative;flex:none;width:75px;height:75px}')
    expect(v2ShellCss).toContain('.avatar-picker-hit{')
    expect(v2ShellCss).toContain('.character-avatar-wrap:hover .avatar-picker-hit')
  })
})
