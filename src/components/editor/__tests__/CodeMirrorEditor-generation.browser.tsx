import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelExecutionLeaseReceipt } from '../../../shared/ipc-channels'
import { useLLMStore } from '../../../stores/llm-store'
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  listeners = new Map()
  useLLMStore.setState({
    defaultModelId: 'editor-model',
    loaded: true,
    activeRequests: new Map(),
  })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'llm:begin-execution-lease') return { success: true, lease: LEASE }
    if (channel === 'llm:close-execution-lease') return { success: true }
    if (channel === 'llm:generate-stream') {
      const requestId = String(args[0])
      queueMicrotask(() => {
        listeners.get('llm:stream-chunk')?.({ requestId, chunk: '残缺片段' } as never)
        listeners.get('llm:stream-done')?.({
          requestId,
          fullText: '残缺片段',
          finishReason: 'length',
        } as never)
      })
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
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('CodeMirror editor AI generation boundary', () => {
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
    expect(invoke).toHaveBeenCalledWith('llm:close-execution-lease', 'editor-generation-lease')
  })
})
