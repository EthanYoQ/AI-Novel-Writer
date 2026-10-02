/**
 * 段落文字的横向排列必须恒定 —— 光标停在哪一段、选区头划过哪一段，都不许错位。
 *
 * 先生（第六次报障）：
 *   「在正文中，左键点击或者左键长按选中内容的时候，会出现排列开始错位的现象。」
 *
 * 实测（Chromium + v2 皮肤）确认的机制：
 *   正文里 AI 生成 / 粘贴进来的段落，段首常带一排行内缩进字符（全角空格）。
 *   live-preview 本来把这排字符隐去、缩进交给 CSS 的 `text-indent: 2em`，
 *   **但光标所在行例外**（当时的用意是让作者看得见、能编辑）。
 *   于是那一行同时吃到两份缩进：CSS 的 2em ＋ 显形字符的 2em = **四格**，
 *   比其余段落右移整整 2 格（实测 33.3px）：
 *     · 左键点某一段 → 那一段整段横向错位；
 *     · 按住左键拖选   → 指针划过的段落依次错位，通篇参差不齐。
 *
 * 修法：光标行保留缩进字符可见（作者要能看见、能编辑），但让 CSS 的缩进**给行内字符让位** ——
 * live-preview 给光标行打 `cm-lp-indent-live`，v2-editor.css 把该行的 `text-indent` 归零。
 * 两份缩进于是只剩一份：
 *   非光标行（字符被隐去）→ 文字起点 = CSS 给的 2em；
 *   光标行  （字符显形）  → 文字起点 = 行内那两个字符自己占的 2em。
 * 两边都是 2em，光标进出这一行时一个字都不动，点选与拖选也不再让某一段跳走。
 *
 * 测量手段刻意用 **DOM Range** 直接量「第一个实义字」的真实位置，
 * 不走 `coordsAtPos` —— 它读的是 CodeMirror 自己的坐标账本，
 * 而本 bug 恰恰是「账本与现实对不上」这一类。
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

/** 第 1 段留作首字下沉（浮动大字，不参与横向测量）；3 / 5 / 7 行交替「带缩进 / 不带缩进」。 */
const CONTENT = [
  '夜色沉了下来。',            // 行1 首字下沉行
  '',
  '\u3000\u3000院子里那盏灯还亮着。', // 行3 带行内缩进（AI 生成的典型格式）
  '',
  '他终于开口：「进来吧。」',       // 行5 无行内缩进
  '',
  '\u3000\u3000外面下起了细雨。',   // 行7 带行内缩进
  '',
  '灯影在墙上摇晃。',            // 行9 无行内缩进
].join('\n')

/** 参与横向对齐比较的行（跳过首字下沉行）。 */
const MEASURED_LINES = [3, 5, 7, 9]

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

/** 该行「第一个可见实义字」的真实屏幕 x —— 直接量 DOM Range。 */
function glyphLeft(surface: HTMLElement, lineNumber: number): number | null {
  const lineEl = surface.querySelectorAll<HTMLElement>('.cm-line')[lineNumber - 1]
  if (!lineEl) return null
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const index = text.search(/[^\s\u2003\u3000]/)
    if (index >= 0) {
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return Math.round(range.getBoundingClientRect().left * 10) / 10
    }
  }
  return null
}

function alignReport(surface: HTMLElement): { xs: Record<number, number | null>; spread: number } {
  const xs: Record<number, number | null> = {}
  for (const line of MEASURED_LINES) xs[line] = glyphLeft(surface, line)
  const values = Object.values(xs).filter((value): value is number => value != null)
  const spread = values.length > 1 ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10 : 0
  return { xs, spread }
}

/**
 * 两个横向位置的差。
 *
 * 容 1px 是必要的：光标行的缩进由行内那两个全角空格自己占（实测 33.3px），
 * 非光标行由 CSS 的 `text-indent: 2em`（33px）提供 —— 两者相差一个亚像素，
 * 视觉上看不出，但 `toBe` 会红。
 */
function gap(a: number | null, b: number | null): number {
  if (a == null || b == null) return Number.POSITIVE_INFINITY
  return Math.round(Math.abs(a - b) * 10) / 10
}

async function setCaret(view: EditorView, pos: number): Promise<void> {
  await act(async () => {
    view.dispatch({ selection: { anchor: pos } })
  })
  await settle()
}

function mouse(type: string, x: number, y: number): MouseEvent {
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

describe('段落横向排列恒定（光标 / 选区不许让某一段错位）', () => {
  it('光标落在带行内缩进的段落上时，该段文字不移动', async () => {
    const { view, surface } = await renderEditor(CONTENT)

    await setCaret(view, view.state.doc.line(5).from)
    const baseline = alignReport(surface)
    console.log(`[基准·光标在第5行] ${JSON.stringify(baseline.xs)} 最大差=${baseline.spread}px`)
    expect(baseline.spread, `本来就不该有错位：${JSON.stringify(baseline.xs)}`).toBeLessThanOrEqual(1)

    // 光标移进带缩进的段落 —— 修复前这一行会右移 2 格（实测 33.3px）
    await setCaret(view, view.state.doc.line(3).from)
    const onIndented = alignReport(surface)
    console.log(`[光标在第3行·带缩进] ${JSON.stringify(onIndented.xs)} 最大差=${onIndented.spread}px`)

    expect(
      onIndented.spread,
      `光标停到带缩进的段落上，那一段不该横向错位：${JSON.stringify(onIndented.xs)}`,
    ).toBeLessThanOrEqual(1)
    expect(gap(onIndented.xs[3], baseline.xs[3]), '第 3 行首字必须留在原位').toBeLessThanOrEqual(1)

    await setCaret(view, view.state.doc.line(7).from)
    const onIndented7 = alignReport(surface)
    console.log(`[光标在第7行·带缩进] ${JSON.stringify(onIndented7.xs)} 最大差=${onIndented7.spread}px`)
    expect(onIndented7.spread, `任何一行当光标行时都不许错位：${JSON.stringify(onIndented7.xs)}`).toBeLessThanOrEqual(1)
  })

  it('左键点击带缩进的段落：整段文字一动不动', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, view.state.doc.line(9).from)
    const before = alignReport(surface)

    const target = surface.querySelectorAll<HTMLElement>('.cm-line')[2].getBoundingClientRect()
    await act(async () => {
      view.focus()
      surface.dispatchEvent(mouse('mousedown', target.left + 40, target.top + target.height / 2))
    })
    await settle()

    const during = alignReport(surface)
    console.log(`[点击第3行·按下时] ${JSON.stringify(during.xs)} 最大差=${during.spread}px`)
    expect(during.spread, `点击带缩进的段落不该让它错位：${JSON.stringify(during.xs)}`).toBeLessThanOrEqual(1)
    expect(gap(during.xs[3], before.xs[3]), '第 3 行首字位置不该因点击而变').toBeLessThanOrEqual(1)

    await act(async () => {
      window.dispatchEvent(mouse('mouseup', target.left + 40, target.top + target.height / 2))
    })
    await settle()
    const after = alignReport(surface)
    expect(after.spread, '松手后同样不许错位').toBeLessThanOrEqual(1)
  })

  it('按住左键拖选、指针划过带缩进的段落：整篇排列保持整齐', async () => {
    const { view, surface } = await renderEditor(CONTENT)
    await setCaret(view, 0)
    const before = alignReport(surface)

    const first = surface.querySelectorAll<HTMLElement>('.cm-line')[0].getBoundingClientRect()
    await act(async () => {
      view.focus()
      surface.dispatchEvent(mouse('mousedown', first.left + 5, first.top + first.height / 2))
    })
    await settle()

    for (const lineIndex of [2, 4, 6, 8]) {
      const rect = surface.querySelectorAll<HTMLElement>('.cm-line')[lineIndex].getBoundingClientRect()
      await act(async () => {
        document.dispatchEvent(mouse('mousemove', rect.left + 40, rect.top + rect.height / 2))
      })
      await settle()
      const report = alignReport(surface)
      const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
      console.log(`[拖到第${lineIndex + 1}行·选区头在第${headLine}行] ${JSON.stringify(report.xs)} 最大差=${report.spread}px`)
      expect(
        report.spread,
        `拖选经过第 ${lineIndex + 1} 行时全篇仍须对齐：${JSON.stringify(report.xs)}`,
      ).toBeLessThanOrEqual(1)
    }

    await act(async () => {
      document.dispatchEvent(mouse('mouseup', 0, 0))
    })
    await settle()
    const after = alignReport(surface)
    for (const line of MEASURED_LINES) {
      expect(gap(after.xs[line], before.xs[line]), `第 ${line} 行首字应当回到原处`).toBeLessThanOrEqual(1)
    }
  })

  it('markdown 标记照旧：光标所在行仍然显示语法（缩进字符的隐藏不外溢）', async () => {
    const { view, surface } = await renderEditor('# 标题行\n\n**加粗**的正文。')
    // 光标停在加粗那段 —— `**` 是光标行，必须照常显示，作者要能改语法
    await setCaret(view, view.state.doc.line(3).from + 3)

    const boldLine = surface.querySelectorAll<HTMLElement>('.cm-line')[2]
    console.log(`[光标行 markdown] ${JSON.stringify(boldLine.textContent)}`)
    expect(boldLine.textContent, '光标行的强调标记仍应显示').toContain('**')
  })

  it('光标行的缩进字符照常显形，但 CSS 缩进让位（不叠成四格）', async () => {
    // 这是本次修复的落点：光标行**保留**缩进字符可见（作者要能看见、能改），
    // 同时由 v2-editor.css 把该行的 text-indent 归零 —— 两份缩进只留一份。
    const { view, surface } = await renderEditor(CONTENT)
    const line3 = () => surface.querySelectorAll<HTMLElement>('.cm-line')[2]

    await setCaret(view, view.state.doc.line(9).from)
    expect(line3().textContent, '非光标行的缩进应当被隐去（缩进交给 CSS）').not.toContain('\u3000\u3000')

    await setCaret(view, view.state.doc.line(3).from)
    expect(line3().textContent, '光标行的缩进字符应当显形 —— 作者要能看见、能编辑').toContain('\u3000\u3000')

    const report = alignReport(surface)
    console.log(`[光标行显形] ${JSON.stringify(report.xs)} 最大差=${report.spread}px`)
    expect(
      report.spread,
      `缩进字符显形时文字起点仍须与其余段落对齐：${JSON.stringify(report.xs)}`,
    ).toBeLessThanOrEqual(1)
  })

  it('v3「时尚杂志」外壳下同样不对齐就报错（v3 编辑器排版承自 v2，行为必须一致）', async () => {
    useUiVersionStore.setState({ uiVersion: 'v3' })
    document.documentElement.setAttribute('data-mag', '1')
    try {
      const { view, surface } = await renderEditor(CONTENT)

      await setCaret(view, view.state.doc.line(9).from)
      const baseline = alignReport(surface)

      await setCaret(view, view.state.doc.line(3).from)
      const onIndented = alignReport(surface)
      console.log(`[v3·光标在第3行] ${JSON.stringify(onIndented.xs)} 最大差=${onIndented.spread}px`)

      expect(onIndented.spread, `v3 下同样不许错位：${JSON.stringify(onIndented.xs)}`).toBeLessThanOrEqual(1)
      expect(gap(onIndented.xs[3], baseline.xs[3]), 'v3 下第 3 行首字必须留在原位').toBeLessThanOrEqual(1)
    } finally {
      document.documentElement.removeAttribute('data-mag')
      useUiVersionStore.setState({ uiVersion: 'v2' })
    }
  })
})
