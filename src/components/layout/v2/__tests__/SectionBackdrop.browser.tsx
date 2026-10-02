import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useMagOpenerStore } from '../../../../stores/mag-opener-store'
import SectionSweep from '../magazine/SectionSweep'

/**
 * 栏目背景 · 真渲染契约（v3「时尚杂志」）。
 *
 * 上一版这里是一整幅 1440ms 的「栏目开篇页」过场 —— 先生判定「太慢，像卡顿」。
 * 现在栏目身份改成**常驻的背景**：编辑区底色 200ms 换色、右下角一枚属性驱动的
 * 巨号编号水印、左缘一条通高色带；切栏目只剩一道 300ms 的扫线。
 *
 * 这个文件验的就是「背景真的长出来了」以及「换栏目真的只换属性」：
 * 底色、色带、水印三处的取值全部来自 `data-sec` / `data-sec-no` 两个属性，
 * 所以换栏目不会重建任何 DOM —— 这是「不卡」的结构原因，值得钉住。
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocaleState = useLocaleStore.getState()

let host: HTMLDivElement
let sweepHost: HTMLDivElement
let editor: HTMLElement
let root: Root

/** 编辑区的那一层：结构照 ShellV2 的原样（属性在 .editor 上）。 */
function mountEditor(attrs: { sec?: string; no?: string }): void {
  editor = document.createElement('section')
  editor.className = 'editor'
  if (attrs.sec) editor.setAttribute('data-sec', attrs.sec)
  if (attrs.no) editor.setAttribute('data-sec-no', attrs.no)
  editor.style.width = '1000px'
  editor.style.height = '700px'
  host.append(editor)
}

function paint(el: HTMLElement, pseudo?: string): CSSStyleDeclaration {
  return getComputedStyle(el, pseudo)
}

beforeEach(async () => {
  await page.viewport(1440, 900)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useMagOpenerStore.setState({ opening: null })

  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  document.body.append(host)
  mountEditor({ sec: '3', no: '03' })
  // 扫线组件要真挂进文档才量得到计算样式
  sweepHost = document.createElement('div')
  document.body.append(sweepHost)
  root = createRoot(sweepHost)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  sweepHost.remove()
  useMagOpenerStore.setState({ opening: null })
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

describe('栏目背景 · 常驻底色', () => {
  it('编辑区底色取当前栏目色（人物 = 赭金），随属性换', () => {
    const charactersBg = paint(editor).backgroundColor

    // 换到「知识库」（07 / 檀褐）：只换属性
    editor.setAttribute('data-sec', '7')
    editor.setAttribute('data-sec-no', '07')
    const libraryBg = paint(editor).backgroundColor

    expect(charactersBg).not.toBe(libraryBg)
    // 底色是纸色混一点点栏目色：既认得出是哪一栏，又不能抢正文
    expect(charactersBg).not.toBe('rgb(251, 251, 252)')
    expect(charactersBg).not.toBe('rgb(168, 132, 47)')
  })

  it('底色过渡是 200ms 一档 —— 常驻背景要即时，不能是慢过场', () => {
    expect(paint(editor).transitionProperty).toContain('background-color')
    expect(parseFloat(paint(editor).transitionDuration)).toBeLessThanOrEqual(0.24)
  })

  it('左缘通高色带：4px、当前栏目色、从上下边缘出血', () => {
    const band = paint(editor, '::before')
    expect(band.width).toBe('4px')
    expect(band.backgroundColor).toBe('rgb(168, 132, 47)')
    expect(band.top).toBe('0px')
    expect(band.bottom).toBe('0px')
  })

  it('右下巨号编号水印取自属性 —— 换栏目不重建任何 DOM', () => {
    const mark = paint(editor, '::after')
    expect(mark.content).toBe('"03"')
    expect(parseFloat(mark.fontSize)).toBeGreaterThanOrEqual(160)
    expect(parseFloat(mark.opacity)).toBeLessThan(0.25)
    expect(mark.pointerEvents).toBe('none')

    // 属性一改，水印立刻跟着改；节点还是同一块版面
    editor.setAttribute('data-sec-no', '07')
    expect(paint(editor, '::after').content).toBe('"07"')
  })

  it('没有 data-sec 时（工具区）背景退回纸色，不挂色带也不挂水印', () => {
    const plain = document.createElement('section')
    plain.className = 'editor'
    plain.style.width = '400px'
    plain.style.height = '200px'
    host.append(plain)

    // 两处伪元素都不该有内容 —— 工具区不是栏目，没有色带也没有编号水印
    expect(paint(plain, '::before').content).toBe('none')
    expect(paint(plain, '::after').content).toBe('none')
  })

  it('内容层透明：彩色是版面，白纸才是内容', () => {
    const body = document.createElement('div')
    body.className = 'edit-body'
    host.append(body)
    expect(paint(body).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })
})

describe('栏目背景 · 分家', () => {
  it('v2 墨纸书斋下：这些规则一条都不匹配', async () => {
    await act(async () => {
      document.documentElement.removeAttribute('data-mag')
    })
    const band = paint(editor, '::before')
    expect(band.backgroundColor).not.toBe('rgb(168, 132, 47)')
    expect(paint(editor, '::after').content).not.toBe('"03"')
  })
})

describe('栏目扫线', () => {
  it('切栏目时扫一道 300ms 的线，颜色取该栏目', async () => {
    act(() => useMagOpenerStore.getState().open('characters'))
    await act(async () => {
      root.render(<SectionSweep />)
    })

    const sweep = document.querySelector('.mag-sweep') as HTMLElement
    expect(sweep).not.toBeNull()
    const style = paint(sweep)
    expect(style.animationName).toBe('mag-sweep')
    expect(parseFloat(style.animationDuration) * 1000).toBe(300)
    expect(style.pointerEvents).toBe('none')
    expect(sweep.getAttribute('aria-hidden')).toBe('true')
    // 扫线的颜色与背景、色带是同一个栏目色（人物 = 赭金）
    expect(sweep.style.getPropertyValue('--mag-sec')).toBe('var(--mag-sec-3)')
  })

  it('没有触发时不渲染任何东西', async () => {
    await act(async () => {
      root.render(<SectionSweep />)
    })
    expect(document.querySelector('.mag-sweep')).toBeNull()
  })
})
