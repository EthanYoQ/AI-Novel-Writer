import { getCurrentProjectPath, getProjectDb } from '../database'
import { readPortableRuntimeFreeze } from '../services/portable-runtime-freeze'
import { countDraftUnits } from '../../src/shared/draft-units'
import { WORKING_DRAFT_STATUS_SQL } from '../../src/shared/draft-status'
import { CHAPTER_RESTORED_REPROJECTION_PENDING } from '../../src/shared/finalization-step-error'
import { DraftRepository } from './draft-repository'
import { FinalizationRepository } from './finalization-repository'
import { PostProcessRepository } from './post-process-repository'
import type {
  ChapterDeletionOperation,
  ChapterDeletionProjectionStatus,
  ChapterRestoreMode,
  DamagedTrashEntry,
  RestoreTrashedChapterRequest,
  RestoreTrashedChapterResult,
  TrashedChapter,
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
  legacy_knowledge_authorization: ChapterDeletionOperation['legacyKnowledgeAuthorization']
  legacy_knowledge_authorized_at: string
  status: ChapterDeletionOperation['status']
  attempt_count: number
  created_at: string
  updated_at: string
  completed_at: string
}

interface FinalizedChapterTarget {
  id: number
  chapter_number: number
  status: string
  content_id: number
  finalization_id: string
  chapter_title: string | null
  target_file_name: string | null
  knowledge_document_id: string | null
}

function requireDatabase() {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db
}

function parsePostProcessRunIds(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(candidate => typeof candidate === 'string')
      ? parsed
      : null
  } catch {
    return null
  }
}

function requireFinalizedTarget(
  db: ReturnType<typeof requireDatabase>,
  draftId: number,
  chapterNumber: number,
): FinalizedChapterTarget {
  const target = db.prepare(`
    SELECT drafts_all.id, drafts_all.chapter_number, drafts_all.status, drafts_all.content_id,
           finalization_outbox_all.finalization_id,
           finalization_outbox_all.chapter_title,
           finalization_outbox_all.target_file_name,
           finalization_outbox_all.knowledge_document_id
    FROM drafts_all
    LEFT JOIN finalization_outbox_all ON finalization_outbox_all.draft_id = drafts_all.id
    WHERE drafts_all.id = ?
  `).get(draftId) as (Omit<FinalizedChapterTarget, 'finalization_id'> & {
    finalization_id: string | null
  }) | undefined
  if (!target) throw new Error('DRAFT_NOT_FOUND')
  if (target.chapter_number !== chapterNumber) throw new Error('CHAPTER_DELETE_TARGET_MISMATCH')
  if (target.status !== 'finalized' || !target.finalization_id) {
    throw new Error('CHAPTER_DELETE_NOT_FINALIZED')
  }
  return target as FinalizedChapterTarget
}

function listPostProcessRunIds(
  db: ReturnType<typeof requireDatabase>,
  chapterNumber: number,
  finalizationId: string,
): string[] {
  const rows = db.prepare(`
    SELECT id FROM post_process_runs
    WHERE trigger_source_type = 'chapter_finalize' AND trigger_source_id IN (?, ?)
    ORDER BY id
  `).all(String(chapterNumber), `finalization:${finalizationId}`) as Array<{ id: string }>
  return rows.map(row => row.id)
}

const SUPERSEDED_SUFFIX = ':superseded:'

function companionOperationId(operationId: string, draftId: number): string {
  return `${operationId}${SUPERSEDED_SUFFIX}${draftId}`
}

function primaryOperationId(operationId: string): string {
  const index = operationId.indexOf(SUPERSEDED_SUFFIX)
  return index < 0 ? operationId : operationId.slice(0, index)
}

function companionRows(db: ReturnType<typeof requireDatabase>, operationId: string): ChapterDeletionRow[] {
  const prefix = `${operationId}${SUPERSEDED_SUFFIX}`
  return db.prepare(`
    SELECT * FROM chapter_deletion_operations
    WHERE substr(operation_id, 1, length(?)) = ?
    ORDER BY draft_id
  `).all(prefix, prefix) as ChapterDeletionRow[]
}

/**
 * 删除把本章的定稿和全部被替换的旧定稿原地置为 deleted，进回收站（ADR-0025）。不推连续性水位：
 * 后面各章的要点照常可信，被删章自己的要点与派生物经视图排除。按章号登记的旧后处理记录改记到这份定稿下，
 * 否则缺口期间按章号找「最新后处理」会找到被删的那一份。
 */
function moveChapterToTrash(
  db: ReturnType<typeof requireDatabase>,
  operationId: string,
  target: FinalizedChapterTarget,
  postProcessRunIds: readonly string[],
): void {
  const superseded = db.prepare(`
    SELECT drafts_all.id, drafts_all.content_id,
           finalization_outbox_all.finalization_id, finalization_outbox_all.chapter_title,
           finalization_outbox_all.target_file_name, finalization_outbox_all.knowledge_document_id
    FROM drafts_all
    LEFT JOIN finalization_outbox_all ON finalization_outbox_all.draft_id = drafts_all.id
    WHERE drafts_all.chapter_number = ? AND drafts_all.status = 'superseded'
    ORDER BY drafts_all.id
  `).all(target.chapter_number) as Array<{
    id: number
    content_id: number
    finalization_id: string | null
    chapter_title: string | null
    target_file_name: string | null
    knowledge_document_id: string | null
  }>
  for (const row of superseded) {
    const runIds = row.finalization_id
      ? (db.prepare(`
          SELECT id FROM post_process_runs
          WHERE trigger_source_type = 'chapter_finalize' AND trigger_source_id = ?
          ORDER BY id
        `).all(`finalization:${row.finalization_id}`) as Array<{ id: string }>).map(run => run.id)
      : []
    const manuscriptStatus = row.target_file_name ? 'pending' : 'not_required'
    const knowledgeStatus = row.knowledge_document_id ? 'pending' : 'not_required'
    const finished = manuscriptStatus === 'not_required' && knowledgeStatus === 'not_required'
    db.prepare(`
      INSERT INTO chapter_deletion_operations (
        operation_id, draft_id, chapter_number, chapter_title, finalization_id,
        target_file_name, knowledge_document_id, post_process_run_ids,
        manuscript_status, knowledge_status, legacy_knowledge_authorization, status, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_required', ?, CASE WHEN ? THEN datetime('now') ELSE '' END)
    `).run(
      companionOperationId(operationId, row.id),
      row.id,
      target.chapter_number,
      row.chapter_title ?? '',
      row.finalization_id ?? '',
      row.target_file_name ?? '',
      row.knowledge_document_id ?? '',
      JSON.stringify(runIds),
      manuscriptStatus,
      knowledgeStatus,
      finished ? 'completed' : 'pending',
      finished ? 1 : 0,
    )
  }
  const rekey = db.prepare(`
    UPDATE post_process_runs SET trigger_source_id = ?
    WHERE id = ? AND trigger_source_type = 'chapter_finalize' AND trigger_source_id = ?
  `)
  for (const runId of postProcessRunIds) rekey.run(`finalization:${target.finalization_id}`, runId, String(target.chapter_number))
  const moved = db.prepare(`
    UPDATE drafts_all
    SET status = 'deleted', deletion_id = ?, deleted_from_status = status, deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE chapter_number = ? AND (id = ? OR status = 'superseded')
  `).run(operationId, target.chapter_number, target.id)
  if (moved.changes !== superseded.length + 1) throw new Error('CHAPTER_DELETE_SOURCE_CHANGED')
}

interface TrashRow {
  id: number
  deletion_id: string
  chapter_number: number
  deleted_from_status: string
  deleted_at: string
  word_count: number
  content_id: number
  finalization_id: string | null
  chapter_title: string | null
}

const TRASH_ROWS_SQL = `
  SELECT d.id, d.deletion_id, d.chapter_number, d.deleted_from_status, d.deleted_at, d.word_count, d.content_id,
         o.finalization_id, o.chapter_title
  FROM drafts_all d LEFT JOIN finalization_outbox_all o ON o.draft_id = d.id
  WHERE d.status = 'deleted'`

function restoreModeOf(
  db: ReturnType<typeof requireDatabase>,
  chapterNumber: number,
  finalizationId: string,
): ChapterRestoreMode {
  if (db.prepare("SELECT 1 FROM drafts WHERE chapter_number = ? AND status = 'finalized'").get(chapterNumber)) return 'as-history'
  return readPortableRuntimeFreeze(getCurrentProjectPath()).isFrozen('finalization_outbox', finalizationId)
    ? 'reopen-as-draft'
    : 'into-gap'
}

/** 一次删除带走的行收成回收站的一项；行不成形时抛错，由调用方决定是单列这一项还是拒绝。 */
function trashEntryOf(db: ReturnType<typeof requireDatabase>, deletionId: string, rows: readonly TrashRow[]): TrashedChapter {
  const primaries = rows.filter(row => row.deleted_from_status === 'finalized')
  const primary = primaries[0]
  if (primaries.length !== 1 || !primary?.finalization_id
    || rows.some(row => row.chapter_number !== primary.chapter_number)) throw new Error('CHAPTER_TRASH_ENTRY_INVALID')
  const receipt = getRow(deletionId)
  if (!receipt || receipt.draft_id !== primary.id) throw new Error('CHAPTER_TRASH_RECEIPT_MISSING')
  return {
    deletionId,
    draftId: primary.id,
    chapterNumber: primary.chapter_number,
    chapterTitle: primary.chapter_title ?? '',
    deletedAt: primary.deleted_at,
    wordCount: primary.word_count,
    versionCount: rows.length,
    cleanup: receipt.status,
    restoreMode: restoreModeOf(db, primary.chapter_number, primary.finalization_id),
  }
}

function deleteDraftFacts(
  db: ReturnType<typeof requireDatabase>,
  draftId: number,
  draftContentId: number,
  postProcessRunIds: readonly string[],
): void {
  const contentIds = new Set<number>([draftContentId])
  const revisionContents = db.prepare(`
    SELECT content_id FROM revisions WHERE base_draft_id = ?
  `).all(draftId) as Array<{ content_id: number }>
  const reviewContents = db.prepare(`
    SELECT content_id FROM reviews WHERE base_draft_id = ?
  `).all(draftId) as Array<{ content_id: number }>
  for (const row of [...revisionContents, ...reviewContents]) contentIds.add(row.content_id)

  for (const runId of postProcessRunIds) {
    db.prepare('DELETE FROM post_process_runs WHERE id = ?').run(runId)
  }
  db.prepare('DELETE FROM drafts_all WHERE id = ?').run(draftId)
  for (const contentId of contentIds) {
    try {
      db.prepare('DELETE FROM contents WHERE id = ?').run(contentId)
    } catch {
      // A content row shared by another still-live fact is not a deletion
      // target. Foreign keys preserve it without weakening this commit.
    }
  }
}

function rowToOperation(row: ChapterDeletionRow): ChapterDeletionOperation {
  const postProcessRunIds = parsePostProcessRunIds(row.post_process_run_ids) ?? []
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
    legacyKnowledgeAuthorization: row.legacy_knowledge_authorization,
    legacyKnowledgeAuthorizedAt: row.legacy_knowledge_authorized_at,
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

function aggregateStatus(rows: readonly ChapterDeletionRow[]): ChapterDeletionOperation['status'] {
  const projections = rows.flatMap(row => [row.manuscript_status, row.knowledge_status])
  if (projections.every(status => status === 'completed' || status === 'not_required')) return 'completed'
  return projections.includes('failed') ? 'failed' : 'pending'
}

function refreshAggregateStatus(operationId: string): void {
  const db = requireDatabase()
  const primaryId = primaryOperationId(operationId)
  const ids = primaryId === operationId ? [operationId] : [operationId, primaryId]
  for (const id of ids) {
    const row = getRow(id)
    if (!row) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
    const status = aggregateStatus(id === primaryId ? [row, ...companionRows(db, id)] : [row])
    db.prepare(`
      UPDATE chapter_deletion_operations
      SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE '' END,
          updated_at = datetime('now')
      WHERE operation_id = ?
    `).run(status, status, id)
  }
}

export class ChapterDeletionRepository {
  static begin(input: {
    operationId: string
    draftId: number
    chapterNumber: number
    legacyKnowledgeAuthorizationRequired?: boolean
  }): ChapterDeletionOperation {
    const db = requireDatabase()
    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM chapter_deletion_operations WHERE draft_id = ?
      `).get(input.draftId) as ChapterDeletionRow | undefined
      if (existing) {
        if (existing.chapter_number !== input.chapterNumber) {
          throw new Error('CHAPTER_DELETE_REQUEST_MISMATCH')
        }
        return existing.operation_id
      }

      const target = requireFinalizedTarget(db, input.draftId, input.chapterNumber)
      const postProcessRunIds = listPostProcessRunIds(db, input.chapterNumber, target.finalization_id)

      db.prepare(`
        INSERT INTO chapter_deletion_operations (
          operation_id, draft_id, chapter_number, chapter_title, finalization_id,
          target_file_name, knowledge_document_id, post_process_run_ids,
          manuscript_status, knowledge_status, legacy_knowledge_authorization, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.legacyKnowledgeAuthorizationRequired || target.knowledge_document_id
          ? 'pending'
          : 'not_required',
        input.legacyKnowledgeAuthorizationRequired ? 'required' : 'not_required',
        input.legacyKnowledgeAuthorizationRequired ? 'authorization_required' : 'pending',
      )

      if (input.legacyKnowledgeAuthorizationRequired) return input.operationId
      moveChapterToTrash(db, input.operationId, target, postProcessRunIds)
      return input.operationId
    })

    const operationId = transaction()
    const operation = ChapterDeletionRepository.get(operationId)
    if (!operation) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
    return operation
  }

  static confirmLegacyKnowledgeAbsent(operationId: string): ChapterDeletionOperation {
    const db = requireDatabase()
    const transaction = db.transaction(() => {
      const row = db.prepare(`
        SELECT * FROM chapter_deletion_operations WHERE operation_id = ?
      `).get(operationId) as ChapterDeletionRow | undefined
      if (!row) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
      if (
        row.status !== 'authorization_required'
        || row.legacy_knowledge_authorization !== 'required'
      ) {
        throw new Error('CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED')
      }

      const target = requireFinalizedTarget(db, row.draft_id, row.chapter_number)
      if (
        target.finalization_id !== row.finalization_id
        || (target.chapter_title ?? '') !== row.chapter_title
        || (target.target_file_name ?? '') !== row.target_file_name
        || (target.knowledge_document_id ?? '') !== ''
      ) {
        throw new Error('CHAPTER_DELETE_SOURCE_CHANGED')
      }

      const frozenRunIds = parsePostProcessRunIds(row.post_process_run_ids)
      if (!frozenRunIds) throw new Error('CHAPTER_DELETE_RECEIPT_CORRUPT')
      const currentRunIds = listPostProcessRunIds(db, row.chapter_number, row.finalization_id)
      if (JSON.stringify(currentRunIds) !== JSON.stringify(frozenRunIds)) {
        throw new Error('CHAPTER_DELETE_SOURCE_CHANGED')
      }

      const updated = db.prepare(`
        UPDATE chapter_deletion_operations
        SET legacy_knowledge_authorization = 'consumed',
            legacy_knowledge_authorized_at = datetime('now'),
            knowledge_status = 'not_required', knowledge_error = '',
            status = 'pending', updated_at = datetime('now')
        WHERE operation_id = ?
          AND status = 'authorization_required'
          AND legacy_knowledge_authorization = 'required'
      `).run(operationId)
      if (updated.changes !== 1) {
        throw new Error('CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED')
      }
      moveChapterToTrash(db, operationId, target, frozenRunIds)
      return operationId
    })

    const confirmedOperationId = transaction()
    const operation = ChapterDeletionRepository.get(confirmedOperationId)
    if (!operation) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
    return operation
  }

  /** 回收站里一项的主定稿收据，恢复前用来选实体稿目标、判定批量。不在回收站时为 null。 */
  static trashedFinal(deletionId: string): {
    draftId: number; chapterNumber: number; chapterTitle: string; finalizationId: string; targetFileName: string; contentSnapshot: string
  } | null {
    const row = requireDatabase().prepare(`
      SELECT d.id AS draftId, d.chapter_number AS chapterNumber, o.chapter_title AS chapterTitle, o.finalization_id AS finalizationId,
             o.target_file_name AS targetFileName, o.content_snapshot AS contentSnapshot
      FROM drafts_all d JOIN finalization_outbox_all o ON o.draft_id = d.id
      WHERE d.deletion_id = ? AND d.status = 'deleted' AND d.deleted_from_status = 'finalized'
    `).get(deletionId) as ReturnType<typeof ChapterDeletionRepository.trashedFinal> | undefined
    return row ?? null
  }

  /** 回收站全部各项，新删的在前。一项读不全只单列这一项，不挡其余各项。 */
  static listTrash(): { entries: TrashedChapter[]; damaged: DamagedTrashEntry[] } {
    const db = requireDatabase()
    return db.transaction(() => {
      const groups = new Map<string, TrashRow[]>()
      for (const row of db.prepare(`${TRASH_ROWS_SQL} ORDER BY d.id`).all() as TrashRow[]) {
        groups.set(row.deletion_id, [...groups.get(row.deletion_id) ?? [], row])
      }
      const entries: TrashedChapter[] = []
      const damaged: DamagedTrashEntry[] = []
      for (const [deletionId, rows] of groups) {
        try { entries.push(trashEntryOf(db, deletionId, rows)) }
        catch (error) { damaged.push({ deletionId, error: error instanceof Error ? error.message : String(error) }) }
      }
      entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.chapterNumber - b.chapterNumber)
      return { entries, damaged }
    })()
  }

  /**
   * 把回收站里的一项放回去，一个事务，全有或全无。恢复方式在事务里重算，与作者确认时看到的不同就拒绝；
   * 这次删除的清理没完成也拒绝（被冻结的收据除外，它的清理不在本机）。放回原位与作为旧版本放回都删掉
   * 这次删除的收据，同一章以后才能再删；以被删稿开新稿不动回收站。
   */
  static restore(
    request: RestoreTrashedChapterRequest,
    republishTargetFileName?: string,
  ): Exclude<RestoreTrashedChapterResult, { success: false }> {
    const db = requireDatabase()
    return db.transaction((): Exclude<RestoreTrashedChapterResult, { success: false }> => {
      const rows = db.prepare(`${TRASH_ROWS_SQL} AND d.deletion_id = ? ORDER BY d.id`).all(request.deletionId) as TrashRow[]
      if (rows.length === 0) {
        const draft = db.prepare('SELECT chapter_number, status FROM drafts WHERE id = ?').get(request.draftId) as
          { chapter_number: number; status: string } | undefined
        if (!draft || !['finalized', 'superseded'].includes(draft.status)) {
          throw new Error('CHAPTER_RESTORE_NOT_FOUND')
        }
        return { success: true, outcome: 'already-restored', chapterNumber: draft.chapter_number, draftId: request.draftId }
      }
      const entry = trashEntryOf(db, request.deletionId, rows)
      if (entry.draftId !== request.draftId) throw new Error('CHAPTER_RESTORE_REQUEST_MISMATCH')
      if (entry.restoreMode !== request.expectedMode) throw new Error('CHAPTER_RESTORE_MODE_CHANGED')
      if (entry.cleanup !== 'completed'
        && !readPortableRuntimeFreeze(getCurrentProjectPath()).isFrozen('chapter_deletion_operations', request.deletionId)) {
        throw new Error('CHAPTER_RESTORE_CLEANUP_INCOMPLETE')
      }
      const primary = rows.find(row => row.id === entry.draftId)!
      const chapterNumber = entry.chapterNumber

      if (entry.restoreMode === 'reopen-as-draft') {
        const body = db.prepare('SELECT body FROM contents WHERE id = ?').pluck().get(primary.content_id) as string | undefined
        if (body === undefined) throw new Error('CHAPTER_TRASH_ENTRY_INVALID')
        const existing = db.prepare(`
          SELECT d.id FROM drafts d JOIN contents c ON c.id = d.content_id
          WHERE d.chapter_number = ? AND d.status IN (${WORKING_DRAFT_STATUS_SQL}) AND c.body = ?
          ORDER BY d.version DESC, d.id DESC LIMIT 1
        `).pluck().get(chapterNumber, body) as number | undefined
        if (existing !== undefined) return { success: true, outcome: 'reopened-as-draft', chapterNumber, draftId: existing, created: false }
        const draftId = DraftRepository.create({ chapterNumber, source: 'rewrite', content: body, wordCount: countDraftUnits(body) }, db)
        return { success: true, outcome: 'reopened-as-draft', chapterNumber, draftId, created: true }
      }

      const finalizationId = primary.finalization_id!
      const intoGap = entry.restoreMode === 'into-gap'
      FinalizationRepository.reinstateDeleted(db, intoGap
        ? { deletionId: request.deletionId, chapterNumber, as: 'original', republish: { finalizationId, targetFileName: republishTargetFileName
          ?? db.prepare('SELECT target_file_name FROM finalization_outbox_all WHERE finalization_id = ?').pluck().get(finalizationId) as string } }
        : { deletionId: request.deletionId, chapterNumber, as: 'superseded' })
      const removedKnowledge = (db.prepare(`
        SELECT knowledge_document_id FROM chapter_deletion_operations WHERE operation_id = ?
      `).pluck().get(request.deletionId) as string | undefined ?? '') !== ''
      const prefix = `${request.deletionId}${SUPERSEDED_SUFFIX}`
      db.prepare(`
        DELETE FROM chapter_deletion_operations WHERE operation_id = ? OR substr(operation_id, 1, length(?)) = ?
      `).run(request.deletionId, prefix, prefix)
      if (!intoGap) return { success: true, outcome: 'restored-as-history', chapterNumber, draftId: entry.draftId }

      // 本章要点与角色派生字段绑定的收据没变，水位也没动，仍然可信；只有知识库文档在删除时清掉了，要重导。
      // 删除时本来就没有知识库文档（旧版章节确认过不在库里），就没有要重导的，导入步骤原样不动。
      const run = removedKnowledge ? PostProcessRepository.getLatestRun('chapter_finalize', String(chapterNumber)) : null
      if (run && PostProcessRepository.getSteps(run.id).some(step => step.stepKey === 'kb_import')) {
        PostProcessRepository.markStepFailed(run.id, 'kb_import', CHAPTER_RESTORED_REPROJECTION_PENDING)
      }
      return { success: true, outcome: 'restored', chapterNumber, draftId: entry.draftId, finalizationId, publicationStatus: 'pending' }
    }).immediate()
  }

  /** 彻底删除回收站里的项，一个事务。已经不在回收站的原样列为 alreadyGone。收据保留，作删除证明。 */
  static purge(deletionIds: readonly string[] | 'all'): { purged: string[]; alreadyGone: string[] } {
    const db = requireDatabase()
    return db.transaction(() => {
      const ids = deletionIds === 'all'
        ? db.prepare("SELECT DISTINCT deletion_id FROM drafts_all WHERE status = 'deleted' ORDER BY deletion_id").pluck().all() as string[]
        : [...new Set(deletionIds)]
      const purged: string[] = []
      const alreadyGone: string[] = []
      const runsOf = db.prepare(`
        SELECT id FROM post_process_runs WHERE trigger_source_type = 'chapter_finalize' AND trigger_source_id = ? ORDER BY id
      `).pluck()
      for (const deletionId of ids) {
        const rows = db.prepare(`${TRASH_ROWS_SQL} AND d.deletion_id = ? ORDER BY d.id`).all(deletionId) as TrashRow[]
        if (rows.length === 0) { alreadyGone.push(deletionId); continue }
        for (const row of rows) {
          deleteDraftFacts(db, row.id, row.content_id,
            row.finalization_id ? runsOf.all(`finalization:${row.finalization_id}`) as string[] : [])
        }
        purged.push(deletionId)
      }
      return { purged, alreadyGone }
    }).immediate()
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

  /** 实体稿还没清理完的删除收据（含旧版本收据）占着的文件名，小写。 */
  static reservedManuscriptTargets(): Set<string> {
    const names = requireDatabase().prepare(`
      SELECT target_file_name FROM chapter_deletion_operations
      WHERE manuscript_status IN ('pending', 'failed') AND target_file_name <> ''
    `).pluck().all() as string[]
    return new Set(names.map(name => name.toLowerCase()))
  }

  static listIncomplete(): ChapterDeletionOperation[] {
    const rows = requireDatabase().prepare(`
      SELECT * FROM chapter_deletion_operations
      WHERE status != 'completed' AND instr(operation_id, ?) = 0
      ORDER BY created_at, operation_id
    `).all(SUPERSEDED_SUFFIX) as ChapterDeletionRow[]
    return rows.map(rowToOperation)
  }

  static settle(operationId: string): ChapterDeletionOperation {
    refreshAggregateStatus(operationId)
    const operation = ChapterDeletionRepository.get(operationId)
    if (!operation) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
    return operation
  }

  static listCompanions(operationId: string): ChapterDeletionOperation[] {
    return companionRows(requireDatabase(), operationId).map(rowToOperation)
  }

  static startAttempt(operationId: string): ChapterDeletionOperation {
    const db = requireDatabase()
    const result = db.prepare(`
      UPDATE chapter_deletion_operations
      SET attempt_count = attempt_count + 1, status = 'pending', updated_at = datetime('now')
      WHERE operation_id = ? AND status != 'authorization_required'
    `).run(operationId)
    if (result.changes !== 1) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
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
    if (result.changes !== 1) throw new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')
    refreshAggregateStatus(operationId)
    return ChapterDeletionRepository.get(operationId)!
  }
}
