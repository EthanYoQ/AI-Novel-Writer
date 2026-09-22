/**
 * 「作者按 Enter 起的新段落」是一个**固定的落脚点**：光标进出它，它都不变。
 *
 * 先生：
 *   「用户没输入任何内容，但创建的那个空段落只要一直不变即可；
 *    用户移动走光标，那个地方依然在那就行。」
 *   「传统 word，移动上下按键的光标，对段落间距是没影响的，哪怕是空段落。」
 *
 * 这一条把两种「一行空白」彻底分开 —— 它们长得一样，来历却不同：
 *   · **段间距**（`段A / 空行 / 段B` 里那个空行）：排版分隔，压矮到 1.2em（约 20px）；
 *   · **作者起的新段落**：写作落脚点，按**完整行高**渲染，与光标在哪无关。
 *
 * 实现：Enter 时用 `markUserParagraph` 把这一行的位置登记进 StateField，
 * live-preview 据此给它打 `cm-lp-user-paragraph`（v2-editor.css 给整行高）；
 * 方向键也认这个来历 —— 路过段间距要跨过去，遇到作者的落脚点要停下来。
 *
 * 改动前实测（先生报障）：光标移走后那一格被收回成 20px，下方内容整体上移 18px，
 * 段与段之间于是残留一段多余的空白 —— 正是他说的「排版错位」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import { useLocaleStore } from '../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 两段之间恰好一个空行 —— 本项目的排版约定。 */
const CONTENT = '第一段文字。\n\n第二段文字。'
/** 完整行高约 38px、段间距约 20px —— 断言用它们区分「落脚点」与「分隔」。 */
const FULL_LINE_MIN = 30

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

async function pressKey(view: EditorView, key: string, keyCode: number): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true,
    }))
  })
  await settle()
}

async function setCaret(view: EditorView, pos: number): Promise<void> {
  await act(async () => {
    view.dispatch({ selection: { anchor: pos } })
  })
  await settle()
}

async function typeText(view: EditorView, text: string): Promise<void> {
  await act(async () => {
    view.dispatch(view.state.replaceSelection(text))
  })
  await settle()
}

function lineTops(surface: HTMLElement): number[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    .map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)
}

function lineHeights(surface: HTMLElement): number[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    .map((el) => Math.round(el.getBoundingClientRect().height))
}

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

describe('作者按 Enter 起的新段落：固定落脚点', () => {
  it('光标移走时它保持原样，下方段落一动不动（Word 手感）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)
    await pressKey(view, 'Enter', 13)

    const created = caretLine(view)
    expect(created, '新段落落在两段之间').toBe(3)
    const before = lineTops(surface)
    console.log(`[Enter 之后] 高度=${JSON.stringify(lineHeights(surface))} 位置=${JSON.stringify(before)}`)
    expect(lineHeights(surface)[created - 1], '新段落那一格是完整行高').toBeGreaterThan(FULL_LINE_MIN)

    await pressKey(view, 'ArrowUp', 38)
    const after = lineTops(surface)
    console.log(`[↑ 移走后] 高度=${JSON.stringify(lineHeights(surface))} 位置=${JSON.stringify(after)}`)

    expect(
      after,
      '移走光标不该移动任何一行 —— 那一格要保持原样、下方段落待在原地',
    ).toEqual(before)
    expect(
      lineHeights(surface)[created - 1],
      '新段落那一格即使没有光标，也仍是完整行高',
    ).toBeGreaterThan(FULL_LINE_MIN)
  })

  it('↓ 能回到刚起的那一段，且回来时版面依然不动', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)
    await pressKey(view, 'Enter', 13)
    const created = caretLine(view)
    const before = lineTops(surface)

    await pressKey(view, 'ArrowUp', 38)
    expect(caretLine(view), '↑ 回到上一段').toBe(1)

    await pressKey(view, 'ArrowDown', 40)
    expect(caretLine(view), '↓ 必须回到刚起的那一段').toBe(created)
    expect(lineTops(surface), '回来时版面同样不该动').toEqual(before)
  })

  it('连按两次 Enter：每一格都保持原样，方向键穿过时下方一动不动', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)

    await pressKey(view, 'Enter', 13)
    await pressKey(view, 'Enter', 13)
    expect(caretLine(view), '第二次 Enter 又起了一格').toBe(4)

    const before = lineTops(surface)
    const heights = lineHeights(surface)
    console.log(`[Enter×2] 高度=${JSON.stringify(heights)} 位置=${JSON.stringify(before)}`)
    // 两次 Enter 起的两格都该是完整行高（不是被压矮的小段空白）
    expect(heights[2], '第一格（已是落脚点）保持完整行高').toBeGreaterThan(FULL_LINE_MIN)
    expect(heights[3], '第二格（当前落脚点）是完整行高').toBeGreaterThan(FULL_LINE_MIN)

    for (let i = 0; i < 3; i += 1) {
      await pressKey(view, 'ArrowUp', 38)
      expect(lineTops(surface), `第 ${i + 1} 次 ↑ 不该移动任何一行`).toEqual(before)
    }
  })

  it('新段落一旦落笔，就回归普通正文行（标记不再生效）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)
    await pressKey(view, 'Enter', 13)
    await typeText(view, '新写的一段。')

    expect(view.state.doc.line(3).text, '新段落写下内容').toBe('新写的一段。')
    // 落笔后它有文字，行高本来就由正文样式提供；此时把光标移走也不该有任何位移
    const before = lineTops(surface)
    await pressKey(view, 'ArrowUp', 38)
    expect(lineTops(surface), '光标离开已落笔的段落，版面不动').toEqual(before)
  })

  it('文末 Enter 起的新段落同样固定，且 ↑ / ↓ 来回都自在', async () => {
    const { view, surface } = await renderEditor('第一段文字。')
    await setCaret(view, view.state.doc.length)
    await pressKey(view, 'Enter', 13)
    expect(caretLine(view)).toBe(3)

    const before = lineTops(surface)
    await pressKey(view, 'ArrowUp', 38)
    expect(caretLine(view), '↑ 回到上一段').toBe(1)
    expect(lineTops(surface), '文末那一格同样保持原样').toEqual(before)

    await pressKey(view, 'ArrowDown', 40)
    expect(caretLine(view), '↓ 回到新段落').toBe(3)
  })
})
