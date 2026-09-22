/**
 * 换行后「新行的落点」必须与正文段落一致。
 *
 * 先生报的现象：「Enter 一下之后其实没正确落到位置，输入一下才到位；
 * Backspace 一次也没返回到位，必须再按一次。」
 *
 * 根因（本文件守住它）：live-preview 会把行首的缩进空白当 markdown 标记隐藏，
 * 而 CSS 用 `text-indent: 2em` 提供缩进。空行若被隐藏，就渲染成
 * `<div class="cm-line"><br></div>`，**但 text-indent 依然把它推到缩进位** ——
 * 于是光标停在行左缘、视觉内容却在缩进位（实测差 90px），
 * 作者敲下第一个字、缩进字符重新显示后，光标才「跳到位」。
 *
 * 修复：空行不参与隐藏（它本来就没有可隐藏的标记）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INDENT = '\u2003\u2003'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.ui = 'v2'
  container = document.createElement('div')
  container.className = 'app-skin-root light'
  container.style.height = '400px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete document.documentElement.dataset.ui
})

async function renderEditor(content: string): Promise<{ view: EditorView; surface: HTMLElement }> {
  await act(async () => root.render(
    <CodeMirrorEditor content={content} mode="prose" />,
  ))
  const surface = container.querySelector<HTMLElement>('.cm-content')
  expect(surface).toBeTruthy()
  await act(async () => surface!.focus())
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  return { view: view!, surface: surface! }
}

/** 量一行「第一个实义字」的真实横向位置（跳过行首的空白 / 缩进字符）。 */
function glyphLeft(line: HTMLElement): number | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const index = text.search(/[^\s\u2003\u3000]/)
    if (index >= 0) {
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return Math.round(range.getBoundingClientRect().left)
    }
  }
  return null
}

describe('换行后新行的落点', () => {
  /**
   * 这一条此前比较的是「两行第一个字符的 getBoundingClientRect 左缘」——
   * 而两行的第一个字符都是**空白**（em 空格），浏览器对只含空白的 Range 给出的
   * 矩形并不可靠；它当时能绿，只是因为两行都量到了同一个不可靠的值。
   *
   * 先生第六次报障后，带缩进的正文行改为**一律隐藏**行内缩进（错位修复），
   * 于是正文行的「第一个字符」变成了实义字 —— 两个不同的东西一比，假象就露了。
   * 这里改成守**真正要守的东西**：空行上打字的落点，与正文行文字的起点一致。
   */
  it('does not hide the indent of an empty line (so the caret lands where the text will be)', async () => {
    const { view, surface } = await renderEditor(`第一段正文。\n\n${INDENT}第二段正文。\n${INDENT}`)
    const lines = () => Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    expect(lines(), '应当渲染出 4 行').toHaveLength(4)

    // 空行的缩进字符必须照常留在 DOM 里（空行没有可隐藏的标记，藏了只会让落点错位）
    expect(
      lines()[3].textContent,
      '空行的行首缩进字符不应被隐藏',
    ).toBe(INDENT)

    // 带缩进的正文行：缩进交给 CSS，文字起点就是「作者的段落左边」
    const bodyStart = glyphLeft(lines()[2])
    expect(bodyStart, '正文行应当量得到文字起点').not.toBeNull()

    // 在那条带缩进的空行上打一个字 —— 它必须落在与正文行文字相同的位置上
    const emptyLine = view.state.doc.line(4)
    await act(async () => {
      view.dispatch({
        changes: { from: emptyLine.to, insert: '新' },
        selection: { anchor: emptyLine.to + 1 },
      })
    })
    const typedStart = glyphLeft(lines()[3])
    console.log(`[CARET] 正文行文字起点=${bodyStart} 空行打字后首字=${typedStart}`)

    expect(
      typedStart,
      `空行上打下的字(${typedStart}) 必须落在正文行文字的位置(${bodyStart})上 —— `
      + '行内的缩进字符不该把字再推开两格',
    ).toBe(bodyStart)
  })

  it('keeps the indent visible on a fresh empty line created by Enter', async () => {
    const { view, surface } = await renderEditor('第一段正文。')
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
    // 模拟换行（并把缩进一并带上，与 CodeMirror 的 markdown 行为一致）
    await act(async () => {
      view.dispatch(view.state.replaceSelection(`\n${INDENT}`))
    })

    const lines = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    const emptyLine = lines[lines.length - 1]
    const childTags = Array.from(emptyLine.childNodes).map(n => n.nodeName).join(',')
    console.log('[CARET] 新空行 childNodes=', childTags, '| textContent=', JSON.stringify(emptyLine.textContent))

    // 缩进字符必须还在 DOM 里可见（而不是被换成 <br>）
    expect(
      emptyLine.textContent,
      '新行的行首缩进字符不应被隐藏 —— 否则光标会与视觉落点错位',
    ).toBe(INDENT)
  })

  it('still hides the indent on non-empty paragraphs away from the caret', async () => {
    // 反向守护：正文行（非光标行）的缩进仍然要被隐藏，
    // 避免 CSS 的 text-indent 与行内缩进叠成四格。
    const { view, surface } = await renderEditor(`${INDENT}第一段正文。\n第二段正文。`)
    // 光标放到第二行，第一行成为「非光标行」
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })

    const lines = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    const firstLineText = lines[0].textContent ?? ''
    console.log('[CARET] 非光标行的 textContent=', JSON.stringify(firstLineText))

    expect(
      firstLineText,
      '非光标正文行的缩进字符应被隐藏（缩进交给 CSS），以免叠成四格',
    ).toBe('第一段正文。')
  })
})
