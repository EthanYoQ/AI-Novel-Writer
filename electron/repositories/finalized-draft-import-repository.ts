import { createHash } from 'node:crypto'

import type {
  FinalizedDraftImportChapter,
  FinalizedDraftImportDraftReceipt,
  FinalizedDraftImportReceipt,
  FinalizedDraftImportRequest,
} from '../../src/shared/finalized-draft-import'
import type {
  AuthorManuscriptImportPreview,
  AuthoritativeChapterSequence,
} from '../../src/shared/author-manuscript-import'
import { getProjectDb } from '../database'
import {
  countDraftUnits,
  countLegacyDraftUnitsV1,
} from '../../src/shared/draft-units'
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

interface AuthorityRow {
  draft_id: number
  chapter_number: number
  version: number
  title: string | null
  body: string
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
    if (!Number.isInteger(chapter.wordCount) || chapter.wordCount !== countDraftUnits(chapter.content)) {
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

function requestPayloadHash(request: FinalizedDraftImportRequest, chapters: FinalizedDraftImportChapter[]): string {
  if (
    request.expectedAuthorityFingerprint === undefined
    && request.expectedManifestFingerprint === undefined
    && request.expectedCommitManifestFingerprint === undefined
  ) return sha256(JSON.stringify({ operationId: request.operationId, chapters }))
  if (request.expectedCommitManifestFingerprint === undefined) {
    return sha256(JSON.stringify({
      operationId: request.operationId,
      expectedAuthorityFingerprint: request.expectedAuthorityFingerprint ?? null,
      expectedManifestFingerprint: request.expectedManifestFingerprint ?? null,
      chapters,
    }))
  }
  return sha256(JSON.stringify({
    operationId: request.operationId,
    expectedAuthorityFingerprint: request.expectedAuthorityFingerprint ?? null,
    expectedManifestFingerprint: request.expectedManifestFingerprint ?? null,
    expectedCommitManifestFingerprint: request.expectedCommitManifestFingerprint ?? null,
    chapters,
  }))
}

function requestPayloadHashCandidates(
  request: FinalizedDraftImportRequest,
  chapters: FinalizedDraftImportChapter[],
): ReadonlySet<string> {
  const candidates = new Set<string>([requestPayloadHash(request, chapters)])
  const legacyCounters = [
    countLegacyDraftUnitsV1,
    (content: string) => content.length,
  ] as const
  for (const count of legacyCounters) {
    candidates.add(requestPayloadHash(request, chapters.map(chapter => ({
      ...chapter,
      wordCount: count(chapter.content),
    }))))
  }
  return candidates
}

function manifestFingerprint(chapters: FinalizedDraftImportChapter[]): string {
  return sha256(JSON.stringify(chapters.map(chapter => ({
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    contentHash: sha256(chapter.content),
    wordCount: chapter.wordCount,
  }))))
}

function authorityRows(): AuthorityRow[] {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current.prepare(`
    SELECT drafts.id AS draft_id, drafts.chapter_number, drafts.version,
           contents.body,
           (SELECT chapter_title FROM finalization_outbox WHERE draft_id = drafts.id) AS title
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    WHERE drafts.status = 'finalized'
    ORDER BY drafts.chapter_number ASC, drafts.version ASC, drafts.id ASC
  `).all() as AuthorityRow[]
}

function authorityFingerprint(rows: AuthorityRow[]): string {
  return sha256(JSON.stringify(rows.map(row => ({
    draftId: row.draft_id,
    chapterNumber: row.chapter_number,
    version: row.version,
    bodyHash: sha256(row.body),
  }))))
}

function sequenceFromRows(rows: AuthorityRow[]): AuthoritativeChapterSequence {
  const fingerprint = authorityFingerprint(rows)
  if (rows.length === 0) {
    return {
      status: 'empty',
      lastChapterNumber: 0,
      nextChapterNumber: 1,
      duplicateChapterNumbers: [],
      authorityFingerprint: fingerprint,
    }
  }
  const counts = new Map<number, number>()
  for (const row of rows) counts.set(row.chapter_number, (counts.get(row.chapter_number) ?? 0) + 1)
  const duplicateChapterNumbers = [...counts]
    .filter(([, count]) => count > 1)
    .map(([chapterNumber]) => chapterNumber)
  const maxChapter = Math.max(...rows.map(row => row.chapter_number))
  let firstGapChapterNumber: number | undefined
  for (let chapterNumber = 1; chapterNumber <= maxChapter; chapterNumber += 1) {
    if (!counts.has(chapterNumber)) {
      firstGapChapterNumber = chapterNumber
      break
    }
  }
  if (duplicateChapterNumbers.length > 0 || firstGapChapterNumber !== undefined) {
    return {
      status: 'invalid',
      lastChapterNumber: maxChapter,
      ...(firstGapChapterNumber === undefined ? {} : { firstGapChapterNumber }),
      duplicateChapterNumbers,
      authorityFingerprint: fingerprint,
    }
  }
  return {
    status: 'continuous',
    lastChapterNumber: maxChapter,
    nextChapterNumber: maxChapter + 1,
    duplicateChapterNumbers: [],
    authorityFingerprint: fingerprint,
  }
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
      || (fact.publication_status !== 'pending' && fact.publication_status !== 'published')
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
  static authoritySequence(): AuthoritativeChapterSequence {
    return sequenceFromRows(authorityRows())
  }

  static getCommittedOperation(
    operationId: string,
    input: FinalizedDraftImportChapter[],
  ): FinalizedDraftImportReceipt | null {
    const current = getProjectDb()
    if (!current) throw new Error('项目数据库未打开')
    const normalizedOperationId = requireNonEmptyOperationId(operationId)
    const chapters = normalizeChapters(input)
    const row = current.prepare(`
      SELECT operation_id, payload_hash, receipt_json
      FROM finalized_draft_import_operations
      WHERE operation_id = ?
    `).get(normalizedOperationId) as ImportOperationRow | undefined
    if (!row) return null
    const receipt = parseStoredReceipt(row)
    verifyStoredFacts(receipt, chapters)
    return receipt
  }

  static preview(input: FinalizedDraftImportChapter[]): AuthorManuscriptImportPreview {
    const chapters = normalizeChapters(input)
    const rows = authorityRows()
    const sequence = sequenceFromRows(rows)
    const existingByChapter = new Map(rows.map(row => [row.chapter_number, row]))
    const conflictChapterNumbers: number[] = []
    const duplicateChapterNumbers: number[] = []
    const newChapterNumbers: number[] = []
    const previewChapters = chapters.map(chapter => {
      const existing = existingByChapter.get(chapter.chapterNumber)
      if (!existing) {
        newChapterNumbers.push(chapter.chapterNumber)
        return {
          number: chapter.chapterNumber,
          title: chapter.title,
          wordCount: chapter.wordCount,
          disposition: 'new' as const,
        }
      }
      if (
        sha256(existing.body) === sha256(chapter.content)
        && (existing.title === null || existing.title === chapter.title)
      ) {
        duplicateChapterNumbers.push(chapter.chapterNumber)
        return {
          number: chapter.chapterNumber,
          title: chapter.title,
          wordCount: chapter.wordCount,
          disposition: 'duplicate' as const,
        }
      }
      conflictChapterNumbers.push(chapter.chapterNumber)
      return {
        number: chapter.chapterNumber,
        title: chapter.title,
        wordCount: chapter.wordCount,
        disposition: 'conflict' as const,
      }
    })

    const expectedNext = sequence.nextChapterNumber
    let candidateGap: number | undefined
    if (expectedNext !== undefined && newChapterNumbers.length > 0) {
      const ordered = [...newChapterNumbers].sort((left, right) => left - right)
      let expected = expectedNext
      for (const chapterNumber of ordered) {
        if (chapterNumber !== expected) {
          candidateGap = expected
          break
        }
        expected += 1
      }
    }
    const authorityInvalid = sequence.status === 'invalid'
    const classification = authorityInvalid || conflictChapterNumbers.length > 0 || candidateGap !== undefined
      ? 'conflict'
      : newChapterNumbers.length === 0
        ? 'exact-duplicate'
        : 'ready'
    const nextChapterNumber = classification === 'conflict'
      ? undefined
      : (sequence.lastChapterNumber + newChapterNumbers.length + 1)
    return {
      classification,
      authorityFingerprint: sequence.authorityFingerprint,
      manifestFingerprint: manifestFingerprint(chapters),
      chapterCount: chapters.length,
      targetStatus: 'finalized',
      ...(nextChapterNumber === undefined ? {} : { nextChapterNumber }),
      chapters: previewChapters,
      newChapterNumbers,
      duplicateChapterNumbers,
      conflictChapterNumbers,
      ...((sequence.firstGapChapterNumber ?? candidateGap) === undefined
        ? {}
        : { firstGapChapterNumber: sequence.firstGapChapterNumber ?? candidateGap }),
      authorityInvalid,
    }
  }

  static commit(projectRoot: string, request: FinalizedDraftImportRequest): FinalizedDraftImportReceipt {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const operationId = requireNonEmptyOperationId(request.operationId)
    const chapters = normalizeChapters(request.chapters)
    const normalizedRequest = { ...request, operationId }
    const payloadHash = requestPayloadHash(normalizedRequest, chapters)
    const acceptedPayloadHashes = requestPayloadHashCandidates(normalizedRequest, chapters)

    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT operation_id, payload_hash, receipt_json
        FROM finalized_draft_import_operations
        WHERE operation_id = ?
      `).get(operationId) as ImportOperationRow | undefined
      if (existing) {
        if (!acceptedPayloadHashes.has(existing.payload_hash)) {
          throw new Error('定稿导入 operationId 已绑定不同载荷')
        }
        const receipt = parseStoredReceipt(existing)
        verifyStoredFacts(receipt, chapters)
        return { ...receipt, idempotent: true }
      }

      const expectedCommitManifestFingerprint = request.expectedCommitManifestFingerprint
        ?? request.expectedManifestFingerprint
      if (expectedCommitManifestFingerprint !== undefined) {
        if (expectedCommitManifestFingerprint !== manifestFingerprint(chapters)) {
          throw new Error('原稿清单与已确认预览不一致，预览已过期')
        }
      }
      if (request.expectedAuthorityFingerprint !== undefined) {
        const currentAuthority = sequenceFromRows(authorityRows()).authorityFingerprint
        if (request.expectedAuthorityFingerprint !== currentAuthority) {
          throw new Error('项目权威章节已变化，原稿预览已过期')
        }
        const preview = this.preview(chapters)
        if (preview.classification !== 'ready') {
          throw new Error('原稿章节不能形成连续且无冲突的权威正文')
        }
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
