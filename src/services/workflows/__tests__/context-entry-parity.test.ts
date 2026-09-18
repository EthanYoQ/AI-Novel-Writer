import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { freezeChapterGoals } from '../../../shared/chapter-goal-review'
import type { ReviewRevisionContext } from '../../../shared/review-revision-generation'
import {
  ChapterMaterialCapacityError,
  assembleChapterMaterials,
  selectReviewRevisionMaterials,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'
import { reviewHistoryMaterials } from '../commands/review-chapter.command'
import { refineHistoryMaterials } from '../commands/refine-draft.command'

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

/**
 * S10B-2 三类入口（写 / 审 / 修）的共享准入。
 *
 * 这三个入口的材料装配各写各的（来源族群与渲染措辞本来就不同），但**准入语义只有一套**：
 * 三者最终都调用同一个 `selectChapterSources`，容量、固定内容哈希、必需覆盖与失败
 * 语义因此必须逐条一致。这个套件用同一组情形驱动三个入口**真实的**装配缝，
 * 断言的是共享规则本身，而不是「各自能跑」。
 */
const PARITY_IDENTITY = { projectId: '项目', epoch: '会话' }
/** 当前章；前一章（= 本字段 - 1）的定稿是审/修入口的必需锚点。 */
const SOURCE_CHAPTER = 5
const REQUIRED_FITS = '必需的短材料'
const OPTIONAL_SENTINEL = '可选材料标记'

interface AdmissionOutcome {
  /** 该入口最终让模型看到的材料文本。 */
  readonly visibleText: string
  /** 省略原因（合同词汇）。 */
  readonly omissionReasons: readonly string[]
  /** 显式失败时的稳定码与合同裁决；未失败为 null。 */
  readonly failure: { code: string; decision: string } | null
}

function admissionOutcomeFrom(error: unknown): AdmissionOutcome {
  if (!(error instanceof ChapterMaterialCapacityError)) throw error
  return { visibleText: '', omissionReasons: error.decision.omissions.map(omission => omission.reason),
    failure: { code: error.code, decision: error.decision.decision } }
}

function frozenHistoryItem(chapterNumber: number, content: string): ReviewRevisionContext['history'][number] {
  return { draftId: chapterNumber, chapterNumber, chapterTitle: `第${chapterNumber}章`, content,
    identity: { ...PARITY_IDENTITY, sourceId: `finalized:${chapterNumber}`, revision: chapterNumber,
      contentHash: sha(content), provenance: 'finalized' } }
}

/** 把「一份必需材料 + 若干可选材料」映射成一份冻结上下文里的定稿历史。 */
function frozenHistory(required: string, optional: readonly string[]): ReviewRevisionContext {
  return {
    version: 1, operation: 'review-chapter',
    source: { id: 1, chapterNumber: SOURCE_CHAPTER, version: 1, status: 'draft', content: '待审正文。' },
    sourceHash: sha('待审正文。'), config: {} as ReviewRevisionContext['config'],
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '', worldbuilding: '',
    history: [frozenHistoryItem(SOURCE_CHAPTER - 1, required),
      ...optional.map((content, index) => frozenHistoryItem(SOURCE_CHAPTER - 2 - index, content))],
    blueprints: [], frozenGoals: freezeChapterGoals(SOURCE_CHAPTER, null), preflightFindings: [],
  }
}

/** 审/修共用同一条装配路径：冻结上下文 -> 本入口材料 -> 共享准入。 */
function runFrozenEntry(kind: 'review' | 'refine', required: string, optional: readonly string[]): AdmissionOutcome {
  const frozen = frozenHistory(required, optional)
  const materials = kind === 'review'
    ? reviewHistoryMaterials(frozen, PARITY_IDENTITY)
    : refineHistoryMaterials(frozen, PARITY_IDENTITY)
  try {
    const admission = selectReviewRevisionMaterials({ current: PARITY_IDENTITY, writingLanguage: 'zh-CN',
      materials, relevanceTerms: [] })
    return { visibleText: admission.admitted.map(material => material.text).join('\n\n'),
      omissionReasons: admission.selection.omissions.map(omission => omission.reason), failure: null }
  } catch (error) { return admissionOutcomeFrom(error) }
}

interface EntryPoint {
  readonly name: string
  run(required: string, optional: readonly string[]): Promise<AdmissionOutcome> | AdmissionOutcome
}

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: '写稿 generate-draft',
    async run(required, optional) {
      try {
        const bundle = await assembleChapterMaterials({
          identity: PARITY_IDENTITY, writingLanguage: 'zh-CN',
          authorProjectFacts: [required], characterProfiles: '', futurePlans: '',
          references: optional.map(text => ({ text, rendered: text })),
          finalized: [], candidates: [], relevanceTerms: [],
        })
        return { visibleText: bundle.text, omissionReasons: bundle.omissions.map(omission => omission.reason), failure: null }
      } catch (error) { return admissionOutcomeFrom(error) }
    },
  },
  { name: '审稿 review-chapter', run: (required, optional) => runFrozenEntry('review', required, optional) },
  { name: '修稿 refine-draft', run: (required, optional) => runFrozenEntry('refine', required, optional) },
]

describe('S10B-2 写/审/修共享同一套准入语义', () => {
  it.each(ENTRY_POINTS)('$name 对装不下的必需材料显式失败，绝不静默丢弃', async ({ run }) => {
    const outcome = await run('长'.repeat(7_000), [])
    expect(outcome.failure).toEqual({ code: 'CHAPTER_MATERIAL_CAPACITY_CONFLICT', decision: 'capacity-conflict' })
    expect(outcome.visibleText).toBe('')
  })

  it.each(ENTRY_POINTS)('$name 整体省略超预算的可选材料，绝不截断', async ({ run }) => {
    const outcome = await run(REQUIRED_FITS, [`${OPTIONAL_SENTINEL}${'可选'.repeat(7_000)}`])
    expect(outcome.failure).toBeNull()
    expect(outcome.omissionReasons).toEqual(['budget'])
    // 必需锚点在；超预算的可选块连一个片段都没有进入材料。
    expect(outcome.visibleText).toContain(REQUIRED_FITS)
    expect(outcome.visibleText).not.toContain(OPTIONAL_SENTINEL)
  })

  it.each(ENTRY_POINTS)('$name 对同一份不可变内容只纳入一次', async ({ run }) => {
    const duplicate = '同一份不可变内容'
    const outcome = await run(REQUIRED_FITS, [duplicate, duplicate])
    expect(outcome.failure).toBeNull()
    expect(outcome.omissionReasons).toEqual(['duplicate-content'])
    expect(outcome.visibleText.match(new RegExp(duplicate, 'gu'))).toHaveLength(1)
  })

  it('审稿与修稿不洗白未知来源，并按同一条规则拒绝跨会话材料', () => {
    // 写稿路径从不构造这类候选（它的来源族群全是主进程/作者自选），所以这两条只在
    // 冻结身份进入的审/修路径上可达；两者必须给出**完全相同**的裁决。
    const optionalOmissions = (kind: 'review' | 'refine', over: Partial<{ provenance: 'unknown'; epoch: string }>) => {
      const frozen = frozenHistory(REQUIRED_FITS, ['可选的另一份定稿'])
      const materials = (kind === 'review' ? reviewHistoryMaterials : refineHistoryMaterials)(frozen, PARITY_IDENTITY)
        .map(material => (material.required ? material : { ...material, identity: { ...material.identity, ...over } }))
      return selectReviewRevisionMaterials({ current: PARITY_IDENTITY, writingLanguage: 'zh-CN', materials, relevanceTerms: [] })
        .selection.omissions.filter(omission => !omission.required).map(omission => omission.reason)
    }
    expect(optionalOmissions('review', { provenance: 'unknown' })).toEqual(['unknown-provenance'])
    expect(optionalOmissions('refine', { provenance: 'unknown' })).toEqual(['unknown-provenance'])
    expect(optionalOmissions('review', { epoch: '别的会话' })).toEqual(['invalid-source-ref'])
    expect(optionalOmissions('refine', { epoch: '别的会话' })).toEqual(['invalid-source-ref'])
  })
})
