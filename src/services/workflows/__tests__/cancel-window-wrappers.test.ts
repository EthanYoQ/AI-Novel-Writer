import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type StepCallbacks, type WorkflowContext } from '../../../stores/workflow-store'
import { GenerationHarnessError, type GenerationSession } from '../../generation/generation-harness'
import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from '../commands/base-command'
import { runPostProcessPipeline } from '../workflow-utils'

// #587 第三轮：包装层只因「取消已请求」就把任何错误改写成取消，store 便把真实失败记成已取消。
// 这里走真实的包装（callLLMResult、withRetry 与后处理流水线）和真实的 store，看作者最后看到的运行状态。

const projectPath = 'C:\\cancel-window'
const RUN_ID = 'cancel-window-run'
const session = { projectId: 'cancel-window', leaseId: 'lease-cancel-window', projectPath }

function storageFailure() {
  return Object.assign(new Error('生成记录写入失败：磁盘空间不足'), { code: 'GENERATION_STORAGE_FAILED' })
}

function cancelRun() {
  useWorkflowStore.getState().cancelWorkflow(RUN_ID)
}

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'skills:list-user': return []
      case 'fs:check-exists': return false
      case 'db:post-process-get-latest-run': return null
      case 'db:post-process-create-run': return { success: true, id: 'post-run-1' }
      case 'db:post-process-get-steps': return []
      case 'db:post-process-mark-step-failed': return { success: true }
      case 'db:post-process-mark-step-ok': return { success: true }
      default: throw new Error(`测试未配置桌面调用：${channel}`)
    }
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn() } })
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {},
    currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: { id: session.projectId, name: '取消窗口', path: projectPath, sessionLease: session.leaseId, novelConfig: {} } as never,
  })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

async function runOneStep(executor: (context: WorkflowContext, callbacks: StepCallbacks) => Promise<unknown>) {
  await useWorkflowStore.getState().startWorkflow({
    runId: RUN_ID, type: 'batch_generate', title: '批量创作 · 第 5 章', projectPath, projectSession: session,
    steps: [{ name: '第 5 章', description: '', executor: async (_step, context, callbacks) => {
      await executor(context, callbacks)
      return undefined
    } }],
  })
  return useWorkflowStore.getState().history[0]
}

class OneCompletionCommand extends BaseWorkflowCommand<string> {
  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, async () => (
      await this.callLLMResult('写第 5 章', 'system', params.callbacks, undefined, params.context)
    ).content)
  }
}

function sessionThat(complete: GenerationSession['complete']): WorkflowGenerationRuntimeDependencies {
  const generation: GenerationSession = {
    budget: { maxAttempts: 1, maxRequestedOutputTokens: 1024, maxRequestedOutputTokensPerAttempt: 1024, deadlineAt: Date.now() + 60_000 },
    complete,
  }
  return {
    createRuntime: async () => ({
      execute: operation => operation({ session: generation }),
      close: async () => undefined,
    }),
  }
}

describe('callLLMResult：作者点了取消', () => {
  it('取消请求之后会话报存储错误：运行和这一步都记失败，带原错误码', async () => {
    const finished = await runOneStep((context, callbacks) => new OneCompletionCommand(sessionThat(async () => {
      cancelRun()
      throw storageFailure()
    })).execute({ step: {}, context, callbacks }))

    expect(finished).toMatchObject({ status: 'failed', errorCode: 'GENERATION_STORAGE_FAILED' })
    expect(finished.steps[0]).toMatchObject({ status: 'failed', errorCode: 'GENERATION_STORAGE_FAILED' })
  })

  it('会话因取消中止：运行和这一步都记已取消', async () => {
    const finished = await runOneStep((context, callbacks) => new OneCompletionCommand(sessionThat(async () => {
      cancelRun()
      throw new GenerationHarnessError('CANCELLED', '生成请求已取消。')
    })).execute({ step: {}, context, callbacks }))

    expect(finished).toMatchObject({ status: 'cancelled' })
    expect(finished.steps[0]).toMatchObject({ status: 'cancelled' })
  })
})

class SingleShotCommand extends BaseWorkflowCommand<string> {
  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.callLLM('写第 5 章', 'system', params.callbacks, undefined, params.context))
  }
}

class BoundedCommand extends BaseWorkflowCommand<string> {
  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.callLLMWithBoundedCompletion('写第 5 章', 'system', params.callbacks,
      { mode: 'append-visible-text', maxContinuations: 2 }, undefined, params.context))
  }
}

// 主进程把失败写进收据后照常返回结果，不抛错；取消截断的请求同样返回，只是收据里没有失败码（主进程不把取消码交给渲染端）。
function returnedIncomplete(failureCode?: 'GENERATION_STORAGE_FAILED' | 'ROOT_BUDGET_EXHAUSTED') {
  return { status: 'incomplete', content: '第 5 章写到一半', finishReason: 'error',
    receipt: { purpose: 'workflow', ...(failureCode ? { failureCode } : {}) } } as unknown as Awaited<ReturnType<GenerationSession['complete']>>
}

describe.each([
  ['callLLM', SingleShotCommand],
  ['有界续写', BoundedCommand],
] as const)('%s：作者点了取消，主进程返回的是结果而不是异常', (_label, Command) => {
  it.each(['GENERATION_STORAGE_FAILED', 'ROOT_BUDGET_EXHAUSTED'] as const)('收据带真实失败码 %s：运行和这一步都记失败', async failureCode => {
    const finished = await runOneStep((context, callbacks) => new Command(sessionThat(async () => {
      cancelRun()
      return returnedIncomplete(failureCode)
    })).execute({ step: {}, context, callbacks }))

    expect(finished).toMatchObject({ status: 'failed', errorCode: failureCode })
    expect(finished.steps[0]).toMatchObject({ status: 'failed', errorCode: failureCode })
  })

  it('取消截断的结果（收据没有失败码）：运行和这一步都记已取消', async () => {
    const finished = await runOneStep((context, callbacks) => new Command(sessionThat(async () => {
      cancelRun()
      return returnedIncomplete()
    })).execute({ step: {}, context, callbacks }))

    expect(finished).toMatchObject({ status: 'cancelled' })
    expect(finished.steps[0]).toMatchObject({ status: 'cancelled' })
  })
})

describe('定稿后处理（withRetry）：作者点了取消', () => {
  const postProcess = (stopOnFailure: boolean, executor: () => Promise<void>) => (context: WorkflowContext, callbacks: StepCallbacks) => runPostProcessPipeline(
    projectPath, 'chapter_5_finalize', '第 5 章定稿', [{ key: 'character_cards', label: '角色状态更新', critical: false, executor }],
    callbacks, { retryCount: 2, stopOnFailure, cancellation: context, projectSession: session },
  )
  const markedFailed = () => invoke.mock.calls.filter(([channel]) => channel === 'db:post-process-mark-step-failed')

  it('批量创作（失败即停）：取消请求之后这一步写入失败，先记下失败，运行记失败，不重试', async () => {
    const executor = vi.fn(async () => { cancelRun(); throw storageFailure() })
    const finished = await runOneStep(postProcess(true, executor))

    expect(executor).toHaveBeenCalledOnce()
    expect(markedFailed()).toEqual([['db:post-process-mark-step-failed', 'post-run-1', 'character_cards', '生成记录写入失败：磁盘空间不足', projectPath, session]])
    expect(finished).toMatchObject({ status: 'failed' })
    expect(finished.error).toContain('角色状态更新')
    expect(finished.steps[0]).toMatchObject({ status: 'failed' })
  })

  it('单章定稿（失败不挡后续）：取消请求之后这一步写入失败，失败照样记进后处理，运行按作者的取消记已取消', async () => {
    const executor = vi.fn(async () => { cancelRun(); throw storageFailure() })
    const finished = await runOneStep(postProcess(false, executor))

    expect(executor).toHaveBeenCalledOnce()
    expect(markedFailed()).toHaveLength(1)
    expect(finished).toMatchObject({ status: 'cancelled' })
  })

  it('这一步因取消中止：不记失败，运行记已取消', async () => {
    const finished = await runOneStep(postProcess(true, async () => {
      cancelRun()
      throw new Error('GENERATION_WORKFLOW_CANCELLED')
    }))

    expect(markedFailed()).toEqual([])
    expect(finished).toMatchObject({ status: 'cancelled' })
    expect(finished.steps[0]).toMatchObject({ status: 'cancelled' })
  })
})
