import { afterEach, describe, expect, it, vi } from 'vitest'

import { runPostProcessPipeline } from '../workflow-utils'

function stubIpcInvoke() {
  const invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'db:post-process-get-latest-run':
        return invoke.mock.calls.filter(([name]) => name === channel).length === 1 ? null : { id: 'run-1' }
      case 'db:post-process-create-run':
        return { success: true, id: 'run-1' }
      case 'db:post-process-get-steps':
        return []
      case 'db:post-process-mark-step-failed':
        return { success: true }
      default:
        throw new Error(`Unexpected IPC channel: ${channel}`)
    }
  })
  vi.stubGlobal('window', {
    velaAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runPostProcessPipeline stopOnFailure', () => {
  it('persists the failed step and stops before any later post-processing step runs', async () => {
    const invoke = stubIpcInvoke()
    const secondStep = vi.fn(async () => undefined)
    const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

    await expect(runPostProcessPipeline(
      'C:/novel',
      'chapter_2_finalize',
      '第2章定稿',
      [
        { key: 'first', label: '第一步', critical: true, executor: async () => { throw new Error('模型超时') } },
        { key: 'second', label: '第二步', critical: false, executor: secondStep },
      ],
      callbacks,
      { retryCount: 0, stopOnFailure: true },
    )).rejects.toThrow('后处理步骤失败：第一步 — 模型超时')

    expect(invoke).toHaveBeenCalledWith('db:post-process-mark-step-failed', 'run-1', 'first', '模型超时')
    expect(secondStep).not.toHaveBeenCalled()
  })
})
