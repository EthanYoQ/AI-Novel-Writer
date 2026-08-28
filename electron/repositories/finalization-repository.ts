import { getProjectDb } from '../database'

export type PublicationStatus = 'pending' | 'published'

export interface FinalizationCommitInput {
  finalizationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  contentHash: string
  contentRevision: number
  targetFileName: string
}

export interface FinalizationRecord {
  finalizationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  /** outbox 内冻结的不可变正文；发布和重试绝不回读 contents.body。 */
  contentSnapshot: string
  contentHash: string
  contentRevision: number
  targetFileName: string
  knowledgeDocumentId: string
  publicationStatus: PublicationStatus
  lastError: string
  publishedAt: string | null
}

interface FinalizationRow {
  finalization_id: string
  draft_id: number
  chapter_number: number
  chapter_title: string
  content_hash: string
  content_revision: number
  target_file_name: string
  knowledge_document_id: string
  publication_status: PublicationStatus
  last_error: string
  published_at: string | null
  content_snapshot: string
}

function rowToRecord(row: FinalizationRow): FinalizationRecord {
  return {
    finalizationId: row.finalization_id,
    draftId: row.draft_id,
    chapterNumber: row.chapter_number,
    chapterTitle: row.chapter_title,
    contentSnapshot: row.content_snapshot ?? '',
    contentHash: row.content_hash,
    contentRevision: row.content_revision,
    targetFileName: row.target_file_name,
    knowledgeDocumentId: row.knowledge_document_id ?? '',
    publicationStatus: row.publication_status,
    lastError: row.last_error ?? '',
    publishedAt: row.published_at ?? null,
  }
}

function requireDatabase() {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function hasSameFinalizationInput(
  existing: FinalizationRow,
  input: FinalizationCommitInput,
): boolean {
  return existing.draft_id === input.draftId
    && existing.chapter_number === input.chapterNumber
    && existing.chapter_title === input.chapterTitle
    && existing.content_hash === input.contentHash
    && existing.content_revision === input.contentRevision
    && existing.content_snapshot === input.content
}

/**
 * 定稿的数据库事实源。正文、字数、定稿状态与发布 outbox 必须由同一个 SQLite
 * transaction 共同提交；任何一个 statement 失败都会回滚其余变化。
 */
export class FinalizationRepository {
  static commit(input: FinalizationCommitInput): FinalizationRecord {
    const db = requireDatabase()
    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM finalization_outbox WHERE draft_id = ?
      `).get(input.draftId) as FinalizationRow | undefined
      if (existing) {
        // renderer 可能在主进程已提交而响应丢失后重发同一冻结快照。此时新生成的
        // finalizationId/碰撞候选文件名都不能破坏幂等性，必须返回原提交。
        if (hasSameFinalizationInput(existing, input)) {
          return rowToRecord(existing)
        }
        throw new Error('该草稿已有不可替换的定稿提交')
      }

      const draft = db.prepare(`
        SELECT id, chapter_number, status, content_id FROM drafts WHERE id = ?
      `).get(input.draftId) as {
        id: number
        chapter_number: number
        status: string
        content_id: number
      } | undefined
      if (!draft) throw new Error(`草稿不存在：${input.draftId}`)
      if (draft.chapter_number !== input.chapterNumber) {
        throw new Error('草稿与定稿章节不匹配')
      }
      if (draft.status === 'finalized') {
        throw new Error('草稿已定稿但缺少可恢复发布记录')
      }

      db.prepare('UPDATE contents SET body = ? WHERE id = ?')
        .run(input.content, draft.content_id)
      db.prepare(`
        UPDATE drafts
        SET status = 'finalized', word_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(input.content.length, input.draftId)
      db.prepare(`
        INSERT INTO finalization_outbox (
          finalization_id, draft_id, chapter_number, chapter_title,
          content_hash, content_revision, content_snapshot, target_file_name, publication_status,
          last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '')
      `).run(
        input.finalizationId,
        input.draftId,
        input.chapterNumber,
        input.chapterTitle,
        input.contentHash,
        input.contentRevision,
        input.content,
        input.targetFileName,
      )

      return {
        finalizationId: input.finalizationId,
        draftId: input.draftId,
        chapterNumber: input.chapterNumber,
        chapterTitle: input.chapterTitle,
        contentSnapshot: input.content,
        contentHash: input.contentHash,
        contentRevision: input.contentRevision,
        targetFileName: input.targetFileName,
        knowledgeDocumentId: '',
        publicationStatus: 'pending' as const,
        lastError: '',
        publishedAt: null,
      }
    })
    return transaction()
  }

  static get(finalizationId: string): FinalizationRecord | null {
    const db = requireDatabase()
    const row = db.prepare(`
      SELECT * FROM finalization_outbox WHERE finalization_id = ?
    `).get(finalizationId) as FinalizationRow | undefined
    return row ? rowToRecord(row) : null
  }

  static getByDraftId(draftId: number): FinalizationRecord | null {
    const db = requireDatabase()
    const row = db.prepare(`
      SELECT * FROM finalization_outbox WHERE draft_id = ?
    `).get(draftId) as FinalizationRow | undefined
    return row ? rowToRecord(row) : null
  }

  static linkKnowledgeDocument(draftId: number, documentId: string): FinalizationRecord {
    const normalizedDocumentId = documentId.trim()
    if (!normalizedDocumentId) throw new Error('知识库文档身份不能为空')
    const db = requireDatabase()
    const result = db.prepare(`
      UPDATE finalization_outbox
      SET knowledge_document_id = ?, updated_at = datetime('now')
      WHERE draft_id = ?
    `).run(normalizedDocumentId, draftId)
    if (result.changes !== 1) throw new Error(`草稿缺少定稿提交：${draftId}`)
    const record = FinalizationRepository.getByDraftId(draftId)
    if (!record) throw new Error(`草稿缺少定稿提交：${draftId}`)
    return record
  }

  static markPublicationPending(finalizationId: string, error: string): FinalizationRecord {
    const db = requireDatabase()
    const result = db.prepare(`
      UPDATE finalization_outbox
      SET publication_status = 'pending', last_error = ?, updated_at = datetime('now')
      WHERE finalization_id = ?
    `).run(error, finalizationId)
    if (result.changes !== 1) throw new Error(`定稿提交不存在：${finalizationId}`)
    const record = FinalizationRepository.get(finalizationId)
    if (!record) throw new Error(`定稿提交不存在：${finalizationId}`)
    return record
  }

  static markPublished(finalizationId: string): FinalizationRecord {
    const db = requireDatabase()
    const result = db.prepare(`
      UPDATE finalization_outbox
      SET publication_status = 'published', last_error = '',
          published_at = datetime('now'), updated_at = datetime('now')
      WHERE finalization_id = ?
    `).run(finalizationId)
    if (result.changes !== 1) throw new Error(`定稿提交不存在：${finalizationId}`)
    const record = FinalizationRepository.get(finalizationId)
    if (!record) throw new Error(`定稿提交不存在：${finalizationId}`)
    return record
  }
}
