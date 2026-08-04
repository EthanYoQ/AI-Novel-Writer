import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BLUEPRINT_GENERATION_COUNT,
  getBlueprintBatchAdvice,
  getBlueprintBatchSize,
  MAX_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST,
} from '../blueprint-batch-policy'

describe('blueprint batch policy', () => {
  it('defaults the requested generation scope to five while allowing the workflow to split a larger scope', () => {
    expect(DEFAULT_BLUEPRINT_GENERATION_COUNT).toBe(5)
    expect(MAX_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST).toBe(5)
  })

  it('never expands a physical request beyond five chapters and can reduce it for constrained models', () => {
    expect(getBlueprintBatchSize(100_000)).toBe(5)
    expect(getBlueprintBatchSize(4096)).toBe(5)
    expect(getBlueprintBatchSize(512)).toBe(1)
  })

  it('explains batching and throughput tradeoffs in both interface languages', () => {
    expect(getBlueprintBatchAdvice('zh-CN')).toBe(
      '每次最多5章分批调用；章节越多耗时/调用次数越多，低输出能力模型应减少章节或提高输出上限。',
    )
    expect(getBlueprintBatchAdvice('en-US')).toContain('at most 5 chapters')
    expect(getBlueprintBatchAdvice('en-US')).toContain('more time and API calls')
  })
})
