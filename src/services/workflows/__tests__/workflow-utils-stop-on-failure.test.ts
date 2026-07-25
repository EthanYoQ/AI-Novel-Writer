import { afterEach, describe, expect, it, vi } from 'vitest'

import { runPostProcessPipeline } from '../workflow-utils'

const projectSession = {
  projectId: 'project-1',
  leaseId: 'lease-1',
  projectPath: 'C:/novel',
} as const

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
      { retryCount: 0, stopOnFailure: true, projectSession },
    )).rejects.toThrow('后处理步骤失败：第一步 — 模型超时')

    expect(invoke).toHaveBeenCalledWith(
      'db:post-process-mark-step-failed',
      'run-1',
      'first',
      '模型超时',
      'C:/novel',
      projectSession,
    )
    expect(secondStep).not.toHaveBeenCalled()
  })

  it('keeps every step and the final summary bound to the id returned by create-run', async () => {
    const createdRunId = 'run-created-in-same-second'
    const unrelatedLatestRunId = 'run-unrelated-latest'
    let getStepsCalls = 0
    const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
      void _args
      switch (channel) {
        case 'db:post-process-get-latest-run':
          return { id: unrelatedLatestRunId }
        case 'db:post-process-create-run':
          return { success: true, id: createdRunId }
        case 'db:post-process-get-steps':
          getStepsCalls += 1
          return getStepsCalls === 1
            ? [{
                id: 1,
                runId: createdRunId,
                stepKey: 'only',
                label: '唯一步骤',
                critical: true,
                ok: false,
                errorMsg: '',
                attemptCount: 0,
                completedAt: '',
                lastAttemptAt: '',
              }]
            : [{
                id: 1,
                runId: createdRunId,
                stepKey: 'only',
                label: '唯一步骤',
                critical: true,
                ok: true,
                errorMsg: '',
                attemptCount: 1,
                completedAt: '2026-07-25T00:00:00.000Z',
                lastAttemptAt: '2026-07-25T00:00:00.000Z',
              }]
        case 'db:post-process-mark-step-ok':
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

    const status = await runPostProcessPipeline(
      'C:/novel',
      'chapter_2_finalize',
      '第2章定稿',
      [{ key: 'only', label: '唯一步骤', critical: true, executor: async () => undefined }],
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      { retryCount: 0, projectSession },
    )

    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:post-process-get-latest-run'))
      .toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(
      'db:post-process-mark-step-ok',
      createdRunId,
      'only',
      'C:/novel',
      projectSession,
    )
    expect(invoke.mock.calls.filter(([channel, runId]) =>
      channel === 'db:post-process-get-steps' && runId === createdRunId
    )).toHaveLength(2)
    expect(invoke.mock.calls.some(([, runId]) => runId === unrelatedLatestRunId)).toBe(false)
    expect(status.allCriticalPassed).toBe(true)
    expect(status.steps.only.ok).toBe(true)
  })

  it('fails closed before IPC when no frozen project session is supplied', async () => {
    const invoke = stubIpcInvoke()

    await expect(runPostProcessPipeline(
      'C:/novel',
      'chapter_2_finalize',
      '第2章定稿',
      [],
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      { retryCount: 0 },
    )).rejects.toThrow('后处理缺少冻结项目会话')

    expect(invoke).not.toHaveBeenCalled()
  })
})
