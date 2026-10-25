import { describe, expect, it, vi } from 'vitest'
import { createMainOwnedGenerationRuntime, type MainGenerationRunHandle, type MainGenerationRunView, type MainGenerationTransport } from '../generation-runtime'
import type { GenerationOutcome, GenerationTask } from '../generation-harness'
import { knownAppErrorMessage } from '../../../i18n/app-errors'
import { runFailure } from '../../../components/run/run-failure'
import type { WorkflowRun } from '../../../stores/workflow-store'

// 讨论区 #77：服务商以上下文超长拒绝时，运行以登记过的码失败，界面建议换用上下文更长的模型或精简本章材料。
// 「上下文窗口」设置不再影响发送，所以文案不再指向它（维护者 2026-10-26 确认）。

const handle: MainGenerationRunHandle = { projectId: '项目', epoch: '会话', rootActionId: '动作', runId: '运行' }
const task: GenerationTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '写第 9 章' }] }

function transport(failureCode?: string): MainGenerationTransport {
  const view: MainGenerationRunView = { handle, budget: { maxAttempts: 32, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 },
    status: 'running', nonReplayable: false, artifacts: [] }
  const outcome = { status: 'incomplete', content: '', finishReason: 'error', receipt: {
    model: { id: '模型', configurationRevision: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64) },
    capabilities: { contextWindowTokens: null, maxOutputTokens: 2000, reasoning: null, structuredOutput: null, usage: null, source: { contextWindowTokens: 'unknown', maxOutputTokens: 'legacy-profile', featureFlags: 'unknown' } },
    budget: { attempt: 1, maxAttempts: 32, requestedOutputTokens: 2000, cumulativeRequestedOutputTokens: 2000, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 },
    finishReason: 'error', ...(failureCode ? { failureCode } : {}),
  } } as GenerationOutcome
  return { read: vi.fn(async () => structuredClone(view)), list: vi.fn(async () => [structuredClone(view)]),
    execute: vi.fn(async () => ({ outcome: structuredClone(outcome), run: structuredClone(view) })),
    cancel: vi.fn(async () => ({ ...structuredClone(view), status: 'cancelled' as const })), subscribe: vi.fn(() => () => {}) }
}

async function complete(failureCode?: string) {
  const runtime = await createMainOwnedGenerationRuntime({ runHandle: handle }, transport(failureCode))
  try { return await runtime.execute(({ session }) => session.complete(task, { invocationNonce: 'call' })) } finally { await runtime.close() }
}

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
    ['zh-CN', ['换用上下文更长的模型', '精简本章要求、参考材料'], '上下文窗口'],
    ['en-US', ['model with a longer context', 'shorten the chapter request and reference material'], 'Context Window'],
  ] as const)('%s 文案建议换模型或精简材料，不指向上下文窗口设置', (locale, advice, stale) => {
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
