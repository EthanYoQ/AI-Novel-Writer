import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  container.className = 'dark'
  container.style.height = '300px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CodeMirror writing caret', () => {
  it('uses a text pointer and a high-contrast caret in both themes', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content="光标可见" mode="prose" />,
    ))

    const editableSurface = container.querySelector<HTMLElement>('.cm-content')
    expect(editableSurface).toBeTruthy()
    await act(async () => editableSurface!.focus())
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLElement>('.cm-cursor')).toBeTruthy()
    })
    const caret = container.querySelector<HTMLElement>('.cm-cursor')
    expect(caret).toBeTruthy()
    expect(getComputedStyle(editableSurface!).cursor).toBe('text')
    expect(getComputedStyle(caret!).borderLeftColor).toBe('rgb(255, 255, 255)')

    container.className = ''
    expect(getComputedStyle(caret!).borderLeftColor).toBe('rgb(122, 31, 18)')
  })
})
