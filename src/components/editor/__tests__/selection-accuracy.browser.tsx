import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'

import CodeMirrorEditor from '../CodeMirrorEditor'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'

/**
 * 先生（鼠标选取偶尔「发瓢」）：拖选的落点必须与鼠标所在字符一致。
 *
 * 检验方式是完全往返的：用 CodeMirror 自己的 coordsAtPos() 取某字符的屏幕坐标，
 * 在该坐标派发真实鼠标事件，再看 posAtCoords() 是否回到同一个字符位置。
 * 若两者对不上，说明 CSS（text-indent / line-height / padding / 折行）让
 * 坐标映射发生了系统性偏移 —— 那正是「发瓢」的来源。
 */

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONTENT = [
  '\u3000\u3000夜色沉了下来。他站在门口，没有说话。',
  '',
  '\u3000\u3000院子里那盏灯还亮着，像是等人回来。',
  // 这一行刻意不带缩进字符，用来覆盖 .cm-lp-indent（由 CSS 补缩进）的坐标行为
  '他终于开口：「进来吧，外面冷。」',
].join('\n')

let container: HTMLDivElement | undefined
let root: Root | undefined

function currentView(): EditorView {
  const dom = container?.querySelector('.cm-editor')
  if (!dom) throw new Error('未找到 .cm-editor')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('未能取回 EditorView')
  return view
}

function mouse(type: string, x: number, y: number): MouseEvent {
  // buttons: CodeMirror 靠它判断拖选是否仍在进行
  return new MouseEvent(type, {
    clientX: x,
    clientY: y,
    buttons: type === 'mouseup' ? 0 : 1,
    button: 0,
    detail: 1,
    bubbles: true,
    cancelable: true,
    view: window,
  })
}

/** 把某个文档位置「往返」一次：取坐标 → 派发鼠标 → 问它认为这是哪一位。 */
function roundTrip(view: EditorView, pos: number): number | null {
  const coords = view.coordsAtPos(pos)
  if (!coords) return null
  const x = coords.left + 1
  const y = (coords.top + coords.bottom) / 2
  return view.posAtCoords({ x, y })
}

describe('鼠标选取落点一致性', () => {
  beforeEach(async () => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useUiVersionStore.setState({ uiVersion: 'v2' })
    document.documentElement.dataset.ui = 'v2'
    document.documentElement.dataset.v2Theme = '0'
    container = document.createElement('div')
    container.style.height = '600px'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CodeMirrorEditor
          mode="prose"
          content={CONTENT}
          editable
          hideStatusBar
          onChange={() => {}}
          onCharCountChange={() => {}}
        />,
      )
    })
    /**
     * 等字体就绪再量坐标。
     *
     * 本文件第一段的首字被 `.cm-lp-dropcap-char` 放大到 3.15em（约 52px），
     * 而「鼠标落在字符左半还是右半」这条分界就压在它的左缘上 ——
     * 字体加载完成前后，字形宽度不同，分界跟着挪，往返检查会偶发
     * 「第1行 offset=2("夜") → 往返得到 3」。
     * 实测（完整套件连跑）：`document.fonts.status` 常处于 `loading`，
     * 补上这一等之后结果才可复现。这是测量的前提，不是对断言的放宽。
     */
    await act(async () => {
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    container = undefined
    root = undefined
  })

  it('每个可见字符的坐标往返后都回到原位（缩进、段落、标点处都要准）', () => {
    const view = currentView()
    const mismatches: string[] = []
    let checked = 0
    let skippedBlank = 0

    for (let lineNo = 1; lineNo <= 4; lineNo += 1) {
      const line = view.state.doc.line(lineNo)
      for (let pos = line.from; pos <= line.to; pos += 1) {
        // 行首的空白字符没有可见字形，鼠标落在那里必然吸附到最近的可测量边界，
        // 这属于合理行为而非坐标缺陷，跳过（数量单独计数以便观察）。
        const char = pos < line.to ? line.text[pos - line.from] : ''
        if (/[\s\u2003\u3000]/.test(char)) {
          skippedBlank += 1
          continue
        }
        checked += 1
        const back = roundTrip(view, pos)
        if (back !== pos) {
          mismatches.push(`第${lineNo}行 offset=${pos - line.from}(${JSON.stringify(char)}) → 往返得到 ${back}`)
        }
      }
    }

    console.log(`往返检查：实检 ${checked} 个可见字符，跳过行首空白 ${skippedBlank} 个，不符 ${mismatches.length} 处`)
    for (const item of mismatches.slice(0, 12)) console.log(`  ${item}`)
    expect(mismatches).toEqual([])
  })

  it('真实拖选能选中鼠标覆盖的那段文字', async () => {
    const view = currentView()
    const line = view.state.doc.line(1)
    const startPos = line.from + 3
    const endPos = line.from + 8
    const startCoords = view.coordsAtPos(startPos)
    const endCoords = view.coordsAtPos(endPos)
    if (!startCoords || !endCoords) throw new Error('缺少坐标')

    await act(async () => {
      view.focus()
      view.contentDOM.dispatchEvent(mouse('mousedown', startCoords.left + 1, (startCoords.top + startCoords.bottom) / 2))
      document.dispatchEvent(mouse('mousemove', endCoords.left + 1, (endCoords.top + endCoords.bottom) / 2))
      document.dispatchEvent(mouse('mouseup', endCoords.left + 1, (endCoords.top + endCoords.bottom) / 2))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const selected = view.state.selection.main
    console.log(
      `拖选结果：from=${selected.from} to=${selected.to} 期望=${startPos}..${endPos} `
      + `选中文字=${JSON.stringify(view.state.sliceDoc(selected.from, selected.to))}`,
    )
    expect(selected.from).toBe(startPos)
    expect(selected.to).toBe(endPos)
  })

  it('段落缩进恒定：空行与正文行同为 2em，打字时不跳变也不叠格', async () => {
    const view = currentView()
    const emptyLine = view.state.doc.line(2)
    expect(emptyLine.text, '第 2 行应当是空行').toBe('')

    const lineAt = (index: number) => container?.querySelectorAll('.cm-line')[index] as HTMLElement | undefined
    const indentOfEmpty = getComputedStyle(lineAt(1) as HTMLElement).textIndent
    /**
     * 对照行刻意取第 3 行，不取第 1 行。
     *
     * 第 1 行是**光标行**，而带行内缩进的光标行现在会把 CSS 缩进归零
     * （行内那两个字符自己占 2em，见 live-preview 的 `cm-lp-indent-live` 与 v2-editor.css）——
     * 那是「点击某段就整段横向错位两格」的修复落点。它的 text-indent 值因此是 0，
     * 但**视觉起点仍是 2em**，与这里要守的「缩进恒定」并不冲突。
     * 第 3 行既是正文行、又不是光标行，才是与空行同类可比的对照。
     */
    const indentOfBody = getComputedStyle(lineAt(2) as HTMLElement).textIndent
    console.log(`诊断：空行 text-indent = ${indentOfEmpty}，非光标正文行 = ${indentOfBody}`)
    // 空行必须与正文行同值 —— 否则第一下敲字时缩进会从 0 跳到 2em，整行横跳
    expect(indentOfEmpty).toBe(indentOfBody)
    expect(parseFloat(indentOfEmpty)).toBeGreaterThan(0)

    await act(async () => {
      view.dispatch({
        changes: { from: emptyLine.from, insert: '夜' },
        selection: { anchor: emptyLine.from + 1 },
      })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const indentAfterTyping = getComputedStyle(lineAt(1) as HTMLElement).textIndent
    console.log(`诊断：打下第一个字后的 text-indent = ${indentAfterTyping}`)
    expect(indentAfterTyping).toBe(indentOfEmpty)
  })

  it('行内的缩进字符会被隐藏，避免与 CSS 缩进叠成四格', async () => {
    const view = currentView()
    const bodyLine = view.state.doc.line(1) // 以两个全角空格起笔
    expect(bodyLine.text.startsWith('\u3000\u3000')).toBe(true)

    // 把光标挪走，让该行不处于编辑态（编辑中的行保留标记可见）
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(4).from } })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    const firstLineText = (container?.querySelectorAll('.cm-line')[0] as HTMLElement | undefined)?.textContent ?? ''
    console.log(`诊断：第一行渲染出的文字 = ${JSON.stringify(firstLineText)}`)
    // 行首的两个全角空格应当已被抹掉，只留正文
    expect(firstLineText.startsWith('\u3000')).toBe(false)
    expect(firstLineText).toContain('夜色沉了下来')
  })
})
