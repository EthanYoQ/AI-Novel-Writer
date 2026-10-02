import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'

/**
 * 「导航书脊」与「书的书脊」不许互相串味 —— 真渲染契约（v3）。
 *
 * 两个组件都用了 `.spine` 这个类名：
 *   · `SpineNav.tsx`  → `<nav class="spine v2-spine">`  左侧导航书脊
 *   · `BookShelf.tsx` → `<div class="spine">`           每本书的书脊
 *
 * 杂志层一开始给导航写的规则是**裸 `.spine`**，于是导航的 94px 宽度、纸白底色、
 * `border-right`、以及 `::after { content: 'AI-NOVEL-WRITER' }` 一起套到了
 * 书架的每一本书上 —— 先生看到的「一个个大胖子特别难看」「书脊的字完全看不清」
 * 就是它（书被撑成 94px，书名被刊名顶掉）。修法：导航规则一律带 `.v2-spine`。
 *
 * 这条链路不报错、不抛异常，只是悄悄改样，所以用一个真渲染的固定装置钉住两侧的
 * 最终尺寸：导航书脊必须是 `--mag-w-spine`（94px），书的书脊必须是书的宽度。
 */
const NAV_SPINE_WIDTH = 94
const BOOK_WIDTH = 13

let host: HTMLDivElement
let nav: HTMLElement
let bookSpine: HTMLElement

beforeEach(async () => {
  await page.viewport(1440, 900)

  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  host = document.createElement('div')
  host.innerHTML = `
    <nav class="spine v2-spine" aria-label="main"></nav>
    <div class="v6shelf">
      <div class="shelf">
        <div class="track">
          <div class="book-space" style="width:${BOOK_WIDTH}px">
            <article class="book texture-cloth" style="--height:206px;--width:${BOOK_WIDTH}px;--depth:3px;--cover:#C8564A;--text:#FFF4F1;--foil:#FFD6CC">
              <div class="spine"><span class="title">长夜将明</span></div>
            </article>
          </div>
        </div>
      </div>
    </div>`
  document.body.append(host)

  nav = host.querySelector<HTMLElement>('nav.spine')!
  bookSpine = host.querySelector<HTMLElement>('.v6shelf .spine')!
})

afterEach(() => {
  host.remove()
})

describe('导航书脊与书的书脊（都叫 .spine）', () => {
  it('导航书脊仍是杂志刊脊的宽度', () => {
    const width = parseFloat(getComputedStyle(nav).width)
    expect(Math.round(width)).toBe(NAV_SPINE_WIDTH)
  })

  it('书的书脊跟着书走，不会吃导航的 94px', () => {
    const width = parseFloat(getComputedStyle(bookSpine).width)
    /* 书有 rotateY，量到的是变换后的包围盒 —— 只要它离 94px 有一个数量级的距离，
       就说明导航那条规则没有落上来。 */
    expect(width).toBeLessThan(30)
    expect(width).toBeGreaterThan(5)
  })

  it("书脊的 ::after 不会印上导航的竖排刊名 'AI-NOVEL-WRITER'", () => {
    const content = getComputedStyle(bookSpine, '::after').content
    expect(content).not.toContain('AI-NOVEL-WRITER')
  })

  it('导航书脊的 ::after 仍然是那行竖排刊名', () => {
    const content = getComputedStyle(nav, '::after').content
    expect(content).toContain('AI-NOVEL-WRITER')
  })
})
