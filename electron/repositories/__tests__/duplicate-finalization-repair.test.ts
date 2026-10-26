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

function insertLegacyFinalized(id: number, chapterNumber: number, version: number, body: string, receipt = true): void {
  const db = getProjectDb()!
  db.prepare('INSERT INTO contents(id, body) VALUES(?, ?)').run(id, body)
  db.prepare("INSERT INTO drafts(id, chapter_number, version, status, content_id, word_count) VALUES(?, ?, ?, 'finalized', ?, 1)")
    .run(id, chapterNumber, version, id)
  if (!receipt) return
  db.prepare(`
    INSERT INTO finalization_outbox(finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, content_snapshot, target_file_name, knowledge_document_id, publication_status)
    VALUES(?, ?, ?, '沉船', ?, 1, ?, ?, ?, 'published')
  `).run(`finalization-${id}`, id, chapterNumber, createHash('sha256').update(body).digest('hex'), body,
    `第${chapterNumber}章 沉船${id}.txt`, `kb-${id}`)
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

  it('再打开一次什么也不改', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿')
    insertLegacyFinalized(2, 1, 2, '第一章新定稿')
    FinalizationRepository.repairDuplicateFinalizations()
    const before = statuses()

    expect(FinalizationRepository.repairDuplicateFinalizations()).toEqual({ chapters: [] })
    expect(statuses()).toEqual(before)
  })
})
