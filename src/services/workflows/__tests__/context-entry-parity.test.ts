import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  assembleChapterMaterials,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'

/**
 * S10B-0 表征护栏：把今天写稿路径拼出的提示词逐字节钉死。
 *
 * 写稿路径即将被移到 S10A 的选择契约上（预算单位、排序、受预算的集合都会变），
 * 而今天没有任何测试能证明"提示词没有因此改变"。本文件就是这个护栏。
 */
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const finalized = (chapterNumber: number, content: string,
  over: Partial<FinalizedMaterialSource> = {}): FinalizedMaterialSource => ({
  chapterNumber, draftId: chapterNumber, title: `第${chapterNumber}章`, content, evidence: [], ...over,
})

/** 覆盖全部输入族的基线输入。 */
function baseline() {
  return {
    identity: { projectId: '项目', epoch: '会话' },
    writingLanguage: 'zh-CN' as const,
    authorProjectFacts: ['作者设定甲', '作者设定乙'],
    characterProfiles: '主角：林岚',
    futurePlans: '第三章：北塔揭晓',
    references: [{ text: '参考材料', rendered: '【参考】参考材料' }],
    finalized: [
      finalized(1, '第一章正文。\n\n林岚抵达海港。\n\n她看见灯塔。', { includeEnding: true }),
      finalized(2, '第二章正文。\n\n林岚离开海港。'),
    ],
    candidates: [{ chapterNumber: 3, draftId: 30, version: 1, content: '第三章草稿。\n\n她走向北塔。' }] as SelectedCandidateDraft[],
    relevanceTerms: ['海港', '北塔'],
  }
}

// 这两条哈希只在上面那份固定输入下稳定：文本由常量拼接而成，术语匹配用的
// toLocaleLowerCase 对中文字符在任何 locale 下都不改变结果。改动提示词即改动哈希，
// 那正是这个护栏存在的意义。
describe('S10B-0 write-path characterization (the composed prompt must not change)', () => {
  it('composes the same bundle for the baseline input', async () => {
    const bundle = await assembleChapterMaterials(baseline())
    expect(bundle.previousEnding).toBe('第三章草稿。\n\n她走向北塔。')
    expect(bundle.omissions).toEqual([])
    expect(bundle.consumedFinalizedSources.map(source => source.draftId)).toEqual([1])
    expect(sha(bundle.text)).toBe('050b5a5585051afef4aef012b7c4177745fa79f1f75dfdc462854275e7f31051')
  })

  it('keeps required author material unbudgeted even when it alone exceeds the budget', async () => {
    // 作者资料、角色档案与后续计划今天不参与预算：它远超 6000 码元上限，却仍完整出现。
    // 因此"要求材料过大"不会挤出可选材料——只有可选块之间互相竞争。
    const input = { ...baseline(), characterProfiles: '主'.repeat(7_000), relevanceTerms: [] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.text).toContain('主'.repeat(7_000))
    expect(bundle.text.length).toBeGreaterThan(7_000)
    expect(sha(bundle.text)).toBe('52571347a646c00452130e1990fc422a2c7df2670f9dddf9f8070d642d41a916')
  })

  it('lets optional material compete for the budget while required material survives', async () => {
    // 只有可选块之间互相竞争 6000 码元上限：过大的可选块被省略（不是截断），要求材料仍在。
    const input = { ...baseline(), references: [{ text: '参', rendered: '参'.repeat(7_000) }] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.omissions).toEqual([{ source: 'reference', reason: 'budget' }])
    expect(bundle.text).not.toContain('参'.repeat(7_000))
    expect(bundle.text).toContain('主角：林岚')
  })

  it('reports an unlocatable evidence index and still recovers nearby prose', async () => {
    const input = { ...baseline(), finalized: [finalized(1, '第一章正文。\n\n林岚抵达海港。', { evidence: ['不存在的引文'] })] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.omissions).toEqual([{ source: 'finalized', chapterNumber: 1, reason: 'evidence-not-locatable' }])
    // 定位失败只说明索引失效，原文仍可从同一可读来源回读。
    expect(bundle.text).toContain('林岚抵达海港')
  })

  it('reports an invalid finalized source without rendering it', async () => {
    const input = { ...baseline(), finalized: [finalized(1, '第一章正文。', { sourceStatus: 'invalid' })], candidates: [] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.omissions).toEqual([{ source: 'finalized', chapterNumber: 1, reason: 'source-invalid' }])
  })
})

describe('S10B-1a drift measurement', () => {
  it('reports which sources the stable contract would move in or out', async () => {
    const bundle = await assembleChapterMaterials(baseline())
    // 传统遍历实际纳入的来源
    expect(bundle.drift.legacyIncluded).toEqual(['author:required', 'candidate:30', 'finalized:1', 'reference:0'])
    // 这份基线输入两边一致，所以没有漂移；切换是否会改动提示词由这个清单回答。
    expect(bundle.drift.onlyInLegacy).toEqual([])
    expect(bundle.drift.onlyInSelection).toEqual([])
    expect(bundle.selection.decision).toBe('ready')
  })

  it('shows the two dedup rules disagreeing', async () => {
    // 参考材料重复了已纳入定稿里的一段：传统遍历按子串规则跳过它，
    // 稳定契约按内容哈希判不出来（文本不同、哈希不同），因此会纳入。
    const input = { ...baseline(), references: [{ text: '她看见灯塔。', rendered: '【重复】她看见灯塔。', deduplicateAgainstFinalized: true }] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.drift.legacyIncluded).not.toContain('reference:0')
    expect(bundle.drift.onlyInSelection).toContain('reference:0')
  })
})
