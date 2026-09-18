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

/** 量一行「第一个可见内容」的横向起点。 */
function contentStart(line: HTMLElement): number | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  const textNode = walker.nextNode()
  if (textNode && (textNode.textContent ?? '').length > 0) {
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 1)
    return Math.round(range.getBoundingClientRect().left)
  }
  const firstChild = line.firstElementChild
  if (firstChild) return Math.round(firstChild.getBoundingClientRect().left)
  return null
}

describe('换行后新行的落点', () => {
  it('does not hide the indent of an empty line (so the caret lands where the text will be)', async () => {
    // 「缩进 + 正文」之后跟一个「缩进 + 空行」——
    // 这两行的内容起点必须相等，否则作者会看到「光标没到位」。
    const { view, surface } = await renderEditor(`${INDENT}第一段正文。\n${INDENT}`)
    // 光标放在第一行（正文行），第二行是空行
    view.dispatch({ selection: EditorSelection.single(2) })

    const lines = Array.from(surface.querySelectorAll<HTMLElement>('.cm-line'))
    expect(lines).toHaveLength(2)
    const textLineStart = contentStart(lines[0])
    const emptyLineStart = contentStart(lines[1])
    console.log('[CARET] 正文行起点=', textLineStart, '空行起点=', emptyLineStart, '| 空行文本=', JSON.stringify(lines[1].textContent))

    expect(textLineStart).not.toBeNull()
    expect(
      emptyLineStart,
      `空行(${emptyLineStart}) 与正文行(${textLineStart}) 的内容起点必须一致，否则光标会落在错位的地方`,
    ).toBe(textLineStart)
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
