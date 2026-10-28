import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-duplicate-repair-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function insertLegacyFinalized(id: number, chapterNumber: number, version: number, body: string, receipt = true,
  publication: { status: 'published' | 'pending'; targetFileName?: string } = { status: 'published' }): void {
  const db = getProjectDb()!
  db.prepare('INSERT INTO contents(id, body) VALUES(?, ?)').run(id, body)
  db.prepare("INSERT INTO drafts(id, chapter_number, version, status, content_id, word_count) VALUES(?, ?, ?, 'finalized', ?, 1)")
    .run(id, chapterNumber, version, id)
  if (!receipt) return
  db.prepare(`
    INSERT INTO finalization_outbox(finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, content_snapshot, target_file_name, knowledge_document_id, publication_status)
    VALUES(?, ?, ?, '沉船', ?, 1, ?, ?, ?, ?)
  `).run(`finalization-${id}`, id, chapterNumber, createHash('sha256').update(body).digest('hex'), body,
    publication.targetFileName ?? `第${chapterNumber}章 沉船${id}.txt`, `kb-${id}`, publication.status)
}

const statuses = () => getProjectDb()!.prepare('SELECT id, status FROM drafts ORDER BY id').all()

describe('遗留的同章重复定稿', () => {
  it('打开项目时保留最高版本，其余降为 superseded，列出旧定稿留下的知识库文档与实体稿', () => {
    insertLegacyFinalized(1, 1, 1, '第一章定稿')
    insertLegacyFinalized(2, 2, 1, '第二章旧定稿')
    insertLegacyFinalized(3, 2, 2, '第二章新定稿')
    insertLegacyFinalized(4, 2, 3, '第二章更早写下却版本更高的定稿', false)
    expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({ status: 'invalid', duplicateChapterNumbers: [2] })

    const repair = FinalizationRepository.repairDuplicateFinalizations()

    expect({ repair, statuses: statuses(), sequence: FinalizedDraftImportRepository.authoritySequence() }).toMatchObject({
      repair: { chapters: [{
        chapterNumber: 2,
        keptDraftId: 4,
        keptVersion: 3,
        superseded: [
          { draftId: 3, version: 2, knowledgeDocumentId: 'kb-3', targetFileName: '第2章 沉船3.txt' },
          { draftId: 2, version: 1, knowledgeDocumentId: 'kb-2', targetFileName: '第2章 沉船2.txt' },
        ],
      }] },
      statuses: [
        { id: 1, status: 'finalized' },
        { id: 2, status: 'superseded' },
        { id: 3, status: 'superseded' },
        { id: 4, status: 'finalized' },
      ],
      sequence: { status: 'continuous', nextChapterNumber: 3 },
    })
  })

  it('没发布成功的旧定稿不列实体稿：它的文件名可能已分给保留的那份定稿', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿', true, { status: 'pending', targetFileName: '第1章 沉船.txt' })
    insertLegacyFinalized(2, 1, 2, '第一章新定稿', true, { status: 'published', targetFileName: '第1章 沉船.txt' })

    expect(FinalizationRepository.repairDuplicateFinalizations().chapters).toMatchObject([{
      keptDraftId: 2,
      superseded: [{ draftId: 1, knowledgeDocumentId: 'kb-1', targetFileName: '' }],
    }])
  })

  it('已发布的旧定稿与保留的定稿同名时不列实体稿：那是当前正文文件', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿', true, { status: 'published', targetFileName: '第1章 沉船.txt' })
    insertLegacyFinalized(2, 1, 2, '第一章新定稿', true, { status: 'pending', targetFileName: '第1章 沉船.txt' })
    insertLegacyFinalized(3, 2, 1, '第二章旧定稿', true, { status: 'published', targetFileName: '第2章 灯室.txt' })
    insertLegacyFinalized(4, 2, 2, '第二章新定稿', true, { status: 'published', targetFileName: '第2章 灯室.txt' })

    expect(FinalizationRepository.repairDuplicateFinalizations().chapters).toMatchObject([
      { keptDraftId: 2, superseded: [{ draftId: 1, targetFileName: '' }] },
      { keptDraftId: 4, superseded: [{ draftId: 3, targetFileName: '' }] },
    ])
  })

  it('再打开一次什么也不改', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿')
    insertLegacyFinalized(2, 1, 2, '第一章新定稿')
    FinalizationRepository.repairDuplicateFinalizations()
    const before = statuses()

    expect(FinalizationRepository.repairDuplicateFinalizations()).toEqual({ chapters: [] })
    expect(statuses()).toEqual(before)
  })

  it('修复把旧定稿降级后，从该章起的连续性投影标为过期，和定稿替换同一规则', () => {
    insertLegacyFinalized(1, 1, 1, '第一章定稿')
    insertLegacyFinalized(2, 2, 1, '第二章旧定稿')
    insertLegacyFinalized(3, 2, 2, '第二章新定稿')
    const meta = () => getProjectDb()!.prepare("SELECT generation, stale_from_chapter FROM continuity_projection_meta WHERE id = 'main'").get() as { generation: number; stale_from_chapter: number | null }
    const before = meta().generation

    FinalizationRepository.repairDuplicateFinalizations()

    expect(meta()).toEqual({ generation: before + 1, stale_from_chapter: 2 })
  })

  it('修复失败或还没跑时，只有版本最高的那份定稿算权威，低版本的不能发布', () => {
    insertLegacyFinalized(1, 1, 2, '第一章版本更高的定稿', true, { status: 'pending' })
    insertLegacyFinalized(2, 1, 1, '第一章后写入却版本更低的定稿', true, { status: 'pending' })

    expect([1, 2].map(id => FinalizationRepository.isAuthoritative(id))).toEqual([true, false])
  })
})
