import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { GenerationBudgetReceipt } from '../../repositories/generation-run-repository'
import { createModelExecutionLeaseReceipt } from '../model-execution-lease'
import { buildMainGenerationPlan, MAIN_GENERATION_POLICY } from '../main-generation-plan'

const task: GenerationTask = { purpose: 'chapter:draft', output: 'visible-text', messages: [{ role: 'user', content: '雨夜，铜钥匙落在门前。' }] }
function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id: '合成模型', name: '合成预算模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: '', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 8192, purposes: ['generation'], ...overrides }
}
function ledger(): GenerationBudgetReceipt {
  return { root: { projectId: '项目', epoch: '会话', rootActionId: '根', operation: '正文', uiActionNonce: '点击', frozenInputHash: 'a'.repeat(64), status: 'active' }, policy: { ...MAIN_GENERATION_POLICY.budget }, attempts: [], activeElapsedMs: 0, blockedCode: null }
}
function plan(profile = model(), input = task, budget = ledger()) {
  const receipt = createModelExecutionLeaseReceipt(profile, { leaseId: '合成租约', createdAt: 1, expiresAt: 1000 })
  return buildMainGenerationPlan(profile, receipt, input, budget)
}
const gemini = () => model({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', modelName: 'gemini-2.5-flash-lite', reasoningOverride: 'medium' })
const silicon = () => model({ baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: { contextWindowTokens: 65536, maxOutputTokens: 8192, reasoning: false, structuredOutput: false, usage: false } })

describe('main generation physical liability planning without provider calls', () => {
  it('keeps the temporary S05 policy finite and explicit', () => {
    expect(MAIN_GENERATION_POLICY.budget).toEqual({ maxPhysicalRequests: 32, maxTokenLiability: 2097152, maxOutputPerRequest: 32768, maxActiveElapsedMs: 3600000 })
  })
  it('uses OpenAI combined completion cap without counting reasoning twice', () => {
    const result = plan(model({ modelName: 'o3', reasoningOverride: 'high' }))
    expect(result.options.outputTokenParameter).toBe('max_completion_tokens')
    expect(result.reasoningUpperBoundTokens).toBe(0)
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + 512)
    expect(result.usagePolicy.reasoning).toBe('included-in-completion')
  })
  it('keeps DeepSeek max_tokens with its included reasoning cap', () => {
    const result = plan(model({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' }))
    expect(result.options.outputTokenParameter).toBeUndefined()
    expect(result.options.maxTokens).toBe(result.requestedOutputTokens)
    expect(result.reasoningUpperBoundTokens).toBe(0)
  })
  it('counts Gemini explicit thinking exactly once in remaining and total', () => {
    const budget = ledger(); budget.policy.maxTokenLiability = 10000
    const result = plan(gemini(), task, budget)
    expect(result.options.reasoning).toEqual({ adapter: 'gemini-thinking-budget', thinkingBudget: 8192 })
    expect(result.reasoningUpperBoundTokens).toBe(8192)
    expect(result.requestedOutputTokens).toBe(10000 - result.inputUpperBoundTokens - 8192 - 512)
    expect(result.reservedTokens).toBe(10000)
    expect(result.usagePolicy.reasoning).toBe('separately-billed')
  })
  it('allows known Gemini explicit zero but refuses an unknown thinking mapping', () => {
    expect(plan({ ...gemini(), reasoningOverride: 'off' }).reasoningUpperBoundTokens).toBe(0)
    expect(() => plan({ ...gemini(), modelName: 'gemini-unknown' })).toThrow('GENERATION_LIABILITY_UNBOUNDED')
  })
  it('reserves the full Silicon V4 1M despite smaller user context and feature claims', () => {
    const result = plan(silicon())
    expect(result.reservedTokens).toBe(1048576)
    expect(result.reasoningUpperBoundTokens).toBe(1048576 - result.inputUpperBoundTokens - result.requestedOutputTokens - 512)
    expect(result.reasoningUpperBoundTokens).toBeGreaterThan(65536)
  })
  it('refuses Silicon V4 when the remaining root cannot cover the full ceiling', () => {
    const budget = ledger(); budget.policy.maxTokenLiability = 1048575
    expect(() => plan(silicon(), task, budget)).toThrow('ROOT_BUDGET_EXHAUSTED')
  })
  it('classifies a third full-context Silicon reservation as exhausted root budget, not input capacity', () => {
    const budget = ledger()
    budget.attempts = [1, 2].map(index => ({ attemptId: `attempt-${index}`, reservationId: `reservation-${index}`,
      rootActionId: '根', status: 'unknown' as const, reservedTokens: 1_048_576, requestedOutputTokens: 8_192 }))
    expect(() => plan(silicon(), task, budget)).toThrow('ROOT_BUDGET_EXHAUSTED')
  })
  it('reduces output for high input occupancy and refuses no positive capacity', () => {
    const budget = ledger(); budget.policy.maxTokenLiability = 4096
    const input = { ...task, messages: [{ role: 'user' as const, content: '雨'.repeat(1000) }] }
    const result = plan(model(), input, budget)
    expect(result.inputUpperBoundTokens).toBe(3068)
    expect(result.requestedOutputTokens).toBe(516)
    expect(() => plan(model(), { ...input, messages: [{ role: 'user', content: '雨'.repeat(1200) }] }, budget)).toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
  })
  it('keeps unknown reservations liable while settled actual and pre-dispatch cancellation differ', () => {
    const budget = ledger(); budget.policy.maxTokenLiability = 10000
    budget.attempts = [{ attemptId: '旧请求', reservationId: '旧预留', rootActionId: '根', status: 'unknown', reservedTokens: 8000, requestedOutputTokens: 7000, actualTokens: 1 }]
    expect(plan(model(), task, budget).reservedTokens).toBe(2000)
    budget.attempts[0].status = 'settled'
    expect(plan(model(), task, budget).requestedOutputTokens).toBe(8192)
    budget.attempts[0].status = 'cancelled-before-dispatch'
    expect(plan(model(), task, budget).requestedOutputTokens).toBe(8192)
  })
  it.each(['maxTokens', 'maxOutputTokens', 'thinking', 'thinking_budget', 'plan', 'reservedTokens', 'responseFormat'])('rejects renderer physical control %s', key => {
    expect(() => plan(model(), { ...task, [key]: 1 } as GenerationTask)).toThrow('GENERATION_SEMANTIC_TASK_INVALID')
  })
  it.each(['https://proxy.example/v1', 'http://api.openai.com/v1', 'https://api.openai.com.evil.example/v1', 'https://api.openai.com:444/v1', 'https://user@api.openai.com/v1'])('does not trust endpoint claims: %s', baseUrl => {
    expect(() => plan(model({ baseUrl }))).toThrow('GENERATION_LIABILITY_UNBOUNDED')
  })
  it('does not trust an arbitrary Silicon model or protocol claim', () => {
    expect(() => plan({ ...silicon(), modelName: 'unknown-model' })).toThrow('GENERATION_LIABILITY_UNBOUNDED')
    expect(() => plan(model({ protocol: 'gemini' }))).toThrow('GENERATION_LIABILITY_UNBOUNDED')
  })
})


it.each([
  'https://api.openai.com/v1',
  'https://api.deepseek.com',
])('official protocol bound does not upgrade unknown model evidence: %s', baseUrl => {
  const profile = model({ baseUrl, modelName: 'unknown-future-model' })
  const receipt = createModelExecutionLeaseReceipt(profile, { leaseId: '合成租约', createdAt: 1, expiresAt: 1000 })
  expect(receipt.capabilityEvidence.source.featureFlags).toBe('unknown')
  expect(receipt.capabilityEvidence.reasoning).toBeNull()
  expect(receipt.capabilityEvidence.usage).toBeNull()
  // 官方 host 只证明协议边界，不证明模型容量。未知模型现在连无 demand 的任务
  // 也必须在这里预检拒绝，而不是凭 host 加用户上限继续发送。
  expect(() => buildMainGenerationPlan(profile, receipt, task, ledger())).toThrow('GENERATION_MODEL_CAPABILITY_UNKNOWN')
})

it('caps output at the main per-request policy even when the profile permits more', () => {
  // o3 的 verified 输出上限是 100000，主控每请求硬边界仍是 32768。
  expect(plan(model({ modelName: 'o3', maxTokens: 100000 })).requestedOutputTokens).toBe(32768)
})

// 准入要求 verified provider 容量，所以随应用发布的每个 OpenAI 目录模型都必须
// 带官方预算 metadata；否则用户能从设置里选中它、却无法生成。
it.each(['gpt-4.1', 'gpt-4.1-2025-04-14', 'o3', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'])(
  'admits every shipped OpenAI catalog model: %s', modelName => {
    const result = plan(model({ modelName, maxTokens: 2048 }))
    expect(result.requestedOutputTokens).toBeGreaterThan(0)
    expect(result.usagePolicy.canBoundTotalLiability).toBe(true)
  })

describe('S07 semantic pre-dispatch integration', () => {
  const known = () => model({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', maxTokens: 16384 })
  const draft = (requestedUnits: number): GenerationTask => ({ ...task,
    budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits, segmentable: false } })
  it('sizes 5000 Chinese units above the former 8K cap with an explicit decision', () => {
    const result = plan(known(), draft(5000))
    expect(result.requestedOutputTokens).toBeGreaterThan(8192)
    expect(result.options.maxTokens).toBe(result.budgetDecision?.reservedOutputTokens)
    expect(result.budgetDecision).toMatchObject({ decision: 'ready', requestedQuantity: 5000, selectedQuantity: 5000 })
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + 512)
  })
  it('refuses an oversized indivisible draft instead of reducing its output cap', () => {
    expect(() => plan({ ...known(), maxTokens: 1024 }, draft(5000))).toThrow('TASK_BUDGET_CAPACITY_CONFLICT')
  })
  it('returns a pre-dispatch split for 200 structured items without editing author inputs', () => {
    const input: GenerationTask = { ...task, output: 'structured-data', budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 200 } }
    const bytes = JSON.stringify(input)
    expect(() => plan(known(), input)).toThrow('TASK_BUDGET_SCOPE_SPLIT_REQUIRED:')
    expect(JSON.stringify(input)).toBe(bytes)
  })
  it('cannot treat an unknown model plus a large user limit as capability proof', () => {
    expect(() => plan(model({ modelName: 'unknown-future-model', maxTokens: 128000,
      capabilities: { contextWindowTokens: 128000, maxOutputTokens: 128000, reasoning: false, usage: true, structuredOutput: true } }),
    draft(900))).toThrow('GENERATION_MODEL_CAPABILITY_UNKNOWN')
  })
  it('refuses an indivisible draft when only the user output cap is too small', () => {
    expect(() => plan(model({
      capabilities: { contextWindowTokens: 1_047_576, maxOutputTokens: 1024, reasoning: false, usage: true, structuredOutput: true },
    }), draft(900))).toThrow('TASK_BUDGET_CAPACITY_CONFLICT')
  })
  it('keeps dense required evidence intact when it cannot fit', () => {
    const input = { ...draft(900), messages: [{ role: 'user' as const, content: '作者明确事实\r\n'.repeat(1000) }] }
    const original = JSON.stringify(input)
    expect(() => plan({ ...known(), capabilities: { contextWindowTokens: 1024, maxOutputTokens: 16384, reasoning: false, structuredOutput: false, usage: false } }, input)).toThrow('TASK_BUDGET_CAPACITY_CONFLICT')
    expect(JSON.stringify(input)).toBe(original)
  })
  it('rejects physical fields hidden inside semantic demand', () => {
    const input = draft(900)
    Object.assign(input.budgetDemand!, { maxTokens: 9 })
    expect(() => plan(known(), input)).toThrow('GENERATION_SEMANTIC_TASK_INVALID')
  })
})
