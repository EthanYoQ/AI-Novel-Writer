import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { invalidateContinuityProjectionFrom, SummaryRepository } from '../summary-repository'

let projectRoot = ''

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
    const request = {
      draftId: draft.draftId,
      chapterNumber: 2,
      chapterNotes: '派生摘要：铜钥匙未交出。',
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
      source: request.source,
      chapterTitle: '码头',
      content,
    })
    invalidateContinuityProjectionFrom(getProjectDb()!, 1)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]?.sourceStatus).toBe('stale')
    expect(SummaryRepository.readFinalizedSource(draft.draftId)?.content).toBe(content)

    SummaryRepository.saveFinalizedContinuity(request)
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]?.sourceStatus).toBe('current')
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
