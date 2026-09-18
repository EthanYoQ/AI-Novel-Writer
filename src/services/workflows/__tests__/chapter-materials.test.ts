import { describe, expect, it } from 'vitest'

import {
  ChapterMaterialCapacityError,
  adjacentEvidencePassages,
  assembleChapterMaterials,
  selectReviewRevisionMaterials,
  type ReviewRevisionMaterial,
} from '../chapter-materials'
import type { ReviewMaterialIdentity } from '../../../shared/review-revision-generation'

/** S10B-1a：该接缝现在需要项目身份并额外返回差异清单，测试里用固定身份。 */
const assemble = (input: Omit<Parameters<typeof assembleChapterMaterials>[0], 'identity'>) =>
  assembleChapterMaterials({ identity: { projectId: '项目', epoch: '会话' }, ...input })

describe('chapter materials', () => {
  it.each([
    {
      writingLanguage: 'zh-CN' as const,
      expectedBoundary: '后续计划边界（只约束当前章，不是当前章任务）',
      expectedTiming: '明确安排在后续章节的知情变化、物品转交、行动和完成状态不得前移',
      expectedForeshadowing: '允许不改变这些时点的铺垫',
    },
    {
      writingLanguage: 'en-US' as const,
      expectedBoundary: 'Future-plan boundary (constrains the current chapter; not a current-chapter task)',
      expectedTiming: 'Knowledge changes, item transfers, actions, and completed states explicitly assigned to later chapters must not be moved earlier',
      expectedForeshadowing: 'foreshadowing that does not change those timings is allowed',
    },
  ])('keeps $writingLanguage future plans verbatim while making their timing role explicit', async ({
    writingLanguage,
    expectedBoundary,
    expectedTiming,
    expectedForeshadowing,
  }) => {
    const futurePlans = '第8章：林岚把钥匙交给周砚。\n第9章：周砚才得知暗门口令。'
    const bundle = await assemble({
      writingLanguage,
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans,
      references: [],
      finalized: [],
      candidates: [],
      relevanceTerms: [],
    })

    expect(bundle.text).toContain(expectedBoundary)
    expect(bundle.text).toContain(expectedTiming)
    expect(bundle.text).toContain(expectedForeshadowing)
    expect(bundle.text.split(futurePlans)).toHaveLength(2)
  })

  it('keeps the hit paragraph and one neighbour on both sides, merging overlapping windows', async () => {
    const content = [
      '林岚冲进库房时仍拖着左腿。',
      '她说伤口不是坠落造成的，而是昨夜被铁钩划开。',
      '周砚伸手要钥匙，她摇头：“我不会交给你。”',
      '警铃响起，两人同时望向门外。',
      '无关尾段。',
    ].join('\n\n')

    const result = adjacentEvidencePassages(content, [
      '伤口不是坠落造成的',
      '我不会交给你',
    ])

    expect(result.locatedEvidence).toBe(2)
    expect(result.passages).toEqual([
      [
        '林岚冲进库房时仍拖着左腿。',
        '她说伤口不是坠落造成的，而是昨夜被铁钩划开。',
        '周砚伸手要钥匙，她摇头：“我不会交给你。”',
        '警铃响起，两人同时望向门外。',
      ].join('\n\n'),
    ])
  })

  it('keeps required author material inside the budget and reports optional gaps', async () => {
    // 决定 1B：必需材料也计入预算，先占容量；可选块只能竞争剩下的部分。
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: ['AUTHOR_REQUIRED_SENTINEL'],
      characterProfiles: '林岚 (protagonist)',
      futurePlans: '第3章才允许交出钥匙。',
      references: [{
        text: '过长可选资料'.repeat(200),
        rendered: '过长可选资料'.repeat(200),
      }],
      finalized: [{
        chapterNumber: 1,
        draftId: 11,
        title: '拒绝',
        content: '林岚拒绝交出钥匙。',
        evidence: ['不存在的错误摘要'],
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
      budgetChars: 400,
    })

    expect(bundle.text).toContain('AUTHOR_REQUIRED_SENTINEL')
    expect(bundle.text).toContain('第3章才允许交出钥匙')
    expect(bundle.text).toContain('可选材料覆盖缺口')
    expect(bundle.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'finalized', reason: 'evidence-not-locatable' }),
      expect.objectContaining({ source: 'reference', reason: 'budget' }),
    ]))
  })

  it('does not count located finalized evidence when its block exceeds the material budget', async () => {
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 1,
        draftId: 11,
        title: '拒绝',
        content: `林岚拒绝交出钥匙。${'很长的定稿原文'.repeat(200)}`,
        evidence: ['拒绝交出钥匙'],
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
      budgetChars: 400,
    })

    expect(bundle.includedFinalizedFacts).toBe(0)
    expect(bundle.consumedFinalizedSources).toEqual([])
    expect(bundle.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 1,
      reason: 'budget',
    })
  })

  it('keeps the previous finalized ending dependency when its prompt block exceeds the budget', async () => {
    const source = {
      chapterNumber: 1,
      draftId: 11,
      title: '拒绝',
      content: `林岚拒绝交出钥匙。${'很长的定稿原文'.repeat(100)}`,
      evidence: ['拒绝交出钥匙'],
      includeEnding: true,
      sourceIdentity: { kind: 'finalized' as const, finalizationId: 'finalization-11', contentHash: 'a'.repeat(64) },
    }
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [source],
      candidates: [],
      relevanceTerms: ['林岚'],
      budgetChars: 400,
    })

    expect(bundle.text).not.toContain(source.content)
    expect(bundle.previousEnding).toBe(source.content)
    expect(bundle.consumedFinalizedSources).toEqual([source])
  })

  it('falls back to relevant neighbouring finalized prose when a far-chapter locator is stale', async () => {
    const staleStatement = '林岚因坠落受伤并把钥匙交给周砚。'
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '旧伤',
        content: [
          '林岚靠着仓门检查左腿。',
          '伤口不是坠落造成的，而是铁钩划伤。',
          '周砚伸手索要钥匙，她明确拒绝交出。',
          '雨声盖住了远处脚步。',
        ].join('\n\n'),
        evidence: [staleStatement],
        sourceStatus: 'stale',
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
    })

    expect(bundle.text).toContain('伤口不是坠落造成的，而是铁钩划伤。')
    expect(bundle.text).not.toContain(staleStatement)
    expect(bundle.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 2,
      reason: 'evidence-not-locatable',
    })
  })

  it('keeps only the containing passage when fallback prose contains a same-source evidence window', async () => {
    const source = {
      chapterNumber: 2,
      draftId: 22,
      title: '交接',
      content: [
        '仓门刚刚打开。',
        '林岚把铜钥匙交给周砚。',
        '周砚当面收好钥匙。',
        '林岚随后检查门锁。',
        '雨声重新盖住脚步。',
      ].join('\n\n'),
      evidence: ['把铜钥匙交给周砚', '无法定位的旧摘要'],
      sourceStatus: 'current' as const,
      sourceIdentity: { kind: 'finalized' as const, finalizationId: 'finalization-22', contentHash: 'b'.repeat(64) },
    }
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: ['AUTHOR_TEXT_MUST_STAY'],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [source],
      candidates: [],
      relevanceTerms: ['林岚'],
    })

    expect(bundle.text.split('仓门刚刚打开。')).toHaveLength(2)
    expect(bundle.text).toContain(source.content)
    expect(bundle.text).toContain('AUTHOR_TEXT_MUST_STAY')
    expect(bundle.text).toContain('第2章 · draft 22 · 定位索引current')
    expect(bundle.consumedFinalizedSources).toEqual([source])
    expect(bundle.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 2,
      reason: 'evidence-not-locatable',
    })
  })

  it('keeps partially overlapping same-source passages', async () => {
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '交叠',
        content: [
          '左侧独有段。',
          '命中的事实段。',
          '林岚检查门锁。',
          '右侧独有段。',
          '无关尾段。',
        ].join('\n\n'),
        evidence: ['命中的事实段', '无法定位的旧摘要'],
        sourceStatus: 'current',
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
    })

    expect(bundle.text).toContain('左侧独有段。')
    expect(bundle.text).toContain('右侧独有段。')
    expect(bundle.text.split('命中的事实段。')).toHaveLength(3)
  })

  it('drops a KB result only when an actually included finalized passage contains its full text', async () => {
    const included = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [
        { text: '铜钥匙交给周砚', rendered: '[KB重复] 铜钥匙交给周砚', deduplicateAgainstFinalized: true },
        { text: '铜钥匙交给周砚后门外亮灯', rendered: '[KB独有] 铜钥匙交给周砚后门外亮灯', deduplicateAgainstFinalized: true },
      ],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '交接',
        content: '林岚把铜钥匙交给周砚。',
        evidence: ['铜钥匙交给周砚'],
        sourceStatus: 'current',
      }],
      candidates: [],
      relevanceTerms: [],
    })

    expect(included.text).not.toContain('[KB重复]')
    expect(included.text).toContain('[KB独有] 铜钥匙交给周砚后门外亮灯')

    const finalizedOverBudget = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [{ text: '铜钥匙', rendered: '[KB保留] 铜钥匙', deduplicateAgainstFinalized: true }],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '超预算',
        content: `铜钥匙${'很长的定稿原文'.repeat(200)}`,
        evidence: ['铜钥匙'],
        sourceStatus: 'current',
      }],
      candidates: [],
      relevanceTerms: [],
      // 预算只够必需材料：定稿块整体被省略，因此它的段落没有进入提示词，
      // 参考材料族的子串规则也就没有理由跳过这条参考。
      budgetChars: 400,
    })

    expect(finalizedOverBudget.text).toContain('[KB保留] 铜钥匙')
    expect(finalizedOverBudget.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 2,
      reason: 'budget',
    })
  })

  it('reports a stale locator without inventing prose when no relevance term matches', async () => {
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '旧章',
        content: '钟楼在雨夜停摆。',
        evidence: ['不存在的旧定位'],
        sourceStatus: 'stale',
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
    })

    expect(bundle.text).not.toContain('钟楼在雨夜停摆。')
    expect(bundle.text).toContain('finalized#2:evidence-not-locatable')
  })

  it('omits a finalized source whose receipt validation failed', async () => {
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '损坏来源',
        content: 'UNVERIFIED_BODY_SENTINEL',
        evidence: ['UNVERIFIED_BODY_SENTINEL'],
        sourceStatus: 'invalid',
      }],
      candidates: [],
      relevanceTerms: ['UNVERIFIED'],
    })

    expect(bundle.text).not.toContain('UNVERIFIED_BODY_SENTINEL')
    expect(bundle.text).toContain('finalized#2:source-invalid')
  })

  it('orders optional blocks by the contract and reports budget exclusions in that same order', async () => {
    // 切换权威后不再是「新章优先」：必需材料在最前，其后按相关度、再按 sourceId 的规范全序，
    // 预算也按同一顺序结算。这里没有相关词，所以顺序就是 sourceId 的码元顺序。
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [
        { text: 'REFERENCE_A', rendered: 'REFERENCE_A' },
        { text: 'REFERENCE_B', rendered: 'REFERENCE_B' },
      ],
      finalized: [1, 4, 2, 3].map(chapterNumber => ({
        chapterNumber,
        draftId: chapterNumber,
        title: `第${chapterNumber}章`,
        content: chapterNumber >= 3
          ? [`CH${chapterNumber}_FIRST`, `CH${chapterNumber}_EVIDENCE`, `CH${chapterNumber}_LAST`].join('\n\n')
          : `CH${chapterNumber}_EVIDENCE_${'TOO_LARGE'.repeat(700)}`,
        evidence: [`CH${chapterNumber}_EVIDENCE`],
        sourceStatus: 'current' as const,
      })),
      candidates: [{
        chapterNumber: 5,
        draftId: 50,
        version: 2,
        content: 'CANDIDATE_FIRST\n\nCANDIDATE_SECOND',
      }],
      relevanceTerms: [],
      budgetChars: 2_000,
    })

    expect(bundle.consumedFinalizedSources.map(source => source.chapterNumber)).toEqual([3, 4])
    expect(bundle.omissions).toEqual([
      { source: 'finalized', chapterNumber: 1, reason: 'budget' },
      { source: 'finalized', chapterNumber: 2, reason: 'budget' },
    ])
    expect(bundle.includedFinalizedFacts).toBe(2)
    const markers = ['CANDIDATE_FIRST', '第3章 · draft 3', '第4章 · draft 4', 'REFERENCE_A', 'REFERENCE_B']
    const positions = markers.map(marker => bundle.text.indexOf(marker))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(bundle.text).toContain('CH3_FIRST\n\nCH3_EVIDENCE\n\nCH3_LAST')
    expect(bundle.text).toContain('CH4_FIRST\n\nCH4_EVIDENCE\n\nCH4_LAST')
    expect(bundle.text).toContain('CANDIDATE_FIRST\n\nCANDIDATE_SECOND')
  })

  it('labels every selected candidate with the exact saved id and version', async () => {
    const bundle = await assemble({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [],
      candidates: [
        { chapterNumber: 1, draftId: 101, version: 2, content: '林岚藏起旧钥匙。\n\n她离开钟楼。' },
        { chapterNumber: 2, draftId: 202, version: 4, content: '周砚抵达码头。\n\n林岚没有交出钥匙。' },
      ],
      relevanceTerms: ['林岚', '钥匙'],
    })

    expect(bundle.text).toContain('第1章 · draft 101 · v2')
    expect(bundle.text).toContain('第2章 · draft 202 · v4')
    expect(bundle.text).toContain('林岚没有交出钥匙')
    expect(bundle.text).toContain('候选正文尚未确认')
  })
})

/**
 * S10B-2：审稿/修稿入口与写稿路径共用同一条准入。这些断言钉住的是**共享语义**，
 * 不是「各自能跑」：成员判定、失败码、固定内容哈希与项目会话校验都走同一个合同。
 */
describe('审稿/修稿入口的共享准入（selectReviewRevisionMaterials）', () => {
  const CURRENT = { projectId: '项目', epoch: '会话' }
  const hash = (seed: string) => seed.repeat(64).slice(0, 64)
  const identity = (sourceId: string, contentHash: string,
    provenance: ReviewMaterialIdentity['provenance'] = 'finalized'): ReviewMaterialIdentity =>
    ({ projectId: CURRENT.projectId, sourceId, revision: 1, contentHash, provenance })
  const material = (sourceId: string, contentHash: string, text: string,
    over: Partial<ReviewRevisionMaterial> = {}): ReviewRevisionMaterial =>
    ({ identity: identity(sourceId, contentHash), category: 'finalized-history', required: false, text, ...over })
  const select = (materials: readonly ReviewRevisionMaterial[], budgetChars?: number) =>
    selectReviewRevisionMaterials({ current: CURRENT, writingLanguage: 'zh-CN', relevanceTerms: [],
      materials, ...(budgetChars === undefined ? {} : { budgetChars }) })

  it('admits in the caller order so each entry point keeps its own rendering', () => {
    // 合同的 included 顺序是「必需优先 + 相关度 + 规范全序」，那是写稿路径的渲染顺序。
    // 审/修入口只按身份判定成员：这里传入逆序，admitted 必须保持逆序，不能重排历史。
    const admission = select([
      material('finalized:9', hash('a'), '第九章'),
      material('finalized:1', hash('b'), '第一章'),
    ])
    expect(admission.admitted.map(item => item.identity.sourceId)).toEqual(['finalized:9', 'finalized:1'])
    expect(admission.selection.decision).toBe('ready')
  })

  it('fails explicitly（与写稿路径同一错误码）when required material alone exceeds the capacity', () => {
    let error: unknown
    try {
      select([material('finalized:1', hash('a'), '长'.repeat(7_000), { required: true })])
    } catch (cause) { error = cause }
    expect(error).toBeInstanceOf(ChapterMaterialCapacityError)
    expect((error as ChapterMaterialCapacityError).code).toBe('CHAPTER_MATERIAL_CAPACITY_CONFLICT')
    expect((error as ChapterMaterialCapacityError).decision).toMatchObject({
      decision: 'capacity-conflict',
      blockingSourceId: 'finalized:1',
      blockingReason: 'budget',
    })
  })

  it('lets optional material compete for the budget while the required anchor survives', () => {
    const admission = select([
      material('finalized:1', hash('b'), '可选'.repeat(7_000)),
      material('finalized:2', hash('a'), '前一章定稿', { required: true }),
    ])
    expect(admission.admitted.map(item => item.identity.sourceId)).toEqual(['finalized:2'])
    expect(admission.selection.omissions).toEqual([
      { sourceId: 'finalized:1', reason: 'budget', category: 'finalized-history', required: false },
    ])
  })

  it('never lets a material without a main-issued provenance become evidence', () => {
    const admission = select([
      material('future:secret-7', hash('a'), '第七章才揭晓的真相',
        { identity: identity('future:secret-7', hash('a'), 'unknown') }),
    ])
    expect(admission.admitted).toEqual([])
    expect(admission.selection.omissions).toEqual([
      { sourceId: 'future:secret-7', reason: 'unknown-provenance', category: 'finalized-history', required: false },
    ])
  })

  it('admits a duplicated immutable content only once', () => {
    const admission = select([
      material('finalized:1', hash('a'), '同一份不可变内容'),
      material('finalized:1-mirror', hash('a'), '同一份不可变内容'),
    ])
    expect(admission.admitted.map(item => item.identity.sourceId)).toEqual(['finalized:1'])
    expect(admission.selection.omissions).toEqual([
      { sourceId: 'finalized:1-mirror', reason: 'duplicate-content', category: 'finalized-history', required: false },
    ])
  })

  it('attaches the live session lease instead of any lease frozen into the material', () => {
    // 冻结材料身份是会话无关的（不含 epoch）；活跃租约由 selectReviewRevisionMaterials 按
    // **当前会话**补上。于是重开项目（租约必然改变）后同一份材料仍然合法：一条遗留的陈旧
    // 租约字段不再把材料误判成 `invalid-source-ref`（这正是 s10b-2 回归）。
    const staleLease = Object.assign(identity('finalized:1', hash('a')), { epoch: '别的会话' })
    const admission = select([material('finalized:1', hash('a'), '别的会话里的历史', { identity: staleLease })])
    expect(admission.admitted.map(item => item.identity.sourceId)).toEqual(['finalized:1'])
    expect(admission.selection.omissions).toEqual([])
  })

  it('still rejects material captured under a different project', () => {
    const admission = select([
      material('finalized:1', hash('a'), '别的项目里的历史',
        { identity: { ...identity('finalized:1', hash('a')), projectId: '别的项目' } }),
    ])
    expect(admission.admitted).toEqual([])
    expect(admission.selection.omissions).toEqual([
      { sourceId: 'finalized:1', reason: 'invalid-source-ref', category: 'finalized-history', required: false },
    ])
  })

  it('reports the same required-coverage settlement the write path uses', () => {
    // 必需锚点缺身份（主进程没给出）时按 `invalid-source-ref` 处理并整体失败，
    // 绝不退回「静默省略必需材料」。
    let error: unknown
    try {
      select([material('finalized:1', hash('a'), '前一章', { identity: identity('', '', 'unknown'), required: true })])
    } catch (cause) { error = cause }
    expect(error).toBeInstanceOf(ChapterMaterialCapacityError)
    expect((error as ChapterMaterialCapacityError).decision).toMatchObject({ decision: 'capacity-conflict', blockingReason: 'invalid-source-ref' })
  })
})
