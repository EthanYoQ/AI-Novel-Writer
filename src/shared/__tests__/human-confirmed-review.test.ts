import { describe, expect, it } from 'vitest'

import {
  createHumanConfirmedReviewSnapshot,
  hasIncludedReviewItems,
  hasIncludedReviewWork,
  parseHumanConfirmedReviewSnapshot,
  renderHumanConfirmedReviewBrief,
  serializeHumanConfirmedReviewSnapshot,
} from '../human-confirmed-review'

const rawAiReport = JSON.stringify({
  summary: '原始 AI 总结：只供人工阅读，不能直接送入修稿模型。',
  items: [
    { category: '连续性', severity: 'error', description: '角色位置前后矛盾。' },
    { category: '节奏', severity: 'warning', description: '转场可以更紧凑。' },
    { category: '措辞', severity: 'pass', description: '表达自然。' },
  ],
})

describe('human-confirmed review snapshot contract', () => {
  it('keeps the raw AI report separate while ignore, restore, add, and confirm produce an immutable selected-work snapshot', () => {
    const sourceBeforeReview = rawAiReport
    const initiallyConfirmed = createHumanConfirmedReviewSnapshot({
      sourceReviewId: 42,
      summary: '原始 AI 总结：只供人工阅读，不能直接送入修稿模型。',
      authorGuidance: '',
      items: [
        { category: '连续性', severity: 'error', description: '角色位置前后矛盾。', decision: 'apply', origin: 'ai' },
        { category: '节奏', severity: 'warning', description: '转场可以更紧凑。', decision: 'apply', origin: 'ai' },
        { category: '措辞', severity: 'pass', description: '表达自然。', decision: 'ignore', origin: 'ai' },
      ],
    })
    expect(initiallyConfirmed).not.toBeNull()

    const afterIgnore = createHumanConfirmedReviewSnapshot({
      ...initiallyConfirmed!,
      items: initiallyConfirmed!.items.map(item => (
        item.description === '转场可以更紧凑。' ? { ...item, decision: 'ignore' as const } : item
      )),
    })
    const afterRestoreAndAdd = createHumanConfirmedReviewSnapshot({
      ...afterIgnore!,
      authorGuidance: '保留第一段的悬念，不要扩写背景设定。',
      items: [
        ...afterIgnore!.items.map(item => (
          item.description === '转场可以更紧凑。' ? { ...item, decision: 'apply' as const } : item
        )),
        {
          category: '作者补充',
          severity: 'warning',
          description: '第一段结尾保留悬念。',
          decision: 'apply',
          origin: 'author',
        },
      ],
    })

    expect(afterRestoreAndAdd).toMatchObject({
      sourceReviewId: 42,
      authorGuidance: '保留第一段的悬念，不要扩写背景设定。',
      items: [
        { severity: 'error', decision: 'apply', origin: 'ai' },
        { severity: 'warning', decision: 'apply', origin: 'ai' },
        { severity: 'pass', decision: 'ignore', origin: 'ai' },
        { decision: 'apply', origin: 'author' },
      ],
    })
    expect(Object.isFrozen(afterRestoreAndAdd)).toBe(true)
    expect(Object.isFrozen(afterRestoreAndAdd!.items)).toBe(true)
    expect(hasIncludedReviewItems(afterRestoreAndAdd!)).toBe(true)
    expect(hasIncludedReviewWork(afterRestoreAndAdd!)).toBe(true)

    const serialized = serializeHumanConfirmedReviewSnapshot(afterRestoreAndAdd!)
    expect(parseHumanConfirmedReviewSnapshot(serialized)).toEqual(afterRestoreAndAdd)
    expect(rawAiReport).toBe(sourceBeforeReview)
    expect(parseHumanConfirmedReviewSnapshot(rawAiReport)).toBeNull()
  })

  it('renders only confirmed apply items and explicit author guidance, and treats an all-ignored review as no model work', () => {
    const noWork = createHumanConfirmedReviewSnapshot({
      sourceReviewId: 42,
      summary: 'AI-only summary must not reach the model.',
      authorGuidance: '   ',
      items: [
        {
          category: '连续性',
          severity: 'error',
          description: '已由作者决定不改的角色位置问题。',
          decision: 'ignore',
          origin: 'ai',
        },
      ],
    })
    expect(noWork).not.toBeNull()
    expect(hasIncludedReviewItems(noWork!)).toBe(false)
    expect(hasIncludedReviewWork(noWork!)).toBe(false)
    expect(renderHumanConfirmedReviewBrief(noWork!)).toBe('')

    const guidanceOnly = createHumanConfirmedReviewSnapshot({
      ...noWork!,
      authorGuidance: '即使有补充说明，也没有作者选择纳入的修稿项。',
    })
    expect(hasIncludedReviewItems(guidanceOnly!)).toBe(false)
    expect(hasIncludedReviewWork(guidanceOnly!)).toBe(true)

    const selectedWork = createHumanConfirmedReviewSnapshot({
      sourceReviewId: 42,
      summary: 'AI-only summary must not reach the model.',
      authorGuidance: '保持第一段悬念。',
      items: [
        {
          category: '连续性',
          severity: 'error',
          description: '角色位置前后矛盾。',
          quote: '他仍在港口。',
          decision: 'apply',
          origin: 'ai',
        },
        {
          category: '节奏',
          severity: 'warning',
          description: '这一项被作者忽略。',
          decision: 'ignore',
          origin: 'ai',
        },
      ],
    })
    const brief = renderHumanConfirmedReviewBrief(selectedWork!)

    expect(brief).toContain('角色位置前后矛盾。')
    expect(brief).toContain('他仍在港口。')
    expect(brief).toContain('保持第一段悬念。')
    expect(brief).not.toContain('这一项被作者忽略。')
    expect(brief).not.toContain('AI-only summary must not reach the model.')
  })
})
