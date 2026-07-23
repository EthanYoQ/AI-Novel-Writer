import { describe, expect, it } from 'vitest'

import {
  createBatchChapterWorkflow,
  MAX_BATCH_CHAPTERS,
  MIN_BATCH_CHAPTERS,
  normalizeBatchChapterCount,
} from '../batch-chapter-workflow'

describe('batch chapter workflow limits', () => {
  it.each([
    [undefined, MIN_BATCH_CHAPTERS],
    [0, MIN_BATCH_CHAPTERS],
    [-3, MIN_BATCH_CHAPTERS],
    [1, 1],
    ['4', 4],
    [MAX_BATCH_CHAPTERS, MAX_BATCH_CHAPTERS],
    [MAX_BATCH_CHAPTERS + 1, MAX_BATCH_CHAPTERS],
  ])('normalizes %p to the safe chapter count %p', (input, expected) => {
    expect(normalizeBatchChapterCount(input)).toBe(expected)
  })

  it('creates one complete chapter step per requested chapter and caps the count at ten', () => {
    const workflow = createBatchChapterWorkflow({
      startChapterNumber: 4,
      chapterCount: 99,
    })

    expect(workflow.type).toBe('batch_generate')
    expect(workflow.steps).toHaveLength(MAX_BATCH_CHAPTERS)
    expect(workflow.steps[0]).toMatchObject({ name: '第4章：创作与后处理' })
    expect(workflow.steps[MAX_BATCH_CHAPTERS - 1]).toMatchObject({ name: '第13章：创作与后处理' })
    expect(workflow.steps.every((step) => step.description.includes('后处理失败立即停止'))).toBe(true)
  })
})
