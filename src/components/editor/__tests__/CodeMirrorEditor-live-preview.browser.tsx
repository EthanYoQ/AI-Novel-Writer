import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import CodeMirrorEditor from '../CodeMirrorEditor'
import { livePreview } from '../live-preview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  container.style.height = '480px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function editorText(): string {
  return container.querySelector('.cm-content')?.textContent ?? ''
}

describe('CodeMirror live prose preview', () => {
  it('renders a paper head, semantic markdown, and a body drop cap in the single editor', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor
        content={'# 雨夜\n\n林岚看见 **灯火**。\n\n尾声'}
        mode="prose"
        paperHead={{ title: '雨夜', subtitle: '长街 · 第一章' }}
      />,
    ))

    const content = container.querySelector<HTMLElement>('.cm-content')!
    await act(async () => content.focus())
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }))

    await vi.waitFor(() => {
      expect(container.querySelector('.cm-lp-paperhead')?.textContent).toBe('雨夜长街 · 第一章')
      expect(container.querySelector('.cm-lp-h1')).toBeTruthy()
      expect(container.querySelector('.cm-lp-strong')?.textContent).toBe('灯火')
      expect(container.querySelector('.cm-lp-dropcap-char')?.textContent).toBe('林')
      expect(editorText()).not.toContain('#')
      expect(editorText()).not.toContain('**')
    })
  })

  it('keeps markdown markers editable on the active line', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content={'# 雨夜\n\n正文'} mode="prose" />,
    ))

    const content = container.querySelector<HTMLElement>('.cm-content')!
    await act(async () => content.focus())

    await vi.waitFor(() => expect(editorText()).toContain('# 雨夜'))
  })

  it('defers external Chinese composition updates and applies only the latest text on composition end', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content="初始" mode="prose" />,
    ))
    const content = container.querySelector<HTMLElement>('.cm-content')!

    await act(async () => {
      content.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      root.render(<CodeMirrorEditor content="你" mode="prose" />)
      root.render(<CodeMirrorEditor content="你好" mode="prose" />)
    })
    expect(editorText()).toBe('初始')

    await act(async () => {
      content.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
    })

    await vi.waitFor(() => expect(editorText()).toBe('你好'))
    expect(editorText()).not.toContain('你你好')
  })

  it('keeps hidden marker ranges aligned when composition inserts before them', async () => {
    const doc = '# 标题\n\n正文\n\n**重点**\n\n尾声'
    const host = document.createElement('div')
    container.append(host)
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdown(), livePreview()],
      }),
    })

    try {
      view.focus()
      const inputState = (view as unknown as { inputState: { composing: number } }).inputState
      inputState.composing = 1
      expect(view.composing).toBe(true)
      view.dispatch({ changes: { from: 0, insert: '前言\n' } })
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))

      await vi.waitFor(() => {
        expect(view.state.doc.toString()).toBe(`前言\n${doc}`)
        expect(host.querySelector('.cm-lp-strong')?.textContent).toBe('重点')
        expect(host.querySelector('.cm-lp-dropcap-char')?.textContent).toBe('前')
        expect(host.querySelector('.cm-content')?.textContent).not.toContain('**')
      })
    } finally {
      view.destroy()
    }
  })
})
