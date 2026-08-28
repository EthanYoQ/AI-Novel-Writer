import { getProjectDb } from '../database'
import type {
  ChapterDeletionOperation,
  ChapterDeletionProjectionStatus,
} from '../../src/shared/chapter-deletion'

interface ChapterDeletionRow {
  operation_id: string
  draft_id: number
  chapter_number: number
  chapter_title: string
  finalization_id: string
  target_file_name: string
  knowledge_document_id: string
  post_process_run_ids: string
  manuscript_status: ChapterDeletionProjectionStatus
  manuscript_error: string
  knowledge_status: ChapterDeletionProjectionStatus
  knowledge_error: string
  status: ChapterDeletionOperation['status']
  attempt_count: number
  created_at: string
  updated_at: string
  completed_at: string
}

function requireDatabase() {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function rowToOperation(row: ChapterDeletionRow): ChapterDeletionOperation {
  let postProcessRunIds: string[] = []
  try {
    const parsed = JSON.parse(row.post_process_run_ids)
    if (Array.isArray(parsed)) postProcessRunIds = parsed.filter(value => typeof value === 'string')
  } catch {
    // Frozen cleanup targets are created by this repository. A malformed row
    // remains visible and retryable rather than being used as SQL input.
  }
  return {
    operationId: row.operation_id,
    draftId: row.draft_id,
    chapterNumber: row.chapter_number,
    chapterTitle: row.chapter_title,
    finalizationId: row.finalization_id,
    targetFileName: row.target_file_name,
    knowledgeDocumentId: row.knowledge_document_id,
    postProcessRunIds,
    manuscriptStatus: row.manuscript_status,
    manuscriptError: row.manuscript_error,
    knowledgeStatus: row.knowledge_status,
    knowledgeError: row.knowledge_error,
    status: row.status,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function getRow(operationId: string): ChapterDeletionRow | undefined {
  return requireDatabase().prepare(`
    SELECT * FROM chapter_deletion_operations WHERE operation_id = ?
  `).get(operationId) as ChapterDeletionRow | undefined
}

function refreshAggregateStatus(operationId: string): void {
  const db = requireDatabase()
  const row = getRow(operationId)
  if (!row) throw new Error(`章节删除操作不存在：${operationId}`)
  const finished = (status: ChapterDeletionProjectionStatus) => (
    status === 'completed' || status === 'not_required'
  )
  const status: ChapterDeletionOperation['status'] = (
    finished(row.manuscript_status) && finished(row.knowledge_status)
  ) ? 'completed' : (
    row.manuscript_status === 'failed' || row.knowledge_status === 'failed'
  ) ? 'failed' : 'pending'
  db.prepare(`
    UPDATE chapter_deletion_operations
    SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE '' END,
        updated_at = datetime('now')
    WHERE operation_id = ?
  `).run(status, status, operationId)
}

export class ChapterDeletionRepository {
  static begin(input: {
    operationId: string
    draftId: number
    chapterNumber: number
  }): ChapterDeletionOperation {
    const db = requireDatabase()
    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM chapter_deletion_operations WHERE draft_id = ?
      `).get(input.draftId) as ChapterDeletionRow | undefined
      if (existing) {
        if (existing.chapter_number !== input.chapterNumber) {
          throw new Error('章节删除请求与已冻结操作不匹配')
        }
        return existing.operation_id
      }

      const target = db.prepare(`
        SELECT drafts.id, drafts.chapter_number, drafts.status, drafts.content_id,
               finalization_outbox.finalization_id,
               finalization_outbox.chapter_title,
               finalization_outbox.target_file_name,
               finalization_outbox.knowledge_document_id
        FROM drafts
        LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
        WHERE drafts.id = ?
      `).get(input.draftId) as {
        id: number
        chapter_number: number
        status: string
        content_id: number
        finalization_id: string | null
        chapter_title: string | null
        target_file_name: string | null
        knowledge_document_id: string | null
      } | undefined
      if (!target) throw new Error(`草稿不存在：${input.draftId}`)
      if (target.chapter_number !== input.chapterNumber) {
        throw new Error('草稿与待删除章节身份不匹配')
      }
      if (target.status !== 'finalized' || !target.finalization_id) {
        throw new Error('只有具备定稿提交收据的章节才能通过章节生命周期入口删除')
      }

      const postProcessRows = db.prepare(`
        SELECT id FROM post_process_runs
        WHERE trigger_source_type = 'chapter_finalize' AND trigger_source_id = ?
        ORDER BY id
      `).all(String(input.chapterNumber)) as Array<{ id: string }>
      const postProcessRunIds = postProcessRows.map(row => row.id)
      const contentIds = new Set<number>([target.content_id])
      const revisionContents = db.prepare(`
        SELECT content_id FROM revisions WHERE base_draft_id = ?
      `).all(input.draftId) as Array<{ content_id: number }>
      const reviewContents = db.prepare(`
        SELECT content_id FROM reviews WHERE base_draft_id = ?
      `).all(input.draftId) as Array<{ content_id: number }>
      for (const row of [...revisionContents, ...reviewContents]) contentIds.add(row.content_id)

      db.prepare(`
        INSERT INTO chapter_deletion_operations (
          operation_id, draft_id, chapter_number, chapter_title, finalization_id,
          target_file_name, knowledge_document_id, post_process_run_ids,
          manuscript_status, knowledge_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operationId,
        target.id,
        target.chapter_number,
        target.chapter_title ?? '',
        target.finalization_id,
        target.target_file_name ?? '',
        target.knowledge_document_id ?? '',
        JSON.stringify(postProcessRunIds),
        target.target_file_name ? 'pending' : 'not_required',
        target.knowledge_document_id ? 'pending' : 'not_required',
      )

      for (const runId of postProcessRunIds) {
        db.prepare('DELETE FROM post_process_runs WHERE id = ?').run(runId)
      }
      db.prepare('DELETE FROM drafts WHERE id = ?').run(input.draftId)
      for (const contentId of contentIds) {
        try {
          db.prepare('DELETE FROM contents WHERE id = ?').run(contentId)
        } catch {
          // A content row shared by another still-live fact is not a deletion
          // target. Foreign keys preserve it without weakening this commit.
        }
      }
      return input.operationId
    })

    const operationId = transaction()
    const operation = ChapterDeletionRepository.get(operationId)
    if (!operation) throw new Error(`章节删除操作不存在：${operationId}`)
    return operation
  }

  static get(operationId: string): ChapterDeletionOperation | null {
    const row = getRow(operationId)
    return row ? rowToOperation(row) : null
  }

  static getByDraftId(draftId: number): ChapterDeletionOperation | null {
    const row = requireDatabase().prepare(`
      SELECT * FROM chapter_deletion_operations WHERE draft_id = ?
    `).get(draftId) as ChapterDeletionRow | undefined
    return row ? rowToOperation(row) : null
  }

  static listIncomplete(): ChapterDeletionOperation[] {
    const rows = requireDatabase().prepare(`
      SELECT * FROM chapter_deletion_operations
      WHERE status != 'completed'
      ORDER BY created_at, operation_id
    `).all() as ChapterDeletionRow[]
    return rows.map(rowToOperation)
  }

  static startAttempt(operationId: string): ChapterDeletionOperation {
    const db = requireDatabase()
    const result = db.prepare(`
      UPDATE chapter_deletion_operations
      SET attempt_count = attempt_count + 1, status = 'pending', updated_at = datetime('now')
      WHERE operation_id = ?
    `).run(operationId)
    if (result.changes !== 1) throw new Error(`章节删除操作不存在：${operationId}`)
    return ChapterDeletionRepository.get(operationId)!
  }

  static markProjection(
    operationId: string,
    projection: 'manuscript' | 'knowledge',
    status: Exclude<ChapterDeletionProjectionStatus, 'pending'>,
    error = '',
  ): ChapterDeletionOperation {
    const db = requireDatabase()
    const statusColumn = projection === 'manuscript' ? 'manuscript_status' : 'knowledge_status'
    const errorColumn = projection === 'manuscript' ? 'manuscript_error' : 'knowledge_error'
    const result = db.prepare(`
      UPDATE chapter_deletion_operations
      SET ${statusColumn} = ?, ${errorColumn} = ?, updated_at = datetime('now')
      WHERE operation_id = ?
    `).run(status, error, operationId)
    if (result.changes !== 1) throw new Error(`章节删除操作不存在：${operationId}`)
    refreshAggregateStatus(operationId)
    return ChapterDeletionRepository.get(operationId)!
  }
}
