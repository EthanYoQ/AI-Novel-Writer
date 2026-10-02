/**
 * 气泡菜单上的「全选」—— 一键选中整篇文档。
 *
 * 先生：「在左键选中后弹出的气泡上，增加一个新功能，全选吧，就是全部选中当前文档。」
 *
 * 这个功能的两个隐蔽难点，本文件都守着：
 * 1. **全选必须让气泡还看得见**。气泡的定位靠选区矩形，而全选之后选区顶部通常滚到
 *    视区之外（长文里必然如此）—— 定位若不做视口钳制，按钮会跑到屏幕外面去，
 *    作者点完全选就找不到它了。
 * 2. **全选不该动内容、也不该把视线弹走**。选的是整篇文档，不是「跳到最后一行」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import { useLocaleStore } from '../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONTENT = '第一段正文。\n\n第二段正文。\n\n第三段正文。'

/** 撑得比视口长：全选之后选区顶部一定滚出视区，这才逼出「气泡跑出屏幕」那个坑。 */
const LONG_CONTENT = Array.from(
  { length: 40 },
  (_, index) => `第${index + 1}段正文，用来把这篇文档撑得比一屏更长一些。`,
).join('\n\n')

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
  useLocaleStore.setState({ locale: 'zh-CN' })
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

async function renderEditor(
  content: string,
  options: { mode?: 'prose' | 'document'; onChange?: (text: string) => void } = {},
): Promise<EditorView> {
  await act(async () => {
    root.render(
      <CodeMirrorEditor
        mode={options.mode ?? 'prose'}
        content={content}
        editable
        hideStatusBar
        onChange={options.onChange ?? (() => {})}
        onCharCountChange={() => {}}
      />,
    )
  })
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  expect(view, '应当能取到 CodeMirror 实例').toBeTruthy()
  await settle()
  return view!
}

/** 制造一段非空选区 —— 气泡就是靠它弹出来的。 */
async function selectRange(view: EditorView, from: number, to: number): Promise<void> {
  await act(async () => {
    view.focus()
    view.dispatch({ selection: { anchor: from, head: to } })
  })
  await settle()
}

/** 取气泡按钮的视口矩形（元素不在 DOM 时返回 null，而不是让整条用例挂在超时上）。 */
function bubbleButtonRect(): DOMRect | null {
  try {
    return (page.getByRole('button', { name: '全选' }).element() as HTMLElement).getBoundingClientRect()
  } catch {
    return null
  }
}

/** 气泡为什么在/不在：把这几个量一次性打出来，免得靠猜。 */
function bubbleDiagnostics(view: EditorView, from: number): string {
  const sel = window.getSelection()
  const coords = view.coordsAtPos(from)
  return `原生选区 rangeCount=${sel?.rangeCount ?? -1} collapsed=${sel?.isCollapsed ?? 'n/a'}`
    + ` | coordsAtPos(${from})=${coords ? `top=${coords.top.toFixed(0)},left=${coords.left.toFixed(0)}` : 'null'}`
    + ` | 气泡元素数=${container.querySelectorAll('.fixed.z-50').length}`
    + ` | CM 选区=${view.state.selection.main.from}..${view.state.selection.main.to}`
    + ` | 滚动=${view.scrollDOM.scrollTop}`
}

/**
 * 直接派发 DOM click。
 *
 * 刻意不用 `locator.click()`：Playwright 会等元素「可见且可点在视口内」，
 * 而本文件要验证的恰恰是**若定位失准、按钮跑到视口外**这种情况 ——
 * 用它会先一步超时，把「位置不正确」伪装成「找不到元素」。
 */
async function pressSelectAll(): Promise<void> {
  const button = page.getByRole('button', { name: '全选' }).element() as HTMLElement
  await act(async () => {
    button.click()
  })
  await settle()
}

/**
 * 把视口滚到指定行。
 *
 * 刻意用 CodeMirror 自己的 scrollIntoView，而不是直接改 `scrollDOM.scrollTop`：
 * 后者要等一次 measure 周期才会反映到 `view.visibleRanges`，
 * 于是「取视口内的段落」会取到文档开头那一段（本次踩过，靠诊断数据才发现）。
 */
async function scrollToLine(view: EditorView, lineNumber: number): Promise<void> {
  await act(async () => {
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.line(lineNumber).from, { y: 'start' }),
    })
  })
  await settle()
}

/**
 * 选中**视口内**的一段文字。
 *
 * 用 `coordsAtPos` 逐行实测，而不是读 `view.visibleRanges` —— 后者的 viewport
 * 更新要等一次 measure 周期，测试里容易读到尚未刷新的旧值（本次踩过）。
 * 必须落在视口内：气泡靠选区矩形定位，而作者用鼠标选中的字必然在眼前
 * （选区整个滚出视区时气泡本就该收起，那是既有设计，不在本文件范围内）。
 */
async function selectVisibleParagraph(view: EditorView): Promise<void> {
  for (let lineNumber = 1; lineNumber < view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber)
    if (!line.text.trim()) continue
    const coords = view.coordsAtPos(line.from)
    if (!coords || coords.top < 0 || coords.bottom > window.innerHeight) continue
    const next = view.state.doc.line(lineNumber + 1)
    await selectRange(view, line.from, next.to)
    return
  }
  throw new Error('找不到落在视口内的正文行')
}

describe('气泡菜单的「全选」', () => {
  it('选中文字后，气泡里就有「全选」', async () => {
    const view = await renderEditor(CONTENT)
    await selectRange(view, 0, 4)

    await expect.element(page.getByRole('button', { name: '全选' })).toBeVisible()
    // 与它同排的老按钮不能被挤掉
    await expect.element(page.getByRole('button', { name: '收录为世界观设定' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '润色' })).toBeVisible()
  })

  it('点一下「全选」：整篇文档都被选中', async () => {
    const view = await renderEditor(CONTENT)
    await selectRange(view, 0, 4)

    await act(async () => page.getByRole('button', { name: '全选' }).click())
    await settle()

    const selection = view.state.selection.main
    console.log(`全选结果：from=${selection.from} to=${selection.to} 文档长度=${view.state.doc.length}`)
    expect(selection.from, '选区必须从文首开始').toBe(0)
    expect(selection.to, '选区必须覆盖到文末').toBe(view.state.doc.length)
    expect(view.state.sliceDoc(selection.from, selection.to), '选中的就是全文').toBe(CONTENT)
  })

  it('「全选」只改选区，不改内容（不会惊动 onChange / 脏标记）', async () => {
    const onChange = vi.fn()
    const view = await renderEditor(CONTENT, { onChange })
    await selectRange(view, 0, 4)

    await act(async () => page.getByRole('button', { name: '全选' }).click())
    await settle()

    expect(view.state.doc.toString(), '内容必须一字未动').toBe(CONTENT)
    expect(onChange, '全选不该触发内容变更回调').not.toHaveBeenCalled()
  })

  it('全选之后气泡仍留在视口里（长文档：选区顶部早已滚出视区）', async () => {
    const view = await renderEditor(LONG_CONTENT)
    // 先滚到文档中部，模拟作者读到一半顺手全选
    await scrollToLine(view, 18)
    await selectVisibleParagraph(view)

    console.log(`[诊断] 全选前的滚动位置=${view.scrollDOM.scrollTop}`)
    console.log(`[诊断] ${bubbleDiagnostics(view, view.state.selection.main.from)}`)
    expect(bubbleButtonRect(), '选中一段文字后气泡按钮应当已经在 DOM 里').not.toBeNull()

    await pressSelectAll()

    const rect = bubbleButtonRect()
    expect(rect, '全选之后气泡按钮必须还在 DOM 里').not.toBeNull()
    console.log(
      `全选后气泡：top=${rect!.top.toFixed(0)} bottom=${rect!.bottom.toFixed(0)} `
      + `left=${rect!.left.toFixed(0)} right=${rect!.right.toFixed(0)} `
      + `视口=${window.innerWidth}x${window.innerHeight} 滚动位置=${view.scrollDOM.scrollTop}`,
    )
    expect(rect!.top, '气泡不能被挤到视口上方之外（那样作者就找不到它了）').toBeGreaterThanOrEqual(0)
    expect(rect!.bottom, '气泡不能掉到视口下方之外').toBeLessThanOrEqual(window.innerHeight)
    expect(rect!.left, '气泡不能跑到视口左边之外').toBeGreaterThanOrEqual(0)
    expect(rect!.right, '气泡不能跑到视口右边之外').toBeLessThanOrEqual(window.innerWidth)
  })

  it('全选不把视线弹走：滚动位置留在作者原来在的地方', async () => {
    const view = await renderEditor(LONG_CONTENT)
    await scrollToLine(view, 18)
    await selectVisibleParagraph(view)
    expect(bubbleButtonRect(), '选中一段文字后气泡按钮应当已经在 DOM 里').not.toBeNull()
    const before = view.scrollDOM.scrollTop

    await pressSelectAll()

    console.log(`滚动位置：全选前=${before} 全选后=${view.scrollDOM.scrollTop}`)
    expect(
      Math.abs(view.scrollDOM.scrollTop - before),
      '全选只是铺满高亮，不该把作者正在看的位置弹到文末',
    ).toBeLessThanOrEqual(2)
  })

  it('document 模式（档案阅览）同样有「全选」', async () => {
    const view = await renderEditor(CONTENT, { mode: 'document' })
    await selectRange(view, 0, 4)

    await expect.element(page.getByRole('button', { name: '全选' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '全选' }).click())
    await settle()

    expect(view.state.selection.main.to).toBe(view.state.doc.length)
  })

  it('英文界面下按钮叫 Select all', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    const view = await renderEditor(CONTENT)
    await selectRange(view, 0, 4)

    await expect.element(page.getByRole('button', { name: 'Select all' })).toBeVisible()
  })
})
