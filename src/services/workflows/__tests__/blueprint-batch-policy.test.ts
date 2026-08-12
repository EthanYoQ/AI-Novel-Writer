import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BLUEPRINT_GENERATION_COUNT,
  getBlueprintBatchAdvice,
  MAX_BLUEPRINT_ITEMS_PER_BATCH,
  planBlueprintGenerationCost,
} from '../blueprint-batch-policy'

describe('blueprint batch policy', () => {
  it('defaults the requested generation scope to five while allowing the workflow to split a larger scope', () => {
    expect(DEFAULT_BLUEPRINT_GENERATION_COUNT).toBe(5)
    expect(MAX_BLUEPRINT_ITEMS_PER_BATCH).toBe(5)
  })

  it('derives task cost from logical scope without consulting a model registry', () => {
    expect(planBlueprintGenerationCost(5)).toEqual({
      chapterCount: 5,
      semanticBatchCount: 1,
      expectedCalls: 1,
      exceedsHardLimit: false,
      runtimeBudget: {
        maxAttempts: 7,
        maxRequestedOutputTokens: 16_384,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 600_000,
      },
    })
    expect(planBlueprintGenerationCost(50)).toMatchObject({
      semanticBatchCount: 10,
      expectedCalls: 10,
      exceedsHardLimit: false,
      runtimeBudget: {
        maxAttempts: 20,
        maxRequestedOutputTokens: 81_920,
        deadlineMs: 600_000,
      },
    })
    expect(planBlueprintGenerationCost(51)).toMatchObject({
      semanticBatchCount: 11,
      expectedCalls: 11,
      exceedsHardLimit: true,
      runtimeBudget: { maxAttempts: 20, maxRequestedOutputTokens: 81_920 },
    })
  })

  it('explains batching and throughput tradeoffs in both interface languages', () => {
    expect(getBlueprintBatchAdvice('zh-CN', 7)).toContain('预计至少 2 次模型调用')
    expect(getBlueprintBatchAdvice('zh-CN', 7)).toContain('达到输出限制时会自动继续拆分')
    expect(getBlueprintBatchAdvice('en-US')).toContain('at most 5 chapters')
    expect(getBlueprintBatchAdvice('en-US')).toContain('more time and API calls')
  })
})
