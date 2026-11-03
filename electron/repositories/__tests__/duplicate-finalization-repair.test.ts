import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { PostProcessRepository } from '../post-process-repository'

const LABELS = { remove_replaced_knowledge: '删除旧版本的知识库文档', remove_replaced_manuscripts: '删除旧版本的正文文件' }

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

    const repair = FinalizationRepository.repairDuplicateFinalizations(LABELS)

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

    expect(FinalizationRepository.repairDuplicateFinalizations(LABELS).chapters).toMatchObject([{
      keptDraftId: 2,
      superseded: [{ draftId: 1, knowledgeDocumentId: 'kb-1', targetFileName: '' }],
    }])
  })

  it('已发布的旧定稿与保留的定稿同名时不列实体稿：那是当前正文文件', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿', true, { status: 'published', targetFileName: '第1章 沉船.txt' })
    insertLegacyFinalized(2, 1, 2, '第一章新定稿', true, { status: 'pending', targetFileName: '第1章 沉船.txt' })
    insertLegacyFinalized(3, 2, 1, '第二章旧定稿', true, { status: 'published', targetFileName: '第2章 灯室.txt' })
    insertLegacyFinalized(4, 2, 2, '第二章新定稿', true, { status: 'published', targetFileName: '第2章 灯室.txt' })

    expect(FinalizationRepository.repairDuplicateFinalizations(LABELS).chapters).toMatchObject([
      { keptDraftId: 2, superseded: [{ draftId: 1, targetFileName: '' }] },
      { keptDraftId: 4, superseded: [{ draftId: 3, targetFileName: '' }] },
    ])
  })

  it('再打开一次什么也不改', () => {
    insertLegacyFinalized(1, 1, 1, '第一章旧定稿')
    insertLegacyFinalized(2, 1, 2, '第一章新定稿')
    FinalizationRepository.repairDuplicateFinalizations(LABELS)
    const before = statuses()

    expect(FinalizationRepository.repairDuplicateFinalizations(LABELS)).toEqual({ chapters: [] })
    expect(statuses()).toEqual(before)
  })

  it('修复把旧定稿降级后，从该章起的连续性投影标为过期（定稿替换已不这样做，ADR-0024；遗留修复照旧）', () => {
    insertLegacyFinalized(1, 1, 1, '第一章定稿')
    insertLegacyFinalized(2, 2, 1, '第二章旧定稿')
    insertLegacyFinalized(3, 2, 2, '第二章新定稿')
    const meta = () => getProjectDb()!.prepare("SELECT generation, stale_from_chapter FROM continuity_projection_meta WHERE id = 'main'").get() as { generation: number; stale_from_chapter: number | null }
    const before = meta().generation

    FinalizationRepository.repairDuplicateFinalizations(LABELS)

    expect(meta()).toEqual({ generation: before + 1, stale_from_chapter: 2 })
  })

  describe('旧定稿留下的知识库文档与实体稿接入清理步骤（ADR-0024）', () => {
    /** 保留那份定稿的后处理跑批，与定稿时建的一样按 finalization 记。 */
    function keptRun(draftId: number, chapterNumber: number, body: string): string {
      return PostProcessRepository.createRun({
        triggerSourceType: 'chapter_finalize',
        triggerSourceId: String(chapterNumber),
        sourceLabel: '定稿',
        steps: [{ key: 'kb_import', label: '导入知识库', critical: true }, { key: 'chapter_notes', label: '章节剧情要点', critical: true }],
        finalizedSource: { draftId, finalizationId: `finalization-${draftId}`, chapterNumber, contentHash: createHash('sha256').update(body).digest('hex') },
      })
    }
    const unfinished = (runId: string) => PostProcessRepository.getSteps(runId)
      .map(step => ({ key: step.stepKey, label: step.label, critical: step.critical, ok: step.ok, error: step.errorMsg }))

    it('在保留那份定稿最新的跑批里登记两步清理，记为待清理、不阻断；再打开一次不重复登记', () => {
      insertLegacyFinalized(1, 1, 1, '第一章旧定稿')
      insertLegacyFinalized(2, 1, 2, '第一章新定稿')
      const runId = keptRun(2, 1, '第一章新定稿')

      expect(FinalizationRepository.repairDuplicateFinalizations(LABELS).chapters).toMatchObject([{ keptDraftId: 2, cleanupRegistered: true }])
      FinalizationRepository.repairDuplicateFinalizations(LABELS)

      expect(unfinished(runId).slice(2)).toEqual([
        { key: 'remove_replaced_knowledge', label: '删除旧版本的知识库文档', critical: false, ok: false, error: 'FINALIZATION_REPLACED_CLEANUP_PENDING' },
        { key: 'remove_replaced_manuscripts', label: '删除旧版本的正文文件', critical: false, ok: false, error: 'FINALIZATION_REPLACED_CLEANUP_PENDING' },
      ])
      expect(unfinished(runId)).toHaveLength(4)
    })

    it('只留下知识库文档时只登记删知识库文档那一步', () => {
      insertLegacyFinalized(1, 1, 1, '第一章旧定稿', true, { status: 'pending' })
      insertLegacyFinalized(2, 1, 2, '第一章新定稿')
      const runId = keptRun(2, 1, '第一章新定稿')

      FinalizationRepository.repairDuplicateFinalizations(LABELS)

      expect(unfinished(runId).map(step => step.key)).toEqual(['kb_import', 'chapter_notes', 'remove_replaced_knowledge'])
    })

    it('保留的定稿还没有后处理跑批时不登记，提示照旧说明', () => {
      insertLegacyFinalized(1, 1, 1, '第一章旧定稿')
      insertLegacyFinalized(2, 1, 2, '第一章新定稿')

      expect(FinalizationRepository.repairDuplicateFinalizations(LABELS).chapters).toMatchObject([{ cleanupRegistered: false }])
      expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM post_process_steps').pluck().get()).toBe(0)
    })
  })

  it('修复失败或还没跑时，只有版本最高的那份定稿算权威，低版本的不能发布', () => {
    insertLegacyFinalized(1, 1, 2, '第一章版本更高的定稿', true, { status: 'pending' })
    insertLegacyFinalized(2, 1, 1, '第一章后写入却版本更低的定稿', true, { status: 'pending' })

    expect([1, 2].map(id => FinalizationRepository.isAuthoritative(id))).toEqual([true, false])
  })
})
