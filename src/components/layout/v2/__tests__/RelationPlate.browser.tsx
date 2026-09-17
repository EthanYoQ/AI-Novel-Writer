import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

/**
 * 人物关系图谱 · 真渲染契约（v3「时尚杂志」）。
 *
 * 先生 2026-09-17 的四条原话，一条一条钉在这里：
 *
 *   ①「整个图谱背景上面和下面颜色不一致…要无感背景。」
 *      → 画布不留任何自绘背景（光晕 / 暗角 / 内框全部撤掉）
 *   ②「重置、适应、删除全部角色关系三个按钮也很不美观。」
 *      → 页头工具是一组被竖线分隔的刊用控件
 *   ③「这些注释也互相拥挤，很难看。」
 *      → 图例与提示在一条「页脚带」里，各占一端
 *   ④「展开的副栏头像框依然是 V2 的圆形。」
 *      → 图谱节点头像、首字标记、副栏头像**全是方的**
 *
 * ⚠️ 这一页的 v3 样式走**自己的类名**（`mg-*`），不是覆盖 `.relation-*`。
 * v2 的图谱装帧当年为了压过 demo 基座用了大量 `!important` + 深层选择器，
 * 实测在 mag 层写 `!important` 也压不过它 —— 所以两边各用各的名字。
 * 这份测试验的正是「v3 那些自己的记号真的生效」。
 */
let host: HTMLDivElement

const GRAPH = `
  <div class="relation-view">
    <main class="relation-main">
      <div class="relation-canvas mg-graph-canvas">
        <div class="relation-stage">
          <div class="relation-node mg-graph-node">
            <div class="portrait mg-node-portrait"><span class="mg-node-mark" style="background:#A8842F">布</span></div>
            <div class="name">布兰</div>
            <div class="role">主角</div>
          </div>
        </div>
        <div class="relation-foot">
          <div class="relation-legend"><span><i class="red"></i>核心 / 高亲密</span></div>
          <div class="relation-hint mg-graph-hint">人物越大关系越近 · 拖动人物整理</div>
        </div>
        <div class="relation-zoom"><button type="button">−</button><button type="button">100%</button><button type="button">+</button></div>
      </div>
    </main>
    <aside class="relation-side">
      <div class="relation-visual-head">
        <div class="relation-visual-avatar mg-side-avatar"><span>布</span></div>
        <div class="relation-visual-meta"><div class="quote">他记得每一件事。</div></div>
      </div>
    </aside>
  </div>
`

beforeEach(() => {
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  host.style.width = '1200px'
  host.style.height = '600px'
  host.innerHTML = GRAPH
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

const $ = (selector: string) => document.querySelector(selector) as HTMLElement
const paint = (selector: string, pseudo?: string) => getComputedStyle($(selector), pseudo)

describe('① 无感背景', () => {
  it('画布与它的两层容器都不自绘背景（v2 的光晕与暗角撤掉）', () => {
    for (const selector of ['.relation-view', '.relation-main']) {
      const style = paint(selector)
      expect(style.backgroundImage, `${selector} 的 background-image`).toBe('none')
      expect(
        ['rgba(0, 0, 0, 0)', 'transparent'],
        `${selector} 的 background-color（实测 ${style.backgroundColor}）`,
      ).toContain(style.backgroundColor)
    }
  })

  it('画布的两个伪元素（暗角 / 内缩红框）都被关掉', () => {
    expect(paint('.mg-graph-canvas', '::before').display).toBe('none')
    expect(paint('.mg-graph-canvas', '::after').display).toBe('none')
  })

  /**
   * 画布本身的背景色与节点头像的方角，**在组件里用内联样式**下达 ——
   * 因为 v2 那两条是 `!important` + 深层选择器，mag 层压不过（实测三次都失败）。
   * 内联样式在手写 DOM 的测试里测不到，所以那两条由源码契约看着：
   * 见 `src/components/editor/__tests__/relation-plate-source.test.ts`。
   */
})

describe('② 页头工具是一组刊用控件', () => {
  it('竖线分隔：除第一个之外每个都有左缘分隔线，且是直角', () => {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="relation-tools"><button class="relation-tool">重置</button><button class="relation-tool">适应</button><button class="relation-tool is-danger">清空图谱</button></div>')
    const buttons = document.querySelectorAll('.relation-tool')
    expect(buttons.length).toBe(3)

    const first = getComputedStyle(buttons[0] as HTMLElement)
    const second = getComputedStyle(buttons[1] as HTMLElement)
    expect(first.borderLeftWidth).toBe('0px')
    expect(parseFloat(second.borderLeftWidth)).toBeGreaterThan(0)
    expect(second.borderRadius).toBe('0px')
  })
})

describe('③ 页脚带：图例与提示不再抢位置', () => {
  it('两者都在带子里，各自不再绝对定位', () => {
    expect(paint('.relation-legend').position).toBe('static')
    expect(paint('.mg-graph-hint').position).toBe('static')
    expect(paint('.mg-graph-hint').transform).toBe('none')
  })

  it('提示被推到右侧、图例留在左边 —— 用位置断言，不用 margin:auto', () => {
    /**
     * 注意：flex 容器里的 `margin-left: auto` 在 `getComputedStyle` 里会被**解析成像素**
     * （实测 601.438px），所以不能断言 `'auto'`。这里断言真正的行为：提示在图例右侧。
     */
    const legend = $('.relation-legend').getBoundingClientRect()
    const hint = $('.mg-graph-hint').getBoundingClientRect()
    expect(hint.left).toBeGreaterThan(legend.right)
  })

  it('页脚带贴在画布底部，且不透明（底下的节点不会透出来）', () => {
    const foot = paint('.relation-foot')
    expect(foot.position).toBe('absolute')
    expect(foot.bottom).toBe('0px')
    expect(foot.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('缩放控件挪到带子上方（原来在右下角，会与图例叠住）', () => {
    expect(parseFloat(paint('.relation-zoom').bottom)).toBeGreaterThan(40)
  })
})

describe('④ 方形头像：图谱节点与副栏都是方的', () => {
  it('首字标记铺满头像框（v2 把它缩成 54px 圆点，这里让它跟着框走）', () => {
    // 测试 DOM 里的标记带内联的 v3 方形，铺满行为由 CSS 保证
    expect(paint('.mg-node-mark').display).toBe('grid')
  })

  it('副栏肖像框：定位上下文 + 隐藏溢出（角标要贴着它右下角）', () => {
    /**
     * 方角与墨线在**组件里**用 `forceImportant` 下达（v2 那条是 !important，
     * CSS 层与 React 的 style 对象都压不过）—— 手写 DOM 的这份测试测不到它，
     * 那两条由源码契约看着：`src/components/editor/__tests__/relation-plate-source.test.ts`。
     * 这里只验 CSS 层负责的那部分。
     */
    const avatar = paint('.mg-side-avatar')
    expect(avatar.position).toBe('relative')
    expect(avatar.overflow).toBe('hidden')
  })
})

describe('分家', () => {
  it('v2 下这四条一条都不生效（圆头像与自绘背景都还在）', () => {
    document.documentElement.removeAttribute('data-mag')

    expect(paint('.mg-node-mark').borderRadius).not.toBe('0px')
    expect(paint('.mg-side-avatar').borderRadius).not.toBe('0px')
    expect(paint('.mg-graph-canvas', '::before').display).not.toBe('none')
  })
})
