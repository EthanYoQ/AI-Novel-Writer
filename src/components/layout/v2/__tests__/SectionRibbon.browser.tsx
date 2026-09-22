import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

/**
 * 「四处同步」· 真渲染契约（v3「时尚杂志」）。
 *
 * ShellV2 把当前栏目写成 <html> 上的两个自定义属性：
 *   --mag-active-pos   彩带里的第几格（0–6）
 *   --mag-active-sec   那一栏的颜色
 *
 * 这一份验的是「CSS 那一半真的接上了」：定位标按 pos 落到对应的格子上、
 * 取的是那一栏的颜色、落到工具区（变量被清掉）时自然消失。
 * TS 那一半（ShellV2 什么时候写、什么时候清）由源码契约看着（见同目录的
 * section-sweep-trigger.test.ts）。
 */
let host: HTMLDivElement

const WIDTH = 1400

function ribbon(): CSSStyleDeclaration {
  const bar = document.querySelector('.titlebar') as HTMLElement
  return getComputedStyle(bar, '::after')
}

beforeEach(async () => {
  await page.viewport(1600, 900)
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  host.style.width = `${WIDTH}px`
  host.innerHTML = `
    <header class="titlebar v2-titlebar"></header>
    <div class="tabbar"></div>
  `
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  document.documentElement.style.removeProperty('--mag-active-sec')
  document.documentElement.removeAttribute('data-active-sec')
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

/**
 * 重设当前栏目并**重建**刊头元素。
 *
 * 为什么要重建：伪元素（`::after`）的计算样式**在同一元素上只认首次读取** ——
 * 属性改了、reflow 也做了，`getComputedStyle(el, '::after')` 仍返回旧值
 * （实测：诊断脚本里直接建元素读得到 799.984px，改属性后读却一直是 0）。
 * 这不是实现的问题，是浏览器测试的坑；换个新元素读到的一定是当前值。
 */
function setActive(mark: number | null): void {
  const root = document.documentElement
  if (mark === null) {
    root.style.removeProperty('--mag-active-sec')
    root.removeAttribute('data-active-sec')
  } else {
    root.style.setProperty('--mag-active-sec', `var(--mag-sec-${mark})`)
    root.setAttribute('data-active-sec', String(mark))
  }
  host.innerHTML = '<header class="titlebar v2-titlebar"></header><div class="tabbar"></div>'
  void host.getBoundingClientRect()
}

describe('刊头彩带定位标', () => {
  it('定位标按 --mag-active-pos 落到对应的那一格上', async () => {
    setActive(1)
    const first = parseFloat(ribbon().left)

    setActive(5)
    const fifth = parseFloat(ribbon().left)

    // 第 1 格在最左，第 5 格在第 4 格之后 —— 一格 = 1/7 版面宽
    expect(first).toBeLessThan(2)
    expect(fifth).toBeCloseTo((WIDTH * 4) / 7, 0)
  })

  it('定位标取当前栏目的颜色（伏笔 = 藕紫）', () => {
    setActive(5)
    expect(ribbon().backgroundColor).toBe('rgb(122, 91, 126)')
  })

  it('它比彩带高 2px —— 微微鼓起，是「定位标」不是「又一段彩带」', () => {
    setActive(3)
    const band = getComputedStyle(document.documentElement).getPropertyValue('--mag-band').trim()
    expect(parseFloat(ribbon().height)).toBe(parseFloat(band) + 2)
  })

  it('落到工具区（属性被摘掉）时定位标淡出，而不是停在第 0 格', () => {
    setActive(6)
    expect(parseFloat(ribbon().opacity)).toBe(1)

    setActive(null)
    expect(parseFloat(ribbon().opacity)).toBe(0)
  })
})

describe('四处同步', () => {
  it('编辑区顶带（标签栏上沿）取同一份栏目色', () => {
    setActive(4)
    const shadow = getComputedStyle(document.querySelector('.tabbar') as HTMLElement).boxShadow
    // 松绿 #2E5C4C → rgb(46, 92, 76)
    expect(shadow).toContain('rgb(46, 92, 76)')
    expect(shadow).toContain('inset')
  })

  it('没有当前栏目时顶带也不显影（工具区不该有栏目色）', () => {
    const shadow = getComputedStyle(document.querySelector('.tabbar') as HTMLElement).boxShadow
    expect(shadow).not.toContain('rgb(')
  })
})

describe('分家', () => {
  it('v2 下定位标与顶带都不出现', () => {
    setActive(3)
    document.documentElement.removeAttribute('data-mag')

    expect(ribbon().content).toBe('none')
    const shadow = getComputedStyle(document.querySelector('.tabbar') as HTMLElement).boxShadow
    expect(shadow).toBe('none')
  })})
