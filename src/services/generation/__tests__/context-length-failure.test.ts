import { describe, expect, it, vi } from 'vitest'
import { createMainOwnedGenerationRuntime, type MainGenerationRunHandle, type MainGenerationRunView, type MainGenerationTransport } from '../generation-runtime'
import type { GenerationOutcome, GenerationTask } from '../generation-harness'
import { knownAppErrorMessage } from '../../../i18n/app-errors'
import { runFailure } from '../../../components/run/run-failure'
import type { WorkflowContext, WorkflowRun } from '../../../stores/workflow-store'
import { createStructuredBatchExecutor } from '../../workflows/structured-batch-executor'
import { createWorkflowMainGenerationRuntime } from '../../workflows/workflow-main-generation'
import type { createMainGenerationTransport } from '../main-generation-transport'
import { runFinalizationGeneration } from '../../finalization-generation'
import { describeFinalizationStepError, planFinalizationRetry } from '../../../shared/finalization-step-error'
import { classifyGenerationFailure, formatGenerationBudgetDiagnostic } from '../prompt-budget-failure'
import { presentWorkflowFailure } from '../../../components/panels/ai-output-failure-presentation'

const handle: MainGenerationRunHandle = { projectId: '项目', epoch: '会话', rootActionId: '动作', runId: '运行' }
const task: GenerationTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '写第 9 章' }] }

const view: MainGenerationRunView = { handle, budget: { maxAttempts: 32, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 },
  status: 'running', nonReplayable: false, artifacts: [] }
const failedOutcome = (failureCode?: string) => ({ status: 'incomplete', content: '', finishReason: 'error', receipt: {
  model: { id: '模型', configurationRevision: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64) },
  capabilities: { contextWindowTokens: null, maxOutputTokens: 2000, reasoning: null, structuredOutput: null, usage: null, source: { contextWindowTokens: 'unknown', maxOutputTokens: 'legacy-profile', featureFlags: 'unknown' } },
  budget: { attempt: 1, maxAttempts: 32, requestedOutputTokens: 2000, cumulativeRequestedOutputTokens: 2000, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 },
  finishReason: 'error', ...(failureCode ? { failureCode } : {}),
} }) as GenerationOutcome

function transport(failureCode?: string): MainGenerationTransport {
  return { read: vi.fn(async () => structuredClone(view)), list: vi.fn(async () => [structuredClone(view)]),
    execute: vi.fn(async () => ({ outcome: failedOutcome(failureCode), run: structuredClone(view) })),
    cancel: vi.fn(async () => ({ ...structuredClone(view), status: 'cancelled' as const })), subscribe: vi.fn(() => () => {}) }
}

async function complete(failureCode?: string) {
  const runtime = await createMainOwnedGenerationRuntime({ runHandle: handle }, transport(failureCode))
  try { return await runtime.execute(({ session }) => session.complete(task, { invocationNonce: 'call' })) } finally { await runtime.close() }
}

const CODE = 'GENERATION_CONTEXT_LENGTH_EXCEEDED'
const project = { projectId: '项目', leaseId: '会话', projectPath: 'C:/projects/旧港' }

describe('讨论区 #77：上下文超长码在每条消费路径上都保留', () => {
  it('运行时抛出的错误带登记码与本次调用收据', async () => {
    const error = await complete(CODE).catch((reason: unknown) => reason) as { code?: string; receipt?: { failureCode?: string } }
    expect(error.code).toBe(CODE)
    expect(error.receipt?.failureCode).toBe(CODE)
  })

  it('蓝图等结构化批次以登记码失败，并保留已发出的那次调用', async () => {
    const runtime = await createMainOwnedGenerationRuntime({ runHandle: handle }, transport(CODE))
    // 工作流会话替执行器补上调用编号；这里直接接主进程运行时，同样补一个。
    const result = await runtime.execute(({ session }) => createStructuredBatchExecutor<number, { chapterNumber: number }>({ writingLanguage: 'zh-CN',
      session: { complete: (input, options) => session.complete(input, { ...options, invocationNonce: 'call' }) },
      contract: { buildTask: ({ items }) => ({ purpose: 'chapter-blueprints', output: 'structured-data', messages: [{ role: 'user', content: JSON.stringify(items) }] }),
        inputKey: item => item, outputKey: item => item.chapterNumber, decode: content => JSON.parse(content), validateItem: () => undefined },
    }).execute({ items: [1], limits: { maxBatchItems: 10 } }))
    await runtime.close()
    expect(result).toMatchObject({ ok: false, failure: { reason: 'context_length', message: CODE }, receipt: { calls: 1 } })
  })

  it('导入阶段直接取回执的路径同样以登记码失败，并上报这次请求的传输诊断', async () => {
    const failed = failedOutcome(CODE)
    const diagnostics = { startedAt: 1, elapsedMs: 20, httpStatus: 400, phase: 'response', endReason: 'failed', errorCode: 'HTTP_ERROR', visibleEvents: 0, reasoningEvents: 0 }
    const setGenerationActivity = vi.fn()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'import-generation:read') return { view, modelId: 'model', frozenContext: {} }
      if (channel === 'import-generation:execute') return { run: view, outcome: { ...failed, receipt: { ...failed.receipt, diagnostics } } }
      throw new Error(channel)
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
    const context: WorkflowContext = { runId: 'workflow', projectPath: project.projectPath, projectSession: project,
      generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
    const runtime = await createWorkflowMainGenerationRuntime({ context, callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), setGenerationActivity },
      selection: { operation: 'import-global-facts', promptKeys: [], skillStages: [], output: 'structured-data',
        importSlot: { runId: 'import-run', stage: 'global', batchId: 'done' } } },
    { read: vi.fn(async () => view), subscribe: vi.fn(() => () => {}) } as unknown as ReturnType<typeof createMainGenerationTransport>)
    await runtime.execute(async ({ session }) => {
      await expect(session.complete({ purpose: 'import-global-facts', output: 'structured-data', messages: [] })).rejects.toMatchObject({ code: CODE })
    })
    expect(setGenerationActivity).toHaveBeenLastCalledWith({ operation: 'import-global-facts', diagnostics })
    vi.unstubAllGlobals()
  })

  it('定稿后处理以登记码失败，说明换模型或调低最大输出，且不再提供重试', async () => {
    const source = { finalizationId: '定稿', draftId: 1, chapterNumber: 1, contentHash: 'a'.repeat(64) }
    const slot = { source, stepKey: 'chapter_notes' as const }
    const stored = { view: { handle, artifacts: [], status: 'running', ledger: { physicalRequests: 0 } }, attemptCount: 0, modelId: '模型', context: { slot }, sourceStatus: 'current' }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'finalization-generation:read') return null
      if (channel === 'finalization-generation:begin') return stored
      if (channel === 'finalization-generation:execute') return { run: stored.view, outcome: failedOutcome(CODE) }
      throw new Error(channel)
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
    await expect(runFinalizationGeneration({ session: project, slot, modelId: () => '模型', cancelled: () => false })).rejects.toThrow(CODE)
    vi.unstubAllGlobals()
    expect(describeFinalizationStepError(CODE, zh => zh)).toContain('调低最大输出 Tokens')
    expect(planFinalizationRetry({ chapter_notes: { ok: false, error: CODE } }).rows.size).toBe(0)
  })

  it('预算诊断把它归为服务商上下文超长，而不是其他', () => {
    expect(classifyGenerationFailure(CODE, 'error')).toBe('provider-context')
  })
})

const failedDraft = (error: string, result = ''): WorkflowRun => ({ id: '运行', title: '第 9 章 · 写稿', type: 'chapter_creation', status: 'failed',
  uiLocale: 'zh-CN', writingLanguage: 'zh-CN', projectPath: 'C:/projects/旧港', projectSession: null, chapterWordsTarget: 4000,
  currentStepIndex: 0, createdAt: '2026-10-25T00:00:00.000Z', error, errorCode: error,
  steps: [{ id: 'draft', name: '写稿', description: '', status: 'failed', logs: [], error, errorCode: error, result }] }) as WorkflowRun

describe('讨论区 #77：服务商上下文超长', () => {
  it('主进程回执带上下文超长码时，运行以该码失败，不当作普通未完成', async () => {
    await expect(complete('GENERATION_CONTEXT_LENGTH_EXCEEDED')).rejects.toThrow(/^GENERATION_CONTEXT_LENGTH_EXCEEDED$/u)
    await expect(complete('GENERATION_PROVIDER_FAILED')).resolves.toMatchObject({ status: 'incomplete', finishReason: 'error' })
  })

  it.each([
    ['zh-CN', ['换用上下文更长的模型', '调低最大输出 Tokens', '精简本章要求、参考材料'], '上下文窗口'],
    ['en-US', ['model with a longer context', 'lower Max output tokens', 'shorten the chapter request and reference material'], 'Context Window'],
  ] as const)('%s 文案建议换模型、调低最大输出或精简材料，不指向上下文窗口设置', (locale, advice, stale) => {
    const message = knownAppErrorMessage(locale, new Error('GENERATION_CONTEXT_LENGTH_EXCEEDED'))
    for (const phrase of advice) expect(message).toContain(phrase)
    expect(message).not.toContain(stale)
  })

  it('写稿卡片说明超长原因，不再让作者调整章节要求', () => {
    const { presentation } = runFailure(failedDraft("Error invoking remote method 'generation:execute': Error: GENERATION_CONTEXT_LENGTH_EXCEEDED"))
    expect(presentation.reason).toContain('换用上下文更长的模型')
    expect(presentation.reason).not.toContain('上下文窗口')
    expect(presentation.persistence).toBe('本次未保存草稿或正文章节。')
  })

  it('写稿步骤已有主进程保存的正文时，卡片不说未保存', () => {
    expect(runFailure(failedDraft('GENERATION_CONTEXT_LENGTH_EXCEEDED', '雨夜，铜钥匙落在门前。')).presentation.persistence).toBeUndefined()
  })
})

describe('讨论区 #77：上下文超长说明不被其他展示覆盖', () => {
  it('审稿卡片优先显示登记说明，不被 HTTP 400 诊断覆盖', () => {
    const presentation = presentWorkflowFailure(undefined, `Error invoking remote method 'generation:execute': Error: ${CODE}`, 'zh-CN', false, undefined,
      { operation: 'review-chapter', diagnostics: { startedAt: 1, elapsedMs: 20, httpStatus: 400, phase: 'response', endReason: 'failed', errorCode: 'HTTP_ERROR', visibleEvents: 0, reasoningEvents: 0, firstResponseMs: 20, lastResponseMs: 20, lastOutputMs: null } })
    expect(presentation.reason).toContain('换用上下文更长的模型')
  })

  it('预算诊断认得经 IPC 包装的码', () => {
    expect(classifyGenerationFailure(`Error invoking remote method 'generation:execute': Error: ${CODE}`, 'error')).toBe('provider-context')
  })

  it('旧回执里不认识的理由码不会让诊断渲染出错', () => {
    expect(() => formatGenerationBudgetDiagnostic({ attemptId: 'old', requestedOutputTokens: 1, reservedTokens: 2, actual: null, actualState: 'unknown',
      reasons: [{ code: 'retired-by-a-future-build', selected: true } as never] }, 'zh-CN')).not.toThrow()
  })
})

it('定稿后处理重入时保留的失败候选不掩盖本步骤的上下文超长，且不看同根另一步骤的诊断', async () => {
  const source = { finalizationId: '定稿', draftId: 1, chapterNumber: 1, contentHash: 'a'.repeat(64) }
  const slot = { source, stepKey: 'chapter_notes' as const }
  const failedCandidate = { ...handle, artifactId: '空候选', revision: 0, textHash: 'c'.repeat(64), text: '', status: 'failed', compositionEligible: false }
  const run = (latest: string | null, sibling: string | null) => ({
    view: { handle, artifacts: [failedCandidate], status: 'failed', ledger: { physicalRequests: 2 }, budgetDiagnostics: [{ failureCode: latest }, { failureCode: sibling }] },
    attemptCount: 1, modelId: '模型', context: { slot }, sourceStatus: 'current', latestAttempt: { attemptId: '本步骤', inFlight: false, finishReason: null, failureCode: latest } })
  const start = (stored: unknown) => {
    vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => {
      if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return stored
      throw new Error(channel)
    }), on: () => () => {} } })
    return runFinalizationGeneration({ session: project, slot, modelId: () => '模型', cancelled: () => false })
  }
  await expect(start(run(CODE, null))).rejects.toThrow(CODE)
  await expect(start(run('GENERATION_PROVIDER_FAILED', CODE))).rejects.not.toThrow(CODE)
  vi.unstubAllGlobals()
})
