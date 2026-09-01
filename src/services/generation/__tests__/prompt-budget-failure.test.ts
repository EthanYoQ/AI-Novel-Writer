import { describe, expect, it } from 'vitest'
import type { PromptBudgetReport } from '../generation-harness'
import { formatPromptBudgetFailure } from '../prompt-budget-failure'

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
})
