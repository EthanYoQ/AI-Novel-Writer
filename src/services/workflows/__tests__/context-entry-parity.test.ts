import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ChapterMaterialCapacityError,
  assembleChapterMaterials,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'

/**
 * S10B 表征护栏：把今天写稿路径拼出的提示词逐字节钉死。
 *
 * **这两个哈希在 S10B-1b 变过**：渲染的准入权威从「传统遍历」换成了 S10A 的选择契约
 * （预算单位、排序、受预算的集合都随之改变），提示词因此逐字节不同。哈希改变只证明
 * 提示词确实变了，**不**证明它变好：质量仍是 `not-run`，要等 `early-context` 真模型门
 * 跑完才能判定。护栏本身不因此放松——它仍然是精确的 sha256 钉死，不是快照。
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
describe('S10B write-path characterization (the composed prompt must not change)', () => {
  it('composes the same bundle for the baseline input', async () => {
    const bundle = await assembleChapterMaterials(baseline())
    expect(bundle.previousEnding).toBe('第三章草稿。\n\n她走向北塔。')
    expect(bundle.omissions).toEqual([])
    expect(bundle.consumedFinalizedSources.map(source => source.draftId)).toEqual([1])
    expect(sha(bundle.text)).toBe('4a646510d5b5566f2e703058a422d52fec14f97180a66049901f21b9887b9360')
  })

  it('fails explicitly when required author material alone exceeds the capacity', async () => {
    // 决定 1B：作者资料、角色档案与后续计划现在是**受预算**的单一必需候选。
    // 7000 字符的角色档案远超上限，于是整轮显式失败——既不截断，也不静默丢掉它，
    // 更不会像旧遍历那样把它无界地发出去。
    const input = { ...baseline(), characterProfiles: '主'.repeat(7_000), relevanceTerms: [] }
    const error = await assembleChapterMaterials(input).catch(reason => reason)
    expect(error).toBeInstanceOf(ChapterMaterialCapacityError)
    expect((error as ChapterMaterialCapacityError).code).toBe('CHAPTER_MATERIAL_CAPACITY_CONFLICT')
    expect((error as ChapterMaterialCapacityError).decision).toMatchObject({
      decision: 'capacity-conflict',
      blockingSourceId: 'author:required',
      blockingReason: 'budget',
    })
  })

  it('lets optional material compete for the budget while required material survives', async () => {
    // 必需材料先占预算，其余按相关度与规范全序竞争；过大的可选块被整体省略（不是截断）。
    const input = { ...baseline(), references: [{ text: '参', rendered: '参'.repeat(7_000) }] }
    const bundle = await assembleChapterMaterials(input)
    expect(bundle.omissions).toEqual([{ source: 'reference', reason: 'budget' }])
    expect(bundle.text).not.toContain('参'.repeat(7_000))
    expect(bundle.text).toContain('主角：林岚')
    expect(sha(bundle.text)).toBe('c3742ac83ae9e90ab8f870d2c7370f2642cd529c8969863e87bba65bcffc79ca')
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

describe('S10B-1b single authority', () => {
  it('composes the prompt from the contract included list, in the contract order', async () => {
    const bundle = await assembleChapterMaterials(baseline())
    const { selection } = bundle
    if (selection.decision !== 'ready') throw new Error('unreachable')
    // 必需材料排在最前，其后按相关度与规范全序（同分时按 sourceId 的码元顺序）。
    expect(selection.included.map(item => item.ref.sourceId))
      .toEqual(['author:required', 'candidate:30', 'finalized:1', 'reference:0'])
    for (const item of selection.included) expect(bundle.text).toContain(item.text)
    // 块头只由各族原有的模板生成：渲染顺序就是合同顺序，没有第二条遍历。
    const candidateBlock = bundle.text.indexOf('【未定稿候选 · 第3章 · draft 30 · v1】')
    const finalizedBlock = bundle.text.indexOf('【定稿原文 · 第1章 · draft 1 · 定位索引legacy】')
    expect(candidateBlock).toBeGreaterThanOrEqual(0)
    expect(finalizedBlock).toBeGreaterThan(candidateBlock)
  })

  it('keeps the reference-family substring rule on top of the contract dedup', async () => {
    // 参考材料重复了已纳入定稿里的一段：合同的内容哈希判不出来（文本不同、哈希不同），
    // 参考材料族的局部子串规则仍然把它整条过滤掉。
    const input = { ...baseline(), references: [{ text: '她看见灯塔。', rendered: '【重复】她看见灯塔。', deduplicateAgainstFinalized: true }] }
    const bundle = await assembleChapterMaterials(input)
    if (bundle.selection.decision !== 'ready') throw new Error('unreachable')
    expect(bundle.selection.included.map(item => item.ref.sourceId)).not.toContain('reference:0')
    expect(bundle.text).not.toContain('【重复】她看见灯塔。')
    // 族局部规则只是不重复发送已经发过的字节，不是一条准入裁决，因此不记省略。
    expect(bundle.omissions).toEqual([])
  })
})
