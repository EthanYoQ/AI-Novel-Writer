/**
 * 书架书脊的书名字号 —— 先生：「新书在书架上，书脊显示的字体都特别小，
 * 特别是我的书名很短，结果字体反而很小看不清。」
 *
 * 实测确认的根因（两条叠加）：
 *
 *   ① 字号被绑死在**书脊厚度**上：`shell.css` 的
 *        .v6shelf .title { font-size: min(13px, calc(var(--width) - 3px)) }
 *      而书脊厚度由 `spineDimensions()` 按**总字数**换算：
 *        总字数 = 章数 × 每章字数 → 页数 → 毫米 → 像素，下限 10px。
 *      新书章数少 → 书脊只有 10px → 字号被压到 min(13, 7) = **7px**，自然看不清。
 *      对照：约 13 万字以上的书书脊才够宽（≥16px），字号才吃得到 13px 上限。
 *
 *   ② `.title` 的内边距是固定的 `left:12px; right:12px`，而书脊常窄于 24px ——
 *      容器宽度被算成 0，`justify-content:center` 于是把竖排文字往右推半个字号。
 *
 * 本文件守住修复结果：任何体量的书，书脊上的书名都必须有可读字号，且水平居中。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import BookShelf from '../BookShelf'
import type { ShelfBook } from '../bookShelfSpine'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { useLocaleStore } from '../../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 书名字号的可读下限 —— 先生定的 12px（书脊这种竖排场景低于它就很难辨认）。 */
const MIN_READABLE_FONT_PX = 12

/** 按「章数 × 每章字数」估算总字数：spineDimensions 默认每章 2500 字。 */
function book(title: string, chapters: number | undefined): ShelfBook {
  return { id: title, title, chapters }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  document.documentElement.dataset.ui = 'v2'
  document.documentElement.dataset.v2Theme = '0'
  container = document.createElement('div')
  container.className = 'app-skin-root light'
  container.style.height = '700px'
  container.style.width = '900px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete document.documentElement.dataset.ui
  delete document.documentElement.dataset.v2Theme
})

async function renderShelf(books: ShelfBook[]): Promise<void> {
  await act(async () => {
    root.render(<BookShelf books={books} />)
  })
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

interface SpineSample {
  title: string
  /** CSS 里真正的书脊宽度（--width）—— getBoundingClientRect 会带上 3D 旋转，不能直接用 */
  cssWidth: number
  fontSize: number
  /** 竖排文字相对书脊中心的水平偏移（正数=偏右） */
  horizontalOffset: number
}

function sampleSpines(): SpineSample[] {
  const books = Array.from(container.querySelectorAll<HTMLElement>('.v6shelf .book'))
  return books.map((book) => {
    const title = book.querySelector<HTMLElement>('.title')!
    const spine = book.querySelector<HTMLElement>('.spine')!
    const spineRect = spine.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    return {
      title: title.textContent ?? '',
      cssWidth: Math.round(parseFloat(getComputedStyle(book).getPropertyValue('--width')) * 10) / 10,
      fontSize: Math.round(parseFloat(getComputedStyle(title).fontSize) * 10) / 10,
      // 两个 rect 处在同一变换上下文里，彼此的中心差是可信的
      horizontalOffset: Math.round(((titleRect.left + titleRect.width / 2) - (spineRect.left + spineRect.width / 2)) * 10) / 10,
    }
  })
}

describe('书架书脊的书名字号', () => {
  it('诊断：不同体量的书，书脊宽度与书名字号', async () => {
    await renderShelf([
      book('新书', 12),        // 3 万字 —— 新建的书多半是这个体量
      book('一', 12),          // 3 万字 + 极短书名（先生特别提到的那种）
      book('刚建的书', undefined), // 还没有进度快照
      book('十万字', 40),      // 10 万字
      book('二十万字', 80),    // 20 万字
      book('四十万字', 160),   // 40 万字
    ])

    const samples = sampleSpines()
    for (const sample of samples) {
      const overflow = Math.round((sample.fontSize - sample.cssWidth) * 10) / 10
      console.log(
        `[书脊] 书名=${JSON.stringify(sample.title)} 书脊宽=${sample.cssWidth}px `
        + `字号=${sample.fontSize}px 水平偏移=${sample.horizontalOffset}px `
        + `横向溢出=${overflow}px`,
      )
    }
    expect(samples).toHaveLength(6)
  })

  it('任何体量的书，书脊上的书名都必须有可读字号', async () => {
    await renderShelf([
      book('新书', 12),
      book('一', 12),
      book('刚建的书', undefined),
      book('二十万字', 80),
    ])

    const samples = sampleSpines()
    const tooSmall = samples.filter((sample) => sample.fontSize < MIN_READABLE_FONT_PX)
    expect(
      tooSmall,
      `这些书的书名字号低于 ${MIN_READABLE_FONT_PX}px，看不清：`
      + tooSmall.map((s) => `${s.title}(${s.fontSize}px/书脊${s.cssWidth}px)`).join('、'),
    ).toEqual([])
  })

  it('竖排书名在书脊上水平居中（窄书脊也不能被推到一边）', async () => {
    await renderShelf([book('新书', 12), book('一', 12), book('二十万字', 80)])
    const samples = sampleSpines()
    for (const sample of samples) {
      expect(
        Math.abs(sample.horizontalOffset),
        `「${sample.title}」的书名偏了 ${sample.horizontalOffset}px（书脊宽 ${sample.cssWidth}px）`,
      ).toBeLessThanOrEqual(1.5)
    }
  })
})
