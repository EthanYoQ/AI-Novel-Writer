import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { SummaryRepository } from '../summary-repository'

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
    }])
  })

  it('replaces the same finalized summary row on retry without duplicating facts', () => {
    const content = '第一章定稿正文。'
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
    })).toThrow(/finalized/u)
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
    })

    expect(SummaryRepository.getLatestSnapshot()).toEqual({
      chapterNumber: 1,
      characterStates: '角色状态仍需保留',
    })
  })
})
