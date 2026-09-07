import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import type {
  FinalizedContinuityFact,
  FinalizedContinuityProjection,
  FinalizedSourceIdentity,
  FinalizedSourceSnapshot,
  SaveFinalizedContinuityRequest,
} from '../../src/shared/finalized-continuity'

const FACT_CATEGORIES = new Set(['character-state', 'timeline', 'open-thread', 'plot'])

function normalizedFacts(value: unknown, chapterNumber: number): FinalizedContinuityFact[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('连续性事实参数无效')
  return value.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('连续性事实参数无效')
    const fact = input as Record<string, unknown>
    const entities = Array.isArray(fact.entities)
      ? fact.entities.map(entity => typeof entity === 'string' ? entity.trim() : '')
      : []
    const statement = typeof fact.statement === 'string' ? fact.statement.trim() : ''
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim() : ''
    if (
      !FACT_CATEGORIES.has(String(fact.category))
      || fact.sourceChapter !== chapterNumber
      || entities.length > 8
      || entities.some(entity => !entity || entity.length > 80)
      || !statement
      || statement.length > 280
      || !evidence
      || evidence.length > 240
    ) throw new Error('连续性事实参数无效')
    return {
      category: fact.category as FinalizedContinuityFact['category'],
      entities: [...new Set(entities)],
      statement,
      sourceChapter: chapterNumber,
      evidence,
    }
  })
}

function parseFacts(value: string, chapterNumber: number): FinalizedContinuityFact[] {
  try {
    return normalizedFacts(JSON.parse(value) as unknown, chapterNumber)
  } catch {
    return []
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameSource(left: FinalizedSourceIdentity, right: FinalizedSourceIdentity): boolean {
  return left.draftId === right.draftId
    && left.finalizationId === right.finalizationId
    && left.chapterNumber === right.chapterNumber
    && left.contentHash === right.contentHash
}

function readFinalizedSourceFromDb(
  db: BetterSqlite3.Database,
  draftId: number,
): FinalizedSourceSnapshot | null {
  const row = db.prepare(`
    SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
           contents.body AS content, finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.chapter_title AS chapterTitle,
           finalization_outbox.content_hash AS contentHash,
           finalization_outbox.content_snapshot AS contentSnapshot
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.id = ?
  `).get(draftId) as {
    draftId: number
    chapterNumber: number
    status: string
    content: string
    finalizationId: string
    chapterTitle: string
    contentHash: string
    contentSnapshot: string
  } | undefined
  if (
    !row
    || row.status !== 'finalized'
    || row.content !== row.contentSnapshot
    || sha256(row.contentSnapshot) !== row.contentHash
  ) return null
  return {
    source: {
      draftId: row.draftId,
      finalizationId: row.finalizationId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    },
    chapterTitle: row.chapterTitle,
    content: row.contentSnapshot,
  }
}

export function invalidateContinuityProjectionFrom(
  db: BetterSqlite3.Database,
  chapterNumber: number,
): void {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('连续性投影失效章节无效')
  }
  db.prepare(`
    UPDATE continuity_projection_meta
    SET generation = generation + 1,
        stale_from_chapter = CASE
          WHEN stale_from_chapter IS NULL OR stale_from_chapter > ? THEN ?
          ELSE stale_from_chapter
        END
    WHERE id = 'main'
  `).run(chapterNumber, chapterNumber)
}

export class SummaryRepository {
  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const chapterNotes = input.chapterNotes.trim()
    const normalized = normalizedFacts(input.facts ?? [], input.chapterNumber)
    const facts = JSON.stringify(normalized)
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !chapterNotes
    ) throw new Error('连续性投影参数无效')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('连续性投影来源已失效，已拒绝过期结果')
      }
      if (normalized.some(fact => !snapshot.content.includes(fact.evidence))) {
        throw new Error('连续性事实引文无法在绑定定稿正文中精确定位')
      }
      const generation = (db.prepare(`
        SELECT generation FROM continuity_projection_meta WHERE id = 'main'
      `).get() as { generation: number }).generation
      const updated = db.prepare(`
        UPDATE summary_snapshots
        SET chapter_number = ?, chapter_notes = ?, continuity_facts = ?,
            source_finalization_id = ?, source_content_hash = ?, projection_generation = ?,
            created_at = datetime('now')
        WHERE draft_id = ?
      `).run(
        input.chapterNumber,
        chapterNotes,
        facts,
        input.source.finalizationId,
        input.source.contentHash,
        generation,
        input.draftId,
      )
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots (
            draft_id, chapter_number, chapter_notes, continuity_facts,
            source_finalization_id, source_content_hash, projection_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.draftId,
          input.chapterNumber,
          chapterNotes,
          facts,
          input.source.finalizationId,
          input.source.contentHash,
          generation,
        )
      }
    })()
  }

  static listFinalizedContinuityBefore(chapterNumber: number): FinalizedContinuityProjection[] {
    const db = getProjectDb()
    if (!db) return []
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
      throw new Error('连续性投影目标章节无效')
    }
    const rows = db.prepare(`
      SELECT summary_snapshots.draft_id AS draftId,
             summary_snapshots.chapter_number AS chapterNumber,
             COALESCE(finalization_outbox.chapter_title, '') AS chapterTitle,
             summary_snapshots.chapter_notes AS chapterNotes,
             summary_snapshots.continuity_facts AS continuityFacts,
             summary_snapshots.source_finalization_id AS sourceFinalizationId,
             summary_snapshots.source_content_hash AS sourceContentHash,
             summary_snapshots.projection_generation AS projectionGeneration,
             finalization_outbox.finalization_id AS currentFinalizationId,
             finalization_outbox.content_hash AS currentContentHash,
             finalization_outbox.content_snapshot AS contentSnapshot,
             contents.body AS currentContent,
             continuity_projection_meta.generation AS currentGeneration,
             continuity_projection_meta.stale_from_chapter AS staleFromChapter
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number = drafts.chapter_number
            AND newer.status = 'finalized'
            AND (newer.version > drafts.version OR (newer.version = drafts.version AND newer.id > drafts.id))
        )
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as Array<Omit<FinalizedContinuityProjection, 'facts' | 'source' | 'sourceStatus'> & {
      continuityFacts: string
      sourceFinalizationId: string
      sourceContentHash: string
      projectionGeneration: number
      currentFinalizationId: string | null
      currentContentHash: string | null
      contentSnapshot: string | null
      currentContent: string
      currentGeneration: number
      staleFromChapter: number | null
    }>
    return rows.map((row) => {
      const hasBoundSource = Boolean(row.sourceFinalizationId && row.sourceContentHash)
      const sourceCurrent = hasBoundSource
        && row.currentFinalizationId === row.sourceFinalizationId
        && row.currentContentHash === row.sourceContentHash
        && row.contentSnapshot === row.currentContent
        && sha256(row.currentContent) === row.currentContentHash
      const invalidated = row.staleFromChapter !== null
        && row.chapterNumber >= row.staleFromChapter
        && row.projectionGeneration < row.currentGeneration
      return {
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        chapterNotes: row.chapterNotes,
        facts: parseFacts(row.continuityFacts, row.chapterNumber),
        ...(hasBoundSource ? {
          source: {
            draftId: row.draftId,
            finalizationId: row.sourceFinalizationId,
            chapterNumber: row.chapterNumber,
            contentHash: row.sourceContentHash,
          },
        } : {}),
        sourceStatus: !hasBoundSource ? 'legacy' : sourceCurrent && !invalidated ? 'current' : 'stale',
      }
    })
  }

  /** Raw immutable prose is the deterministic fallback when a derived projection is stale. */
  static readFinalizedSource(draftId: number): FinalizedSourceSnapshot | null {
    const db = getProjectDb()
    if (!db) return null
    if (!Number.isSafeInteger(draftId) || draftId < 1) throw new Error('定稿来源身份无效')
    return readFinalizedSourceFromDb(db, draftId)
  }

  /** 保存角色状态快照 */
  static saveSnapshot(chapterNumber: number, characterStates: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      INSERT INTO summary_snapshots (chapter_number, character_states)
      VALUES (?, ?)
    `).run(chapterNumber, characterStates)
  }

  /** 获取最新角色状态快照 */
  static getLatestSnapshot(): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      `SELECT character_states AS characterStates, chapter_number AS chapterNumber
       FROM summary_snapshots
       WHERE draft_id IS NULL
       ORDER BY id DESC LIMIT 1`,
    ).get() as { characterStates: string; chapterNumber: number } | undefined
    return row ?? null
  }
}
