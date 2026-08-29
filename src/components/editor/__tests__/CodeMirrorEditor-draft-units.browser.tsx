import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CodeMirror draft-unit display', () => {
  it('reports Chinese characters and English words with the generation unit', async () => {
    const onCharCountChange = vi.fn()

    await act(async () => root.render(
      <CodeMirrorEditor
        content="林岚 walked into the room."
        mode="prose"
        onCharCountChange={onCharCountChange}
      />,
    ))

    expect(onCharCountChange).toHaveBeenLastCalledWith(6)
  })
})
