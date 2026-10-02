import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import MagLogo from '../magazine/MagLogo'

/**
 * 刊标「圆角框体里的双页 W」—— **真渲染**契约（v3）。
 *
 * 为什么必须真渲染：先生先抱怨「给我一个圆角框体框起来，才像 logo 啊」，
 * 后抱怨「我要朱砂变色，但是现在不是」。第二句的根因不是配色选错了，而是
 * **SVG 的 presentation attribute 不解析 `var()`** ——
 *
 *     <rect fill="var(--mag-brand-seal, #C8564A)" />   ← 整条失效，回落成黑
 *
 * 源码里明明写着朱砂、`grep` 得到、测试也可能过（若只做文本断言），
 * 画出来却是黑的。所以这里量的是**浏览器算出来的颜色**，不是源码里的字符串。
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SEAL_RGB = 'rgb(200, 86, 74)'
const WHITE_RGB = 'rgb(255, 255, 255)'

let host: HTMLDivElement
let root: Root

async function render(element: React.ReactElement): Promise<HTMLElement> {
  await act(async () => {
    root.render(element)
  })
  return host.firstElementChild as HTMLElement
}

beforeEach(async () => {
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('刊标 · 圆角框体', () => {
  it('框体是圆角方形，不是尖角方块', async () => {
    const svg = await render(<MagLogo size={32} />)
    const frame = svg.querySelector<SVGRectElement>('rect')!
    expect(frame.getAttribute('rx')).toBe('9.5')
    const box = frame.getBoundingClientRect()
    expect(Math.round(box.width)).toBe(30)
    expect(Math.round(box.height)).toBe(30)
  })

  it('框体算出来是**朱砂**，不是黑（var() 必须走 style）', async () => {
    const svg = await render(<MagLogo size={32} />)
    const frame = svg.querySelector<SVGRectElement>('rect')!
    expect(getComputedStyle(frame).fill).toBe(SEAL_RGB)
  })

  it('框内两笔是白色：后页灰白细、前页纯白粗', async () => {
    const svg = await render(<MagLogo size={32} />)
    const paths = svg.querySelectorAll<SVGPathElement>('path')
    expect(paths.length).toBe(2)
    expect(getComputedStyle(paths[0]).stroke).toBe(WHITE_RGB)
    expect(getComputedStyle(paths[1]).stroke).toBe(WHITE_RGB)
    expect(Number(paths[0].getAttribute('stroke-opacity'))).toBeLessThan(1)
    expect(Number(paths[0].getAttribute('stroke-width'))).toBeLessThan(
      Number(paths[1].getAttribute('stroke-width')),
    )
  })

  it('尺寸跟着 size 走，16px 那档也不糊（框体仍在）', async () => {
    const svg = await render(<MagLogo size={16} />)
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    const frame = svg.querySelector<SVGRectElement>('rect')!
    expect(Math.round(frame.getBoundingClientRect().width)).toBe(15)
    expect(getComputedStyle(frame).fill).toBe(SEAL_RGB)
  })

  it('品牌色不跟栏目换色：把 --mag-sec 换成别的颜色，框体仍是朱砂', async () => {
    document.documentElement.style.setProperty('--mag-sec', '#3F6E8C')
    const svg = await render(<MagLogo size={32} />)
    const frame = svg.querySelector<SVGRectElement>('rect')!
    expect(getComputedStyle(frame).fill).toBe(SEAL_RGB)
    document.documentElement.style.removeProperty('--mag-sec')
  })
})
