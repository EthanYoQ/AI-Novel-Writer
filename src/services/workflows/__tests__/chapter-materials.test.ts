import { describe, expect, it } from 'vitest'

import { adjacentEvidencePassages, assembleChapterMaterials } from '../chapter-materials'

describe('chapter materials', () => {
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
      references: ['过长可选资料'.repeat(30)],
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
