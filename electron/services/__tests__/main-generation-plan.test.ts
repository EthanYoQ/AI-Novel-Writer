import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { GenerationBudgetReceipt } from '../../repositories/generation-run-repository'
import { createModelExecutionLeaseReceipt } from '../model-execution-lease'
import { batchRootBudget, buildMainGenerationPlan, MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { settleProviderUsage } from '../generation-run-service'

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

it.each([task, { ...task, budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 1000, segmentable: false } } as GenerationTask])(
  'plans unregistered compatible models as estimates without inventing capability: %j', input => {
    const result = plan(model({ provider: 'custom', baseUrl: 'http://localhost:8000/v1', modelName: 'hand-entered' }), input)
    expect(result.usagePolicy).toMatchObject({ canBoundTotalLiability: false, reasoning: 'unknown' })
    expect(result.requestedOutputTokens).toBe(input.budgetDemand ? 2912 : 8192)
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + 512)
    expect(result.options.reasoning).toBeUndefined()
    if (input.budgetDemand) expect(result.budgetDecision?.reasons).toContainEqual({ code: 'model-capability-unknown', selected: true })
    const qwen = plan(model({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B' }), input)
    expect(qwen.options.reasoning).toBeUndefined()
    expect(qwen.usagePolicy).toMatchObject({ canBoundTotalLiability: false, reasoning: 'unknown' })
    expect(qwen.requestedOutputTokens).toBeGreaterThan(0)
  })

describe('fixed Qwen native admission', () => {
  const qwen = () => model({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1',
    modelName: 'Qwen/Qwen3.8-27B', maxTokens: 16384, reasoningOverride: 'medium' })
  const inputs: GenerationTask[] = [task, { ...task, budgetDemand: {
    kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 1000, segmentable: false,
  } }]

  it.each(inputs)('reserves separate Qwen budgets without claiming a hard bound: %j', input => {
    const budget = ledger()
    const result = plan(qwen(), input, budget)
    expect(result.reasoningUpperBoundTokens).toBe(16384)
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + 16384 + 512)
    expect(result.usagePolicy).toMatchObject({ canBoundTotalLiability: false, reasoning: 'unknown' })
    expect(result.requestedOutputTokens).toBe(input.budgetDemand ? 2912 : 16384)
    expect(settleProviderUsage({ promptTokens: 100, completionTokens: 20000, reasoningTokens: 18000,
      totalTokens: 20100, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true }, result.usagePolicy))
      .toMatchObject({ trusted: true, actualTokens: 20100, reasoningTokens: 18000 })
    expect(settleProviderUsage(null, result.usagePolicy).trusted).toBe(false)
    expect(plan({ ...qwen(), maxTokens: 32768 }, input).requestedOutputTokens).toBe(input.budgetDemand ? 2912 : 16384)
    expect(result.options.reasoning).toEqual({ adapter: 'openai-thinking-budget', thinkingBudget: 16384 })
    expect(plan({ ...qwen(), provider: 'custom' }, input)).toEqual(result)
    if (input.budgetDemand) expect(result.budgetDecision?.reasons).toContainEqual({ code: 'liability-bound-unknown', selected: true })
    budget.policy.maxTokenLiability = result.reservedTokens * 2
    budget.attempts = [1, 2].map(index => ({ attemptId: `q-${index}`, reservationId: `r-${index}`,
      rootActionId: '根', status: 'unknown', reservedTokens: result.reservedTokens, requestedOutputTokens: result.requestedOutputTokens, actualTokens: 100 }))
    expect(() => plan(qwen(), input, budget)).toThrow('ROOT_BUDGET_EXHAUSTED')
    budget.attempts.forEach(attempt => { attempt.status = 'settled' })
    expect(plan(qwen(), input, budget).reservedTokens).toBe(result.reservedTokens)
    const off = plan({ ...qwen(), reasoningOverride: 'off' }, input)
    expect(off.reasoningUpperBoundTokens).toBe(0)
    expect(off.reservedTokens).toBe(off.inputUpperBoundTokens + off.requestedOutputTokens + 512)
    const manual = plan({ ...qwen(), reasoningMapping: { adapter: 'openai-thinking-budget', supportedEfforts: ['medium'], providerValues: { medium: 4096 } } }, input)
    expect(manual.reasoningUpperBoundTokens).toBe(4096)
    expect(manual.reservedTokens).toBe(manual.inputUpperBoundTokens + manual.requestedOutputTokens + 4096 + 512)
    expect(() => plan(qwen(), { ...input, messages: [{ role: 'user', content: 'x'.repeat(262144) }] }))
      .toThrow(input.budgetDemand ? 'TASK_BUDGET_CAPACITY_CONFLICT' : 'GENERATION_INPUT_CAPACITY_EXCEEDED')
  })

  it.each([
    { baseUrl: 'https://api.siliconflow.com/v1' }, { baseUrl: 'http://api.siliconflow.cn/v1' },
    { baseUrl: 'https://api.siliconflow.cn/v2' }, { baseUrl: 'https://api.siliconflow.cn/v1?proxy=1' },
    { baseUrl: 'https://api.siliconflow.cn.evil.test/v1' }, { modelName: 'Qwen/Qwen3.8-27B-other' },
    { protocol: 'gemini' },
    { reasoningOverride: 'auto' }, { reasoningOverride: 'high' }, { reasoningOverride: 'low' },
  ] as Partial<ModelProfile>[])('does not invent Qwen mappings for unmatched settings %j', overrides => {
    for (const input of inputs) {
      const result = plan({ ...qwen(), ...overrides }, input)
      expect(result.options.reasoning).toBeUndefined()
      expect(result.usagePolicy.canBoundTotalLiability).toBe(false)
    }
  })
})

describe('main generation physical liability planning without provider calls', () => {
  it.each(['high', 'max'] as const)('keeps SiliconFlow output and liability unchanged for explicit %s', reasoningOverride => {
    for (const input of [task, { ...task, budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 1000, segmentable: false } } as GenerationTask]) {
      const before = plan(silicon(), input)
      const after = plan({ ...silicon(), reasoningOverride }, input)
      expect(after.options.reasoning).toEqual({ adapter: 'siliconflow-v4-thinking', reasoningEffort: reasoningOverride })
      expect({ ...after, options: { ...after.options, reasoning: undefined } }).toEqual({ ...before, options: { ...before.options, reasoning: undefined } })
      expect(after.reservedTokens).toBe(1_048_576)
    }
  })
  it('keeps the temporary S05 policy finite and explicit', () => {
    expect(MAIN_GENERATION_POLICY.budget).toEqual({ maxPhysicalRequests: 32, maxTokenLiability: 2097152, maxOutputPerRequest: 32768, maxActiveElapsedMs: 3600000 })
  })
  it('scales batch roots by chapter count without shrinking below the single-root policy', () => {
    expect(batchRootBudget(1)).toEqual(MAIN_GENERATION_POLICY.budget)
    expect(batchRootBudget(4)).toEqual(MAIN_GENERATION_POLICY.budget)
    expect(batchRootBudget(5)).toEqual({ maxPhysicalRequests: 40, maxTokenLiability: 2_621_440, maxOutputPerRequest: 32768, maxActiveElapsedMs: 4_500_000 })
    expect(batchRootBudget(10).maxPhysicalRequests).toBe(80)
    for (const invalid of [0, -1, 1.5, Number.NaN]) expect(() => batchRootBudget(invalid)).toThrow('GENERATION_BATCH_INTENT_INVALID')
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
  it('distinguishes known Gemini zero from an unknown thinking estimate', () => {
    expect(plan({ ...gemini(), reasoningOverride: 'off' }).reasoningUpperBoundTokens).toBe(0)
    expect(plan({ ...gemini(), modelName: 'gemini-unknown' }).usagePolicy)
      .toMatchObject({ canBoundTotalLiability: false, reasoning: 'unknown' })
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
    expect(plan(model({ baseUrl })).usagePolicy.canBoundTotalLiability).toBe(false)
  })
  it('does not trust an arbitrary Silicon model or protocol claim', () => {
    expect(plan({ ...silicon(), modelName: 'unknown-model' }).usagePolicy.canBoundTotalLiability).toBe(false)
    expect(plan(model({ protocol: 'gemini' })).usagePolicy.canBoundTotalLiability).toBe(false)
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
  // 兼容请求可按运行估算发送，官方 host 不会补成已验证型号能力。
  expect(buildMainGenerationPlan(profile, receipt, task, ledger()).usagePolicy.canBoundTotalLiability).toBe(false)
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

// SPEC-002：无 budgetDemand 的任务（plot-tree、finalization 提取、agent 等）也必须把
// 已验证的模型容量、用户 ModelSettings 限额、根预算余量与输入占用合并成同一个输出上限，
// 与 demand 分支同源；不能只信 lease 里冻结的 capabilityEvidence 数值。
describe('no-demand tasks merge verified capability, user limits and input occupancy (SPEC-002)', () => {
  const plot = (content = '合成情节数据'): GenerationTask => ({ purpose: 'plot-tree-snapshot', output: 'structured-data',
    reasoningStage: 'planning', messages: [{ role: 'user', content }] })
  const userCaps = (contextWindowTokens: number, maxOutputTokens: number) =>
    ({ contextWindowTokens, maxOutputTokens, reasoning: false, structuredOutput: true, usage: true })
  const deepseek = (overrides: Partial<ModelProfile> = {}) => model({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-flash', reasoningOverride: 'off', ...overrides })

  it('never requests more than the verified model output limit when the user limit is larger', () => {
    // OpenAI 目录里 gpt-4-turbo 已验证输出上限 4096，用户在设置里填了 32768。
    const result = plan(model({ modelName: 'gpt-4-turbo', maxTokens: 32768, reasoningOverride: 'off',
      capabilities: userCaps(128000, 32768) }), plot())
    expect(result.requestedOutputTokens).toBe(4096)
    expect(result.options.maxTokens).toBe(4096)
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + 4096 + 512)
  })
  it('keeps the smaller user output limit below the verified model limit', () => {
    const result = plan(model({ modelName: 'gpt-4-turbo', maxTokens: 2048, reasoningOverride: 'off' }), plot())
    expect(result.requestedOutputTokens).toBe(2048)
  })
  it('refuses input that exceeds a smaller user context limit instead of trusting the 1M model window', () => {
    const profile = deepseek({ maxTokens: 2048, capabilities: userCaps(4096, 2048) })
    expect(() => plan(profile, plot('A'.repeat(10000)))).toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
  })
  it('lets the user context limit reduce the output cap by the input occupancy', () => {
    const result = plan(deepseek({ maxTokens: 4000, capabilities: userCaps(4096, 4000) }), plot())
    expect(result.requestedOutputTokens).toBe(4096 - result.inputUpperBoundTokens - 512)
    expect(result.requestedOutputTokens).toBeLessThan(4000)
  })
  it('refuses input that exceeds the verified model context even without a user context limit', () => {
    // gpt-3.5-turbo 已验证上下文 16385；OpenAI 目录条目没有 lease 级 capabilities，
    // 所以冻结证据的 contextWindowTokens 为 null，不能因此放行。
    const profile = model({ modelName: 'gpt-3.5-turbo', maxTokens: 4096, reasoningOverride: 'off' })
    expect(() => plan(profile, plot('A'.repeat(20000)))).toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
  })
  it('keeps the Silicon V4 full-context reservation while honoring the user context limit', () => {
    const profile = { ...silicon(), reasoningOverride: 'off' as const,
      capabilities: userCaps(4096, 3000) }
    const result = plan(profile, plot())
    expect(result.requestedOutputTokens).toBe(3000)
    expect(result.reservedTokens).toBe(1_048_576)
    expect(() => plan(profile, plot('A'.repeat(10000)))).toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
  })
  it('uses the verified Silicon context (1M), not the documented 1,048,576 reservation, as the input capacity', () => {
    const profile = model({ baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'deepseek-ai/DeepSeek-V4-Flash',
      reasoningOverride: 'off', maxTokens: 16384 })
    expect(plan(profile, plot('A'.repeat(900_000))).requestedOutputTokens).toBe(16384)
    expect(() => plan(profile, plot('A'.repeat(1_000_000)))).toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
  })
  it('treats the root output ceiling and remaining liability exactly as before', () => {
    expect(plan(deepseek({ maxTokens: 100000 }), plot()).requestedOutputTokens).toBe(32768)
    const budget = ledger(); budget.policy.maxTokenLiability = 4096
    expect(plan(deepseek({ maxTokens: 16384 }), plot(), budget).requestedOutputTokens)
      .toBe(4096 - plan(deepseek(), plot()).inputUpperBoundTokens - 512)
  })
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
    const result = plan(model({ modelName: 'unknown-future-model', maxTokens: 128000,
      capabilities: { contextWindowTokens: 128000, maxOutputTokens: 128000, reasoning: false, usage: true, structuredOutput: true } }),
    draft(900))
    expect(result.usagePolicy.canBoundTotalLiability).toBe(false)
    expect(result.budgetDecision?.reasons).toContainEqual({ code: 'model-capability-unknown', selected: true })
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
