/**
 * 空行上的光标锚点，必须与「这一行有文字时」完全一致。
 *
 * 先生（第二次报障）：
 *   「按下 Enter 之后，光标换行，但是没有落到位置；输入任意内容后就正确了。
 *    删除时按两次 Backspace 才会正确 —— 因为我们默认的渲染视图，
 *    段落之间好像是 2 行距离，因此导致了这个 bug。」
 *
 * 实测确认的根因：
 *   CodeMirror 把光标锚在「光标所在行**内容盒（line box）**的垂直中心」上
 *   （实测偏差恒为 -1px）。而内容盒高度就是 `line-height`。
 *   皮肤一度用 `line-height: 0.7` 压缩空行 —— 段落间距确实小了，
 *   但内容盒也跟着矮到 11.55px，于是光标锚点比「这一行若有文字、文字该在的位置」
 *   高出 (37.95 − 11.55) / 2 ≈ 13px。作者敲下第一个字后该行不再是空行、
 *   内容盒恢复全高，光标才「跳」到位；删除时反过来：一删到空行就再次错位，
 *   再删掉这个空行才回到正文行 —— 正是「要按两次 Backspace 才正确」。
 *
 * 修法（见 v2-editor.css 的空行规则）：
 *   **压行块 height，不压 line-height**。行块矮 = 段间距小（先生认可的观感，
 *   约 20px 配 38px 的正文行）；内容盒保持与正文行等高 = 光标锚点正确。
 *   行块比内容盒矮，还必须 `overflow: visible` 放行，否则内容盒被裁、光标又被挤回行块中心。
 *
 *   「行块矮」带来的下方位移（在空行里打字会推下去 18px）不走这条路解决 ——
 *   改由 live-preview 给**光标所在的空行**打 `.cm-lp-caret-empty` 让它提前展开，
 *   位移因此发生在「光标落上去」而非「打字」的那一刻。见 paragraph-separator。
 *
 * 本文件守住这条修法：谁再把 `line-height` 压下去、或给空行加上 height 之类的东西，这里就会红。
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
  expect(surface).toBeTruthy()
  await act(async () => surface!.focus())
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  await settle()
  return { view: view!, surface: surface! }
}

function pressKey(view: EditorView, key: string, keyCode: number): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    code: key === 'Enter' ? 'Enter' : key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  }))
}

/** 光标中心相对指定行**顶部**的距离 —— 这就是 CodeMirror 的锚点。 */
function caretAnchorOffset(surface: HTMLElement, lineIndex: number): number {
  const lineEl = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))[lineIndex]
  expect(lineEl, `第 ${lineIndex + 1} 行应当存在`).toBeTruthy()
  const caretEl = container.querySelector<HTMLElement>('.cm-cursor')
  expect(caretEl, '应当能看到光标元素').toBeTruthy()
  const line = lineEl.getBoundingClientRect()
  const caret = caretEl!.getBoundingClientRect()
  return (caret.top + caret.bottom) / 2 - line.top
}

function lineBox(surface: HTMLElement, lineIndex: number): { height: number; lineHeight: string } {
  const lineEl = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))[lineIndex]
  return {
    height: Math.round(lineEl.getBoundingClientRect().height),
    lineHeight: getComputedStyle(lineEl).lineHeight,
  }
}

describe('空行上的光标锚点', () => {
  it('Enter 产生的空行：光标锚点与「输入文字后」一致（不再漂移 13px）', async () => {
    const { view, surface } = await renderEditor('第一段正文。\n第二段正文。')
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
    await settle()

    // 真实按键：先生就是按 Enter
    await act(async () => pressKey(view, 'Enter', 13))
    await settle()

    // Enter 现在一次产出「空行 + 新段落行」（见 CodeMirrorEditor 的 enterPlainParagraph），
    // 所以 2 行的文档会变成 4 行，光标落在最后一行（新段落行）。
    expect(view.state.doc.lines, 'Enter 之后应当变成 4 行（空行 + 新段落行）').toBe(4)
    const caretLineIndex = view.state.doc.lines - 1
    const anchorOnEmpty = caretAnchorOffset(surface, caretLineIndex)

    // 打下一个实义字 —— 这是「这一行有文字时」光标应处的位置
    await act(async () => {
      view.dispatch(view.state.replaceSelection('新'))
    })
    await settle()
    const anchorOnText = caretAnchorOffset(surface, caretLineIndex)

    const emptyBox = lineBox(surface, caretLineIndex)
    console.log(
      `[空行锚点] 空行时=${anchorOnEmpty.toFixed(1)} 有字时=${anchorOnText.toFixed(1)} `
      + `→ 漂移=${(anchorOnEmpty - anchorOnText).toFixed(1)}px | 空行行块=${emptyBox.height}px `
      + `内容盒=${emptyBox.lineHeight}`,
    )

    expect(
      Math.abs(anchorOnEmpty - anchorOnText),
      `空行上的光标锚点(${anchorOnEmpty.toFixed(1)}) 必须与输入文字后(${anchorOnText.toFixed(1)}) 一致，`
      + '否则作者会看到「Enter 之后没落到位置、输入一下才到位」',
    ).toBeLessThanOrEqual(1.5)
  })

  it('Backspace 删回空行时，锚点仍然正确（对应「要按两次才正确」）', async () => {
    const { view, surface } = await renderEditor('第一段正文。\n第二段正文。')
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
    await settle()
    await act(async () => pressKey(view, 'Enter', 13))
    await settle()

    // 先输入一个字，量出正确锚点（光标此时在最后一行 = 新段落行）
    await act(async () => {
      view.dispatch(view.state.replaceSelection('新'))
    })
    await settle()
    const caretLineIndex = view.state.doc.lines - 1
    const anchorOnText = caretAnchorOffset(surface, caretLineIndex)

    // 删掉这个字 —— 该行重新变成空行
    await act(async () => {
      const end = view.state.doc.length
      view.dispatch({
        changes: { from: end - 1, to: end },
        selection: { anchor: end - 1 },
      })
    })
    await settle()
    expect(
      view.state.doc.line(view.state.doc.lines).text,
      '删掉最后一个字后，最后一行应当回到空行',
    ).toBe('')
    const anchorAfterDelete = caretAnchorOffset(surface, caretLineIndex)

    console.log(
      `[删除回空行] 删除后锚点=${anchorAfterDelete.toFixed(1)} 有字时=${anchorOnText.toFixed(1)} `
      + `→ 漂移=${(anchorAfterDelete - anchorOnText).toFixed(1)}px`,
    )
    expect(
      Math.abs(anchorAfterDelete - anchorOnText),
      '删回空行后光标不该再跳回错误位置',
    ).toBeLessThanOrEqual(1.5)
  })

  it('空行：内容盒必须与正文行等高，行块则可以更矮（光标锚点与段间距各自的前提）', async () => {
    const { surface } = await renderEditor('第一段正文。\n\n第二段正文。')
    const emptyBox = lineBox(surface, 1)
    const textBox = lineBox(surface, 0)

    console.log(`[内容盒] 空行 line-height=${emptyBox.lineHeight} 高=${emptyBox.height}px | 正文行 line-height=${textBox.lineHeight} 高=${textBox.height}px`)
    expect(
      parseFloat(emptyBox.lineHeight),
      '空行的 line-height 必须与正文行一致 —— 光标锚点就是按内容盒中心算的',
    ).toBe(parseFloat(textBox.lineHeight))

    // 行块更矮 = 段间距小（先生认可的观感）。
    // 代价是光标落到这一行时它要展开（见 paragraph-separator 的「光标所在的空行会提前展开」），
    // 这样位移发生在光标落上去的那一刻，而不是打字的那一刻。
    expect(
      emptyBox.height,
      `空行行块(${emptyBox.height}px) 应当矮于正文行(${textBox.height}px) —— 这就是段间距`,
    ).toBeLessThan(textBox.height)
  })

  it('含空行的长文里，CodeMirror 认为的行位置与 DOM 实际位置逐行对齐（height+overflow 没有骗到它）', async () => {
    // 空行用 `height` 压矮、同时让内容盒溢出行块 —— 这是本次修复的关键手法。
    // 风险在于 CodeMirror 的行高是用 getBoundingClientRect 量出来的，
    // 若「它量到的行高」与「行实际占的位置」对不上，滚动锚定与视口推算就会逐行累积误差。
    // 这里把每一行的「文档坐标」与「DOM 实际坐标」对一次账。
    const content = ['第一段。', '', '第二段。', '', '第三段。', '', '第四段。'].join('\n')
    const { view, surface } = await renderEditor(content)
    await settle()

    const lineEls = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    expect(lineEls).toHaveLength(7)

    const firstPos = view.state.doc.line(1).from
    const cmBase = view.lineBlockAt(firstPos).top
    const domBase = lineEls[0].getBoundingClientRect().top

    const rows: string[] = []
    const mismatches: string[] = []
    for (let i = 1; i <= 7; i += 1) {
      const pos = view.state.doc.line(i).from
      const cmTop = view.lineBlockAt(pos).top - cmBase
      const domTop = lineEls[i - 1].getBoundingClientRect().top - domBase
      rows.push(`行${i}: CM=${cmTop.toFixed(1)} DOM=${domTop.toFixed(1)}`)
      if (Math.abs(cmTop - domTop) > 1.5) {
        mismatches.push(`行${i}: CodeMirror 认为在 ${cmTop.toFixed(1)}，实际在 ${domTop.toFixed(1)}`)
      }
    }
    console.log(`[行位置账本] ${rows.join(' | ')}`)

    expect(
      mismatches,
      'CodeMirror 的行位置账本必须与真实 DOM 一致，否则长文滚动与点击定位会漂',
    ).toEqual([])
  })
})
