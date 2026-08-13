import { createHash } from 'node:crypto'

import type {
  FinalizedDraftImportChapter,
  FinalizedDraftImportDraftReceipt,
  FinalizedDraftImportReceipt,
  FinalizedDraftImportRequest,
} from '../../src/shared/finalized-draft-import'
import { getProjectDb } from '../database'
import { resolveManuscriptTarget } from '../services/manuscript-publisher'

interface ImportOperationRow {
  operation_id: string
  payload_hash: string
  receipt_json: string
}

interface ImportedDraftFactRow {
  draft_id: number
  chapter_number: number
  status: string
  word_count: number
  body: string
  finalization_id: string
  content_hash: string
  content_snapshot: string
  target_file_name: string
  publication_status: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requireNonEmptyOperationId(operationId: string): string {
  const normalized = operationId.trim()
  if (!normalized || normalized.length > 200) {
    throw new Error('定稿导入 operationId 无效')
  }
  return normalized
}

function normalizeChapters(chapters: FinalizedDraftImportChapter[]): FinalizedDraftImportChapter[] {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('定稿导入至少需要一个章节')
  }
  const seen = new Set<number>()
  const normalized = chapters.map((chapter) => {
    if (!Number.isInteger(chapter.chapterNumber) || chapter.chapterNumber < 1) {
      throw new Error('定稿导入章节号必须是唯一正整数')
    }
    if (seen.has(chapter.chapterNumber)) {
      throw new Error(`定稿导入章节号重复：${chapter.chapterNumber}`)
    }
    seen.add(chapter.chapterNumber)
    if (typeof chapter.title !== 'string') {
      throw new Error(`第 ${chapter.chapterNumber} 章标题无效`)
    }
    if (typeof chapter.content !== 'string' || chapter.content.trim().length === 0) {
      throw new Error(`第 ${chapter.chapterNumber} 章正文不能为空`)
    }
    if (!Number.isInteger(chapter.wordCount) || chapter.wordCount !== chapter.content.length) {
      throw new Error(`第 ${chapter.chapterNumber} 章字数与正文不一致`)
    }
    return {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      content: chapter.content,
      wordCount: chapter.wordCount,
    }
  })
  return normalized.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

function requestPayloadHash(operationId: string, chapters: FinalizedDraftImportChapter[]): string {
  return sha256(JSON.stringify({ operationId, chapters }))
}

function finalizationId(operationId: string, chapterNumber: number): string {
  return `import-${sha256(`${operationId}:${chapterNumber}`).slice(0, 32)}`
}

function parseStoredReceipt(row: ImportOperationRow): FinalizedDraftImportReceipt {
  let candidate: unknown
  try {
    candidate = JSON.parse(row.receipt_json)
  } catch {
    throw new Error('定稿导入收据损坏，已拒绝重放')
  }
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('定稿导入收据损坏，已拒绝重放')
  }
  const receipt = candidate as Partial<FinalizedDraftImportReceipt>
  if (
    receipt.operationId !== row.operation_id
    || receipt.payloadHash !== row.payload_hash
    || !Array.isArray(receipt.chapterNumbers)
    || !Array.isArray(receipt.drafts)
    || receipt.chapterNumbers.length !== receipt.drafts.length
  ) {
    throw new Error('定稿导入收据与操作事实不一致，已拒绝重放')
  }
  return receipt as FinalizedDraftImportReceipt
}

function verifyStoredFacts(
  receipt: FinalizedDraftImportReceipt,
  chapters: FinalizedDraftImportChapter[],
): void {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  if (
    receipt.chapterNumbers.length !== chapters.length
    || receipt.drafts.length !== chapters.length
    || receipt.chapterNumbers.some((number, index) => number !== chapters[index].chapterNumber)
  ) {
    throw new Error('定稿导入收据章节覆盖不完整，已拒绝重放')
  }
  for (const [index, draftReceipt] of receipt.drafts.entries()) {
    const chapter = chapters[index]
    if (
      draftReceipt.chapterNumber !== chapter.chapterNumber
      || draftReceipt.status !== 'finalized'
      || draftReceipt.publicationStatus !== 'pending'
      || draftReceipt.contentHash !== sha256(chapter.content)
    ) {
      throw new Error('定稿导入收据内容不一致，已拒绝重放')
    }
    const fact = db.prepare(`
      SELECT drafts.id AS draft_id, drafts.chapter_number, drafts.status, drafts.word_count,
             contents.body, finalization_outbox.finalization_id,
             finalization_outbox.content_hash, finalization_outbox.content_snapshot,
             finalization_outbox.target_file_name, finalization_outbox.publication_status
      FROM drafts
      JOIN contents ON contents.id = drafts.content_id
      JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE drafts.id = ? AND finalization_outbox.finalization_id = ?
    `).get(draftReceipt.draftId, draftReceipt.finalizationId) as ImportedDraftFactRow | undefined
    if (
      !fact
      || fact.chapter_number !== chapter.chapterNumber
      || fact.status !== 'finalized'
      || fact.word_count !== chapter.wordCount
      || fact.body !== chapter.content
      || fact.content_snapshot !== chapter.content
      || fact.content_hash !== draftReceipt.contentHash
      || fact.target_file_name !== draftReceipt.targetFileName
      || fact.publication_status !== 'pending'
    ) {
      throw new Error('定稿导入已提交事实缺失或漂移，已拒绝重放')
    }
  }
}

/**
 * 导入小说的不可分割数据库提交：正文、finalized 草稿与发布 outbox 要么全部
 * 成功，要么全部回滚。operationId 只允许重放完全相同的规范化载荷。
 */
export class FinalizedDraftImportRepository {
  static commit(projectRoot: string, request: FinalizedDraftImportRequest): FinalizedDraftImportReceipt {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const operationId = requireNonEmptyOperationId(request.operationId)
    const chapters = normalizeChapters(request.chapters)
    const payloadHash = requestPayloadHash(operationId, chapters)

    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT operation_id, payload_hash, receipt_json
        FROM finalized_draft_import_operations
        WHERE operation_id = ?
      `).get(operationId) as ImportOperationRow | undefined
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new Error('定稿导入 operationId 已绑定不同载荷')
        }
        const receipt = parseStoredReceipt(existing)
        verifyStoredFacts(receipt, chapters)
        return { ...receipt, idempotent: true }
      }

      const drafts: FinalizedDraftImportDraftReceipt[] = []
      for (const chapter of chapters) {
        const versionRow = db.prepare(`
          SELECT MAX(version) AS max_version FROM drafts WHERE chapter_number = ?
        `).get(chapter.chapterNumber) as { max_version: number | null }
        const contentResult = db.prepare('INSERT INTO contents (body) VALUES (?)').run(chapter.content)
        const contentId = Number(contentResult.lastInsertRowid)
        const draftResult = db.prepare(`
          INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
          VALUES (?, ?, 'finalized', 'write', ?, ?)
        `).run(
          chapter.chapterNumber,
          (versionRow.max_version ?? 0) + 1,
          contentId,
          chapter.wordCount,
        )
        const draftId = Number(draftResult.lastInsertRowid)
        const frozenContentHash = sha256(chapter.content)
        const frozenFinalizationId = finalizationId(operationId, chapter.chapterNumber)
        const target = resolveManuscriptTarget({
          projectRoot,
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.title,
          finalizationId: frozenFinalizationId,
        })
        db.prepare(`
          INSERT INTO finalization_outbox (
            finalization_id, draft_id, chapter_number, chapter_title,
            content_hash, content_revision, content_snapshot, target_file_name,
            publication_status, last_error
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'pending', '')
        `).run(
          frozenFinalizationId,
          draftId,
          chapter.chapterNumber,
          chapter.title,
          frozenContentHash,
          chapter.content,
          target.fileName,
        )
        drafts.push({
          chapterNumber: chapter.chapterNumber,
          draftId,
          finalizationId: frozenFinalizationId,
          contentHash: frozenContentHash,
          targetFileName: target.fileName,
          status: 'finalized',
          publicationStatus: 'pending',
        })
      }

      const receipt: FinalizedDraftImportReceipt = {
        operationId,
        payloadHash,
        chapterNumbers: chapters.map(chapter => chapter.chapterNumber),
        drafts,
        idempotent: false,
      }
      db.prepare(`
        INSERT INTO finalized_draft_import_operations (operation_id, payload_hash, receipt_json)
        VALUES (?, ?, ?)
      `).run(operationId, payloadHash, JSON.stringify(receipt))
      return receipt
    })
    return transaction()
  }
}
