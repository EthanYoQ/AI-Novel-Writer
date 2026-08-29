import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
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
        wordCount: content.length,
      }],
    })
    const draft = receipt.drafts[0]!

    SummaryRepository.saveFinalizedContinuity({
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterNotes: '情节：怀表停摆；伏笔：表盖内侧刻着陌生坐标。',
    })

    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM blueprints').get())
      .toEqual({ count: 0 })
    expect(SummaryRepository.listFinalizedContinuityBefore(2)).toEqual([{
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterTitle: '午夜怀表',
      chapterNotes: '情节：怀表停摆；伏笔：表盖内侧刻着陌生坐标。',
    }])
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
        wordCount: content.length,
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
