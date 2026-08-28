import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore, type WorkflowDefinition } from '../workflow-store'
import { globalEventBus } from '../../shared/event-bus'
import { useProjectStore } from '../project-store'
import { useLocaleStore } from '../locale-store'
import { createBoundedCompletionError } from '../../services/workflows/bounded-completion'
import { PromptBudgetExceededError } from '../../services/generation/generation-harness'

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
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
})

describe('workflow pause at a safe step boundary', () => {
  it('freezes the project writing language into both the run and command context', async () => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({
      currentProject: {
        ...project,
        novelConfig: { ...project.novelConfig, writingLanguage: 'en-US' },
      },
    })
    const observedLanguages: unknown[] = []

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Frozen writing language',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'write',
        description: 'capture context',
        executor: async (_step, context) => {
          observedLanguages.push(context.writingLanguage)
          const current = useProjectStore.getState().currentProject!
          useProjectStore.setState({
            currentProject: {
              ...current,
              novelConfig: { ...current.novelConfig, writingLanguage: 'zh-CN' },
            },
          })
          observedLanguages.push(context.writingLanguage)
        },
      }],
    })

    expect(observedLanguages).toEqual(['en-US', 'en-US'])
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      writingLanguage: 'en-US',
      status: 'completed',
    })
  })

  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-CN', 'en-US'],
    ['en-US', 'zh-CN'],
    ['en-US', 'en-US'],
  ] as const)(
    'freezes writing language %s and UI locale %s independently for the whole run',
    async (writingLanguage, uiLocale) => {
      const project = useProjectStore.getState().currentProject!
      useProjectStore.setState({
        currentProject: {
          ...project,
          novelConfig: { ...project.novelConfig, writingLanguage },
        },
      })
      useLocaleStore.setState({ locale: uiLocale })
      const observed: Array<{ writingLanguage: unknown; uiLocale: unknown }> = []

      await useWorkflowStore.getState().startWorkflow({
        type: 'chapter_creation',
        title: 'Frozen language seams',
        projectPath,
        projectSession: frozenSession(),
        steps: [{
          name: 'capture',
          description: 'capture frozen language seams',
          executor: async (_step, context) => {
            observed.push({
              writingLanguage: context.writingLanguage,
              uiLocale: context.uiLocale,
            })
            const current = useProjectStore.getState().currentProject!
            useProjectStore.setState({
              currentProject: {
                ...current,
                novelConfig: {
                  ...current.novelConfig,
                  writingLanguage: writingLanguage === 'en-US' ? 'zh-CN' : 'en-US',
                },
              },
            })
            useLocaleStore.setState({ locale: uiLocale === 'en-US' ? 'zh-CN' : 'en-US' })
            observed.push({
              writingLanguage: context.writingLanguage,
              uiLocale: context.uiLocale,
            })
          },
        }],
      })

      expect(observed).toEqual([
        { writingLanguage, uiLocale },
        { writingLanguage, uiLocale },
      ])
      expect(useWorkflowStore.getState().history[0]).toMatchObject({
        writingLanguage,
        uiLocale,
        status: 'completed',
      })
    },
  )

  it('keeps store-owned success and pause logs in the UI locale frozen at launch', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    let finishFirstStep: (() => void) | undefined

    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'batch_generate',
      title: 'Frozen UI copy',
      projectPath,
      projectSession: frozenSession(),
      steps: [
        {
          name: 'Chapter one',
          description: 'first step',
          executor: async () => new Promise<void>(resolve => { finishFirstStep = resolve }),
        },
        {
          name: 'Chapter two',
          description: 'second step',
          executor: async () => undefined,
        },
      ],
    })
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => expect(finishFirstStep).toBeTypeOf('function'))

    useLocaleStore.setState({ locale: 'zh-CN' })
    useWorkflowStore.getState().pauseWorkflow(runId)
    finishFirstStep!()
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('paused'))
    useWorkflowStore.getState().resumeWorkflow(runId)
    await completion

    const messages = useWorkflowStore.getState().globalLogs.map(entry => entry.message).join('\n')
    expect(messages).toContain('[Started] Workflow "Frozen UI copy" started')
    expect(messages).toContain('[Running] [Frozen UI copy] Step: Chapter one')
    expect(messages).toContain('[Pause requested] "Frozen UI copy" will pause after the current chapter')
    expect(messages).toContain('[Paused] Workflow "Frozen UI copy" paused after the current step')
    expect(messages).toContain('[Resumed] Workflow "Frozen UI copy" resumed')
    expect(messages).toContain('[Completed] Workflow "Frozen UI copy" completed')
    expect(messages).not.toMatch(/\[(?:开始|执行|暂停|继续|完成)\]/u)
  })

  it('keeps cancellation status and logs in the launch UI locale after the global locale changes', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    let finishStep: (() => void) | undefined
    const completion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Frozen cancellation copy',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'Draft',
        description: 'draft step',
        executor: async () => new Promise<void>(resolve => { finishStep = resolve }),
      }],
    })
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => expect(finishStep).toBeTypeOf('function'))

    useLocaleStore.setState({ locale: 'zh-CN' })
    useWorkflowStore.getState().cancelWorkflow(runId)
    expect(useWorkflowStore.getState().activeRuns[0]?.error)
      .toBe('Cancellation requested; waiting for the current operation to exit safely.')
    finishStep!()
    await completion

    expect(useWorkflowStore.getState().history[0]?.error).toBe('Workflow was cancelled.')
    const messages = useWorkflowStore.getState().globalLogs.map(entry => entry.message).join('\n')
    expect(messages).toContain('[Cancel requested] Waiting for the current operation to exit safely')
    expect(messages).toContain('[Failed] [Frozen cancellation copy] Step: Draft — Workflow was cancelled.')
    expect(messages).not.toMatch(/\[(?:取消|失败)\]/u)
  })

  it('keeps the store failure wrapper in the launch UI locale while preserving the original error', async () => {
    useLocaleStore.setState({ locale: 'en-US' })

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Frozen failure copy',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: 'Draft',
        description: 'draft step',
        executor: async () => {
          useLocaleStore.setState({ locale: 'zh-CN' })
          throw new Error('provider exploded')
        },
      }],
    })

    expect(useWorkflowStore.getState().history[0]?.error).toBe('provider exploded')
    const messages = useWorkflowStore.getState().globalLogs.map(entry => entry.message).join('\n')
    expect(messages).toContain('[Failed] [Frozen failure copy] Step: Draft — provider exploded')
    expect(messages).not.toContain('[失败]')
  })

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

  it('preserves a typed prompt-budget failure and attributes deleted-KB overflow to remaining config', async () => {
    const failure = new PromptBudgetExceededError({
      totalUtf8Bytes: 13_000,
      limitUtf8Bytes: 12_000,
      reservedOutputTokens: 8_192,
      sections: [
        { sectionName: 'global-guidance', utf8Bytes: 12_020 },
        { sectionName: 'reference-works', utf8Bytes: 400 },
        { sectionName: 'prompt-overhead', utf8Bytes: 580 },
      ],
      modelId: 'model-a',
      errorCode: 'PROMPT_BUDGET_EXHAUSTED',
    })

    await useWorkflowStore.getState().startWorkflow({
      type: 'architecture_generation',
      title: '角色图谱生成',
      projectPath,
      projectSession: frozenSession(),
      steps: [{
        name: '角色图谱',
        description: '生成角色身份清单',
        executor: async () => { throw failure },
      }],
    })

    const run = useWorkflowStore.getState().history[0]
    expect(run).toMatchObject({
      status: 'failed',
      failureCode: 'prompt_budget_exhausted',
      promptBudgetReport: failure.report,
      steps: [expect.objectContaining({
        failureCode: 'prompt_budget_exhausted',
        promptBudgetReport: failure.report,
      })],
    })
    expect(run?.error).toContain('提示词共 13,000 UTF-8 字节')
    expect(run?.error).toContain('全局指导 12,020')
    expect(run?.error).toContain('模型：model-a；结果码：PROMPT_BUDGET_EXHAUSTED')
    expect(run?.error).not.toContain('知识库')
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
