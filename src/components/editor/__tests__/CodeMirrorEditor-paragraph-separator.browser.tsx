/**
 * 段落之间那个空行的高度 —— 它就是「段间距」，而它比正文行矮多少，
 * 在空行里打字时下方内容就会被推下去多少。
 *
 * 这个文件记着三次报障与三次调整，改动前请先读完：
 *
 *  ▸ 第一版（先生：「段落之间的间距默认有点太高了，少一点点。」）
 *    用 `.cm-line:has(> br:only-child) { line-height: 0.7 }` 把空行压到 12px，段间距确实小了。
 *    但压的是**内容盒**，于是引出下一个 bug：CodeMirror 把光标锚在内容盒中心，
 *    空行内容盒矮了 13px，光标就「没落到位」（见 CodeMirrorEditor-empty-line-caret）。
 *
 *  ▸ 第二版（先生：「enter 手感不好 —— 一打字，下方文字段落又自动下沉。」）
 *    改成「内容盒保持全高、只压行块 height」：光标锚点对了，
 *    但空行 20px、正文行 38px —— 在空行里敲下第一个字的那一刻，该行由矮变高，
 *    把下方内容整体推下去 18.1px（本文件实测）。
 *
 *  ▸ 第三版（先生：「想办法在那个最美的排版上解决问题。」）
 *    试过靠收紧行距化解（段间距与行距由同一个数决定，要不跳就得两者相等），
 *    但 1.6 的行距先生判定「太难看」，已回退到 2.3。
 *    **真实解法是把位移「提前」**：由 live-preview 给**光标所在的空行**打上
 *    `.cm-lp-caret-empty`，让它在光标落上去时就展开成完整行高 ——
 *    位移因此发生在「按 Enter / 点进空行」那一刻（作者主动插入内容的时刻，符合预期），
 *    而**打字时不再有任何位移**。本文件守住这一点。
 *
 * ⚠️ 量行距时不要用第 1 行：它是全文第一个正文段落，首字会被 live-preview 打上
 *    `.cm-lp-dropcap-char`（朱砂大字 3.15em），用它的字符 rect 量间距会得到负数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import { useLocaleStore } from '../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  document.documentElement.dataset.ui = 'v2'
  document.documentElement.dataset.v2Theme = '0'
  container = document.createElement('div')
  container.className = 'app-skin-root light'
  container.style.height = '600px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete document.documentElement.dataset.ui
  delete document.documentElement.dataset.v2Theme
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

async function renderEditor(content: string): Promise<{ view: EditorView; surface: HTMLElement }> {
  await act(async () => {
    root.render(
      <CodeMirrorEditor
        mode="prose"
        content={content}
        editable
        hideStatusBar
        onChange={() => {}}
        onCharCountChange={() => {}}
      />,
    )
  })
  const surface = container.querySelector<HTMLElement>('.cm-content')
  expect(surface, '编辑器应当渲染出可编辑面').toBeTruthy()
  await act(async () => surface!.focus())
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  expect(view, '应当能取到 CodeMirror 实例').toBeTruthy()
  await settle()
  return { view: view!, surface: surface! }
}

function lineHeights(surface: HTMLElement): number[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    .map((line) => Math.round(line.getBoundingClientRect().height))
}

/** 取一行里第一个可见字符的 rect —— 用它量「文字与文字之间真实的空白」。 */
function firstCharRect(line: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && !(node.textContent ?? '').trim()) node = walker.nextNode()
  if (!node || !(node.textContent ?? '').trim()) return null
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, 1)
  return range.getBoundingClientRect()
}

describe('段落之间那个空行的高度', () => {
  it('空行明显矮于正文行（段间距仍然小 —— 先生认可的那套排版）', async () => {
    const { surface } = await renderEditor('第一段正文。\n\n第二段正文。')
    const heights = lineHeights(surface)
    expect(heights).toHaveLength(3)

    const [textLine, emptyLine, nextTextLine] = heights
    console.log(`[SEPARATOR] 正文/空行/正文 高度 = ${JSON.stringify(heights)}`)
    expect(textLine).toBe(nextTextLine)
    expect(
      emptyLine,
      `空行(${emptyLine}px) 必须明显矮于正文行(${textLine}px)，否则段间距会占满一整行`,
    ).toBeLessThan(textLine)
    expect(emptyLine, '空行仍要有高度，否则段落会黏在一起看不出分段').toBeGreaterThan(0)
  })

  it('光标所在的空行会提前展开成完整行高（这是「打字不位移」的前提）', async () => {
    const { view, surface } = await renderEditor('第一段正文。\n\n第二段正文。')
    const lineEls = () => Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))

    // 光标放在第三段（正文行）上时，第 2 行这个空行是「矮」的
    view.dispatch({ selection: EditorSelection.single(view.state.doc.line(3).from) })
    await settle()
    const collapsed = Math.round(lineEls()[1].getBoundingClientRect().height)
    const textHeight = Math.round(lineEls()[0].getBoundingClientRect().height)

    // 光标移到空行上 —— 它应当立刻展开成完整行高
    view.dispatch({ selection: EditorSelection.single(view.state.doc.line(2).from) })
    await settle()
    const expanded = Math.round(lineEls()[1].getBoundingClientRect().height)

    console.log(`[SEPARATOR] 空行：光标不在上面=${collapsed}px，光标落上去=${expanded}px，正文行=${textHeight}px`)
    expect(collapsed, '光标不在上面时空行应当是矮的（段间距小）').toBeLessThan(textHeight)
    expect(
      expanded,
      '光标落上去后空行必须展开成完整行高 —— 否则在它里面敲第一个字时，下方内容会被推下去',
    ).toBe(textHeight)
  })

  it('在空行里敲下第一个字，下方内容完全不动（先生报的「一打字下方就下沉」）', async () => {
    const { view, surface } = await renderEditor('第一段正文。\n\n第二段正文。\n第三段正文。')
    // 光标落到空行上（此时它已经展开）
    view.dispatch({ selection: EditorSelection.single(view.state.doc.line(2).from) })
    await settle()

    const lineEls = () => Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    const topsBefore = lineEls().map((el) => el.getBoundingClientRect().top)
    const caretBefore = container.querySelector<HTMLElement>('.cm-cursor')?.getBoundingClientRect()

    await act(async () => {
      view.dispatch(view.state.replaceSelection('新'))
    })
    await settle()

    const topsAfter = lineEls().map((el) => el.getBoundingClientRect().top)
    const caretAfter = container.querySelector<HTMLElement>('.cm-cursor')?.getBoundingClientRect()
    const shifts = topsAfter.map((top, index) => Math.round((top - topsBefore[index]) * 10) / 10)
    console.log(`[SEPARATOR] 打字前后逐行位移 = ${JSON.stringify(shifts)}`)

    const moved = shifts
      .map((shift, index) => ({ line: index + 1, shift }))
      .filter((item) => Math.abs(item.shift) > 0.5)
    expect(
      moved,
      '在空行里打字时任何一行都不该移动 —— 有位移就说明光标所在的空行没有提前展开',
    ).toEqual([])

    if (caretBefore && caretAfter) {
      expect(Math.abs(caretAfter.top - caretBefore.top), '光标自身也不该跳').toBeLessThanOrEqual(1.5)
    }
  })

  it('账本：视觉行距与视觉段间距的实测值（日后调行高就看这一条）', async () => {
    // 一份文档同时量两件事：行 2→3 相邻（行距），行 3→5 跨一个空行（段间距）。
    // ⚠️ 刻意避开第 1 行：它带首字下沉（朱砂大字 3.15em），字符 rect 会得到负数。
    const { surface } = await renderEditor('第一段正文。\n第二段正文。\n第三段正文。\n\n第四段正文。')
    const lines = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    expect(lines).toHaveLength(5)

    const second = firstCharRect(lines[1])
    const third = firstCharRect(lines[2])
    const fifth = firstCharRect(lines[4])
    expect(second && third && fifth, '这三行都应当能取到可见字符').toBeTruthy()

    // 两个数口径一致：都是「上一行文字的**可见底部** → 下一行文字的**可见顶部**」的空白
    const lineGap = Math.round((third!.top - second!.bottom) * 10) / 10
    const paragraphGap = Math.round((fifth!.top - third!.bottom) * 10) / 10
    console.log(`[SEPARATOR账本] 行间可见空白=${lineGap}px | 段间可见空白=${paragraphGap}px`)

    expect(
      paragraphGap,
      `段间距(${paragraphGap}px) 应当大于行距(${lineGap}px)，否则段落之间看不出分隔`,
    ).toBeGreaterThan(lineGap)
    expect(lineGap, '行与行之间必须有可见空白').toBeGreaterThan(1)
  })

  it('空行 DOM 用 :has(> br:only-child) 命中、:empty 不命中（历史坑，留作参考）', async () => {
    const { surface } = await renderEditor('第一段正文。\n\n第二段正文。')
    const lines = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    const emptyLine = lines[1]

    expect(emptyLine.matches(':has(> br:only-child)'), '空行必须能被 :has(> br:only-child) 选中').toBe(true)
    expect(emptyLine.matches(':empty'), '空行带 <br> 子节点，:empty 不会命中 —— 这正是旧规则失效的原因').toBe(false)

    // 正文行不能被误伤
    expect(lines[0].matches(':has(> br:only-child)')).toBe(false)
    expect(lines[2].matches(':has(> br:only-child)')).toBe(false)
  })
})
