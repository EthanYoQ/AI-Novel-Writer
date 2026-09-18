/**
 * 段间距（段落之间那个空行）不能被鼠标点进去。
 *
 * 先生（第四次报障）：
 *   「现在鼠标能在正文、草稿阅览的时候，把光标移动到两个段落的中间
 *    （因为我们渲染默认的是两个段落中间会空出两排字的间距），结果导致上下文抖动。
 *     这个段落中间按照道理是不能被鼠标点击，让光标插进去的。」
 *
 * 抖动链条（前三次报障留下的排版约定，见 CodeMirrorEditor-paragraph-separator）：
 *   空行被压到 1.2em（约 20px）当段间距 → 光标一落上去，`.cm-lp-caret-empty`
 *   把它展开成完整行高（38px）→ 下方所有内容被整体推下去约 18px。
 *   那套展开是为「打字不位移」服务的，前提是作者主动把光标移过去（Enter / 方向键）；
 *   鼠标点空白触发它就纯属意外 —— 本文件守住「鼠标点不进去、版面一动不动」。
 *
 * ⚠️ 修复的落点是 `view.posAndSideAtCoords`（鼠标选取真正的入口，CodeMirror 的
 *    basicMouseSelection 直连它，不走 `posAtCoords`）。所以这里必须用**真实坐标**
 *    派发鼠标事件，不能靠 `view.dispatch` 直接设 selection —— 那样绕过了整条链路，
 *    测不到本 bug。
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

/** 段落之间必须留一个空行 —— 这是本项目正文的排版约定，也是「段间距」的来源。 */
const CONTENT = '第一段正文。\n\n第二段正文。'
/** 末尾再留一个空行：用来验证「点纸页下方的留白仍落到文末」。 */
const CONTENT_WITH_TRAILING_BLANK = '第一段正文。\n\n第二段正文。\n'

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

function lineEls(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
}

/** 鼠标按在真实坐标上 —— 与作者手点走的是同一条链路（mousedown → 内置选取定位）。 */
async function mouseDownAt(surface: HTMLElement, x: number, y: number): Promise<void> {
  await act(async () => {
    surface.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      clientX: x,
      clientY: y,
    }))
  })
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }))
  })
  await settle()
}

function caretLineNumber(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

function caretOffsetInLine(view: EditorView): number {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return view.state.selection.main.head - line.from
}

describe('鼠标点进段间距', () => {
  it('点空行上半：光标落到上一段末尾，绝不停在空行上', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    const gap = lineEls(surface)[1].getBoundingClientRect()

    await mouseDownAt(surface, gap.left + 20, gap.top + 3)

    expect(
      caretLineNumber(view),
      '光标必须落在正文行上 —— 落在第 2 行（空行）就会把它展开、把下方内容推下去',
    ).toBe(1)
    expect(view.state.selection.main.head, '点半步偏上，应当吸附到上一段的末尾').toBe(view.state.doc.line(1).to)
    expect(
      lineEls(surface)[1].classList.contains('cm-lp-caret-empty'),
      '空行不该被标成「光标所在的空行」—— 那正是抖动的前一步',
    ).toBe(false)
  })

  it('点空行下半：光标落到下一段开头', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    const gap = lineEls(surface)[1].getBoundingClientRect()

    await mouseDownAt(surface, gap.left + 20, gap.bottom - 3)

    expect(caretLineNumber(view)).toBe(3)
    expect(caretOffsetInLine(view), '下半应当吸附到下一段的第一个字之前').toBe(0)
  })

  it('点段间距时版面一动不动（先生报的「上下文抖动」）', async () => {
    const { surface } = await renderEditor('第一段正文。\n\n第二段正文。\n第三段正文。')
    const gapIndex = 1
    const before = lineEls(surface).map((el) => el.getBoundingClientRect().top)
    const gap = lineEls(surface)[gapIndex].getBoundingClientRect()

    await mouseDownAt(surface, gap.left + 20, gap.bottom - 3)
    const after = lineEls(surface).map((el) => el.getBoundingClientRect().top)
    const shifts = after.map((top, index) => Math.round((top - before[index]) * 10) / 10)
    console.log(`[段间距点击] 逐行位移 = ${JSON.stringify(shifts)}`)
    expect(shifts.every((shift) => Math.abs(shift) < 0.5), `点击段间距不该移动任何一行：${JSON.stringify(shifts)}`).toBe(true)
  })

  it('点正文行照旧：光标落在该行点到的位置', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    // 第二段的第 3 个字符 —— 用 CodeMirror 自己算出的坐标点它，避免靠猜像素
    const target = view.state.doc.line(3).from + 2
    const coords = view.coordsAtPos(target)
    expect(coords, '应当能取到该字符的屏幕坐标').toBeTruthy()

    await mouseDownAt(surface, coords!.left + 1, (coords!.top + coords!.bottom) / 2)

    const offset = caretOffsetInLine(view)
    expect(caretLineNumber(view), '点时不该把光标挪到别的段落去').toBe(3)
    // 落在该字符的左/右半由 CodeMirror 自己决定，差一个字不算问题；本 bug 关心的是「别跑到别的行去」
    expect(offset, `应当落在点到的那个字附近（实测偏移 ${offset}）`).toBeGreaterThanOrEqual(2)
    expect(offset, `应当落在点到的那个字附近（实测偏移 ${offset}）`).toBeLessThanOrEqual(3)
  })

  it('点纸页下方的留白仍旧落到文末（那是「接着往下写」的入口，不能被吃掉）', async () => {
    const { view, surface } = await renderEditor(CONTENT_WITH_TRAILING_BLANK)
    const paper = surface.getBoundingClientRect()

    await mouseDownAt(surface, paper.left + 20, paper.bottom - 20)

    expect(
      view.state.selection.main.head,
      '纸页留白不属于任何段落，光标应当照 CodeMirror 的原意落到文末',
    ).toBe(view.state.doc.length)
  })

  it('键盘仍能把光标放进空行（Enter 之后要能接着写新段落）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    // 直接把光标设到空行上 —— 模拟 Enter 之后落在新段落行上的情形
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
    })
    await settle()

    expect(caretLineNumber(view), '空行必须仍可承载光标，否则 Enter 之后没法写字').toBe(2)
    expect(
      lineEls(surface)[1].classList.contains('cm-lp-caret-empty'),
      '光标落在空行时，它照旧提前展开 —— 位移发生在作者主动移动的那一刻',
    ).toBe(true)
  })
})
