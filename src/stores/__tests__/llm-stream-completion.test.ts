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

  it('fails an older IPC peer without a finish reason closed as unknown', async () => {
    const onDone = vi.fn()
    const requestId = await useLLMStore.getState().generateStream(
      [{ role: 'user', content: '写正文' }],
      { onDone },
    )

    const doneListener = mocks.listeners.get('llm:stream-done')
    doneListener?.({ requestId, fullText: '旧版本残缺正文' })

    expect(onDone).toHaveBeenCalledWith('旧版本残缺正文', undefined, 'unknown')
  })

  it('rejects a stream that the main process did not start', async () => {
    mocks.invoke.mockResolvedValueOnce({ requestId: 'ignored', started: false })
    const onError = vi.fn()

    await expect(useLLMStore.getState().generateStream(
      [{ role: 'user', content: '写正文' }],
      { onError },
    )).rejects.toThrow('模型流式生成未能启动')

    expect(onError).toHaveBeenCalledWith('模型流式生成未能启动')
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
  })

  it('surfaces an expired model execution lease without replacing it with a generic start error', async () => {
    mocks.invoke.mockResolvedValueOnce({
      requestId: 'expired-lease-stream',
      started: false,
      error: '模型执行租约已过期',
    })
    const onError = vi.fn()

    await expect(useLLMStore.getState().generateStream(
      [{ role: 'user', content: '写正文' }],
      { onError },
      'model',
      { modelExecutionLeaseId: 'expired-lease' },
    )).rejects.toThrow('模型执行租约已过期')

    expect(onError).toHaveBeenCalledWith('模型执行租约已过期')
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
  })

  it('cleans listeners and active state when the IPC transport rejects', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('transport closed'))
    const onError = vi.fn()

    await expect(useLLMStore.getState().generateStream(
      [{ role: 'user', content: '写正文' }],
      { onError },
    )).rejects.toThrow('transport closed')

    expect(onError).toHaveBeenCalledWith('Error: transport closed')
    expect(mocks.listeners.size).toBe(0)
    expect(useLLMStore.getState().activeRequests.size).toBe(0)
  })

  it('rejects non-stream business failures instead of returning them as content', async () => {
    mocks.invoke.mockResolvedValueOnce({ success: false, content: '', error: 'provider failed' })

    await expect(useLLMStore.getState().generate(
      [{ role: 'user', content: '写正文' }],
    )).rejects.toThrow('provider failed')
  })

  it('forwards one frozen model execution lease through regular and streaming requests', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'llm:generate'
      ? { success: true, content: 'done', finishReason: 'stop' }
      : { requestId: 'leased-stream', started: true })

    await useLLMStore.getState().generate(
      [{ role: 'user', content: 'write' }],
      'model',
      { modelExecutionLeaseId: 'opaque-model-lease' },
    )
    const requestId = await useLLMStore.getState().generateStream(
      [{ role: 'user', content: 'continue' }],
      {},
      'model',
      { modelExecutionLeaseId: 'opaque-model-lease' },
    )

    expect(requestId).toEqual(expect.any(String))
    expect(mocks.invoke).toHaveBeenCalledWith('llm:generate', expect.objectContaining({
      modelId: 'model',
      modelExecutionLeaseId: 'opaque-model-lease',
    }))
    expect(mocks.invoke).toHaveBeenCalledWith(
      'llm:generate-stream',
      expect.any(String),
      expect.objectContaining({
        modelId: 'model',
        modelExecutionLeaseId: 'opaque-model-lease',
      }),
    )
  })
})
