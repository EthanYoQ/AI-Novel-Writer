/**
 * Enter 与 Backspace 的行为：**一次 Enter 产出正确的段落结构，一次 Backspace 对称地撤销**。
 *
 * 先生：「按下 Enter 之后光标换行但没有落到位置，输入任意内容后才正确。
 *        删除时按两次 Backspace 才会正确。」
 * 先生（第二轮）：「enter 必须两下才能正确到内容。」
 *
 * 实测确认的真凶有两条，都出在 markdown 默认绑给 Enter 的「续写标记」命令上：
 *
 *   ① 它只插入**一个**换行。而本项目的排版约定是
 *      「段落与段落之间必须保留一个空行作为分隔」（services/prompt-templates.ts
 *      的强制排版要求，AI 生成的草稿也全是这个格式）——
 *      于是作者在段末按一次 Enter，得到的是「紧贴上一段的新行」，段落结构与文档其余部分
 *      不一致，必须再按一次才凑出那个空行。这就是「enter 要两下」。
 *      → 现在：当前行有内容时插入**两个**换行（空行 + 新段落行）。
 *
 *   ② 它把当前行的行首缩进复制到新行，新行里于是躺着看不见的空格：
 *        Enter 后   = `…正文。\n  `
 *        退格 1 次  = `…正文。\n`     ← 只清掉那两个空格，换行符还在
 *        退格 2 次  = `…正文。`       ← 这才回到上一段
 *      → 现在：新行不携带任何行内缩进（缩进本来就由 CSS 的 text-indent 提供，
 *        行内缩进字符还会被 live-preview 隐藏掉）。
 *
 *   ③ 一次 Enter 插入了两个换行，撤销它自然也要删两个换行 —— 所以 Backspace 做了对称处理：
 *      光标停在**段落首行行首**、上面正好是「一段 + 一个空行」时，一次删掉这两个换行，
 *      直接回到上一段末尾（否则光标会先停在空行行首，作者得再按一次）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import { useLocaleStore } from '../../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAMPLE = '第一段正文。\n\n第二段正文。'

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
  expect(surface).toBeTruthy()
  await act(async () => surface!.focus())
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  await settle()
  return { view: view!, surface: surface! }
}

function pressKey(view: EditorView, key: string, keyCode: number): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    code: key === 'Enter' ? 'Enter' : key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  }))
}

/** 把光标放到文末再按 Enter。 */
async function enterAtEnd(view: EditorView): Promise<void> {
  view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
  await settle()
  await act(async () => pressKey(view, 'Enter', 13))
  await settle()
}

describe('Enter：一次就产出正确的段落结构', () => {
  it('段末按一次 Enter → 「空行 + 新段落行」，与文档其余部分的格式一致', async () => {
    const { view } = await renderEditor(SAMPLE)
    await enterAtEnd(view)

    const doc = view.state.doc.toString()
    console.log(`[ENTER] 一次 Enter 后 doc=${JSON.stringify(doc)} 行数=${view.state.doc.lines}`)

    expect(
      doc,
      '段末按一次 Enter 就该得到「空行 + 新段落行」；若只有一个换行，段落之间就没有分隔空行',
    ).toBe(`${SAMPLE}\n\n`)
    // 新段落行是空的，且它上面正好是一个空行
    expect(view.state.doc.line(view.state.doc.lines).text).toBe('')
    expect(view.state.doc.line(view.state.doc.lines - 1).text).toBe('')
  })

  it('Enter 之后光标落在新段落行行首', async () => {
    const { view } = await renderEditor(SAMPLE)
    await enterAtEnd(view)
    const lastLine = view.state.doc.line(view.state.doc.lines)
    console.log(`[ENTER] 光标=${view.state.selection.main.head} 新段落行 from=${lastLine.from}`)
    expect(view.state.selection.main.head).toBe(lastLine.from)
  })

  // 三种真实存在的段落首行缩进写法：半角空格（真实 Tab 插入的就是它）、em 空格、全角空格
  const indents: Array<[string, string]> = [
    ['两个半角空格', '  '],
    ['两个 em 空格', '\u2003\u2003'],
    ['两个全角空格', '\u3000\u3000'],
  ]
  for (const [name, indent] of indents) {
    it(`段落首行是${name}时：新行不继承缩进（避免看不见的空格）`, async () => {
      const { view } = await renderEditor(`${indent}第一段正文。\n\n${indent}第二段正文。`)
      await enterAtEnd(view)
      const gapLine = view.state.doc.line(view.state.doc.lines - 1).text
      const newLine = view.state.doc.line(view.state.doc.lines).text
      console.log(`[ENTER] 缩进=${name} → 空行=${JSON.stringify(gapLine)} 新段落行=${JSON.stringify(newLine)}`)
      expect(gapLine, '分隔空行必须是真空行').toBe('')
      expect(
        newLine,
        '新段落行不能带继承下来的行内缩进 —— 那些看不见的空格正是「按两次 Backspace」的根源',
      ).toBe('')
    })
  }

  it('光标已在空行上时按 Enter：只加一个空行，不额外插入两个换行', async () => {
    const { view } = await renderEditor(`${SAMPLE}\n`)
    // 光标放在最后那个空行上
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
    await settle()
    await act(async () => pressKey(view, 'Enter', 13))
    await settle()
    console.log(`[ENTER] 空行上按 Enter → doc=${JSON.stringify(view.state.doc.toString())}`)
    expect(view.state.doc.toString()).toBe(`${SAMPLE}\n\n`)
  })

  it('列表行上的 Enter 仍然续写列表标记（结构行让位给 CodeMirror）', async () => {
    const { view } = await renderEditor('- 第一项')
    await enterAtEnd(view)
    console.log(`[ENTER] 列表行 → doc=${JSON.stringify(view.state.doc.toString())}`)
    expect(view.state.doc.line(2).text, '列表的续写语义不能被改掉').toBe('- ')
  })

  it('引用行上的 Enter 仍然续写引用标记', async () => {
    const { view } = await renderEditor('> 引文一行')
    await enterAtEnd(view)
    console.log(`[ENTER] 引用行 → doc=${JSON.stringify(view.state.doc.toString())}`)
    expect(view.state.doc.line(2).text.startsWith('>'), '引用的续写语义不能被改掉').toBe(true)
  })

  it('有选区时按 Enter 交给默认行为（先替换选区）', async () => {
    const { view } = await renderEditor('第一段正文。')
    view.dispatch({ selection: EditorSelection.single(0, 3) })
    await settle()
    await act(async () => pressKey(view, 'Enter', 13))
    await settle()
    console.log(`[ENTER] 有选区时 → doc=${JSON.stringify(view.state.doc.toString())}`)
    expect(view.state.doc.toString()).not.toContain('第一段')
  })
})

describe('Backspace：与 Enter 对称，一次回到上一段', () => {
  it('刚 Enter 出来的段落：一次 Backspace 回到上一段末尾', async () => {
    const { view } = await renderEditor(SAMPLE)
    await enterAtEnd(view)
    expect(view.state.doc.toString()).toBe(`${SAMPLE}\n\n`)

    await act(async () => pressKey(view, 'Backspace', 8))
    await settle()
    console.log(`[BACKSPACE] 退格 1 次后 doc=${JSON.stringify(view.state.doc.toString())} 光标=${view.state.selection.main.head}`)

    expect(
      view.state.doc.toString(),
      '一次 Backspace 就该把「刚起的那一段」整个收回去；若还剩一个换行，说明要按两次',
    ).toBe(SAMPLE)
    expect(
      view.state.selection.main.head,
      '光标应当回到上一段末尾',
    ).toBe(SAMPLE.length)
  })

  it('新段落已经写了字：一次 Backspace 清掉空行、把两段接起来', async () => {
    const { view } = await renderEditor(SAMPLE)
    await enterAtEnd(view)
    await act(async () => {
      view.dispatch(view.state.replaceSelection('新段落正文。'))
    })
    await settle()
    expect(view.state.doc.toString()).toBe(`${SAMPLE}\n\n新段落正文。`)

    // 光标移到新段落行行首
    view.dispatch({ selection: EditorSelection.single(SAMPLE.length + 2) })
    await settle()
    await act(async () => pressKey(view, 'Backspace', 8))
    await settle()
    console.log(`[BACKSPACE] 合并后 doc=${JSON.stringify(view.state.doc.toString())}`)
    expect(view.state.doc.toString()).toBe(`${SAMPLE}新段落正文。`)
  })

  it('光标不在行首时，Backspace 仍是普通的删字符', async () => {
    const { view } = await renderEditor(SAMPLE)
    view.dispatch({ selection: EditorSelection.single(view.state.doc.length) })
    await settle()
    await act(async () => pressKey(view, 'Backspace', 8))
    await settle()
    console.log(`[BACKSPACE] 行内退格 → doc=${JSON.stringify(view.state.doc.toString())}`)
    // 只删掉了段末的那个句号，结构和段落分隔都还在
    expect(view.state.doc.toString()).toBe('第一段正文。\n\n第二段正文')
  })
})
