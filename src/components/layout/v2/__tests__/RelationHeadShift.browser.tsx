import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

/**
 * 关系图谱页头：**撑满主列**，操作组贴住右侧简介栏 —— 真渲染契约（v3）。
 *
 * 这一处先生来回两轮：
 *   ① 「人物 / 7 / 重置 / 适应 / 清空图谱，这些全部往右边移动 40px」
 *   ② 「这几个依然没变化，现在我右边非常非常非常的空」
 *
 * 症结不是「移多少」，而是**页头没铺满**：全站页头带着 1080px 版心（mag-type.css），
 * 而关系视图的主列在宽窗口下有 1190px 上下 —— 页头比主列窄一百多像素、又靠左站，
 * 操作组虽然贴着页头右缘，离右侧那 318px 的简介栏却还差几百像素。再挪 40px 当然看不出来。
 * 关系图谱是**一整幅画布**，不该走版心 —— 现在让它撑满 head 那一格。
 *
 * ⚠ 教训（写在这里给后来人）：上一版这个文件用的是**手写的简化结构**，
 *   而真实链路是 `.relation-view > .pagehead-strip > MagPlate(.mag-plate) >
 *   .mp-aside > .mp-actions > .relation-tools` —— 操作组的位置由 .mag-plate 内部决定。
 *   夹具与真实不符，测试全绿、界面没用。所以下面**按 MagPlate.tsx 的真实结构搭**。
 */
const SIDE_WIDTH = 318
/** v3 页头的左右内距（mag-type.css 的 .pagehead-strip padding） */
const STRIP_PAD = 36
/** v2 页头在关系视图里的内距（v2-relation.css） */
const V2_STRIP_PAD = 15

let host: HTMLDivElement

/** 按 RelationMap.tsx + MagPlate.tsx 的真实结构搭出一个关系视图。 */
function mountView(width: number): HTMLElement {
  const view = document.createElement('div')
  view.className = 'relation-view'
  view.style.cssText =
    `width:${width}px;display:grid;grid-template-columns:minmax(0,1fr) ${SIDE_WIDTH}px;` +
    "grid-template-rows:auto minmax(0,1fr);grid-template-areas:'head side' 'main side'"
  view.innerHTML = `
    <div class="pagehead-strip">
      <div class="mag-plate">
        <span class="mp-spine">CAST</span>
        <div class="mp-main">
          <div class="mp-row">
            <span class="mp-sigil"><svg width="26" height="20" viewBox="0 0 26 20"><circle cx="6" cy="10" r="3"/><circle cx="20" cy="5" r="3"/><circle cx="20" cy="15" r="3"/></svg></span>
            <div class="mp-titles"><div class="mp-kicker">CAST · 人物关系图谱</div><h1 class="mp-name">人物关系图谱</h1></div>
          </div>
        </div>
        <div class="mp-aside">
          <div class="mp-chapter"><span class="mp-chapter-label">人物</span><span class="mp-chapter-no">7</span></div>
          <div class="mp-actions">
            <div class="relation-tools">
              <button class="relation-tool">重置</button>
              <button class="relation-tool">适应</button>
              <button class="relation-tool is-danger">清空图谱</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <main class="relation-main" style="height:120px"></main>
    <aside class="relation-side" style="height:120px"></aside>`
  host.append(view)
  return view
}

function geometry(view: HTMLElement) {
  const base = view.getBoundingClientRect().left
  const rect = (selector: string) => {
    const el = view.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(`没找到 ${selector}`)
    const box = el.getBoundingClientRect()
    return { left: Math.round(box.left - base), right: Math.round(box.right - base) }
  }
  return {
    strip: rect(':scope > .pagehead-strip'),
    tools: rect('.relation-tools'),
    side: rect(':scope > .relation-side'),
  }
}

beforeEach(async () => {
  await page.viewport(1700, 900)
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  host.remove()
})

describe('关系图谱页头的版心', () => {
  it('v3 宽窗口：页头撑满主列，不再缩在 1080px 里', () => {
    const view = mountView(1508)
    const g = geometry(view)
    expect(g.strip.left).toBe(0)
    /* 主列 = 视图宽 - 简介栏 */
    expect(g.strip.right).toBe(1508 - SIDE_WIDTH)
  })

  it('v3 窄窗口：同样撑满，不溢出', () => {
    const view = mountView(1240)
    const g = geometry(view)
    expect(g.strip.left).toBe(0)
    expect(g.strip.right).toBe(1240 - SIDE_WIDTH)
  })

  it('v3：操作组贴到页头右缘（只剩页头自己的内距），且不越过简介栏', () => {
    const view = mountView(1508)
    const g = geometry(view)
    expect(g.side.left - g.tools.right).toBe(STRIP_PAD)
    expect(g.tools.right).toBeLessThanOrEqual(g.side.left)
  })

  it('v2：页头与操作组仍是老样子（v3 这把尺子不许量到 v2 头上）', () => {
    const view = mountView(1508)
    document.documentElement.removeAttribute('data-mag')
    const g = geometry(view)
    expect(g.strip.left).toBe(0)
    expect(g.side.left - g.tools.right).toBe(V2_STRIP_PAD)
    document.documentElement.setAttribute('data-mag', '1')
  })
})
