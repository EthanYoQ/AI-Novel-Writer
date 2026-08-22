import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore, type WorkflowDefinition } from '../workflow-store'
import { globalEventBus } from '../../shared/event-bus'
import { useProjectStore } from '../project-store'
import { createBoundedCompletionError } from '../../services/workflows/bounded-completion'

const projectPath = 'C:\\test-project'

function frozenSession(leaseId = 'lease-test-project') {
  return {
    projectId: 'test-project',
    leaseId,
    projectPath,
  }
}

beforeEach(() => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project',
      name: 'Test',
      path: projectPath,
      sessionLease: 'lease-test-project',
      novelConfig: {},
    } as never,
  })
})

describe('workflow pause at a safe step boundary', () => {
  it('copies a bounded terminal failure code to the failed step and run without changing its message', async () => {
    const failure = createBoundedCompletionError('content_filter')

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: '内容策略失败测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: '写稿',
        description: '生成正文',
        executor: async () => { throw failure },
      }],
    })

    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: 'AI 输出因内容限制而未完成，结果未被保存。',
      failureCode: 'content_filter',
      steps: [expect.objectContaining({
        status: 'failed',
        error: 'AI 输出因内容限制而未完成，结果未被保存。',
        failureCode: 'content_filter',
      })],
    })
  })

  it('atomically replaces provisional output and reconciles it to the terminal step result', async () => {
    let finishStep: (() => void) | undefined
    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: '流式草稿对账测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'write',
        description: 'stream and persist',
        executor: async (_step, _context, callbacks) => {
          callbacks.appendText('过期临时文本')
          expect(callbacks.replaceText).toBeTypeOf('function')
          callbacks.replaceText?.('安全正文预览')
          await new Promise<void>(resolve => { finishStep = resolve })
          return '已持久化终稿'
        },
      }],
    })

    await vi.waitFor(() => expect(finishStep).toBeTypeOf('function'))
    expect(useWorkflowStore.getState().activeRuns[0]?.steps[0]?.result).toBe('安全正文预览')

    finishStep!()
    await completion
    expect(useWorkflowStore.getState().history[0]?.steps[0]?.result).toBe('已持久化终稿')
  })

  it('allows cancellation cleanup but rejects late non-empty output mutations', async () => {
    let callbacksRef: Parameters<WorkflowDefinition['steps'][number]['executor']>[2] | undefined
    let finishStep: (() => void) | undefined
    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: '取消后的流式输出测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'write',
        description: 'stream until cancelled',
        executor: async (_step, _context, callbacks) => {
          callbacksRef = callbacks
          callbacks.replaceText?.('取消前安全预览')
          await new Promise<void>(resolve => { finishStep = resolve })
        },
      }],
    })
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => expect(finishStep).toBeTypeOf('function'))

    useWorkflowStore.getState().cancelWorkflow(runId)
    callbacksRef?.appendText('晚到追加')
    callbacksRef?.replaceText?.('晚到替换')
    expect(useWorkflowStore.getState().activeRuns[0]?.steps[0]?.result).toBe('取消前安全预览')

    callbacksRef?.replaceText?.('')
    expect(useWorkflowStore.getState().activeRuns[0]?.steps[0]?.result).toBe('')
    finishStep!()
    await completion
    expect(useWorkflowStore.getState().history[0]?.steps[0]?.result).toBe('')
  })

  it('fails closed for a legacy definition that has no frozen project session', async () => {
    const executor = vi.fn(async () => undefined)

    const runId = await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Legacy workflow without a session',
      projectPath: 'C:\\test-project',
      steps: [{ name: 'write', description: 'write', executor }],
    } as unknown as WorkflowDefinition)

    expect(executor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history).toContainEqual(expect.objectContaining({
      id: runId,
      status: 'failed',
      error: expect.stringContaining('冻结项目会话'),
    }))
  })

  it('finishes the current step, pauses before the next one, and resumes without starting it early', async () => {
    let finishFirstStep: (() => void) | undefined
    const secondStep = vi.fn(async () => undefined)
    const workflow: WorkflowDefinition = {
      type: 'batch_generate',
      title: '批量创作测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [
        {
          name: '第1章',
          description: '当前章节',
          executor: async () => new Promise<void>((resolve) => { finishFirstStep = resolve }),
        },
        {
          name: '第2章',
          description: '下一章节',
          executor: secondStep,
        },
      ],
    }
    const completedPayloads: Array<{ type: string; projectPath: string; runId: string }> = []
    const activeRunSnapshots: string[][] = []
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', payload => {
      completedPayloads.push(payload)
      activeRunSnapshots.push(useWorkflowStore.getState().activeRuns.map(run => run.id))
    })

    const completion = useWorkflowStore.getState().startWorkflow(workflow)
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => {
      expect(finishFirstStep).toBeTypeOf('function')
    })
    useWorkflowStore.getState().pauseWorkflow(runId)

    finishFirstStep!()
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('paused')
    })
    expect(secondStep).not.toHaveBeenCalled()

    useWorkflowStore.getState().resumeWorkflow(runId)
    await completion

    expect(secondStep).toHaveBeenCalledTimes(1)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({ status: 'completed', title: '批量创作测试' })
    await vi.waitFor(() => {
      expect(completedPayloads).toContainEqual(expect.objectContaining({
        type: 'batch_generate',
        projectPath: 'C:\\test-project',
      }))
    })
    expect(activeRunSnapshots).toContainEqual([runId])
    unsubscribe()
  })

  it('does not start a frozen-project step after the active project switches', async () => {
    const executor = vi.fn(async () => undefined)
    useProjectStore.setState({
      currentProject: {
        id: 'other-project',
        name: 'Other',
        path: 'C:\\other-project',
        sessionLease: 'lease-other-project',
        novelConfig: {},
      } as never,
    })

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'A project workflow',
      projectPath,
      projectSession: frozenSession(),
      steps: [{ name: 'write', description: 'write', executor }],
    })

    expect(executor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      projectPath: 'C:\\test-project',
      status: 'failed',
    })
  })

  it('fails closed for an older lease when the same path has been reopened', async () => {
    const executor = vi.fn(async () => undefined)
    useProjectStore.setState({
      currentProject: {
        id: 'test-project',
        name: 'Test reopened',
        path: 'c:/TEST-PROJECT/',
        sessionLease: 'lease-test-project-reopened',
        novelConfig: {},
      } as never,
    })

    const runId = await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Older same-path workflow',
      projectPath,
      projectSession: frozenSession(),
      steps: [{ name: 'write', description: 'write', executor }],
    })

    expect(executor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history).toContainEqual(expect.objectContaining({
      id: runId,
      status: 'failed',
      error: expect.stringContaining('冻结项目会话'),
    }))
  })

  it('keeps a cancelling run active until its in-flight executor exits', async () => {
    let finishExecutor: (() => void) | undefined
    const completedPayloads: unknown[] = []
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', payload => {
      completedPayloads.push(payload)
    })

    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: '取消竞态测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'write',
        description: 'in-flight write',
        executor: async () => new Promise<void>((resolve) => { finishExecutor = resolve }),
      }],
    })
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => {
      expect(finishExecutor).toBeTypeOf('function')
    })

    useWorkflowStore.getState().cancelWorkflow(runId)

    expect(useWorkflowStore.getState().activeRuns).toContainEqual(expect.objectContaining({
      id: runId,
      status: 'cancelling',
    }))
    expect(useWorkflowStore.getState().isTypeRunning('chapter_creation')).toBe(true)
    expect(useWorkflowStore.getState().history).toHaveLength(0)

    finishExecutor!()
    await completion

    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      id: runId,
      status: 'failed',
      error: '工作流已取消',
    })
    expect(completedPayloads).toHaveLength(0)
    unsubscribe()
  })

  it('rejects a same-path reopen with a new lease after an in-flight step returns', async () => {
    let finishExecutor: (() => void) | undefined
    const seenLeases: string[] = []
    const openResult = vi.fn()
    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'directory',
      title: '同路径重开测试',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: '生成目录',
        description: 'in-flight',
        executor: async (_step, context) => {
          seenLeases.push(context.projectSession?.leaseId ?? 'missing')
          await new Promise<void>((resolve) => { finishExecutor = resolve })
        },
      }],
      onComplete: { mode: 'open', openResult },
    })

    await vi.waitFor(() => expect(finishExecutor).toBeTypeOf('function'))
    useProjectStore.setState({
      currentProject: {
        id: 'test-project',
        name: 'Test reopened',
        path: 'c:/TEST-PROJECT/',
        sessionLease: 'lease-test-project-reopened',
        novelConfig: {},
      } as never,
    })
    finishExecutor!()
    await completion

    expect(seenLeases).toEqual(['lease-test-project'])
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('项目会话已切换或失效'),
    })
    expect(openResult).not.toHaveBeenCalled()
  })
})
