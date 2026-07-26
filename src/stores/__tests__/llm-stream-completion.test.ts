import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (data: unknown) => void>(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    on: vi.fn((channel: string, callback: (data: unknown) => void) => {
      mocks.listeners.set(channel, callback)
      return () => mocks.listeners.delete(channel)
    }),
    get isElectron() { return true },
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError: vi.fn() }))

import { useLLMStore } from '../llm-store'

describe('LLM stream completion propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.invoke.mockResolvedValue({ started: true })
    useLLMStore.setState({
      defaultModelId: 'model',
      activeRequests: new Map(),
      loaded: true,
    })
  })

  it('forwards the IPC finish reason to stream consumers', async () => {
    const onDone = vi.fn()
    const requestId = await useLLMStore.getState().generateStream(
      [{ role: 'user', content: '写正文' }],
      { onDone },
    )

    const doneListener = mocks.listeners.get('llm:stream-done')
    expect(doneListener).toBeTypeOf('function')
    doneListener?.({ requestId, fullText: '半截正文', finishReason: 'length' })

    expect(onDone).toHaveBeenCalledWith('半截正文', undefined, 'length')
  })
})
