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
  ['https://api.openai.com/v1', 'max_completion_tokens'],
  ['https://api.deepseek.com', undefined],
] as const)('official protocol bound does not upgrade unknown model evidence: %s', (baseUrl, parameter) => {
  const profile = model({ baseUrl, modelName: 'unknown-future-model' })
  const receipt = createModelExecutionLeaseReceipt(profile, { leaseId: '合成租约', createdAt: 1, expiresAt: 1000 })
  expect(receipt.capabilityEvidence.source.featureFlags).toBe('unknown')
  expect(receipt.capabilityEvidence.reasoning).toBeNull()
  expect(receipt.capabilityEvidence.usage).toBeNull()
  const result = buildMainGenerationPlan(profile, receipt, task, ledger())
  expect(result.options.outputTokenParameter).toBe(parameter)
  expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + 512)
  // Protocol-bounded planning is not a verified model capability or a provider call.
  expect(result.usagePolicy.canBoundTotalLiability).toBe(true)
})

it('caps output at the main per-request policy even when the profile permits more', () => {
  expect(plan(model({ modelName: 'unknown-future-model', maxTokens: 100000 })).requestedOutputTokens).toBe(32768)
})
