import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { planTaskBudget, type TaskBudgetPlannerInput } from '../task-budget-planner'

/**
 * 属性测试：预算规划是纯函数，安全不变量必须对任意合法输入成立，
 * 而不是只对我恰好想到的那几组 fixture 成立。
 */
const languages = ['zh-CN', 'en-US'] as const
const stages = ['drafting', 'planning', 'review', 'general'] as const

const demand = fc.oneof(
  fc.record({
    kind: fc.constant('draft-units' as const),
    writingLanguage: fc.constantFrom(...languages),
    requestedUnits: fc.integer({ min: 1, max: 20_000 }),
    segmentable: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('structured-items' as const),
    writingLanguage: fc.constantFrom(...languages),
    requestedItems: fc.integer({ min: 1, max: 200 }),
  }),
)

const capability = fc.record({
  modelContextWindowTokens: fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: null }),
  modelMaxOutputTokens: fc.option(fc.integer({ min: 1, max: 400_000 }), { nil: null }),
  userContextWindowTokens: fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: null }),
  userMaxOutputTokens: fc.option(fc.integer({ min: 1, max: 400_000 }), { nil: null }),
}).map(limits => ({
  ...limits,
  // 规划器要求两个来源标记与取值一致。
  modelContextSource: limits.modelContextWindowTokens === null ? 'unknown' as const : 'verified-provider-preset' as const,
  modelOutputSource: limits.modelMaxOutputTokens === null ? 'unknown' as const : 'verified-provider-preset' as const,
}))

const liability = fc.oneof(
  fc.constant({ mode: 'included-in-output' as const }),
  fc.record({ mode: fc.constant('separate-bounded' as const), reasoningUpperBoundTokens: fc.integer({ min: 0, max: 100_000 }) }),
  fc.record({ mode: fc.constant('total-bounded' as const), totalLiabilityUpperBoundTokens: fc.integer({ min: 1, max: 1_048_576 }) }),
)

const plannerInput = fc.record({
  stage: fc.constantFrom(...stages),
  demand,
  inputUpperBoundTokens: fc.integer({ min: 0, max: 500_000 }),
  remainingTokenLiability: fc.integer({ min: 0, max: 2_097_152 }),
  maxOutputPerRequest: fc.integer({ min: 1, max: 32_768 }),
  safetyMarginTokens: fc.integer({ min: 0, max: 4_096 }),
  capability,
  liability,
}).map(entry => ({
  stage: entry.stage,
  demand: entry.demand,
  inputEstimate: { upperBoundTokens: entry.inputUpperBoundTokens, estimatorVersion: 'property-v1' },
  capability: entry.capability,
  root: { remainingTokenLiability: entry.remainingTokenLiability, maxOutputPerRequest: entry.maxOutputPerRequest },
  liability: entry.liability,
  safetyMarginTokens: entry.safetyMarginTokens,
} as TaskBudgetPlannerInput))

const isReady = (decision: ReturnType<typeof planTaskBudget>) => decision.decision === 'ready'

/**
 * 通用生成器里绝大多数样本都会落进失败分支（能力/责任/容量），只对通用输入断言
 * 安全不变量等于只测了很小一部分。这个生成器把需求缩到单请求确实装得下的规模，
 * 并给满根额度，让 ready 分支真正被断言到。
 */
const generousInput = fc.record({
  stage: fc.constantFrom(...stages),
  units: fc.integer({ min: 1, max: 200 }),
  items: fc.integer({ min: 1, max: 2 }),
  writingLanguage: fc.constantFrom(...languages),
  inputUpperBoundTokens: fc.integer({ min: 0, max: 2_048 }),
  safetyMarginTokens: fc.integer({ min: 0, max: 512 }),
  segmentable: fc.boolean(),
}).map(entry => ({
  stage: entry.stage,
  demand: entry.stage === 'general' || entry.stage === 'review'
    ? { kind: 'structured-items' as const, writingLanguage: entry.writingLanguage, requestedItems: entry.items }
    : { kind: 'draft-units' as const, writingLanguage: entry.writingLanguage,
        requestedUnits: entry.units, segmentable: entry.segmentable },
  inputEstimate: { upperBoundTokens: entry.inputUpperBoundTokens, estimatorVersion: 'property-v1' },
  capability: { modelContextWindowTokens: 1_048_576, modelMaxOutputTokens: 32_768,
    modelContextSource: 'verified-provider-preset' as const, modelOutputSource: 'verified-provider-preset' as const,
    userContextWindowTokens: null, userMaxOutputTokens: null },
  root: { remainingTokenLiability: 2_097_152, maxOutputPerRequest: 32_768 },
  liability: { mode: 'included-in-output' as const },
  safetyMarginTokens: entry.safetyMarginTokens,
} as TaskBudgetPlannerInput))

describe('S07 task budget planner invariants', () => {
  it('never reserves more than the remaining root liability', () => {
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget(input)
      if (!isReady(decision)) return
      expect(decision.reservationLiabilityTokens).toBeLessThanOrEqual(input.root.remainingTokenLiability)
    }), { numRuns: 600 })
  })

  it('never exceeds the per-request output ceiling', () => {
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget(input)
      if (!isReady(decision)) return
      expect(decision.reservedOutputTokens).toBeLessThanOrEqual(input.root.maxOutputPerRequest)
      expect(decision.reservedOutputTokens).toBeGreaterThan(0)
    }), { numRuns: 600 })
  })

  it('holds both safety invariants on requests that can actually be dispatched', () => {
    let ready = 0
    fc.assert(fc.property(generousInput, input => {
      const decision = planTaskBudget(input)
      if (!isReady(decision)) return
      ready += 1
      expect(decision.reservationLiabilityTokens).toBeLessThanOrEqual(input.root.remainingTokenLiability)
      expect(decision.reservedOutputTokens).toBeLessThanOrEqual(input.root.maxOutputPerRequest)
      expect(decision.reservedOutputTokens).toBeGreaterThan(0)
    }), { numRuns: 600 })
    // 这个生成器就是为「断言真的被执行」而存在的，跑不到就说明它退化了。
    expect(ready).toBeGreaterThan(500)
  })

  it('keeps quantities and coverage arithmetically consistent', () => {
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget(input)
      expect(decision.selectedQuantity).toBeGreaterThanOrEqual(0)
      expect(decision.selectedQuantity).toBeLessThanOrEqual(decision.requestedQuantity)
      expect(decision.remainingQuantity).toBe(decision.requestedQuantity - decision.selectedQuantity)
      expect(['ready', 'split-required', 'capacity-conflict']).toContain(decision.decision)
      if (decision.decision === 'capacity-conflict') {
        // 失败的决策绝不允许留下任何预留。
        expect(decision.reservedOutputTokens).toBe(0)
        expect(decision.reservationLiabilityTokens).toBe(0)
      }
    }), { numRuns: 600 })
  })

  it('fails closed whenever the model capability is unknown', () => {
    fc.assert(fc.property(plannerInput, input => {
      if (input.capability.modelContextWindowTokens !== null && input.capability.modelMaxOutputTokens !== null) return
      const decision = planTaskBudget(input)
      expect(decision.decision).toBe('capacity-conflict')
      expect(decision.reasons.some(reason => reason.code === 'model-capability-unknown')).toBe(true)
    }), { numRuns: 600 })
  })

  it('reports an unbounded liability protocol as a conflict', () => {
    fc.assert(fc.property(plannerInput, input => {
      // 能力未知会先命中它自己的冲突，这里要单独隔离协议责任这一条。
      fc.pre(input.capability.modelContextWindowTokens !== null && input.capability.modelMaxOutputTokens !== null)
      const decision = planTaskBudget({ ...input, liability: { mode: 'unknown' } })
      expect(decision.decision).toBe('capacity-conflict')
      expect(decision.reasons.some(reason => reason.code === 'liability-bound-unknown')).toBe(true)
    }), { numRuns: 200 })
  })

  it('is a pure function of its input', () => {
    fc.assert(fc.property(plannerInput, input => {
      const first = planTaskBudget(input)
      const second = planTaskBudget(structuredClone(input))
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    }), { numRuns: 400 })
  })
})
