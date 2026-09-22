import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

/**
 * 侧栏两类条目 —— 真渲染契约（v3）。
 *
 * 它们的类名都踩过坑：`ProjectTree.tsx` 渲染的是 **`.tree-item`**（不是 demo 的 `.tree-row`），
 * 设定集分类条目是 **`.ws-category-item`**（内置那几条原先连语义类名都没有）。
 *
 * 交互语言前后被先生定过两次，第十五轮的这句是最终版：
 *   「我要的是交互，按钮颜色和角色列表一致。平时是白色，只有悬停、点击的时候
 *     会变成绿色。但现在完全不对。」
 *
 * 实测（`_probe-v3-r15.mjs`）查出的两处「不对」，都是**匹配**问题，不是配色问题：
 *   · 未选中的条目 className 里带着 `hover:bg-[var(--color-hover)]`，
 *     而选中规则写的是 `[class*='bg-[']`（**子串**匹配）——
 *     于是整排未选中条目被染成实心的当前栏目色，「平时白」从未成立；
 *   · 选中态写在 TSX 的内联样式上，内联压过样式表，v3 给不出自己的颜色。
 * 现在：静息白 / 悬停扫入 / 按下与选中才整行实心；选中态是**语义类**
 * `ws-category-item-on`（v2 那边仍走它自己的 Tailwind 类，一字未动）。
 *
 * 目录条目（`.tree-item`）保持它自己那套 28% 扫入 + **左缘色标** ——
 * 先生先前为它单独定过「宁可明显，不要看不见」，谁也别去「统一」掉谁。
 */
const cases = [
  { cls: 'tree-item', label: '目录条目', mark: true },
  { cls: 'ws-category-item', label: '设定分类条目', mark: false },
] as const

/** 设定栏的栏目色（`--mag-sec-4` 松绿）—— 也就是先生说的那抹「绿色」。 */
const SEC_GREEN = '#2e5c4c'

let host: HTMLDivElement

beforeEach(async () => {
  await page.viewport(1440, 900)
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')
  // ShellV2 在设定集栏目下把这两个令牌写在 <html> 上；夹具照它写
  document.documentElement.style.setProperty('--mag-sec', SEC_GREEN)
  document.documentElement.style.setProperty('--mag-active-sec', SEC_GREEN)

  host = document.createElement('div')
  /**
   * 夹具照**真实组件的 JSX**搭（本项目血泪教训：夹具与真实结构不符 = 测试全绿而界面没用）：
   *   ShellV2: .app-skin-root > .app.v2-app > .main > .body3 > .sidebar-host
   *   侧栏面板: .flex-1.overflow-y-auto > 条目（这一层还决定圆角，见 v2-sidebar.css）
   */
  host.className = 'app-skin-root'
  host.innerHTML = `
    <div class="app v2-app"><div class="main"><div class="body3"><div class="sidebar-host">
      <div class="flex-1 overflow-y-auto p-1">
        <div class="ws-category-item group flex items-center justify-between gap-2 px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5 hover:bg-[var(--color-hover)]" data-id="cat-idle">
          <span class="text-sm font-semibold truncate text-[var(--color-text)]">世界观</span>
          <span class="flex items-center gap-1.5 flex-shrink-0"><span class="text-[0.68rem] tabular-nums" style="color:var(--color-text-muted)">4</span></span>
        </div>
        <div class="ws-category-item group flex items-center justify-between gap-2 px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5 ws-category-item-on" data-id="cat-on">
          <span class="text-sm font-semibold truncate text-[var(--color-text)]">势力</span>
          <span class="flex items-center gap-1.5 flex-shrink-0"><span class="text-[0.68rem] tabular-nums" style="color:var(--color-accent)">7</span></span>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-1">
        <div class="character-zone">
          <div class="char-row px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]" data-id="char-idle">
            <div class="flex items-baseline gap-1.5 min-w-0"><span class="text-sm font-semibold text-[var(--color-text)] truncate">林砚</span></div>
          </div>
          <div class="char-row char-row-on bg-[var(--color-active)] text-[var(--color-text)] px-2.5 py-1 rounded-md text-xs cursor-pointer mb-0.5" data-id="char-on">
            <div class="flex items-baseline gap-1.5 min-w-0"><span class="text-sm font-semibold text-[var(--color-text)] truncate">沈砚之</span></div>
          </div>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-1">
        <div class="tree-item" data-id="tree-idle" style="display:flex;align-items:center">第一章</div>
      </div>
    </div></div></div></div>`
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  document.documentElement.style.removeProperty('--mag-sec')
  document.documentElement.style.removeProperty('--mag-active-sec')
})

function el(id: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-id="${id}"]`)!
}

/** 扫入层的横向缩放：`none` / `matrix(a, …)` 里的 a 就是 scaleX。 */
function sweepScale(node: HTMLElement): number {
  const transform = getComputedStyle(node, '::after').transform
  if (transform === 'none') return 1
  const match = transform.match(/matrix\(([-\d.]+)/)
  return match ? Number(match[1]) : Number.NaN
}

/** 左缘色标的宽度（0 = 收着，4px = 指针在这儿）。 */
function markWidth(node: HTMLElement): number {
  return parseFloat(getComputedStyle(node, '::before').width) || 0
}

function bg(node: HTMLElement): string {
  return getComputedStyle(node).backgroundColor
}

/** 解析 getComputedStyle 颜色（兼容 rgb()/rgba()/color(srgb …)），返回 [r,g,b]。 */
function parseColor(value: string): [number, number, number] {
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (srgb) return [Math.round(Number(srgb[1]) * 255), Math.round(Number(srgb[2]) * 255), Math.round(Number(srgb[3]) * 255)]
  const rgb = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  throw new Error(`无法解析颜色: ${value}`)
}

describe.each(cases)('$label', ({ cls, mark }) => {
  it('扫入块都在（与角色列表同一套悬停语言）', () => {
    const node = cls === 'tree-item' ? el('tree-idle') : el('cat-idle')
    expect(getComputedStyle(node, '::after').content).toBe('""')
    expect(sweepScale(node)).toBeLessThan(0.05)
  })

  it('静息时没有底色（纸面就是白）', () => {
    const node = cls === 'tree-item' ? el('tree-idle') : el('cat-idle')
    const color = bg(node)
    expect(color === 'rgba(0, 0, 0, 0)' || color === 'transparent').toBe(true)
  })

  it('左缘色标的有无与先生定的规矩一致 —— 只有目录条目有', () => {
    const node = cls === 'tree-item' ? el('tree-idle') : el('cat-idle')
    if (mark) {
      // 目录条目：色标元素在（静息收着，悬停才长出来）
      expect(getComputedStyle(node, '::before').content).toBe('""')
    }
    // 静息一律收着；设定分类条目**根本没有**色标（角色列表就没有）
    expect(markWidth(node)).toBe(0)
  })

  it('鼠标扫过时：扫入块铺满', async () => {
    const node = cls === 'tree-item' ? el('tree-idle') : el('cat-idle')
    await page.elementLocator(node).hover()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sweepScale(node)).toBeGreaterThan(0.95)
  })

  it('圆角与角色列表**一模一样**（v3 的发丝直角，不是基座那圈 7px）', () => {
    const node = cls === 'tree-item' ? el('tree-idle') : el('cat-idle')
    const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius)
    expect(radius).toBe(2)
  })
})

describe('设定分类条目的按下态（先生第十五轮的口径）', () => {
  it('选中 = 整行实心，色取**当前栏目色**（设定栏就是那抹绿）', () => {
    expect(bg(el('cat-on'))).toBe('rgb(46, 92, 76)')
  })

  it('选中时文字与计数都反白（实心底上读得出）', () => {
    const node = el('cat-on')
    const name = node.querySelector<HTMLElement>('span span, span')!
    expect(getComputedStyle(name).color).toBe('rgb(255, 255, 255)')
    const count = node.querySelector<HTMLElement>('[style*="--color-accent"]')!
    // 计数反白不是纯白：CSS 里是 color-mix(86% 白 + 14% 松绿)，且新版 Chromium
    // 以 color(srgb …) 返回 —— 断言「接近白」而非精确 rgb()。
    const countRgb = parseColor(getComputedStyle(count).color)
    expect(countRgb[0]).toBeGreaterThan(200)
    expect(countRgb[1]).toBeGreaterThan(200)
    expect(countRgb[2]).toBeGreaterThan(200)
  })

  it('选中时**不**长左缘色标（角色列表就没有，两处要一致）', () => {
    expect(markWidth(el('cat-on'))).toBe(0)
  })

  it('未选中的条目**不许**被选中规则误伤（曾经的 [class*=bg-[] 子串匹配）', () => {
    // 未选中项的 className 里带着 hover:bg-[…] —— 它必须还是白的
    expect(bg(el('cat-idle'))).toBe('rgba(0, 0, 0, 0)')
    expect(el('cat-idle').className).toContain('hover:bg-[')
  })
})

describe('角色列表（标杆，未被本轮改动波及）', () => {
  it('选中仍是品牌朱砂，不是栏目色', () => {
    expect(bg(el('char-on'))).toBe('rgb(200, 86, 74)')
  })

  it('圆角与设定分类同一条发丝直角（两处必须一模一样）', () => {
    const rowRadius = parseFloat(getComputedStyle(el('char-idle')).borderTopLeftRadius)
    const catRadius = parseFloat(getComputedStyle(el('cat-idle')).borderTopLeftRadius)
    expect(rowRadius).toBe(2)
    expect(catRadius).toBe(rowRadius)
  })

  it('悬停仍是它自己那套扫入', async () => {
    await page.elementLocator(el('char-idle')).hover()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sweepScale(el('char-idle'))).toBeGreaterThan(0.95)
    expect(bg(el('char-idle'))).toBe('rgba(0, 0, 0, 0)')
  })
})
