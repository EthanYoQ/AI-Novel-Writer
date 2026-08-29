import { getProjectDb } from '../database'
import type {
  FinalizedContinuityFact,
  FinalizedContinuityProjection,
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

export class SummaryRepository {
  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const chapterNotes = input.chapterNotes.trim()
    const facts = JSON.stringify(normalizedFacts(input.facts ?? [], input.chapterNumber))
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !chapterNotes
    ) throw new Error('连续性投影参数无效')

    const finalized = db.prepare(`
      SELECT id FROM drafts
      WHERE id = ? AND chapter_number = ? AND status = 'finalized'
    `).get(input.draftId, input.chapterNumber)
    if (!finalized) {
      throw new Error('连续性投影必须绑定匹配章节的 finalized 定稿')
    }

    db.transaction(() => {
      const updated = db.prepare(`
        UPDATE summary_snapshots
        SET chapter_number = ?, chapter_notes = ?, continuity_facts = ?, created_at = datetime('now')
        WHERE draft_id = ?
      `).run(input.chapterNumber, chapterNotes, facts, input.draftId)
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots (draft_id, chapter_number, chapter_notes, continuity_facts)
          VALUES (?, ?, ?, ?)
        `).run(input.draftId, input.chapterNumber, chapterNotes, facts)
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
             summary_snapshots.continuity_facts AS continuityFacts
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status = 'finalized'
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as Array<Omit<FinalizedContinuityProjection, 'facts'> & { continuityFacts: string }>
    return rows.map(row => ({
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        chapterNotes: row.chapterNotes,
        facts: parseFacts(row.continuityFacts, row.chapterNumber),
    }))
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
