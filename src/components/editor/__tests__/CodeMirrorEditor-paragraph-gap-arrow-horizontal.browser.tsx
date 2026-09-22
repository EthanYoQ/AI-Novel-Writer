/**
 * ← / → 同样必须跨过段间距（两个自然段落之间那排空白）。
 *
 * 先生（第六次报障）：
 *   「正文、草稿、便利贴的渲染器，左箭头右箭头跨行错误。它们理论上应该和上下按键一样，
 *     在跨段落的时候，能自己跟上上一段落、或者下一段落，但现在没有。」
 *
 * 机制（与上下键同源，写在 paragraph-gap-caret.ts 的文件头里）：
 *   CodeMirror 的逐字符移动是**逻辑行**的 —— 在行末按 → 就是把位置 +1，
 *   也就是「换行符之后」，而那正是下一行的行首；在行首按 ← 同理退到上一行末尾。
 *   可本项目的排版约定是**段间留一个空行**，于是这一格恰好是：
 *   段A 行末 →（→）→ 段间距空行行首 →（→）→ 段B 行首。
 *   光标在段间距上停一下，`.cm-lp-caret-empty` 就把它展开成完整行高，
 *   下方内容整体下沉 —— 与鼠标点进去、与 ↑↓ 停上去，是同一种抖动。
 *
 * 本文件守的与 ↑↓ 那份逐条对称：
 *   · 夹在两段之间的空行，←→ 一律跨过；
 *   · **作者按 Enter 起的新段落行必须仍可落脚**；
 *   · 段内折行时逐字符走，不被整段甩走；
 *   · 连续空白区逐层走遍。
 *
 * 与 `CodeMirrorEditor-paragraph-gap-arrow.browser.tsx` 的分工：
 *   那边守 ↑ / ↓，这边守 ← / →。
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

/** 三段正文，段间各一个空行 —— 就是本项目的排版约定（每行都短到不会折行）。 */
const CONTENT = '第一段文字。\n\n第二段文字。\n\n第三段文字。'

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

type HorizontalKey = 'ArrowLeft' | 'ArrowRight'

/** 真实按键 —— 键盘路径必须走 keymap，不能靠 view.dispatch 绕过去。 */
async function pressArrow(view: EditorView, key: HorizontalKey, shift = false): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key,
      keyCode: key === 'ArrowLeft' ? 37 : 39,
      which: key === 'ArrowLeft' ? 37 : 39,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }))
  })
  await settle()
}

async function pressEnter(view: EditorView): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
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

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

function caretOffset(view: EditorView): number {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return view.state.selection.main.head - line.from
}

function lineTops(surface: HTMLElement): number[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    .map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)
}

function expandedEmptyLines(surface: HTMLElement): number[] {
  return Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    .map((el, index) => (el.classList.contains('cm-lp-caret-empty') ? index + 1 : 0))
    .filter((line) => line > 0)
}

describe('左右箭头跨过段间距', () => {
  it('→ 从第一段末尾出发直接落到第三行（第二段）行首，不停在中间的空白上', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowRight')

    expect(
      caretLine(view),
      '第 2 行是段间距，光标不该停在那里',
    ).toBe(3)
    expect(caretOffset(view), '应当落在第二段的第一个字之前').toBe(0)
  })

  it('← 从第二段行首出发直接回到第一段末尾，不停在中间的空白上', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(3).from)

    await pressArrow(view, 'ArrowLeft')

    expect(
      caretLine(view),
      '第 2 行是段间距，光标不该停在那里',
    ).toBe(1)
    expect(caretOffset(view), '应当落在第一段最后一个字之后').toBe(view.state.doc.line(1).length)
  })

  it('每一段都从行末跨到下一段行首，一次都不落在空行', async () => {
    const { view } = await renderEditor(CONTENT)

    const visited: number[] = []
    for (const lineNumber of [1, 3, 5]) {
      await setCaret(view, view.state.doc.line(lineNumber).to)
      await pressArrow(view, 'ArrowRight')
      visited.push(caretLine(view))
    }

    console.log(`[方向键 →] 依次落点 = ${JSON.stringify(visited)}`)
    expect(visited, '第一段末 → 第二段首 → 第三段首 → 文末（走不动，停在原地）').toEqual([3, 5, 5])
    expect(
      visited.every((line) => line % 2 === 1),
      `任何一次落点都不能是段间距空行（偶数行）：${JSON.stringify(visited)}`,
    ).toBe(true)
  })

  it('落在段首后再按 → 只是段内逐字符右移，不会被甩到下一段', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowRight') // 跨过段间距 → 第二段行首
    expect(caretLine(view)).toBe(3)
    expect(caretOffset(view)).toBe(0)

    await pressArrow(view, 'ArrowRight') // 段内右移一格
    expect(caretLine(view), '还在第二段里').toBe(3)
    expect(caretOffset(view)).toBe(1)
  })

  /**
   * ← 的落点是**上一段的末尾**，所以「跨过段间距」这件事每次都要从某个段落的
   * **行首**触发 —— 落在段末之后再按 ←，那是段内逐字符移动，本来就该停在原段
   * （这与 ↑↓ 不同：上下键每一次都是「换行视觉行」，因此每按一次都换段）。
   */
  it('每一段都从行首跨到上一段末尾，一次都不落在空行', async () => {
    const { view } = await renderEditor(CONTENT)

    const visited: number[] = []
    for (const lineNumber of [5, 3, 1]) {
      await setCaret(view, view.state.doc.line(lineNumber).from)
      await pressArrow(view, 'ArrowLeft')
      visited.push(caretLine(view))
    }

    console.log(`[方向键 ←] 依次落点 = ${JSON.stringify(visited)}`)
    expect(visited, '第三段行首 → 第二段末尾 → 第一段末尾 → 文首（走不动，停在原地）').toEqual([3, 1, 1])
    expect(
      visited.every((line) => line % 2 === 1),
      `任何一次落点都不能是段间距空行（偶数行）：${JSON.stringify(visited)}`,
    ).toBe(true)
  })

  it('落在段末后再按 ← 只是段内逐字符左移，不会被甩回上一段', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(3).from)

    await pressArrow(view, 'ArrowLeft') // 跨过段间距 → 第一段末尾
    expect(caretLine(view)).toBe(1)
    expect(caretOffset(view)).toBe(view.state.doc.line(1).length)

    await pressArrow(view, 'ArrowLeft') // 段内左移一格
    expect(caretLine(view), '还在第一段里').toBe(1)
    expect(caretOffset(view)).toBe(view.state.doc.line(1).length - 1)
  })

  it('跨过段间距时版面一动不动，也不把空行展开', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)
    const before = lineTops(surface)

    await pressArrow(view, 'ArrowRight')
    const after = lineTops(surface)

    const shifts = after.map((top, index) => Math.round((top - before[index]) * 10) / 10)
    console.log(`[左右键] 逐行位移 = ${JSON.stringify(shifts)} 展开的空行 = ${JSON.stringify(expandedEmptyLines(surface))}`)
    expect(shifts.every((shift) => Math.abs(shift) < 0.5), `按键不该移动任何一行：${JSON.stringify(shifts)}`).toBe(true)
    expect(expandedEmptyLines(surface), '空行不该被标成「光标所在的空行」').toEqual([])
  })

  it('段内按 ← → 仍旧逐字符走，让位给 CodeMirror 的默认行为', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).from + 3)

    await pressArrow(view, 'ArrowRight')
    expect(caretLine(view), '段内的 → 不该跨行').toBe(1)
    expect(caretOffset(view), '段内的 → 应当只走一个字').toBe(4)

    await pressArrow(view, 'ArrowLeft')
    expect(caretLine(view), '段内的 ← 不该跨行').toBe(1)
    expect(caretOffset(view), '段内的 ← 应当只回一个字').toBe(3)
  })

  it('Enter 起的新段落行：→ 跨过段间距正好落在它上面', async () => {
    const { view } = await renderEditor('第一段文字。')
    await setCaret(view, view.state.doc.length)

    await pressEnter(view)
    expect(view.state.doc.lines, 'Enter 应当产出「空行 + 新段落行」').toBe(3)
    expect(caretLine(view), 'Enter 之后光标落在新段落行上').toBe(3)

    /**
     * 回到上一段末尾再按 → ：紧邻的第 2 行是段间距（不是作者登记的那一格，
     * 登记的是第 3 行），所以跨过它 —— 落点正是作者按 Enter 起的那一段，
     * 与 ↑↓ 那边「从段A 按 ↓ 落回新段落行」是同一条路径。
     */
    await setCaret(view, view.state.doc.line(1).to)
    await pressArrow(view, 'ArrowRight')
    expect(
      caretLine(view),
      '→ 应当跨过段间距，落在作者按 Enter 起的那一格上',
    ).toBe(3)

    // ← 从新段落行行首出发，同样要能跨回上一段
    await setCaret(view, view.state.doc.line(3).from)
    await pressArrow(view, 'ArrowLeft')
    expect(caretLine(view), '← 应当跨过段间距回到上一段末').toBe(1)
  })

  it('连续空白区逐层走遍：每一行都用 → 到得了，不会被整片跳掉', async () => {
    // 两段正文之间留了两个空行（非标准排版，作者自己敲出来的）
    const { view } = await renderEditor('第一段文字。\n\n\n第二段文字。')
    await setCaret(view, view.state.doc.line(1).to)

    const visited: number[] = []
    for (let i = 0; i < 3; i += 1) {
      await pressArrow(view, 'ArrowRight')
      visited.push(caretLine(view))
    }
    console.log(`[连续空白 →] ${JSON.stringify(visited)}`)

    expect(visited[0], '第一跳跨过紧邻的那格 → 落在中间那个空行上').toBe(3)
    expect(visited[1], '第二跳跨过它后面那格 → 落在正文行上').toBe(4)
    expect(visited, '每一行都到得了').toEqual([3, 4, 4])
  })

  it('文档最末的空行照旧可以落脚（← 到得了，不会被跨掉）', async () => {
    const { view } = await renderEditor('第一段文字。\n')
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowRight')

    expect(caretLine(view), '文末空行走不出去，应当停在它上面').toBe(2)
  })

  it('Shift + → 扩展选区时同样跨过段间距（空行不参与选区头）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowRight', true)

    const selection = view.state.selection.main
    expect(selection.anchor, '锚点应当留在第一段末尾').toBe(view.state.doc.line(1).to)
    expect(
      view.state.doc.lineAt(selection.head).number,
      '选区头不该落在段间距上',
    ).toBe(3)
    expect(expandedEmptyLines(surface), '空行不该被展开（那正是版面错位的前一步）').toEqual([])
  })

  it('Shift + ← 扩展选区时同样跨过段间距', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(3).from)

    await pressArrow(view, 'ArrowLeft', true)

    const selection = view.state.selection.main
    expect(selection.anchor, '锚点应当留在第二段行首').toBe(view.state.doc.line(3).from)
    expect(
      view.state.doc.lineAt(selection.head).number,
      '选区头不该落在段间距上',
    ).toBe(1)
  })

  /**
   * 段落**内部**折行的那些行之间是紧凑的行距，不是段间距，光标该一格一格走。
   * 首字下沉那一行比正文行高得多，是最容易把「跨行判据」写歪的地方。
   */
  it('段落内部折行时，←→ 逐字符走，不会被甩到相邻段落', async () => {
    const longParagraph = '夜色沉了下来。他站在门口，没有说话，只是看着院子里那盏灯，'
      + '像是在等一个人回来。灯火晃了一下，他的影子也跟着晃了晃，又安静下去。'
    const { view } = await renderEditor(`${longParagraph}\n\n第二段文字。`)

    const block = view.lineBlockAt(0)
    const visualLines = Math.round(block.height / view.defaultLineHeight)
    console.log(`[段内横向] 第一段行块高度 = ${Math.round(block.height)}px ≈ ${visualLines} 个视觉行`)
    expect(visualLines, '前置条件：第一段确实折成了多个视觉行').toBeGreaterThan(2)

    // 从段中出发向右走：走完本段最后一个字才跨过段间距到第二段
    await setCaret(view, 0)
    const visited: number[] = []
    let steps = 0
    while (caretLine(view) === 1 && steps < 300) {
      await pressArrow(view, 'ArrowRight')
      visited.push(caretLine(view))
      steps += 1
    }
    console.log(`[段内 →] 走到第 ${JSON.stringify(visited.slice(-3))} 行（共 ${steps} 跳）`)
    expect(visited.slice(0, -1).every((line) => line === 1), '途中每一跳都该还在本段内部').toBe(true)
    expect(caretLine(view), '走完本段才跨过段间距到第二段').toBe(3)
    expect(
      steps,
      '逐字符走：段内一格一格（等于该段字数），最后再一跳跨过段间距',
    ).toBe(view.state.doc.line(1).length + 1)
  })

  it('落点本来就在正文行上时，原样让位给 CodeMirror（不做多余接管）', async () => {
    // 两行紧邻的正文（没有空行）——默认行为必须原样保留
    const { view } = await renderEditor('第一段文字。\n第二段文字。')
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowRight')

    expect(caretLine(view), '紧邻的下一行是正文行，直接落上去').toBe(2)
    expect(caretOffset(view)).toBe(0)
  })
})
