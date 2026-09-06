import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowContext } from '../../../stores/workflow-store'
import { runPostProcessPipeline } from '../workflow-utils'

const projectSession = {
  projectId: 'project-1',
  leaseId: 'lease-1',
  projectPath: 'C:/novel',
} as const

function englishContext(): WorkflowContext {
  return {
    runId: 'post-process-en',
    projectPath: projectSession.projectPath,
    projectSession,
    writingLanguage: 'zh-CN',
    uiLocale: 'en-US',
    data: {},
    cancelled: false,
  }
}

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
      'Chapter 2 finalization',
      [
        { key: 'first', label: 'First step', critical: true, executor: async () => { throw new Error('provider timeout') } },
        { key: 'second', label: 'Second step', critical: false, executor: secondStep },
      ],
      callbacks,
      { retryCount: 1, stopOnFailure: true, cancellation: englishContext(), projectSession },
    )).rejects.toThrow('Post-processing step failed: First step — provider timeout')

    const logs = vi.mocked(callbacks.log).mock.calls.flat().join('\n')
    expect(logs).toContain('First step failed on attempt 1; retrying')
    expect(logs).not.toMatch(/⚠️|✅|❌|⏭️|💡/u)

    expect(invoke).toHaveBeenCalledWith(
      'db:post-process-mark-step-failed',
      'run-1',
      'first',
      'provider timeout',
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
                label: 'Only step',
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
                label: 'Only step',
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

    const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    const status = await runPostProcessPipeline(
      'C:/novel',
      'chapter_2_finalize',
      'Chapter 2 finalization',
      [{ key: 'only', label: 'Only step', critical: true, executor: async () => undefined }],
      callbacks,
      { retryCount: 0, cancellation: englishContext(), projectSession },
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
    const logs = vi.mocked(callbacks.log).mock.calls.flat().join('\n')
    expect(logs).toContain('Initializing post-processing run')
    expect(logs).toContain('Chapter 2 finalization post-processing summary')
    expect(logs).toContain('1/1 succeeded')
    expect(logs).not.toMatch(/初始化后处理跑批|后处理汇总|成功|⚠️|✅|❌|⏭️|💡/u)
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
