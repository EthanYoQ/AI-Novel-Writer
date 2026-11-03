import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { ChapterDeletionService, type ChapterDeletionProjectionCleaner } from '../../services/chapter-deletion-service'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-delete-superseded-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function write(chapterNumber: number, content: string): number {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: countDraftUnits(content) })
}

function finalize(draftId: number, knowledgeDocumentId: string) {
  const draft = DraftRepository.getFull(draftId)!
  const record = FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: draft.chapterNumber,
    chapterTitle: '沉船',
    content: draft.content,
    contentHash: sha256(draft.content),
    contentRevision: 1,
    targetFileName: `第${draft.chapterNumber}章 沉船 ${knowledgeDocumentId}.txt`,
  })
  FinalizationRepository.linkKnowledgeDocument(draftId, knowledgeDocumentId)
  const runId = `finalization:${record.finalizationId}`
  getProjectDb()!.prepare("INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id) VALUES(?,'chapter_finalize',?)").run(runId, runId)
  return record
}

function recordingCleaner(failKnowledge: ReadonlySet<string> = new Set()) {
  const removed = { manuscripts: [] as string[], knowledge: [] as string[] }
  const cleaner: ChapterDeletionProjectionCleaner = {
    async removeManuscript(_root, targetFileName) { removed.manuscripts.push(targetFileName) },
    async removeKnowledgeDocument(_root, documentId) {
      if (failKnowledge.has(documentId)) throw new Error('KB_LOCKED')
      removed.knowledge.push(documentId)
    },
  }
  return { removed, cleaner }
}

function replacedLastChapter() {
  finalize(write(1, '第一章定稿：雾钟。'), 'kb-1')
  const old = write(2, '第二章旧定稿：北堤外的沉船。')
  const oldRecord = finalize(old, 'kb-2-old')
  const current = write(2, '第二章新定稿：沉船在北堤下翻了个身。')
  const currentRecord = finalize(current, 'kb-2-new')
  const working = write(2, '第二章定稿后另起的工作稿。')
  return { old, oldRecord, current, currentRecord, working }
}

describe('删除再定稿过的章节', () => {
  it('同章收据行一起删除，删除收据与清理覆盖每份定稿的实体稿、知识库文档与后处理', async () => {
    const { old, oldRecord, current, currentRecord, working } = replacedLastChapter()
    const { removed, cleaner } = recordingCleaner()
    const service = new ChapterDeletionService({ cleaner, createOperationId: () => 'delete-2' })

    const result = await service.delete(projectRoot, { draftId: current, chapterNumber: 2 })

    const db = getProjectDb()!
    expect({
      result: { success: result.success, status: result.operation?.status },
      drafts: [old, current, working].map(id => DraftRepository.getMeta(id)?.status ?? null),
      receipts: db.prepare('SELECT draft_id, finalization_id FROM chapter_deletion_operations ORDER BY draft_id').all(),
      runs: db.prepare("SELECT id FROM post_process_runs WHERE id LIKE 'finalization:%' ORDER BY id").pluck().all(),
      manuscripts: [...removed.manuscripts].sort(),
      knowledge: [...removed.knowledge].sort(),
      sequence: FinalizedDraftImportRepository.authoritySequence(),
      incomplete: service.listIncomplete(projectRoot),
    }).toMatchObject({
      result: { success: true, status: 'completed' },
      drafts: [null, null, 'draft'],
      receipts: [
        { draft_id: old, finalization_id: oldRecord.finalizationId },
        { draft_id: current, finalization_id: currentRecord.finalizationId },
      ],
      runs: [`finalization:${FinalizationRepository.getByDraftId(1)!.finalizationId}`],
      manuscripts: [oldRecord.targetFileName, currentRecord.targetFileName].sort(),
      knowledge: ['kb-2-new', 'kb-2-old'],
      sequence: { status: 'continuous', nextChapterNumber: 2 },
      incomplete: [],
    })
  })

  it('旧定稿的清理失败时整次删除记为未完成，重试后补完', async () => {
    const { current } = replacedLastChapter()
    const failing = recordingCleaner(new Set(['kb-2-old']))
    const service = new ChapterDeletionService({ cleaner: failing.cleaner, createOperationId: () => 'delete-2' })

    const first = await service.delete(projectRoot, { draftId: current, chapterNumber: 2 })
    const pending = service.listIncomplete(projectRoot).map(operation => operation.operationId)
    const healthy = recordingCleaner()
    const retried = await new ChapterDeletionService({ cleaner: healthy.cleaner }).retry(projectRoot, 'delete-2')

    expect({
      first: { success: first.success, committed: first.committed, status: first.operation?.status },
      pending,
      retried: { success: retried.success, status: retried.operation?.status },
      retriedKnowledge: healthy.removed.knowledge,
    }).toEqual({
      first: { success: false, committed: true, status: 'failed' },
      pending: ['delete-2'],
      retried: { success: true, status: 'completed' },
      retriedKnowledge: ['kb-2-old'],
    })
  })
})
