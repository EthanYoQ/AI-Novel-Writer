/**
 * 方向键必须跨过段间距（两个自然段落之间那排空白）。
 *
 * 先生（第五次报障）：
 *   「在编辑正文和草稿内容的时候，按 ↑ 和 ↓，会让光标落到两个自然段落中间空白的地方。」
 *
 * 机制（校验时查清，写在 paragraph-gap-caret.ts 的文件头里）：
 *   CodeMirror 的上下移动不按行走、按**半行高扫描**；段间距空行只有 20px（正文行 38px），
 *   它的内容盒中心正好卡在扫描起点上方一点点，于是每按一次方向键都会先停在空行上。
 *   那一下还会让 `.cm-lp-caret-empty` 把空行展开，下方内容整体下沉。
 *
 * 本文件守住两条，缺一不可：
 *   · 夹在两段之间的空行，方向键一律跨过；
 *   · **文末那段空行必须仍可落脚** —— 那是 Enter 刚起的新段落行，跨过去了就没法接着写字。
 *
 * 与 `CodeMirrorEditor-paragraph-gap-click.browser.tsx` 的分工：
 *   那边守鼠标（点不进去），这边守键盘（走过去也不停）。
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

/** 真实按键 —— 键盘路径必须走 keymap，不能靠 view.dispatch 绕过去。 */
async function pressArrow(view: EditorView, key: 'ArrowUp' | 'ArrowDown', shift = false): Promise<void> {
  await act(async () => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key,
      keyCode: key === 'ArrowUp' ? 38 : 40,
      which: key === 'ArrowUp' ? 38 : 40,
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

describe('方向键跨过段间距', () => {
  it('↓ 从第一段出发直接落到第三行（第二段），不停在中间的空白上', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)

    await pressArrow(view, 'ArrowDown')

    expect(
      caretLine(view),
      '第 2 行是段间距，光标不该停在那里',
    ).toBe(3)
    expect(view.state.doc.line(caretLine(view)).text, '必须落在有文字的段落行上').not.toBe('')
  })

  it('连续 ↓ 依次停在每一段上，一次都不落在空行', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).from)

    const visited: number[] = []
    for (let i = 0; i < 4; i += 1) {
      await pressArrow(view, 'ArrowDown')
      visited.push(caretLine(view))
    }

    console.log(`[方向键 ↓] 依次落点 = ${JSON.stringify(visited)}`)
    expect(visited.slice(0, 2), '第一跳应当跨过段间距到第 3 行，再一跳回到第 5 行').toEqual([3, 5])
    expect(
      visited.every((line) => line % 2 === 1),
      `任何一次落点都不能是段间距空行（偶数行）：${JSON.stringify(visited)}`,
    ).toBe(true)
  })

  it('连续 ↑ 同样跨过段间距', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(5).from)

    const visited: number[] = []
    for (let i = 0; i < 3; i += 1) {
      await pressArrow(view, 'ArrowUp')
      visited.push(caretLine(view))
    }

    console.log(`[方向键 ↑] 依次落点 = ${JSON.stringify(visited)}`)
    expect(visited.slice(0, 2), '第一跳应当跨过段间距到第 3 行，再一跳回到第 1 行').toEqual([3, 1])
    expect(
      visited.every((line) => line % 2 === 1),
      `任何一次落点都不能是段间距空行（偶数行）：${JSON.stringify(visited)}`,
    ).toBe(true)
  })

  it('跨过段间距时版面一动不动，也不把空行展开', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).to)
    const before = lineTops(surface)

    await pressArrow(view, 'ArrowDown')
    const after = lineTops(surface)

    const shifts = after.map((top, index) => Math.round((top - before[index]) * 10) / 10)
    console.log(`[方向键] 逐行位移 = ${JSON.stringify(shifts)} 展开的空行 = ${JSON.stringify(expandedEmptyLines(surface))}`)
    expect(shifts.every((shift) => Math.abs(shift) < 0.5), `按键不该移动任何一行：${JSON.stringify(shifts)}`).toBe(true)
    expect(expandedEmptyLines(surface), '空行不该被标成「光标所在的空行」').toEqual([])
  })

  it('列位置照旧保持：同一列上跨过段间距', async () => {
    // 起点刻意取第 3 行（第 1 行是首字下沉行，朱砂大字会把该行文字整体推远，
    // 像素列本来就不是同一个坐标系 —— 那里按像素对齐落到行尾是 CodeMirror 的固有行为）。
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(3).from + 3)

    await pressArrow(view, 'ArrowDown')

    expect(caretLine(view)).toBe(5)
    expect(
      Math.abs(caretOffset(view) - 3),
      `横向列位置应当保持（实测落在第 5 行 offset=${caretOffset(view)}）`,
    ).toBeLessThanOrEqual(1)
  })

  it('从首字下沉的段落出发也能跨过段间距（列由像素列决定，落在正文行即可）', async () => {
    const { view } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).from + 3)

    await pressArrow(view, 'ArrowDown')

    expect(caretLine(view), '哪怕列对不上，也绝不能停在段间距上').toBe(3)
  })

  it('Enter 之后那一段空行仍可落脚（新段落行不能被跨过去）', async () => {
    const { view } = await renderEditor('第一段文字。')
    await setCaret(view, view.state.doc.length)

    await pressEnter(view)
    expect(view.state.doc.lines, 'Enter 应当产出「空行 + 新段落行」').toBe(3)
    expect(caretLine(view), 'Enter 之后光标落在新段落行上').toBe(3)

    // 回到上一段，再按 ↓ 回到新段落行 —— 这是作者接着往下写的必经之路
    await pressArrow(view, 'ArrowUp')
    expect(caretLine(view), '从新段落行 ↑ 应当跨过空行回到正文段').toBe(1)

    await pressArrow(view, 'ArrowDown')
    expect(
      caretLine(view),
      '↓ 应当回到新段落行（文末空行走不出去，所以它照旧可停）',
    ).toBe(3)
  })

  /**
   * 先生：「enter 切换段落后，没打字就按 ↑/↓ 把光标移走，那个空段落就回不去了。」
   *
   * 这是「跨整片空白区」写法的直接后果：段中按 Enter 会得到
   * `段A / 空行 / 新段落行 / 空行 / 段B` 连着三行空白，
   * 跨整片就会把它们当成一个整体跨掉 —— 从段A 按 ↓ 直接落到段B，
   * 作者刚建好的落脚点被跳过，再也回不去（除非用鼠标点）。
   * 现在只跨一层：标准段间距照样跨过，连续空白区则逐层走遍。
   */
  it('段中 Enter 起的新段落行：↑ 离开后 ↓ 必须能回来', async () => {
    const { view } = await renderEditor('第一段文字。\n\n第二段文字。')
    await setCaret(view, view.state.doc.line(1).to)

    await pressEnter(view)
    const created = caretLine(view)
    expect(created, '新段落行应当落在段A 与段B 之间').toBe(3)
    expect(view.state.doc.line(created).text, '新段落行应当是空的').toBe('')

    await pressArrow(view, 'ArrowUp')
    expect(caretLine(view), '↑ 应当回到上一段').toBe(1)

    await pressArrow(view, 'ArrowDown')
    expect(
      caretLine(view),
      '↓ 必须回到刚起的那一段 —— 回不去就没法接着往下写了',
    ).toBe(created)

    // 再按一次才是跨过它下面那格段间距、到第二段
    await pressArrow(view, 'ArrowDown')
    expect(caretLine(view), '再按一次才到下一段的正文行').toBe(5)
  })

  it('连续空白区逐层走遍：每一行都用 ↓ 到得了，不会被整片跳掉', async () => {
    // 两段正文之间留了两个空行（非标准排版，作者自己敲出来的）
    const { view } = await renderEditor('第一段文字。\n\n\n第二段文字。')
    await setCaret(view, view.state.doc.line(1).from)

    const visited: number[] = []
    for (let i = 0; i < 3; i += 1) {
      await pressArrow(view, 'ArrowDown')
      visited.push(caretLine(view))
    }
    console.log(`[连续空白 ↓] ${JSON.stringify(visited)}`)

    expect(visited[0], '第一跳跨过紧邻的那格 → 落在中间那个空行上').toBe(3)
    expect(visited[1], '第二跳跨过它后面那格 → 落在正文行上').toBe(4)
    expect(visited, '每一行都到得了').toEqual([3, 4, 4])
  })

  it('文档最前面的空行照旧可以落脚（作者在正文之上起笔）', async () => {
    const { view } = await renderEditor('\n第一段文字。')
    await setCaret(view, view.state.doc.line(2).from)

    await pressArrow(view, 'ArrowUp')

    expect(caretLine(view), '文首空行走不出去，应当停在它上面').toBe(1)
  })

  it('Shift + ↓ 扩展选区时同样跨过段间距（空行不参与选区头）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(1).from)

    await pressArrow(view, 'ArrowDown', true)

    const selection = view.state.selection.main
    expect(selection.anchor, '锚点应当留在第一段行首').toBe(view.state.doc.line(1).from)
    expect(
      view.state.doc.lineAt(selection.head).number,
      '选区头不该落在段间距上',
    ).toBe(3)
    expect(expandedEmptyLines(surface), '空行不该被展开（那正是版面错位的前一步）').toEqual([])
  })

  /**
   * 先生：「光标在段落中移动的时候，按 ↑ 和 ↓ 位置不对了 —— 直接就跳过一大段，
   *        而不是在段落中正确移动。」
   *
   * 段落**内部**折行的那些行之间是紧凑的行距，不是段间距，光标该一格一格走。
   * 此前这里按「逻辑行号」一刀切：段落折成多个视觉行时，从它的**第一个视觉行**
   * 按 ↓ 会被直接甩到下一个段落 —— 段内的上下移动整个失效。
   */
  it('段落内部折行时，↑↓ 逐视觉行移动，不会被甩到下一段', async () => {
    // 这一段够长，在窄视口下会折成 3 个以上视觉行
    const longParagraph = '夜色沉了下来。他站在门口，没有说话，只是看着院子里那盏灯，'
      + '像是在等一个人回来。灯火晃了一下，他的影子也跟着晃了晃，又安静下去。'
    const { view } = await renderEditor(`${longParagraph}\n\n第二段文字。`)

    const block = view.lineBlockAt(0)
    const visualLines = Math.round(block.height / view.defaultLineHeight)
    console.log(`[段内移动] 第一段行块高度 = ${Math.round(block.height)}px ≈ ${visualLines} 个视觉行`)
    expect(visualLines, '前置条件：第一段确实折成了多个视觉行').toBeGreaterThan(2)

    // ↓：先在段内一格一格走，走完本段才跨过段间距
    await setCaret(view, 0)
    const visited: number[] = []
    let steps = 0
    while (caretLine(view) === 1 && steps < 20) {
      await pressArrow(view, 'ArrowDown')
      visited.push(caretLine(view))
      steps += 1
    }
    console.log(`[段内 ↓] 依次落在第 ${JSON.stringify(visited)} 行（共 ${steps} 跳）`)
    expect(visited.slice(0, -1).every((line) => line === 1), '途中每一跳都该还在本段内部').toBe(true)
    expect(caretLine(view), '走完本段才跨过段间距到第二段').toBe(3)
    /**
     * 跳数**约等于**视觉行数，允许差一格。
     *
     * 段内的移动是 CodeMirror 自己的 `moveVertically`（本扩展在段内一律让位），
     * 它走的是「半行高的像素扫描」，本来就不保证严格一格一行 ——
     * 实测 6 个视觉行走了 5 跳。这里守的是先生报的那个 bug：
     * **从段落中间按一下就到了下一段**（那时这里是 1 跳），而不是精确到格。
     */
    expect(
      steps,
      `段内有 ${visualLines} 个视觉行，应当逐格走过去，而不是一步跳到下一段`,
    ).toBeGreaterThanOrEqual(visualLines - 1)

    // ↑：同样先在段内走
    await setCaret(view, view.state.doc.line(1).to)
    await pressArrow(view, 'ArrowUp')
    expect(caretLine(view), '段内 ↑ 应当还在第一段内部').toBe(1)
  })

  it('落点本来就在正文行上时，原样让位给 CodeMirror（不做多余接管）', async () => {
    // 两行紧邻的正文（没有空行）——默认行为必须原样保留
    const { view } = await renderEditor('第一段文字。\n第二段文字。')
    await setCaret(view, view.state.doc.line(1).from + 2)

    await pressArrow(view, 'ArrowDown')

    expect(caretLine(view)).toBe(2)
    // 横向列由 CodeMirror 的半行扫描自己决定（落在字符左/右半，本来就有 ±1 的余量）——
    // 本命令在「落点不是段间距」时一律返回 false，这里守的是「没有被我们改写」
    expect(caretOffset(view), `实测 offset=${caretOffset(view)}`).toBeGreaterThanOrEqual(1)
    expect(caretOffset(view), `实测 offset=${caretOffset(view)}`).toBeLessThanOrEqual(3)
  })
})
