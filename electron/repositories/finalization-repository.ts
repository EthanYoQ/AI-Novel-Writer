import { createHash } from 'node:crypto'
import { getProjectDb } from '../database'
import { countDraftUnits } from '../../src/shared/draft-units'
import { invalidateContinuityProjectionFrom } from './summary-repository'

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

export interface FinalizedDraftExportSnapshot {
  draftId: number
  chapterNumber: number
  version: number
  title: string
  content: string
  finalizationId: string | null
  contentHash: string
}

export type FinalizedDraftExportAuthorityReceipt = ReadonlyArray<Readonly<{
  draftId: number
  chapterNumber: number
  version: number
  finalizationId: string | null
  contentHash: string
}>>

interface FinalizedDraftExportRow {
  draft_id: number
  chapter_number: number
  version: number
  body: string
  finalization_id: string | null
  outbox_chapter_number: number | null
  chapter_title: string | null
  content_hash: string | null
  content_snapshot: string | null
}

interface AuthoritativeFinalizedDraftExport {
  snapshot: FinalizedDraftExportSnapshot
  receipt: FinalizedDraftExportAuthorityReceipt[number]
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

function selectAuthoritativeExportRows(
  rows: readonly FinalizedDraftExportRow[],
): AuthoritativeFinalizedDraftExport[] {
  const selected: AuthoritativeFinalizedDraftExport[] = []
  const selectedVersions = new Map<number, number>()
  for (const row of rows) {
    const selectedVersion = selectedVersions.get(row.chapter_number)
    if (selectedVersion !== undefined) {
      if (selectedVersion === row.version) {
        throw new Error(`第 ${row.chapter_number} 章存在重复定稿版本，无法确定导出正文`)
      }
      continue
    }
    if (
      !Number.isSafeInteger(row.draft_id) || row.draft_id < 1
      || !Number.isSafeInteger(row.chapter_number) || row.chapter_number < 1
      || !Number.isSafeInteger(row.version) || row.version < 1
    ) throw new Error('定稿导出快照身份无效')
    if (typeof row.body !== 'string' || row.body.trim().length === 0) {
      throw new Error(`第 ${row.chapter_number} 章定稿正文为空`)
    }

    const contentHash = createHash('sha256').update(row.body, 'utf8').digest('hex')
    if (row.finalization_id !== null) {
      if (typeof row.finalization_id !== 'string' || row.finalization_id.trim().length === 0) {
        throw new Error('定稿导出快照身份无效')
      }
      if (row.outbox_chapter_number !== row.chapter_number) {
        throw new Error('定稿导出快照身份不一致')
      }
      if (row.content_snapshot !== row.body) {
        throw new Error('定稿导出快照正文不一致')
      }
      if (row.content_hash !== contentHash) {
        throw new Error('定稿导出快照摘要不一致')
      }
    }

    selectedVersions.set(row.chapter_number, row.version)
    const authority = {
      draftId: row.draft_id,
      chapterNumber: row.chapter_number,
      version: row.version,
      finalizationId: row.finalization_id,
      contentHash,
    }
    selected.push({
      receipt: authority,
      snapshot: {
        ...authority,
        title: row.chapter_title?.trim() ?? '',
        content: row.body,
      },
    })
  }
  return selected
}

function readAuthoritativeExportRows(): AuthoritativeFinalizedDraftExport[] {
  const db = requireDatabase()
  return db.transaction(() => selectAuthoritativeExportRows(db.prepare(`
    SELECT drafts.id AS draft_id, drafts.chapter_number, drafts.version,
           contents.body, finalization_outbox.finalization_id,
           finalization_outbox.chapter_number AS outbox_chapter_number,
           finalization_outbox.chapter_title, finalization_outbox.content_hash,
           finalization_outbox.content_snapshot
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.status = 'finalized'
    ORDER BY drafts.chapter_number ASC, drafts.version DESC, drafts.id DESC
  `).all() as FinalizedDraftExportRow[]))()
}

/**
 * 定稿的数据库事实源。正文、字数、定稿状态与发布 outbox 必须由同一个 SQLite
 * transaction 共同提交；任何一个 statement 失败都会回滚其余变化。
 */
export class FinalizationRepository {
  /** One transactionally frozen, highest-version finalized fact per chapter. */
  static listAuthoritativeForExport(): FinalizedDraftExportSnapshot[] {
    return readAuthoritativeExportRows().map(({ snapshot }) => snapshot)
  }

  static matchesAuthoritativeExportReceipt(receipt: FinalizedDraftExportAuthorityReceipt): boolean {
    if (!Array.isArray(receipt)) return false
    const seenChapters = new Set<number>()
    for (const item of receipt) {
      if (
        !item || typeof item !== 'object'
        || !Number.isSafeInteger(item.draftId) || item.draftId < 1
        || !Number.isSafeInteger(item.chapterNumber) || item.chapterNumber < 1
        || !Number.isSafeInteger(item.version) || item.version < 1
        || !(item.finalizationId === null
          || (typeof item.finalizationId === 'string' && item.finalizationId.trim().length > 0))
        || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.contentHash)
        || seenChapters.has(item.chapterNumber)
      ) return false
      seenChapters.add(item.chapterNumber)
    }

    try {
      const current = readAuthoritativeExportRows().map(({ receipt: item }) => item)
      return current.length === receipt.length && current.every((item, index) => (
        item.draftId === receipt[index]?.draftId
        && item.chapterNumber === receipt[index]?.chapterNumber
        && item.version === receipt[index]?.version
        && item.finalizationId === receipt[index]?.finalizationId
        && item.contentHash === receipt[index]?.contentHash
      ))
    } catch {
      return false
    }
  }

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

      const replacesFinalized = db.prepare(`
        SELECT 1 FROM drafts
        WHERE chapter_number = ? AND status = 'finalized' AND id <> ?
        LIMIT 1
      `).get(input.chapterNumber, input.draftId)
      if (replacesFinalized) invalidateContinuityProjectionFrom(db, input.chapterNumber)

      db.prepare('UPDATE contents SET body = ? WHERE id = ?')
        .run(input.content, draft.content_id)
      db.prepare(`
        UPDATE drafts
        SET status = 'finalized', word_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(countDraftUnits(input.content), input.draftId)
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
