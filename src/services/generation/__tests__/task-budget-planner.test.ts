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
    root: { maxOutputPerRequest: 32_768 },
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
  it.each([1_000, 900_000, 5_000_000])('sends a draft at the output ceiling whatever its %i-token input estimate', upperBoundTokens => {
    const decision = planTaskBudget(fixture(chineseDraft(500, false), {
      inputEstimate: { upperBoundTokens, estimatorVersion: 'fixture-input-v1' },
      capability: { modelContextWindowTokens: 131_072, modelMaxOutputTokens: 32_768, modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset', userContextWindowTokens: 32_768, userMaxOutputTokens: 16_384 },
    }))
    expect(decision).toMatchObject({ decision: 'ready', requestedQuantity: 500, selectedQuantity: 500,
      requestedOutputTokens: 1712, reservedOutputTokens: 16_384, reservationLiabilityTokens: upperBoundTokens + 16_384 + 512 })
    expect(decision.reasons).toContainEqual({ code: 'user-output-cap', valueTokens: 16_384, selected: true })
  })

  it.each([[900, 2_672], [5_000, 12_512]])('keeps the %i-unit target soft: one request at the ceiling, never a split', (units, tokens) => {
    for (const segmentable of [true, false]) {
      const decision = planTaskBudget(fixture(chineseDraft(units, segmentable), { root: { maxOutputPerRequest: 4_096 } }))
      expect(decision).toMatchObject({ decision: 'ready', requestedQuantity: units, selectedQuantity: units,
        requestedOutputTokens: tokens, reservedOutputTokens: 4_096 })
    }
  })

  it('uses a user operational limit without upgrading unknown model capability', () => {
    const decision = planTaskBudget(fixture(chineseDraft(900), {
      capability: { modelContextWindowTokens: null, modelMaxOutputTokens: null, modelContextSource: 'unknown',
        modelOutputSource: 'unknown', userContextWindowTokens: 131_072, userMaxOutputTokens: 131_072 },
    }))
    expect(decision).toMatchObject({ decision: 'ready', selectedQuantity: 900, reservedOutputTokens: 32_768 })
    expect(decision.reasons).toContainEqual({ code: 'model-capability-unknown', selected: true })
  })

  it('uses the verified model output limit below a 128K user setting', () => {
    const decision = planTaskBudget(fixture(chineseDraft(5_000), {
      capability: { modelContextWindowTokens: 500_000, modelMaxOutputTokens: 8_192, modelContextSource: 'verified-provider-preset',
        modelOutputSource: 'verified-provider-preset', userContextWindowTokens: 131_072, userMaxOutputTokens: 131_072 },
    }))
    expect(decision).toMatchObject({ decision: 'ready', selectedQuantity: 5_000, reservedOutputTokens: 8_192 })
    expect(decision.reasons).toContainEqual({ code: 'model-output-cap', valueTokens: 8_192, selected: true })
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
  })

  it('splits structured items by the output limit only, never by the input estimate', () => {
    const capability = { modelContextWindowTokens: 1_000_000, modelMaxOutputTokens: 393_000, modelContextSource: 'verified-provider-preset' as const,
      modelOutputSource: 'verified-provider-preset' as const, userContextWindowTokens: 65_536, userMaxOutputTokens: 16_384 }
    for (const upperBoundTokens of [1_000, 60_000, 2_000_000]) {
      expect(planTaskBudget(fixture(chineseItems(200), { capability,
        inputEstimate: { upperBoundTokens, estimatorVersion: 'fixture-input-v1' } }))).toMatchObject({
        decision: 'split-required', selectedQuantity: 5, remainingQuantity: 195, reservedOutputTokens: 15_872 })
    }
  })

  it('sends one structured item even when its estimate exceeds the output limit', () => {
    const decision = planTaskBudget(fixture(chineseItems(1), { root: { maxOutputPerRequest: 2_048 } }))
    expect(decision).toMatchObject({ decision: 'ready', selectedQuantity: 1, requestedOutputTokens: 3_584, reservedOutputTokens: 2_048 })
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

  it('keeps independent reasoning overhead in the reservation', () => {
    const decision = planTaskBudget(fixture(chineseItems(1), {
      liability: { mode: 'separate-bounded', reasoningUpperBoundTokens: 4_096 },
    }))
    expect(decision).toMatchObject({ decision: 'ready', reservedOutputTokens: 32_768, reasoningUpperBoundTokens: 4_096,
      reservationLiabilityTokens: 1_000 + 32_768 + 4_096 + 512 })
    expect(decision.reasons).toContainEqual({ code: 'protocol-reasoning-reserve', valueTokens: 4_096, selected: true })
  })

  it('does not double-count reasoning included in completion usage', () => {
    const decision = planTaskBudget(fixture(chineseItems(5), { liability: { mode: 'included-in-output' } }))
    expect(decision.reasoningUpperBoundTokens).toBe(0)
    expect(decision.reservationLiabilityTokens).toBe(decision.inputUpperBoundTokens + decision.reservedOutputTokens + 512)
  })

  it('reserves a protocol total-liability envelope and records an input that outgrows it in full', () => {
    const liability = { mode: 'total-bounded' as const, totalLiabilityUpperBoundTokens: 1_048_576 }
    const fits = planTaskBudget(fixture(chineseDraft(900), { liability }))
    expect(fits.reservationLiabilityTokens).toBe(1_048_576)
    expect(fits.reasoningUpperBoundTokens).toBe(1_048_576 - 1_000 - 32_768 - 512)
    expect(fits.reasons).toContainEqual({ code: 'protocol-total-bound', valueTokens: 1_048_576, selected: true })
    const outgrown = planTaskBudget(fixture(chineseDraft(900), { liability,
      inputEstimate: { upperBoundTokens: 2_000_000, estimatorVersion: 'fixture-input-v1' } }))
    expect(outgrown).toMatchObject({ decision: 'ready', reservedOutputTokens: 32_768, reasoningUpperBoundTokens: 0,
      reservationLiabilityTokens: 2_000_000 + 32_768 + 512 })
  })

  it('records unknown liability', () => {
    expect(planTaskBudget(fixture(chineseDraft(900), { liability: { mode: 'unknown' } })).reasons)
      .toContainEqual({ code: 'liability-bound-unknown', selected: true })
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
