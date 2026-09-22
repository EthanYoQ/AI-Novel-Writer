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

    // 点在**正文文字所在的那一列**上 —— 文字左侧的缩进区现在算「框外」，
    // 点那里是无效的（见下面那条测试）
    const head = view.coordsAtPos(view.state.doc.line(1).from)
    const tail = view.coordsAtPos(view.state.doc.line(1).to)
    const clickX = tail ? Math.max(gap.left + 10, (head!.left + tail.right) / 2) : gap.left + 100
    console.log(`[调试·点空行] 相邻行文字 left=${head?.left.toFixed(0)} right=${tail?.right.toFixed(0)}`
      + ` 行块 left=${gap.left.toFixed(0)} 点击 x=${clickX.toFixed(0)}`)

    await mouseDownAt(surface, clickX, gap.top + 3)

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

    // 同上：点正文文字所在的列，而不是它左边的缩进区
    const head = view.coordsAtPos(view.state.doc.line(3).from)
    const tail = view.coordsAtPos(view.state.doc.line(3).to)
    const clickX = tail ? (head!.left + tail.right) / 2 : gap.left + 100

    // y 取段间距的 3/4 处：明确在下半，且不贴着行块下缘（贴边时命中测试会偏到下一行）
    await mouseDownAt(surface, clickX, gap.top + gap.height * 0.75)

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

  /**
   * 先生：「鼠标只要移动出正文框，就变成点击箭头，然后拒绝任何光标相关的事件触发就行了。」
   *
   * 这里取代的是此前那条「点纸页下方留白落到文末」的约定 ——
   * 那个入口曾经是「接着往下写」的捷径，但它同时也是错位光标的来源：
   * 纸页四周的留白本来就不属于任何段落，点下去什么也不该发生。
   * 要接着往下写，点最后一行即可（框内）。
   */
  it('正文框外（纸页留白）点击：不放光标，也不动版面', async () => {
    const { view, surface } = await renderEditor(CONTENT_WITH_TRAILING_BLANK)
    const paper = surface.getBoundingClientRect()
    const before = view.state.selection.main.head
    const topsBefore = lineEls(surface).map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)

    // 左侧留白 + 下方留白（两个方向都在框外）
    await mouseDownAt(surface, paper.left + 20, paper.bottom - 20)

    console.log(`[框外点击] 光标 ${before} → ${view.state.selection.main.head}`)
    expect(view.state.selection.main.head, '框外点击不该放光标').toBe(before)
    expect(
      lineEls(surface).map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10),
      '框外点击更不该改动版面',
    ).toEqual(topsBefore)
  })

  it('正文框外点击后，框内的正常点击仍然照常放光标（没有误伤）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    const paper = surface.getBoundingClientRect()

    // 先在框外点一下 —— 被拒
    await mouseDownAt(surface, paper.left + 20, paper.bottom - 20)
    // 再点正文行（框内）—— 必须正常工作
    const target = view.state.doc.line(3).from + 2
    const coords = view.coordsAtPos(target)!
    await mouseDownAt(surface, coords.left + 1, (coords.top + coords.bottom) / 2)

    expect(caretLineNumber(view), '框内点击必须照常生效').toBe(3)
  })

  /**
   * 先生（补充报障）：
   *   「这种温热的分量压在胸口，仿佛一种无声的应承。／（空）／队伍在稀疏的林木间穿行……」
   *   鼠标在**框外**的空白、对准两个段落中间点一下，光标就跑进去了 ——
   *   而且**恰好在段落中间的 Y 轴处**才会触发。
   *
   * 根因：判断「在不在正文框内」时用的是「坐标 → 位置 → 行块矩形」反推，
   * 而**折行的段落**会让这条反推选错参照行（一段折成两三行时，
   * 段间距那一格与上一段最后一行被混在一起），于是正好点在两段之间的 Y 上就放行了。
   * 现在改成直接问 DOM（`elementFromPoint`），浏览器的命中测试没有这种歧义。
   */
  it('折行长段落之间、框外留白正中点击：无效（光标不许插进段间距）', async () => {
    const LONG = '这种温热的分量压在胸口，仿佛一种无声的应承。'
      + '\n\n'
      + '队伍在稀疏的林木间穿行，午后的日头斜斜挂在西边。'
    const { view, surface } = await renderEditor(LONG)
    const lines = lineEls(surface)
    // 段落折行后仍在同一个 .cm-line 里，所以这里仍是「段A / 空行 / 段B」三个元素
    expect(lines, '折行不改变逻辑行数').toHaveLength(3)
    expect(
      view.lineBlockAt(0).height,
      '前置条件：第一段确实折了行（这正是此前判断失准的场景）',
    ).toBeGreaterThan(view.defaultLineHeight * 1.5)

    const gap = lines[1].getBoundingClientRect()
    const paper = surface.getBoundingClientRect()
    const before = view.state.selection.main.head
    const topsBefore = lines.map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)

    // 先生说的那个 Y：段间距的**正中**
    const middleY = (gap.top + gap.bottom) / 2
    for (const [label, x] of [
      ['框外左', paper.left + 20],
      ['框外右', paper.right - 20],
      ['框外左·更靠外', paper.left + 2],
    ] as const) {
      await mouseDownAt(surface, x, middleY)
      console.log(`[折行段落·${label}] x=${x.toFixed(0)} y=${middleY.toFixed(0)}`
        + ` → 光标 ${before} → ${view.state.selection.main.head}`)
      expect(view.state.selection.main.head, `${label}的框外点击不该放光标`).toBe(before)
      expect(
        lines.map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10),
        `${label}的框外点击不该动版面`,
      ).toEqual(topsBefore)
    }
  })

  /**
   * 先生（附截图）：「鼠标在正文框外边、点击在两个段落中间，就会出现一个光标 —— 这是不对的。」
   *
   * 截图里的红箭头指的是**正文文字左边、但仍在行块之内**的那片空白。
   * 此前「正文框」按行块的宽度算（整栏宽），于是文字两侧的留白被当成了框内而放行；
   * 现在按**文字本身的横向范围**算（DOM Range 包围盒），那些空白一律算框外。
   */
  it('正文文字两侧的留白（仍在行块内）：点击无效；文字上仍照常吸附', async () => {
    const LONG = '这种温热的分量压在胸口，仿佛一种无声的应承。'
      + '\n\n'
      + '队伍在稀疏的林木间穿行，午后的日头斜斜挂在西边。'
    const { view, surface } = await renderEditor(LONG)
    const lines = lineEls(surface)
    const gap = lines[1].getBoundingClientRect()
    const middleY = (gap.top + gap.bottom) / 2
    const lineRect = lines[0].getBoundingClientRect()

    // 独立量一遍「正文文字」实际占的横向范围（与实现同法：逐文本节点量字形）
    const textBounds = (() => {
      let left = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const nodeText = node.textContent ?? ''
        if (nodeText.trim() === '') continue
        const nodeRange = document.createRange()
        nodeRange.selectNodeContents(node)
        for (const rect of nodeRange.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue
          left = Math.min(left, rect.left)
          right = Math.max(right, rect.right)
        }
      }
      return { left, right }
    })()
    console.log(`[几何] 行块 ${lineRect.left.toFixed(0)}..${lineRect.right.toFixed(0)}`
      + ` 文字 ${textBounds.left.toFixed(0)}..${textBounds.right.toFixed(0)}`)

    const before = view.state.selection.main.head
    const topsBefore = lines.map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)

    // ① 缩进区（文字左缘之左、行块之内）—— 截图里那支箭头的落点
    await mouseDownAt(surface, lineRect.left + 10, middleY)
    console.log(`[缩进区] x=${(lineRect.left + 10).toFixed(0)} → 光标 ${before} → ${view.state.selection.main.head}`)
    expect(view.state.selection.main.head, '缩进区点击不该放光标').toBe(before)

    // ② 每行右侧的空档（文字右缘之右）
    const rightGapX = Math.min(textBounds.right + 40, surface.getBoundingClientRect().right - 4)
    await mouseDownAt(surface, rightGapX, middleY)
    console.log(`[文字右侧空档] x=${rightGapX.toFixed(0)} → 光标 ${before} → ${view.state.selection.main.head}`)
    expect(view.state.selection.main.head, '文字右侧空档点击不该放光标').toBe(before)

    expect(
      lines.map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10),
      '框外的点击都不该改动版面',
    ).toEqual(topsBefore)

    // ③ 对照组：点在**文字**上（同一 Y）—— 既有的「吸附到相邻段落」必须照常工作
    const onTextX = (textBounds.left + textBounds.right) / 2
    await mouseDownAt(surface, onTextX, middleY)
    const landed = view.state.selection.main.head
    const landedLine = view.state.doc.lineAt(landed).number
    console.log(`[文字上·对照] x=${onTextX.toFixed(0)} → 光标落在第 ${landedLine} 行`)
    expect(landedLine, '点在正文文字上时，仍应吸附到相邻段落').not.toBe(2)
    expect(landedLine, '且应当紧邻段间距').toBeLessThanOrEqual(3)
  })

  /**
   * 先生：「刷新后，我鼠标在编辑器框外点击，依然会让编辑器框体变色、控制其中的光标。」
   *
   * 「框体变色」= 编辑器被聚焦（`.cm-focused`）。原因是按下处理挂在**冒泡阶段**：
   * CodeMirror 自己的处理在 contentDOM 上先跑完（聚焦 + 放插入点），
   * 我们再 preventDefault 已经晚一步。现在改到**捕获阶段**并 stopPropagation。
   */
  it('正文框外点击：编辑器不该被聚焦（框体不该变色）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    const editorEl = container.querySelector<HTMLElement>('.cm-editor')!
    const paper = surface.getBoundingClientRect()

    // 先主动让步：把焦点从编辑器上移开
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur()
    })
    await settle()
    const focusedBefore = editorEl.classList.contains('cm-focused')
    console.log(`[框外聚焦] 点击前 hasFocus=${view.hasFocus} cm-focused=${focusedBefore}`)

    await mouseDownAt(surface, paper.left + 20, paper.bottom - 20)

    console.log(`[框外聚焦] 点击后 hasFocus=${view.hasFocus} cm-focused=${editorEl.classList.contains('cm-focused')}`)
    expect(view.hasFocus, '框外点击不该让编辑器拿到焦点').toBe(false)
    expect(editorEl.classList.contains('cm-focused'), '框体不该因框外点击而变色').toBe(false)
  })

  /**
   * 先生：「给鼠标点击正文框外加一个功能，就是让正文框本来在工作的时候的红色提示消失吧。
   *        不然完全没任何反应也有点奇怪。」
   *
   * 编辑中的朱砂光标（`.cm-cursor`）只在编辑器聚焦时显示。
   * 框外点击作为「退出编辑」的手势：正文一概不动，只让那份工作提示消失。
   */
  it('正文框外点击：退出编辑状态（工作时的提示消失）', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    const editorEl = container.querySelector<HTMLElement>('.cm-editor')!
    const paper = surface.getBoundingClientRect()

    // 先进入编辑状态
    await act(async () => view.focus())
    await settle()
    expect(view.hasFocus, '前置条件：编辑器处于编辑状态').toBe(true)
    const headBefore = view.state.selection.main.head

    await mouseDownAt(surface, paper.left + 20, paper.bottom - 20)

    console.log(`[框外退出编辑] hasFocus=${view.hasFocus} cm-focused=${editorEl.classList.contains('cm-focused')}`
      + ` 光标 ${headBefore} → ${view.state.selection.main.head}`)
    expect(view.hasFocus, '框外点击应当让编辑器退出编辑状态').toBe(false)
    expect(editorEl.classList.contains('cm-focused'), '工作提示（聚焦态）应当消失').toBe(false)
    expect(view.state.selection.main.head, '但正文里的光标位置一概不动').toBe(headBefore)
  })

  it('鼠标形状：正文框外是普通箭头，框内仍是文本光标', async () => {
    const { surface } = await renderEditor(CONTENT)
    const bodyLine = lineEls(surface)[0]

    const paperCursor = getComputedStyle(surface).cursor
    const bodyCursor = getComputedStyle(bodyLine).cursor
    console.log(`[鼠标形状] 纸页留白=${paperCursor} 正文行=${bodyCursor}`)

    expect(paperCursor, '纸页留白处应当是普通箭头 —— 那里不接受落笔').toBe('default')
    expect(bodyCursor, '正文行内仍须是文本光标').toBe('text')
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
