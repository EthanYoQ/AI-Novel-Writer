import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import type { ModelExecutionLeaseReceipt } from '../../../shared/ipc-channels'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LEASE: ModelExecutionLeaseReceipt = {
  leaseId: 'editor-generation-lease',
  modelId: 'editor-model',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'editor-model-v1',
  modelRevision: 'a'.repeat(64),
  endpointFingerprint: 'b'.repeat(64),
  capabilityEvidence: {
    source: {
      contextWindowTokens: 'unknown',
      maxOutputTokens: 'user-operational-cap',
      featureFlags: 'unknown',
    },
    subjectFingerprint: 'c'.repeat(64),
    contextWindowTokens: null,
    maxOutputTokens: 4096,
    reasoning: null,
    structuredOutput: null,
    usage: null,
  },
  createdAt: 1,
  expiresAt: 60_001,
}

type EventListener = (data: never) => void

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let listeners: Map<string, EventListener>
let deferStream: boolean
let pendingRequestId: string | null
let deferFirstLease: boolean
let rejectFirstLease: ((error: Error) => void) | null
let leaseRequestCount: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  listeners = new Map()
  deferStream = false
  pendingRequestId = null
  deferFirstLease = false
  rejectFirstLease = null
  leaseRequestCount = 0
  useLLMStore.setState({
    defaultModelId: 'editor-model',
    loaded: true,
    activeRequests: new Map(),
  })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'llm:begin-execution-lease') {
      leaseRequestCount += 1
      if (deferFirstLease && leaseRequestCount === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirstLease = reject
        })
      }
      return { success: true, lease: LEASE }
    }
    if (channel === 'llm:close-execution-lease') return { success: true }
    if (channel === 'llm:generate-stream') {
      const requestId = String(args[0])
      pendingRequestId = requestId
      if (!deferStream) {
        queueMicrotask(() => {
          listeners.get('llm:stream-chunk')?.({ requestId, chunk: '残缺片段' } as never)
          listeners.get('llm:stream-done')?.({
            requestId,
            fullText: '残缺片段',
            finishReason: 'length',
          } as never)
        })
      }
      return { requestId, started: true }
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, listener: EventListener) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLLMStore.setState({ defaultModelId: null, activeRequests: new Map() })
  useLocaleStore.setState({ locale: 'zh-CN' })
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('CodeMirror editor AI generation boundary', () => {
  it('localizes search and AI-result actions for an English interface', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await act(async () => root.render(
      <CodeMirrorEditor content="Original passage" mode="prose" />,
    ))

    const editor = container.querySelector<HTMLElement>('.cm-content')!
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    })
    await expect.element(page.getByRole('textbox', { name: 'Find' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: 'Replace' })).toBeVisible()

    await act(async () => page.getByText('Original passage').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: 'Refine' }).click())

    await expect.element(page.getByText('Refine preview')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled()
  })

  it('keeps a length-limited result non-applicable while closing its model lease', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content="原文段落" mode="prose" />,
    ))

    await page.getByText('原文段落').click({ clickCount: 3 })

    await act(async () => page.getByRole('button', { name: '润色' }).click())

    await expect.element(page.getByText('生成未完整完成，结果不可应用')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '替换' })).toBeDisabled()
    await expect.element(page.getByText('残缺片段')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('llm:begin-execution-lease', 'editor-model')
    expect(invoke).toHaveBeenCalledWith(
      'llm:generate-stream',
      expect.any(String),
      expect.objectContaining({ reasoningStage: 'review' }),
    )
    expect(invoke).toHaveBeenCalledWith('llm:close-execution-lease', 'editor-generation-lease')
  })

  it('applies a delayed AI result to the frozen original selection instead of a later selection', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => view.dispatch({ selection: { anchor: 1, head: 2 } }))

    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-chunk')?.({ requestId, chunk: '替换甲' } as never)
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('替换甲')
  })

  it('keeps a delayed result copyable but refuses stale offsets after the document changes', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => view.dispatch({ changes: { from: 0, insert: '新' } }))

    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('新甲乙')
    await expect.element(page.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
    await expect.element(page.getByText('替换甲')).toBeVisible()
  })

  it('keeps a completed result copyable but refuses replacement after the editor becomes read-only', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" editable />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()

    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" editable={false} />,
    ))
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('甲乙')
    await expect.element(page.getByText('正文已变为只读，结果未应用；你仍可复制预览内容')).toBeVisible()
    await expect.element(page.getByText('替换甲')).toBeVisible()
  })

  it('keeps request B visible when cancelled request A fails after B succeeds', async () => {
    deferFirstLease = true
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await vi.waitFor(() => expect(rejectFirstLease).not.toBeNull())
    await act(async () => page.getByRole('button', { name: '取消' }).click())

    await act(async () => {
      view.dispatch({ selection: { anchor: 0 } })
      view.dispatch({ selection: { anchor: 0, head: 2 } })
    })
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await vi.waitFor(() => expect(pendingRequestId).not.toBeNull())
    await act(async () => {
      listeners.get('llm:stream-done')?.({
        requestId: pendingRequestId!,
        fullText: 'B 的结果',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('B 的结果')).toBeVisible()

    await act(async () => rejectFirstLease!(new Error('A late failure')))

    await expect.element(page.getByText('B 的结果')).toBeVisible()
    await expect.element(page.getByText('生成失败，结果不可应用')).not.toBeInTheDocument()
  })
})
