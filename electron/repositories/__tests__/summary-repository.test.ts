import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { invalidateContinuityProjectionFrom, SummaryRepository } from '../summary-repository'

let projectRoot = ''

function projectionGeneration(): number {
  return (getProjectDb()!.prepare(`
    SELECT generation FROM continuity_projection_meta WHERE id = 'main'
  `).get() as { generation: number }).generation
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-continuity-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('finalized continuity projection', () => {
  it('persists chapter facts against a finalized draft even when no blueprint exists', () => {
    const content = '第一章正文尾声：银色怀表在午夜停摆。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-without-blueprint',
      chapters: [{
        chapterNumber: 1,
        title: '午夜怀表',
        content,
        wordCount: countDraftUnits(content),
      }],
    })
    const draft = receipt.drafts[0]!

    SummaryRepository.saveFinalizedContinuity({
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterNotes: '情节：怀表停摆；伏笔：表盖内侧刻着陌生坐标。',
      projectionGeneration: projectionGeneration(),
      source: {
        draftId: draft.draftId,
        finalizationId: draft.finalizationId,
        chapterNumber: 1,
        contentHash: draft.contentHash,
      },
      facts: [{
        category: 'open-thread',
        entities: ['银色怀表'],
        statement: '怀表表盖内侧有陌生坐标。',
        sourceChapter: 1,
        evidence: '银色怀表在午夜停摆。',
      }],
    })

    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM blueprints').get())
      .toEqual({ count: 0 })
    expect(SummaryRepository.listFinalizedContinuityBefore(2)).toEqual([{
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterTitle: '午夜怀表',
      chapterNotes: '情节：怀表停摆；伏笔：表盖内侧刻着陌生坐标。',
      facts: [{
        category: 'open-thread',
        entities: ['银色怀表'],
        statement: '怀表表盖内侧有陌生坐标。',
        sourceChapter: 1,
        evidence: '银色怀表在午夜停摆。',
      }],
      source: {
        draftId: draft.draftId,
        finalizationId: draft.finalizationId,
        chapterNumber: 1,
        contentHash: draft.contentHash,
      },
      sourceStatus: 'current',
    }])
  })

  it('replaces the same finalized summary row on retry without duplicating facts', () => {
    const content = '第一章定稿正文。林岚把红色钥匙收进口袋。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-retry-same-row',
      chapters: [{ chapterNumber: 1, title: '第一章', content, wordCount: countDraftUnits(content) }],
    })
    const request = {
      draftId: receipt.drafts[0]!.draftId,
      chapterNumber: 1,
      chapterNotes: '林岚已经拿到红色钥匙。',
      projectionGeneration: projectionGeneration(),
      facts: [{
        category: 'character-state' as const,
        entities: ['林岚'],
        statement: '林岚持有红色钥匙。',
        sourceChapter: 1,
        evidence: '林岚把红色钥匙收进口袋。',
      }],
      source: {
        draftId: receipt.drafts[0]!.draftId,
        finalizationId: receipt.drafts[0]!.finalizationId,
        chapterNumber: 1,
        contentHash: receipt.drafts[0]!.contentHash,
      },
    }

    SummaryRepository.saveFinalizedContinuity(request)
    SummaryRepository.saveFinalizedContinuity(request)

    expect(getProjectDb()!.prepare(
      'SELECT COUNT(*) AS count FROM summary_snapshots WHERE draft_id = ?',
    ).get(request.draftId)).toEqual({ count: 1 })
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0]?.facts).toEqual(request.facts)
  })

  it('keeps source-bound character locators idempotent through note retries and history invalidation', () => {
    getProjectDb()!.prepare(
      "INSERT INTO characters (name, role) VALUES ('林岚', 'protagonist')",
    ).run()
    const content = '第二章定稿：林岚抵达新港，随身带着铁罗盘。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-character-candidates',
      chapters: [{ chapterNumber: 2, title: '新港', content, wordCount: countDraftUnits(content) }],
    })
    const draft = receipt.drafts[0]!
    const source = {
      draftId: draft.draftId,
      finalizationId: draft.finalizationId,
      chapterNumber: 2,
      contentHash: draft.contentHash,
    }
    const summaryRequest = {
      draftId: draft.draftId,
      chapterNumber: 2,
      chapterNotes: '本章正文保留角色状态变化原文。',
      facts: [],
      projectionGeneration: projectionGeneration(),
      source,
    }
    const candidateRequest = {
      draftId: draft.draftId,
      chapterNumber: 2,
      candidates: [{ characterName: '林岚', field: 'keyItems' as const, value: '铁罗盘' }],
      projectionGeneration: projectionGeneration(),
      source,
    }

    SummaryRepository.saveFinalizedContinuity(summaryRequest)
    SummaryRepository.saveFinalizedCharacterStateCandidates(candidateRequest)
    SummaryRepository.saveFinalizedCharacterStateCandidates(candidateRequest)
    SummaryRepository.saveFinalizedContinuity(summaryRequest)

    expect(JSON.parse((getProjectDb()!.prepare(
      'SELECT character_state_candidates AS candidates FROM summary_snapshots WHERE draft_id = ?',
    ).get(draft.draftId) as { candidates: string }).candidates)).toHaveLength(1)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      facts: [],
      characterStateCandidates: [{
        characterName: '林岚',
        field: 'keyItems',
        value: '铁罗盘',
      }],
      sourceStatus: 'current',
    })

    SummaryRepository.saveFinalizedCharacterStateCandidates({
      ...candidateRequest,
      candidates: [{ characterName: '林岚', field: 'keyItems', value: '铁制罗盘' }],
    })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]?.characterStateCandidates).toEqual([{
      characterName: '林岚',
      field: 'keyItems',
      value: '铁制罗盘',
    }])

    invalidateContinuityProjectionFrom(getProjectDb()!, 1)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      sourceStatus: 'stale',
      characterStateCandidates: [expect.objectContaining({ characterName: '林岚', field: 'keyItems' })],
    })
    expect(() => SummaryRepository.saveFinalizedCharacterStateCandidates(candidateRequest))
      .toThrow(/失效水位已推进/u)
  })

  it('rejects unbounded or cross-chapter continuity facts', () => {
    const content = '定稿正文。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-invalid-fact',
      chapters: [{ chapterNumber: 1, title: '第一章', content, wordCount: countDraftUnits(content) }],
    })
    const draftId = receipt.drafts[0]!.draftId

    expect(() => SummaryRepository.saveFinalizedContinuity({
      draftId,
      chapterNumber: 1,
      chapterNotes: '连续性要点',
      projectionGeneration: projectionGeneration(),
      source: {
        draftId,
        finalizationId: receipt.drafts[0]!.finalizationId,
        chapterNumber: 1,
        contentHash: receipt.drafts[0]!.contentHash,
      },
      facts: [{
        category: 'plot',
        entities: [],
        statement: 'x'.repeat(281),
        sourceChapter: 2,
        evidence: '短证据',
      }],
    })).toThrow('连续性事实参数无效')
  })

  it('rejects a continuity projection that is not bound to the matching finalized chapter', () => {
    const draftId = getProjectDb()!.prepare(`
      INSERT INTO contents (body) VALUES ('未定稿正文')
    `).run().lastInsertRowid
    const created = getProjectDb()!.prepare(`
      INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
      VALUES (1, 1, 'draft', 'write', ?, 5)
    `).run(draftId)

    expect(() => SummaryRepository.saveFinalizedContinuity({
      draftId: Number(created.lastInsertRowid),
      chapterNumber: 1,
      chapterNotes: '不能持久化',
      projectionGeneration: projectionGeneration(),
      source: {
        draftId: Number(created.lastInsertRowid),
        finalizationId: 'missing-finalization',
        chapterNumber: 1,
        contentHash: '0'.repeat(64),
      },
    })).toThrow(/来源已失效/u)
  })

  it('does not let a continuity projection shadow the latest character-state snapshot', () => {
    SummaryRepository.saveSnapshot(1, '角色状态仍需保留')
    const content = '定稿正文'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-does-not-shadow-character-state',
      chapters: [{
        chapterNumber: 1,
        title: '第一章',
        content,
        wordCount: countDraftUnits(content),
      }],
    })
    SummaryRepository.saveFinalizedContinuity({
      draftId: receipt.drafts[0]!.draftId,
      chapterNumber: 1,
      chapterNotes: '连续性事实',
      projectionGeneration: projectionGeneration(),
      source: {
        draftId: receipt.drafts[0]!.draftId,
        finalizationId: receipt.drafts[0]!.finalizationId,
        chapterNumber: 1,
        contentHash: receipt.drafts[0]!.contentHash,
      },
    })

    expect(SummaryRepository.getLatestSnapshot()).toEqual({
      chapterNumber: 1,
      characterStates: '角色状态仍需保留',
    })
  })

  it('marks an invalidated suffix stale while preserving raw finalized prose for deterministic fallback', () => {
    const content = '林岚在码头拒绝交出铜钥匙。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-watermark',
      chapters: [{ chapterNumber: 2, title: '码头', content, wordCount: countDraftUnits(content) }],
    })
    const draft = receipt.drafts[0]!
    const frozenSource = SummaryRepository.readFinalizedSource(draft.draftId)
    expect(frozenSource.status).toBe('valid')
    if (frozenSource.status !== 'valid') throw new Error('expected valid finalized source')
    const request = {
      draftId: draft.draftId,
      chapterNumber: 2,
      chapterNotes: '派生摘要：铜钥匙未交出。',
      projectionGeneration: frozenSource.snapshot.projectionGeneration,
      facts: [{
        category: 'character-state' as const,
        entities: ['林岚', '铜钥匙'],
        statement: '林岚仍持有铜钥匙。',
        sourceChapter: 2,
        evidence: '林岚在码头拒绝交出铜钥匙。',
      }],
      source: {
        draftId: draft.draftId,
        finalizationId: draft.finalizationId,
        chapterNumber: 2,
        contentHash: draft.contentHash,
      },
    }
    SummaryRepository.saveFinalizedContinuity(request)

    expect(SummaryRepository.readFinalizedSource(draft.draftId)).toEqual({
      status: 'valid',
      snapshot: {
        source: request.source,
        chapterTitle: '码头',
        content,
        projectionGeneration: 0,
      },
    })
    invalidateContinuityProjectionFrom(getProjectDb()!, 1)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]?.sourceStatus).toBe('stale')
    expect(SummaryRepository.readFinalizedSource(draft.draftId)).toMatchObject({
      status: 'valid',
      snapshot: { content },
    })

    expect(() => SummaryRepository.saveFinalizedContinuity({
      ...request,
      chapterNotes: '旧在途结果不应复活。',
    })).toThrow(/失效水位已推进/u)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: '派生摘要：铜钥匙未交出。',
      sourceStatus: 'stale',
    })

    const refreshedSource = SummaryRepository.readFinalizedSource(draft.draftId)
    expect(refreshedSource.status).toBe('valid')
    if (refreshedSource.status !== 'valid') throw new Error('expected refreshed finalized source')
    SummaryRepository.saveFinalizedContinuity({
      ...request,
      chapterNotes: '新水位重新提炼：铜钥匙未交出。',
      projectionGeneration: refreshedSource.snapshot.projectionGeneration,
    })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: '新水位重新提炼：铜钥匙未交出。',
      sourceStatus: 'current',
    })
  })

  it('distinguishes locatable legacy prose from invalid receipt-bound sources', () => {
    const legacyContentId = getProjectDb()!.prepare(
      "INSERT INTO contents (body) VALUES ('旧定稿正文仍可定位。')",
    ).run().lastInsertRowid
    const legacyDraftId = Number(getProjectDb()!.prepare(`
      INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
      VALUES (9, 1, 'finalized', 'write', ?, 10)
    `).run(legacyContentId).lastInsertRowid)

    expect(SummaryRepository.readFinalizedSource(legacyDraftId)).toEqual({
      status: 'legacy',
      draftId: legacyDraftId,
      chapterNumber: 9,
      chapterTitle: '',
      content: '旧定稿正文仍可定位。',
    })

    const receiptContent = '原始定稿正文。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-invalid-source-read',
      chapters: [{
        chapterNumber: 10,
        title: '损坏收据',
        content: receiptContent,
        wordCount: countDraftUnits(receiptContent),
      }],
    })
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox SET content_hash = ? WHERE draft_id = ?
    `).run('0'.repeat(64), receipt.drafts[0]!.draftId)
    expect(SummaryRepository.readFinalizedSource(receipt.drafts[0]!.draftId))
      .toEqual({ status: 'invalid' })
  })

  it('rejects a precise quote that is not present in the frozen finalized source', () => {
    const content = '林岚拒绝交出铜钥匙。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'continuity-quote-boundary',
      chapters: [{ chapterNumber: 1, title: '拒绝', content, wordCount: countDraftUnits(content) }],
    })
    const draft = receipt.drafts[0]!
    expect(() => SummaryRepository.saveFinalizedContinuity({
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterNotes: '摘要可能误读了正文。',
      projectionGeneration: projectionGeneration(),
      facts: [{
        category: 'character-state',
        entities: ['林岚'],
        statement: '林岚交出铜钥匙。',
        sourceChapter: 1,
        evidence: '林岚交出铜钥匙。',
      }],
      source: {
        draftId: draft.draftId,
        finalizationId: draft.finalizationId,
        chapterNumber: 1,
        contentHash: draft.contentHash,
      },
    })).toThrow(/无法在绑定定稿正文中精确定位/u)
  })
})
