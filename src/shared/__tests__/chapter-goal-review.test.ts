import { describe, expect, it } from 'vitest'
import { buildChapterGoalReviewPrompt, chapterGoalReviewItems, freezeChapterGoals, normalizeChapterGoalReview, parseChapterGoalReview } from '../chapter-goal-review'

const draft = '她合上已经装订好的相册。两人约定周三再搬设备。'
const goals = freezeChapterGoals(3, '完成相册；约定周三搬设备')
const answer = [
  { id: goals.items[0]!.id, status: 'completed', description: '装订已完成。', evidence: [{ quote: '已经装订好的相册' }] },
  { id: goals.items[1]!.id, status: 'completed', description: '约定已经达成，无需提前搬家。', evidence: [{ quote: '两人约定周三再搬设备。' }] },
]

describe('本章目标审稿合同', () => {
  it('软件按原文冻结每个显式条目，不让模型改写目标', () => {
    expect(goals.items.map(item => item.text)).toEqual(['完成相册', '约定周三搬设备'])
    expect(Object.isFrozen(goals.items)).toBe(true)
    const result = normalizeChapterGoalReview(answer, goals, draft, 'zh-CN')
    expect(result.items.map(item => item.status)).toEqual(['completed', 'completed'])
    for (const item of result.items) for (const evidence of item.evidence) {
      expect(draft.slice(evidence.start, evidence.end)).toBe(evidence.quote)
    }
    expect(parseChapterGoalReview(result)).toEqual(result)
  })

  it.each([
    ['漏项', [answer[0]]],
    ['重复项', [answer[0], answer[0], answer[1]]],
    ['改写目标', [{ ...answer[0], text: '准备相册' }, answer[1]]],
    ['未知状态', [{ ...answer[0], status: 'pass' }, answer[1]]],
    ['非逐字引文', [{ ...answer[0], evidence: [{ quote: '她装订完了相册。' }] }, answer[1]]],
    ['完成但无证据', [{ ...answer[0], evidence: [] }, answer[1]]],
    ['错误id', [{ ...answer[0], id: '别的目标' }, answer[1]]],
    ['缺少结果', undefined],
  ])('%s 不得变成全部通过', (_name, raw) => {
    const result = normalizeChapterGoalReview(raw, goals, draft, 'zh-CN')
    expect(result.coverage).toBe('unknown')
    expect(result.items.map(item => item.text)).toEqual(goals.items.map(item => item.text))
    expect(result.items.some(item => item.status === 'unknown')).toBe(true)
    expect(chapterGoalReviewItems(result, 'zh-CN').some(item => item.severity === 'unknown')).toBe(true)
  })

  it('区分有延期证据的未完成和没有充分证据的未知，不额外请求模型', () => {
    const result = normalizeChapterGoalReview([
      { ...answer[0], status: 'unmet', description: '完成动作被推迟。', evidence: [{ quote: '明天再装订' }] },
      { ...answer[1], status: 'unknown', description: '没有找到约定的证据。', evidence: [] },
    ], goals, '她说，明天再装订。', 'zh-CN')
    expect(result.coverage).toBe('complete') // 已覆盖两项，不代表目标已达成。
    expect(result.items.map(item => item.status)).toEqual(['unmet', 'unknown'])
    expect(chapterGoalReviewItems(result, 'zh-CN').map(item => item.severity)).toEqual(['error', 'unknown'])
  })

  it('未配置与来源读取失败均不作为目标验收通过', () => {
    const absent = normalizeChapterGoalReview([], freezeChapterGoals(3, null), draft, 'zh-CN')
    const unavailable = normalizeChapterGoalReview([], freezeChapterGoals(3, undefined), draft, 'zh-CN')
    expect(absent.coverage).toBe('not_configured')
    expect(unavailable.coverage).toBe('unknown')
    expect(chapterGoalReviewItems(absent, 'zh-CN')[0]?.severity).toBe('unknown')
    expect(chapterGoalReviewItems(unavailable, 'zh-CN')[0]?.severity).toBe('unknown')
  })

  it('提示强调到期动作、原意和同一请求，不要求未来行动提前兑现', () => {
    const prompt = buildChapterGoalReviewPrompt(goals, 'zh-CN')
    expect(prompt).toContain('同一 JSON 根对象')
    expect(prompt).toContain('部分完成不等于整项目标完成')
    expect(prompt).toContain('只需本章达成约定，不要求提前执行')
    expect(prompt).toContain(JSON.stringify(goals))
  })

  it('读取历史或损坏报告不假造有效目标合同', () => {
    expect(parseChapterGoalReview(undefined)).toBeNull()
    const valid = normalizeChapterGoalReview(answer, goals, draft, 'zh-CN')
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], status: 'pass' }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], evidence: [] }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [valid.items[0], valid.items[0]] })).toBeNull()
  })
})
