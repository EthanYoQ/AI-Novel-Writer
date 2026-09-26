import { describe, expect, it } from 'vitest'
import { freezeChapterGoals, parseChapterGoalReview } from '../chapter-goal-review'
import type { ConsistencyFinding } from '../consistency-preflight'
import { buildReviewGenerationReport, parseReviewGenerationResult } from '../review-generation-report'

const passingItem = { category: '剧情连贯性', severity: 'pass', description: '未发现矛盾。' }
const passing = { summary: '原始总结。', items: [passingItem] }
const source = '她合上已经装订好的相册。两人约定周三再搬设备。'
const goals = freezeChapterGoals(3, '完成相册；约定周三搬设备')
const answers = [
  { id: goals.items[0]!.id, status: 'completed', description: '装订已完成。', evidence: [{ quote: '已经装订好的相册' }] },
  { id: goals.items[1]!.id, status: 'completed', description: '约定已达成。', evidence: [{ quote: '两人约定周三再搬设备。' }] },
]

function build(overrides: Partial<Parameters<typeof buildReviewGenerationReport>[0]> = {}) {
  return buildReviewGenerationReport({
    content: JSON.stringify({ ...passing, goalReviews: answers }),
    sourceContent: source,
    frozenGoals: goals,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    preflightFindings: [],
    ...overrides,
  })
}

describe('parseReviewGenerationResult', () => {
  it('accepts one strict JSON object or the original JSON fence and preserves category bytes', () => {
    const content = JSON.stringify({ ...passing, items: [{ ...passingItem, category: '  原始类别  ' }] })
    const expected = { ...passing, items: [{ ...passingItem, category: '  原始类别  ' }] }
    expect(parseReviewGenerationResult(content)).toEqual(expected)
    expect(parseReviewGenerationResult(` \n\`\`\`JSON\t\r\n${content}\r\n\`\`\` \n`)).toEqual(expected)
    expect(parseReviewGenerationResult(JSON.stringify({ ...passing, items: Array.from({ length: 10 }, () => passingItem) })).items).toHaveLength(10)
  })

  it('bounds summary, description and quote by Unicode characters without splitting surrogate pairs', () => {
    const result = parseReviewGenerationResult(JSON.stringify({
      summary: ` ${'🌙'.repeat(121)} `,
      items: [{ category: '人物', severity: 'warning', description: ` ${'言'.repeat(201)} `, quote: ` ${'𠮷'.repeat(161)} ` }],
    }))
    expect(result.summary).toBe('🌙'.repeat(120))
    expect(result.items[0]?.description).toBe('言'.repeat(200))
    expect(result.items[0]?.quote).toBe('𠮷'.repeat(160))
  })

  it.each([
    ['array root', []],
    ['null root', null],
    ['missing summary', { items: [passingItem] }],
    ['empty summary', { ...passing, summary: ' \n ' }],
    ['non-array items', { ...passing, items: {} }],
    ['no items', { ...passing, items: [] }],
    ['too many items', { ...passing, items: Array.from({ length: 11 }, () => passingItem) }],
    ['null item', { ...passing, items: [null] }],
    ['array item', { ...passing, items: [[]] }],
    ['unknown severity', { ...passing, items: [{ ...passingItem, severity: 'unknown' }] }],
    ['blank category', { ...passing, items: [{ ...passingItem, category: ' ' }] }],
    ['non-string description', { ...passing, items: [{ ...passingItem, description: 1 }] }],
    ['blank description', { ...passing, items: [{ ...passingItem, description: '\n' }] }],
    ['blank optional quote', { ...passing, items: [{ ...passingItem, quote: ' ' }] }],
    ['non-string quote', { ...passing, items: [{ ...passingItem, quote: null }] }],
    ['extra root key', { ...passing, approved: true }],
    ['model normalized goal contract', { ...passing, goalReview: {} }],
    ['model stable fact key', { ...passing, items: [{ ...passingItem, stableFactKey: 'forged' }] }],
    ['model source chapter', { ...passing, items: [{ ...passingItem, sourceChapter: 1 }] }],
  ])('rejects %s before normalization', (_label, value) => {
    expect(() => parseReviewGenerationResult(JSON.stringify(value))).toThrow('invalid review contract')
  })

  it.each(['error', 'warning'])('requires a nonempty quote for %s', severity => {
    expect(() => parseReviewGenerationResult(JSON.stringify({ ...passing, items: [{ ...passingItem, severity }] }))).toThrow()
    const item = { ...passingItem, severity, quote: '原文。' }
    expect(parseReviewGenerationResult(JSON.stringify({ ...passing, items: [item] })).items).toEqual([item])
  })

  it.each([
    '{"summary":"broken",',
    `explanation ${JSON.stringify(passing)}`,
    `${JSON.stringify(passing)} ${JSON.stringify(passing)}`,
    `\`\`\`\n${JSON.stringify(passing)}\n\`\`\``,
    `<think>private</think>${JSON.stringify(passing)}`,
  ])('does not salvage arbitrary wrappers or partial JSON: %s', content => {
    expect(() => parseReviewGenerationResult(content)).toThrow(SyntaxError)
  })
})

describe('buildReviewGenerationReport', () => {
  it('keeps frozen goal wording and per-goal source evidence, then removes raw model goalReviews', () => {
    const result = build()
    const normalized = parseChapterGoalReview(result.goalReview)!
    expect(result.summary).toBe(passing.summary)
    expect(result).not.toHaveProperty('goalReviews')
    expect(result.items[0]).toEqual(passingItem)
    expect(normalized.items.map(item => item.text)).toEqual(goals.items.map(item => item.text))
    expect(normalized.items.map(item => item.status)).toEqual(['completed', 'completed'])
    for (const item of normalized.items) for (const evidence of item.evidence) {
      expect(source.slice(evidence.start, evidence.end)).toBe(evidence.quote)
    }
    expect(result.items.slice(1).map(item => item.goalId)).toEqual(goals.items.map(item => item.id))
  })

  it.each([
    ['missing goal', [answers[0]]],
    ['duplicate goal', [answers[0], answers[0], answers[1]]],
    ['rewritten goal', [{ ...answers[0], text: '改成准备相册' }, answers[1]]],
    ['foreign goal', [{ ...answers[0], id: 'foreign' }, answers[1]]],
    ['invalid evidence', [{ ...answers[0], evidence: [{ quote: '模型编造的原文' }] }, answers[1]]],
    ['absent evidence', [{ ...answers[0], evidence: [] }, answers[1]]],
    ['invalid completion label', [{ ...answers[0], status: 'pass' }, answers[1]]],
    ['missing model goals', undefined],
  ])('keeps %s unknown rather than declaring an overall pass', (_label, goalReviews) => {
    const result = build({ content: JSON.stringify({ ...passing, goalReviews }) })
    expect(result.summary).toBe('审稿包含待核实项目，不能视为全部通过。')
    expect(result.items.some(item => item.severity === 'unknown')).toBe(true)
    expect(parseChapterGoalReview(result.goalReview)?.items.map(item => item.text)).toEqual(goals.items.map(item => item.text))
  })

  it('checks quotes only against the supplied source, including UTF-16 positions', () => {
    const frozenGoals = freezeChapterGoals(1, '锁上门')
    const sourceContent = '🌙她锁上门。'
    const content = JSON.stringify({ ...passing, goalReviews: [{ id: frozenGoals.items[0]!.id, status: 'completed', description: '已经锁门。', evidence: [{ quote: '她锁上门。' }] }] })
    const valid = build({ content, frozenGoals, sourceContent })
    expect(parseChapterGoalReview(valid.goalReview)?.items[0]?.evidence).toEqual([{ quote: '她锁上门。', start: 2, end: 7 }])
    const changed = build({ content, frozenGoals, sourceContent: '她没有锁门。' })
    expect(parseChapterGoalReview(changed.goalReview)?.items[0]?.status).toBe('unknown')
    expect(changed.summary).toContain('不能视为全部通过')
  })

  it.each(['zh-CN', 'en-US'] as const)('keeps unknown above unmet in the %s summary and separates UI from writing language', uiLocale => {
    const goalReviews = [
      { ...answers[0], status: 'unmet', evidence: [{ quote: '明天再装订' }] },
      { ...answers[1], status: 'unknown', evidence: [] },
    ]
    const result = build({ content: JSON.stringify({ ...passing, goalReviews }), sourceContent: '明天再装订。', uiLocale, writingLanguage: 'zh-CN' })
    expect(parseChapterGoalReview(result.goalReview)?.items.map(item => item.status)).toEqual(['unmet', 'unknown'])
    expect(result.summary).toBe(uiLocale === 'en-US'
      ? 'The review contains unresolved items and is not an overall pass.'
      : '审稿包含待核实项目，不能视为全部通过。')
    expect(result.items[1]?.severity).toBe('error')
    expect(result.items[2]?.severity).toBe('unknown')
  })

  it.each(['zh-CN', 'en-US'] as const)('uses the historical %s unmet summary when all goals have verified outcomes', uiLocale => {
    const result = build({
      content: JSON.stringify({ ...passing, goalReviews: [{ ...answers[0], status: 'unmet', evidence: [{ quote: '明天再装订' }] }, answers[1]] }),
      sourceContent: `明天再装订。${source}`,
      uiLocale,
    })
    expect(result.summary).toBe(uiLocale === 'en-US'
      ? 'Some chapter goals are unmet; check their evidence.'
      : '本章存在尚未完成的目标，请核对逐项证据。')
    expect(result.items.some(item => item.severity === 'unknown')).toBe(false)
  })

  it.each([null, undefined])('does not promote absent or unavailable frozen goals to pass: %s', sourceGoals => {
    const result = build({ frozenGoals: freezeChapterGoals(3, sourceGoals) })
    expect(result.items.some(item => item.severity === 'unknown')).toBe(true)
    expect(result.summary).toContain('不能视为全部通过')
  })

  it.each(['zh-CN', 'en-US'] as const)('appends only frozen preflight findings in %s without mutating input or losing model/goal items', uiLocale => {
    const finding: ConsistencyFinding = Object.freeze({
      stableFactKey: 'fact:frozen', severity: 'warning', sourceChapter: 2, evidence: '韩峥已死。',
      issue: Object.freeze({ zhCN: '蓝图与既成事实冲突。', enUS: 'The blueprint conflicts with established facts.' }),
      suggestion: Object.freeze({ zhCN: '核对原文。', enUS: 'Check the source.' }),
    })
    const preflightFindings = Object.freeze([finding])
    const before = JSON.stringify({ goals, preflightFindings })
    const result = build({ preflightFindings, uiLocale })
    expect(result.items).toHaveLength(4)
    expect(result.items[0]).toEqual(passingItem)
    expect(result.items.at(-1)).toEqual({
      category: uiLocale === 'en-US' ? 'Deterministic continuity preflight' : '确定性一致性预检',
      severity: 'warning', description: uiLocale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN,
      quote: finding.evidence, stableFactKey: finding.stableFactKey, sourceChapter: finding.sourceChapter,
    })
    expect(result.summary).toBe(passing.summary)
    expect(JSON.stringify({ goals, preflightFindings })).toBe(before)
  })

  it('retains the strict model shape gate before adding trusted goal and preflight metadata', () => {
    expect(() => build({ content: JSON.stringify({ ...passing, items: [{ ...passingItem, goalId: goals.items[0]!.id }] }) })).toThrow('invalid review contract')
  })
})
