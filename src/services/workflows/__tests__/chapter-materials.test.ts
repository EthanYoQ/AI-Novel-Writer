import { describe, expect, it } from 'vitest'

import { adjacentEvidencePassages, assembleChapterMaterials } from '../chapter-materials'

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
  ])('keeps $writingLanguage future plans verbatim while making their timing role explicit', ({
    writingLanguage,
    expectedBoundary,
    expectedTiming,
    expectedForeshadowing,
  }) => {
    const futurePlans = '第8章：林岚把钥匙交给周砚。\n第9章：周砚才得知暗门口令。'
    const bundle = assembleChapterMaterials({
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

  it('keeps the hit paragraph and one neighbour on both sides, merging overlapping windows', () => {
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

  it('keeps required author material outside the optional budget and reports optional gaps', () => {
    const bundle = assembleChapterMaterials({
      writingLanguage: 'zh-CN',
      authorProjectFacts: ['AUTHOR_REQUIRED_SENTINEL'],
      characterProfiles: '林岚 (protagonist)',
      futurePlans: '第3章才允许交出钥匙。',
      references: [{
        text: '过长可选资料'.repeat(30),
        rendered: '过长可选资料'.repeat(30),
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
      budgetChars: 10,
    })

    expect(bundle.text).toContain('AUTHOR_REQUIRED_SENTINEL')
    expect(bundle.text).toContain('第3章才允许交出钥匙')
    expect(bundle.text).toContain('可选材料覆盖缺口')
    expect(bundle.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'finalized', reason: 'evidence-not-locatable' }),
      expect.objectContaining({ source: 'reference', reason: 'budget' }),
    ]))
  })

  it('does not count located finalized evidence when its block exceeds the material budget', () => {
    const bundle = assembleChapterMaterials({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [{
        chapterNumber: 1,
        draftId: 11,
        title: '拒绝',
        content: '林岚拒绝交出钥匙。',
        evidence: ['拒绝交出钥匙'],
      }],
      candidates: [],
      relevanceTerms: ['林岚'],
      budgetChars: 10,
    })

    expect(bundle.includedFinalizedFacts).toBe(0)
    expect(bundle.consumedFinalizedSources).toEqual([])
    expect(bundle.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 1,
      reason: 'budget',
    })
  })

  it('keeps the previous finalized ending dependency when its prompt block exceeds the budget', () => {
    const source = {
      chapterNumber: 1,
      draftId: 11,
      title: '拒绝',
      content: '林岚拒绝交出钥匙。',
      evidence: ['拒绝交出钥匙'],
      includeEnding: true,
      sourceIdentity: { kind: 'finalized' as const, finalizationId: 'finalization-11', contentHash: 'a'.repeat(64) },
    }
    const bundle = assembleChapterMaterials({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [],
      finalized: [source],
      candidates: [],
      relevanceTerms: ['林岚'],
      budgetChars: 10,
    })

    expect(bundle.text).not.toContain(source.content)
    expect(bundle.previousEnding).toBe(source.content)
    expect(bundle.consumedFinalizedSources).toEqual([source])
  })

  it('falls back to relevant neighbouring finalized prose when a far-chapter locator is stale', () => {
    const staleStatement = '林岚因坠落受伤并把钥匙交给周砚。'
    const bundle = assembleChapterMaterials({
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

  it('keeps only the containing passage when fallback prose contains a same-source evidence window', () => {
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
    const bundle = assembleChapterMaterials({
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

  it('keeps partially overlapping same-source passages', () => {
    const bundle = assembleChapterMaterials({
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

  it('drops a KB result only when an actually included finalized passage contains its full text', () => {
    const included = assembleChapterMaterials({
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

    const finalizedOverBudget = assembleChapterMaterials({
      writingLanguage: 'zh-CN',
      authorProjectFacts: [],
      characterProfiles: '',
      futurePlans: '（无）',
      references: [{ text: '铜钥匙', rendered: '[KB保留] 铜钥匙', deduplicateAgainstFinalized: true }],
      finalized: [{
        chapterNumber: 2,
        draftId: 22,
        title: '超预算',
        content: `铜钥匙${'很长的定稿原文'.repeat(20)}`,
        evidence: ['铜钥匙'],
        sourceStatus: 'current',
      }],
      candidates: [],
      relevanceTerms: [],
      budgetChars: 20,
    })

    expect(finalizedOverBudget.text).toContain('[KB保留] 铜钥匙')
    expect(finalizedOverBudget.omissions).toContainEqual({
      source: 'finalized',
      chapterNumber: 2,
      reason: 'budget',
    })
  })

  it('reports a stale locator without inventing prose when no relevance term matches', () => {
    const bundle = assembleChapterMaterials({
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

  it('omits a finalized source whose receipt validation failed', () => {
    const bundle = assembleChapterMaterials({
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

  it('labels every selected candidate with the exact saved id and version', () => {
    const bundle = assembleChapterMaterials({
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
