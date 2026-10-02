/**
 * 中键与右键点进段间距 —— 先生第二次报障。
 *
 * 先生：「鼠标中键和鼠标右键，也能把光标点击在两个段落中间，导致段落错位，
 *        类似之前我们修复的左键一样。」
 *
 * 为什么左键的修复没管住它们（源码事实，不是推断）：
 *   `@codemirror/view` 的 mousedown 处理器写着 `if (!style && event.button == 0)`
 *   —— **中键与右键根本不进入选取通道**，插入点是浏览器原生放进 contenteditable 的，
 *   随后被 DOM 观察者同步成一笔 `userEvent: "select.pointer"` 的选区事务。
 *   左键走的是「坐标 → 位置」映射（补丁挂在那里），这条事务**不经过坐标映射**，
 *   所以补丁对它无能为力。
 *
 * 测试怎么还原这条链路：
 *   合成 MouseEvent 不会让浏览器真的移动原生插入点，所以除了派发 mousedown，
 *   还要**手动补上那笔 DOM 同步事务**（`userEvent: 'select.pointer'`）——
 *   这才忠实对应真实浏览器里发生的事。过滤器要拦的正是这一笔。
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

const CONTENT = '第一段正文。\n\n第二段正文。'

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

async function renderEditor(content = CONTENT): Promise<{ view: EditorView; surface: HTMLElement }> {
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

function lineEls(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
}

/**
 * 中键（button=1）或右键（button=2）点击，并补上真实浏览器随后会发生的那笔
 * DOM 选区同步事务 —— 它才是把光标真正插进段间距的那一下。
 */
async function pointerClickAt(
  view: EditorView,
  surface: HTMLElement,
  button: 1 | 2,
  x: number,
  y: number,
  nativeInsertionAt: number,
): Promise<void> {
  await act(async () => {
    surface.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button,
      buttons: button === 1 ? 4 : 2,
      detail: 1,
      clientX: x,
      clientY: y,
    }))
    // 浏览器原生把插入点放进空行 → CodeMirror 的 DOM 观察者把它同步成这笔事务
    view.dispatch({
      selection: { anchor: nativeInsertionAt },
      userEvent: 'select.pointer',
    })
  })
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button, clientX: x, clientY: y }))
  })
  await settle()
}

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

describe('中键与右键点进段间距', () => {
  it('中键：光标被吸附到相邻段落，不停在空行上（且版面不动）', async () => {
    const { view, surface } = await renderEditor()
    const gap = lineEls(surface)[1].getBoundingClientRect()
    const gapPos = view.state.doc.line(2).from
    const before = lineEls(surface).map((el) => el.getBoundingClientRect().top)

    await pointerClickAt(view, surface, 1, gap.left + 100, gap.top + 3, gapPos)

    console.log(`[中键] 光标落在第 ${caretLine(view)} 行，head=${view.state.selection.main.head}`)
    expect(caretLine(view), '中键点段间距不能把光标插进空行').not.toBe(2)
    expect(view.state.selection.main.head, '点半步偏上 → 吸附到上一段末尾')
      .toBe(view.state.doc.line(1).to)

    const shifts = lineEls(surface)
      .map((el, index) => Math.round((el.getBoundingClientRect().top - before[index]) * 10) / 10)
    console.log(`[中键] 逐行位移 = ${JSON.stringify(shifts)}`)
    expect(shifts.every((shift) => Math.abs(shift) < 0.5), `版面不该错位：${JSON.stringify(shifts)}`).toBe(true)
  })

  it('右键：同样吸附到相邻段落，不停在空行上', async () => {
    const { view, surface } = await renderEditor()
    const gap = lineEls(surface)[1].getBoundingClientRect()
    const gapPos = view.state.doc.line(2).from

    await pointerClickAt(view, surface, 2, gap.left + 100, gap.bottom - 3, gapPos)

    console.log(`[右键] 光标落在第 ${caretLine(view)} 行，head=${view.state.selection.main.head}`)
    expect(caretLine(view), '右键点段间距不能把光标插进空行').not.toBe(2)
    expect(view.state.selection.main.head, '点半步偏下 → 吸附到下一段开头')
      .toBe(view.state.doc.line(3).from)
  })

  it('命中段间距之后，跟随而来的指针事务会被拉回（过滤器独立生效）', async () => {
    const { view, surface } = await renderEditor()
    const gap = lineEls(surface)[1].getBoundingClientRect()
    const gapPos = view.state.doc.line(2).from
    // 先把光标放在下一段开头，模拟「点之前光标在别处」
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    })
    await settle()
    // 在段间距上按下（这一步会把「命中」写进 state）
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 1,
        buttons: 4,
        detail: 1,
        clientX: gap.left + 100,
        clientY: gap.bottom - 3,
      }))
    })
    await settle()

    await act(async () => {
      view.dispatch({ selection: { anchor: gapPos }, userEvent: 'select.pointer' })
    })
    await settle()

    console.log(`[过滤器] 指针事务之后光标在第 ${caretLine(view)} 行（head=${view.state.selection.main.head}）`)
    expect(caretLine(view), '指针事务不能把光标留在空行上').not.toBe(2)
  })

  it('没命中段间距时，指针事务照旧生效 —— 过滤器不许过度拦截', async () => {
    // 这条守的是一个真实回归：点击纸页下方的留白会按 CodeMirror 的原意落到文末，
    // 而文末往往正是一个空行 —— 只看「落在空白行」就拦，会把「接着往下写」的入口吃掉。
    const { view } = await renderEditor('第一段正文。\n\n第二段正文。\n')
    const tailLine = view.state.doc.lines
    const tail = view.state.doc.line(tailLine).from
    expect(view.state.doc.line(tailLine).text, '文末应当是一个空行').toBe('')

    await act(async () => {
      view.dispatch({ selection: { anchor: tail }, userEvent: 'select.pointer' })
    })
    await settle()

    expect(
      view.state.selection.main.head,
      '没有命中标记时，指针事务必须原样生效',
    ).toBe(tail)
  })

  it('键盘仍能把光标放进空行 —— 过滤器只认指针来源', async () => {
    const { view } = await renderEditor()
    const gapPos = view.state.doc.line(2).from

    await act(async () => {
      view.dispatch({ selection: { anchor: gapPos }, userEvent: 'select' })
    })
    await settle()

    expect(caretLine(view), '方向键移到空行是作者主动操作，必须照旧生效').toBe(2)
  })

  it('程序化选区不受影响（Enter 之后的新空行段必须能承载光标）', async () => {
    const { view } = await renderEditor()
    const gapPos = view.state.doc.line(2).from

    await act(async () => {
      view.dispatch({ selection: { anchor: gapPos } })
    })
    await settle()

    expect(caretLine(view), '没有指针来源注解的选区一概不碰').toBe(2)
  })

  it('中键点在正文行上：行为照旧（光标落在该行，不误伤）', async () => {
    const { view, surface } = await renderEditor()
    const target = view.state.doc.line(3).from + 2
    const coords = view.coordsAtPos(target)
    expect(coords).toBeTruthy()

    await pointerClickAt(
      view,
      surface,
      1,
      (coords!.left + coords!.right) / 2,
      (coords!.top + coords!.bottom) / 2,
      target,
    )

    expect(caretLine(view), '点在正文上不该被挪走').toBe(3)
  })
})
