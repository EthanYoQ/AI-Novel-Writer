import { describe, expect, it } from 'vitest'

import {
  planTaskBudget,
  type TaskBudgetDemand,
  type TaskBudgetPlannerInput,
} from '../task-budget-planner'

function fixture(
  demand: TaskBudgetDemand,
  overrides: Partial<TaskBudgetPlannerInput> = {},
): TaskBudgetPlannerInput {
  return {
    stage: demand.kind === 'structured-items' ? 'planning' : 'drafting',
    demand,
    inputEstimate: { upperBoundTokens: 1_000, estimatorVersion: 'fixture-input-v1' },
    capability: {
      modelContextWindowTokens: 131_072,
      modelMaxOutputTokens: 32_768,
      modelContextSource: 'verified-provider-preset',
      modelOutputSource: 'verified-provider-preset',
      userContextWindowTokens: null,
      userMaxOutputTokens: null,
    },
    root: { remainingTokenLiability: 2_097_152, maxOutputPerRequest: 32_768 },
    liability: { mode: 'included-in-output' },
    safetyMarginTokens: 512,
    ...overrides,
  }
}

const chineseDraft = (requestedUnits: number, segmentable = true): TaskBudgetDemand => ({
  kind: 'draft-units',
  writingLanguage: 'zh-CN',
  requestedUnits,
  segmentable,
})

const chineseItems = (requestedItems: number): TaskBudgetDemand => ({
  kind: 'structured-items',
  writingLanguage: 'zh-CN',
  requestedItems,
})

describe('S07 task budget planner', () => {
  it.each([
    [900, 2_672],
    [2_000, 5_312],
    [3_000, 7_712],
  ])('plans the complete %i-unit Chinese target without a universal 4K cap', (units, tokens) => {
    const decision = planTaskBudget(fixture(chineseDraft(units), {
      root: { remainingTokenLiability: 100_000, maxOutputPerRequest: 8_192 },
    }))

    expect(decision).toMatchObject({
      policyVersion: 's07-task-budget-v1',
      decision: 'ready',
      requestedQuantity: units,
      selectedQuantity: units,
      requestedOutputTokens: tokens,
      reservedOutputTokens: tokens,
    })
  })

  it('splits a segmentable draft before a historical 4K request ceiling', () => {
    const decision = planTaskBudget(fixture(chineseDraft(3_000), {
      root: { remainingTokenLiability: 100_000, maxOutputPerRequest: 4_096 },
    }))

    expect(decision).toMatchObject({
      decision: 'split-required',
      requestedQuantity: 3_000,
      selectedQuantity: 1_493,
      remainingQuantity: 1_507,
      reservedOutputTokens: 4_096,
    })
    expect(decision.reasons).toContainEqual({
      code: 'scope-split',
      valueTokens: 4_096,
      selected: true,
    })
  })

  it('does not silently segment a task that cannot preserve segment candidates', () => {
    const decision = planTaskBudget(fixture(chineseDraft(3_000, false), {
      root: { remainingTokenLiability: 100_000, maxOutputPerRequest: 4_096 },
    }))

    expect(decision.decision).toBe('capacity-conflict')
    expect(decision.reservedOutputTokens).toBe(0)
    expect(decision.reasons).toContainEqual({ code: 'draft-segmentation-disabled', selected: true })
  })

  it('does not let a user-entered 128K limit stand in for unknown model capability', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      capability: {
        modelContextWindowTokens: null,
        modelMaxOutputTokens: null,
        modelContextSource: 'unknown',
        modelOutputSource: 'unknown',
        userContextWindowTokens: 131_072,
        userMaxOutputTokens: 131_072,
      },
    }))

    expect(decision).toMatchObject({
      decision: 'capacity-conflict',
      selectedQuantity: 0,
      reservationLiabilityTokens: 0,
    })
    expect(decision.reasons).toContainEqual({ code: 'model-capability-unknown', selected: true })
  })

  it('uses the verified model limit even when the user setting is 128K', () => {
    const decision = planTaskBudget(fixture(chineseDraft(5_000), {
      capability: {
        modelContextWindowTokens: 500_000,
        modelMaxOutputTokens: 8_192,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: 131_072,
        userMaxOutputTokens: 131_072,
      },
    }))

    expect(decision).toMatchObject({
      decision: 'split-required',
      selectedQuantity: 3_200,
      reservedOutputTokens: 8_192,
    })
    expect(decision.reasons).toContainEqual({
      code: 'model-output-cap',
      valueTokens: 8_192,
      selected: true,
    })
  })

  it('splits 200 structured items into complete non-overlapping ranges', () => {
    const batches: number[] = []
    let remaining = 200
    while (remaining > 0) {
      const decision = planTaskBudget(fixture(chineseItems(remaining)))
      expect(decision.selectedQuantity).toBeGreaterThan(0)
      batches.push(decision.selectedQuantity)
      remaining = decision.remainingQuantity
    }

    expect(batches).toEqual(Array.from({ length: 20 }, () => 10))
    expect(batches.reduce((sum, value) => sum + value, 0)).toBe(200)
  })

  it('sizes a 16K operational cap to five dense blueprint items per request', () => {
    const decision = planTaskBudget(fixture(chineseItems(200), {
      capability: {
        modelContextWindowTokens: 1_000_000,
        modelMaxOutputTokens: 393_000,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: 65_536,
        userMaxOutputTokens: 16_384,
      },
    }))

    expect(decision).toMatchObject({
      decision: 'split-required',
      selectedQuantity: 5,
      remainingQuantity: 195,
      reservedOutputTokens: 15_872,
    })
  })

  it('freezes the dense Chinese blueprint fixture behind structured planning sizing', () => {
    const names = Array.from(
      { length: 12 },
      (_, index) => `角色${String(index).padStart(2, '0')}${'甲'.repeat(4)}`,
    )
    const serialized = JSON.stringify({
      blueprints: [{
        chapterNumber: 1,
        title: '题'.repeat(30),
        role: '角'.repeat(60),
        purpose: '目'.repeat(120),
        keyEvents: '事'.repeat(150),
        characters: names,
        newCharacterCandidates: names.map((name, index) => ({
          name,
          role: index === 0 ? 'protagonist' : 'supporting',
        })),
        relationships: Array.from({ length: 8 }, (_, index) => ({
          from: names[index],
          to: names[index + 1],
          relation: '关'.repeat(40),
        })),
        suspenseHook: '悬'.repeat(80),
      }],
    })

    expect({
      utf16Characters: serialized.length,
      utf8Bytes: new TextEncoder().encode(serialized).byteLength,
      nonAsciiCharacters: Array.from(serialized).filter(character => character.codePointAt(0)! > 127).length,
    }).toEqual({
      utf16Characters: 1_936,
      utf8Bytes: 3_936,
      nonAsciiCharacters: 1_000,
    })
    expect(planTaskBudget(fixture(chineseItems(1))).requestedOutputTokens).toBe(3_584)
  })

  it('explains when one structured item cannot fit beside required input', () => {
    const decision = planTaskBudget(fixture(chineseItems(1), {
      capability: {
        modelContextWindowTokens: 4_096,
        modelMaxOutputTokens: 4_096,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: null,
        userMaxOutputTokens: null,
      },
      inputEstimate: { upperBoundTokens: 2_500, estimatorVersion: 'fixture-input-v1' },
    }))

    expect(decision.decision).toBe('capacity-conflict')
    expect(decision.reasons).toContainEqual({ code: 'single-item-capacity-conflict', selected: true })
    expect(decision.reasons.some(reason => reason.code === 'required-input-capacity-conflict')).toBe(true)
  })

  it('keeps independent reasoning overhead in the root reservation', () => {
    const decision = planTaskBudget(fixture(chineseItems(1), {
      root: { remainingTokenLiability: 10_000, maxOutputPerRequest: 32_768 },
      liability: { mode: 'separate-bounded', reasoningUpperBoundTokens: 4_096 },
    }))

    expect(decision).toMatchObject({
      decision: 'ready',
      requestedOutputTokens: 3_584,
      reservedOutputTokens: 3_584,
      reasoningUpperBoundTokens: 4_096,
      reservationLiabilityTokens: 9_192,
    })
  })

  it('does not double-count reasoning included in completion usage', () => {
    const decision = planTaskBudget(fixture(chineseItems(5), {
      liability: { mode: 'included-in-output' },
    }))

    expect(decision.reasoningUpperBoundTokens).toBe(0)
    expect(decision.reservationLiabilityTokens).toBe(
      decision.inputUpperBoundTokens + decision.reservedOutputTokens + 512,
    )
  })

  it('preserves a protocol total-liability envelope instead of inventing a reasoning cap', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      liability: { mode: 'total-bounded', totalLiabilityUpperBoundTokens: 32_768 },
    }))

    expect(decision.decision).toBe('ready')
    expect(decision.reservationLiabilityTokens).toBe(32_768)
    expect(decision.reasoningUpperBoundTokens).toBe(
      32_768 - decision.inputUpperBoundTokens - decision.reservedOutputTokens - 512,
    )
  })

  it('does not shrink an exact protocol liability bound to a conservative model capacity', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      capability: {
        modelContextWindowTokens: 1_000_000,
        modelMaxOutputTokens: 393_000,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: 65_536,
        userMaxOutputTokens: 16_384,
      },
      root: { remainingTokenLiability: 2_000_000, maxOutputPerRequest: 32_768 },
      liability: { mode: 'total-bounded', totalLiabilityUpperBoundTokens: 1_048_576 },
    }))

    expect(decision.decision).toBe('ready')
    expect(decision.reservationLiabilityTokens).toBe(1_048_576)
    expect(decision.reasons).toContainEqual({
      code: 'protocol-total-bound',
      valueTokens: 1_048_576,
      selected: true,
    })
  })

  it('subtracts separately bounded reasoning from the model context capacity', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      capability: {
        modelContextWindowTokens: 12_000,
        modelMaxOutputTokens: 8_192,
        modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset',
        userContextWindowTokens: null,
        userMaxOutputTokens: null,
      },
      inputEstimate: { upperBoundTokens: 3_000, estimatorVersion: 'fixture-input-v1' },
      root: { remainingTokenLiability: 100_000, maxOutputPerRequest: 32_768 },
      liability: { mode: 'separate-bounded', reasoningUpperBoundTokens: 8_192 },
    }))

    expect(decision.decision).toBe('capacity-conflict')
    expect(decision.reasons).toContainEqual({
      code: 'model-context-cap',
      valueTokens: 296,
      selected: true,
    })
  })

  it('fails closed when total liability cannot be bounded or the parent remainder cannot reserve it', () => {
    expect(planTaskBudget(fixture(chineseDraft(900), {
      liability: { mode: 'unknown' },
    })).reasons).toContainEqual({ code: 'liability-bound-unknown', selected: true })

    const exhausted = planTaskBudget(fixture(chineseDraft(900), {
      root: { remainingTokenLiability: 8_000, maxOutputPerRequest: 32_768 },
      liability: { mode: 'total-bounded', totalLiabilityUpperBoundTokens: 32_768 },
    }))
    expect(exhausted.decision).toBe('capacity-conflict')
    expect(exhausted.reasons).toContainEqual({
      code: 'root-remaining-cap',
      valueTokens: 8_000,
      selected: true,
    })
  })

  it('reports a fully exhausted parent budget instead of treating zero as malformed input', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      root: { remainingTokenLiability: 0, maxOutputPerRequest: 32_768 },
    }))

    expect(decision.decision).toBe('capacity-conflict')
    expect(decision.reasons).toContainEqual({
      code: 'root-remaining-cap',
      valueTokens: 0,
      selected: true,
    })
  })

  it('uses the explicit writing language for structured item estimates', () => {
    const chinese = planTaskBudget(fixture(chineseItems(5)))
    const english = planTaskBudget(fixture({
      kind: 'structured-items',
      writingLanguage: 'en-US',
      requestedItems: 5,
    }))

    expect(chinese.requestedOutputTokens).toBe(15_872)
    expect(english.requestedOutputTokens).toBe(10_752)
  })
})
