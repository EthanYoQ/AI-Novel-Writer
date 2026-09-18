import { describe, expect, it } from 'vitest'
import type { PromptBudgetReport } from '../generation-harness'
import {
  classifyGenerationFailure,
  formatGenerationBudgetDiagnostic,
  formatPromptBudgetFailure,
  formatTaskBudgetDecisionFailure,
} from '../prompt-budget-failure'
import { planTaskBudget, type GenerationBudgetDiagnostic } from '../task-budget-planner'

describe('writing skill prompt budget diagnostics', () => {
  it('shows the safe skill display name without exposing its prompt content', () => {
    const report: PromptBudgetReport = {
      totalUtf8Bytes: 12_500,
      limitUtf8Bytes: 12_000,
      contextWindowTokens: 16_384,
      estimatedInputTokens: 3_200,
      reservedOutputTokens: 4_096,
      sections: [{
        sectionName: 'writing-skill',
        displayName: 'Scene Craft',
        utf8Bytes: 2_400,
      }],
      modelId: 'model-1',
      errorCode: 'PROMPT_BUDGET_EXHAUSTED',
    }

    expect(formatPromptBudgetFailure(report, 'en-US')).toContain('Writing Skill: Scene Craft 2,400')
    expect(formatPromptBudgetFailure(report, 'zh-CN')).toContain('写作 Skill：Scene Craft 2,400')
    expect(JSON.stringify(report)).not.toContain('Prefer concrete action')
  })

  it('separates requested, total reserved and trusted actual usage', () => {
    const diagnostic: GenerationBudgetDiagnostic = {
      attemptId: 'attempt-1',
      plannerVersion: 's07-task-budget-v1',
      requestedOutputTokens: 7_712,
      reservedTokens: 9_224,
      actual: { input: 900, completion: 3_050, reasoning: 210, total: 4_160 },
      actualState: 'settled',
      finishReason: 'stop',
      failureCode: null,
      reasons: [{ code: 'model-output-cap', valueTokens: 8_192, selected: true }],
    }

    const message = formatGenerationBudgetDiagnostic(diagnostic, 'zh-CN')
    expect(message).toContain('需求输出 7,712 tokens')
    expect(message).toContain('总预留 9,224 tokens')
    expect(message).toContain('实际总量 4,160 tokens')
    expect(message).toContain('推理 210')
    expect(message).toContain('裁决依据：模型输出上限')
  })

  it('keeps an unknown sent attempt charged at its reservation', () => {
    const message = formatGenerationBudgetDiagnostic({
      attemptId: 'attempt-unknown',
      requestedOutputTokens: 4_096,
      reservedTokens: 8_192,
      actual: null,
      actualState: 'unknown',
      failureCode: 'NETWORK_ERROR',
      reasons: [],
    }, 'zh-CN')

    expect(message).toContain('网络')
    expect(message).toContain('实际用量未知')
    expect(message).toContain('仍按预留额度保守记账')
  })

  it.each([
    ['TASK_BUDGET_CAPACITY_CONFLICT', null, 'capacity-preflight'],
    ['TASK_BUDGET_CAPACITY_CONFLICT:single-item-capacity-conflict', null, 'capacity-preflight'],
    ["Error invoking remote method 'generation:run': Error: TASK_BUDGET_CAPACITY_CONFLICT:model-capability-unknown", null, 'capacity-preflight'],
    ['TASK_BUDGET_SPLIT_REQUIRED:scope-split', null, 'capacity-preflight'],
    // 主进程预检实际抛出的是带 SCOPE_ 的拼写，批执行器也按它解析。
    ['TASK_BUDGET_SCOPE_SPLIT_REQUIRED:7', null, 'capacity-preflight'],
    ["Error invoking remote method 'generation:execute': Error: TASK_BUDGET_SCOPE_SPLIT_REQUIRED:7", null, 'capacity-preflight'],
    ['ROOT_BUDGET_EXHAUSTED', null, 'budget-exhausted'],
    [null, 'length', 'provider-length'],
    ['NETWORK_ERROR', null, 'network'],
    ['GENERATION_STORAGE_FAILED', null, 'storage'],
    ['SQLITE_FULL', null, 'storage'],
    ['GENERATION_CANCELLED', null, 'cancelled'],
    [null, 'cancelled', 'cancelled'],
  ] as const)('classifies %s / %s separately', (failureCode, finishReason, category) => {
    expect(classifyGenerationFailure(failureCode, finishReason)).toBe(category)
  })

  it('reports a released pre-dispatch reservation without inventing zero actual usage', () => {
    const message = formatGenerationBudgetDiagnostic({
      attemptId: 'cancelled-before-dispatch',
      requestedOutputTokens: 4_096,
      reservedTokens: 8_192,
      actual: null,
      actualState: 'not-dispatched',
      failureCode: 'GENERATION_CANCELLED',
      reasons: [],
    }, 'zh-CN')

    expect(message).toContain('已取消')
    expect(message).toContain('原总预留 8,192 tokens')
    expect(message).toContain('请求未发送，预留已释放')
    expect(message).not.toContain('实际用量')
    expect(message).not.toContain('实际总量 0')
  })

  it('explains a preflight conflict without exposing prompt content', () => {
    const decision = planTaskBudget({
      stage: 'drafting',
      demand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 3_000, segmentable: false },
      inputEstimate: { upperBoundTokens: 1_000, estimatorVersion: 'fixture-v1' },
      capability: {
        modelContextWindowTokens: 8_192,
        modelMaxOutputTokens: 4_096,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: null,
        userMaxOutputTokens: null,
      },
      root: { remainingTokenLiability: 100_000, maxOutputPerRequest: 32_768 },
      liability: { mode: 'included-in-output' },
      safetyMarginTokens: 512,
    })

    const message = formatTaskBudgetDecisionFailure(decision, 'zh-CN')
    expect(message).toContain('本次未发送')
    expect(message).toContain('此正文任务不能安全分段')
    expect(message).not.toContain('任何作者正文')
  })
})
