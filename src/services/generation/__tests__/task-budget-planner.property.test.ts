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
  maxOutputPerRequest: fc.integer({ min: 1, max: 32_768 }),
  safetyMarginTokens: fc.integer({ min: 0, max: 4_096 }),
  capability,
  liability,
}).map(entry => ({
  stage: entry.stage,
  demand: entry.demand,
  inputEstimate: { upperBoundTokens: entry.inputUpperBoundTokens, estimatorVersion: 'property-v1' },
  capability: entry.capability,
  root: { maxOutputPerRequest: entry.maxOutputPerRequest },
  liability: entry.liability,
  safetyMarginTokens: entry.safetyMarginTokens,
} as TaskBudgetPlannerInput))

const isReady = (decision: ReturnType<typeof planTaskBudget>) => decision.decision === 'ready'

describe('S07 task budget planner invariants', () => {
  it('never lets the input estimate change the decision or the output', () => {
    fc.assert(fc.property(plannerInput, fc.integer({ min: 0, max: 5_000_000 }), (input, other) => {
      const first = planTaskBudget(input)
      const second = planTaskBudget({ ...input, inputEstimate: { ...input.inputEstimate, upperBoundTokens: other } })
      expect([second.decision, second.selectedQuantity, second.reservedOutputTokens])
        .toEqual([first.decision, first.selectedQuantity, first.reservedOutputTokens])
    }), { numRuns: 600 })
  })

  it('never exceeds the per-request output ceiling', () => {
    let ready = 0
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget(input)
      if (!isReady(decision)) return
      ready += 1
      expect(decision.reservedOutputTokens).toBeLessThanOrEqual(input.root.maxOutputPerRequest)
      expect(decision.reservedOutputTokens).toBeGreaterThan(0)
    }), { numRuns: 600 })
    expect(ready).toBeGreaterThan(250)
  })

  it('keeps quantities and coverage arithmetically consistent', () => {
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget(input)
      expect(decision.selectedQuantity).toBeGreaterThanOrEqual(1)
      expect(decision.selectedQuantity).toBeLessThanOrEqual(decision.requestedQuantity)
      expect(decision.remainingQuantity).toBe(decision.requestedQuantity - decision.selectedQuantity)
      expect(['ready', 'split-required']).toContain(decision.decision)
      if (input.demand.kind === 'draft-units') expect(decision.decision).toBe('ready')
      expect(decision.reservationLiabilityTokens).toBe(decision.inputUpperBoundTokens + decision.reservedOutputTokens
        + decision.reasoningUpperBoundTokens + input.safetyMarginTokens)
    }), { numRuns: 600 })
  })

  it('preserves unknown capability without inventing a model bound', () => {
    fc.assert(fc.property(plannerInput, input => {
      if (input.capability.modelContextWindowTokens !== null && input.capability.modelMaxOutputTokens !== null) return
      const decision = planTaskBudget(input)
      expect(decision.reasons.some(reason => reason.code === 'model-capability-unknown')).toBe(true)
      if (input.capability.modelMaxOutputTokens === null) expect(decision.reasons.some(reason => reason.code === 'model-output-cap')).toBe(false)
    }), { numRuns: 600 })
  })

  it('keeps unknown liability visible', () => {
    fc.assert(fc.property(plannerInput, input => {
      const decision = planTaskBudget({ ...input, liability: { mode: 'unknown' } })
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
