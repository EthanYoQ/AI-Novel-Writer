import { describe, expect, it } from 'vitest'
import { buildChapterGoalReviewBatchPrompt, buildChapterGoalReviewDeferredNote, buildChapterGoalReviewPrompt, chapterGoalReviewItems, freezeChapterGoals, MAX_GOAL_REVIEW_BATCHES, normalizeChapterGoalReview, parseChapterGoalReview, parseChapterGoalReviewBatch, splitChapterGoalsIntoBatches } from '../chapter-goal-review'

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
    expect(prompt).toContain('仅当目标要求达成约定时，本章达成约定即可，不要求提前执行')
    expect(prompt).toContain('先按原意区分当章行动与背景/未来约束')
    expect(prompt).toContain('明确延期、拒绝或相反结果')
    expect(prompt).toContain('正文只写走进图书馆：应 unknown，不能判 unmet')
    expect(prompt.indexOf('1. 先按原意')).toBeLessThan(prompt.indexOf('2. 当章到期'))
    expect(prompt.indexOf('2. 当章到期')).toBeLessThan(prompt.indexOf('3. 全部到期'))
    expect(prompt.indexOf('3. 全部到期')).toBeLessThan(prompt.indexOf('4. 仅未提及'))
    expect(prompt).toContain(JSON.stringify(goals))
    expect(prompt).toContain('按 id、evidence、description、status 顺序')
    // 先生（审稿被截断事故）：合同必须自带上限，否则项数一多就把整份报告顶到截断。
    expect(prompt).toContain('每项不超过 120 字')
    expect(prompt).toContain('每项最多 1 条引文')
    expect(prompt).toContain('任一 unmet → unmet；否则任一 unknown → unknown；仅全部完成 → completed')
  })

  it.each(['“钟楼已经修好。”', '"钟楼已经修好。"', '“钟楼已经修好。”她说。”'])('只容忍一对外围引号：%s', quote => {
    const source = '“钟楼已经修好。”她说。'
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '有完成证据。', evidence: [{ quote }] }], frozen, source, 'zh-CN')
    expect(result.items[0]?.status).toBe('completed')
    const evidence = result.items[0]!.evidence[0]!
    expect(source.slice(evidence.start, evidence.end)).toBe(evidence.quote)
    expect(evidence.quote).toBe(quote === '“钟楼已经修好。”' ? quote : quote.slice(1, -1))
  })

  it.each([
    ['只多一个引号', '钟楼已经修好。”', '钟楼已经修好。'],
    ['空白变化', '“钟楼 已经修好。”', '钟楼已经修好。'],
    ['标点变化', '“钟楼已经修好！”', '钟楼已经修好。'],
    ['跳句拼接', '“钟楼已经修好。工匠离开。”', '钟楼已经修好。他锁好大门。工匠离开。'],
    ['外围剥离后重复', '“修好了”', '修好了。他又说修好了。'],
    ['两层包装', '““修好了””', '修好了'],
    ['空包装', '“”', '修好了'],
  ])('%s 仍是未知，不做模糊匹配', (_case, quote, source) => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '声称完成。', evidence: [{ quote }] }], frozen, source, 'zh-CN')
    expect(result.items[0]?.status).toBe('unknown')
    expect(result.items[0]?.evidence).toEqual([])
  })

  it('不能丢弃一条坏证据后仅靠其他有效引文通过', () => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '声称完成。',
      evidence: [{ quote: '钟楼修好了' }, { quote: '“工匠不在正文中的回答”' }] }], frozen, '钟楼修好了。', 'zh-CN')
    expect(result.items[0]?.status).toBe('unknown')
    expect(result.items[0]?.evidence).toEqual([])
  })

  it('完全逐字命中的重复引文保留原有首个偏移行为', () => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '正文有完成描述。',
      evidence: [{ quote: '修好了' }] }], frozen, '修好了。他又说修好了。', 'zh-CN')
    expect(result.items[0]?.status).toBe('completed')
    expect(result.items[0]?.evidence).toEqual([{ quote: '修好了', start: 0, end: 3 }])
  })

  it('读取历史或损坏报告不假造有效目标合同', () => {
    expect(parseChapterGoalReview(undefined)).toBeNull()
    const valid = normalizeChapterGoalReview(answer, goals, draft, 'zh-CN')
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], status: 'pass' }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], evidence: [] }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [valid.items[0], valid.items[0]] })).toBeNull()
  })
})

/**
 * 先生（审稿截断事故）：逐项核对的输出长度正比于清单条数。条数一多，单次调用最容易
 * 顶到模型输出上限、整份报告作废 —— 所以清单长时要拆成小批次分别核对。
 */
describe('长清单分批核对', () => {
  const goalsWith = (count: number) => freezeChapterGoals(
    1,
    Array.from({ length: count }, (_, index) => `目标${index + 1}`).join('\n'),
  )

  it('清单短就随主审稿一次完成，不多花调用', () => {
    expect(splitChapterGoalsIntoBatches(goalsWith(6))).toHaveLength(1)
  })

  it('清单长按批数均分，而不是硬切出一个过小的尾巴', () => {
    const batches = splitChapterGoalsIntoBatches(goalsWith(9))
    expect(batches.map(batch => batch.items.length)).toEqual([3, 3, 3])
    // 拆批不得丢项、不得换序：合并回来必须与原清单逐项一致。
    expect(batches.flatMap(batch => batch.items.map(item => item.id)))
      .toEqual(goalsWith(9).items.map(item => item.id))
  })

  it('批数有上限：项数再多也不无限追加调用', () => {
    const batches = splitChapterGoalsIntoBatches(goalsWith(40))
    expect(batches).toHaveLength(MAX_GOAL_REVIEW_BATCHES)
    expect(batches.flatMap(batch => batch.items)).toHaveLength(40)
  })

  it('分批合同只要本批的 goalReviews，且自带上限', () => {
    const batch = splitChapterGoalsIntoBatches(goalsWith(9))[1]!
    const prompt = buildChapterGoalReviewBatchPrompt(batch, 'zh-CN')
    expect(prompt).toContain('只输出一个 JSON 对象：{"goalReviews":[...]}')
    expect(prompt).toContain('只包含本批清单的项')
    expect(prompt).toContain('每项不超过 120 字')
    expect(prompt).toContain('每项最多 1 条引文')
    // 只带本批的项，不夹带其它批。
    expect(prompt).toContain('"id":"ch1:keyEvents:4"')
    expect(prompt).not.toContain('"id":"ch1:keyEvents:1"')
  })

  it('分批模式下主审稿明确要求 goalReviews 返回空数组', () => {
    expect(buildChapterGoalReviewDeferredNote('zh-CN')).toContain('必须返回空数组 []')
  })

  it('单批解析容错：数组、对象包装、围栏都收，坏 JSON 退空数组', () => {
    expect(parseChapterGoalReviewBatch('[{"id":"a"}]')).toEqual([{ id: 'a' }])
    expect(parseChapterGoalReviewBatch('{"goalReviews":[{"id":"b"}]}')).toEqual([{ id: 'b' }])
    expect(parseChapterGoalReviewBatch('```json\n[{"id":"c"}]\n```')).toEqual([{ id: 'c' }])
    // 解析不出来就退空数组 —— 该批的目标会被归一化标成 unknown，而不是让一批的格式问题废掉整次审稿。
    expect(parseChapterGoalReviewBatch('not json at all')).toEqual([])
  })
})
