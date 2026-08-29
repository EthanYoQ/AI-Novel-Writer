import { getProjectDb } from '../database'
import type {
  FinalizedContinuityProjection,
  SaveFinalizedContinuityRequest,
} from '../../src/shared/finalized-continuity'

export class SummaryRepository {
  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const chapterNotes = input.chapterNotes.trim()
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
        SET chapter_number = ?, chapter_notes = ?, created_at = datetime('now')
        WHERE draft_id = ?
      `).run(input.chapterNumber, chapterNotes, input.draftId)
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots (draft_id, chapter_number, chapter_notes)
          VALUES (?, ?, ?)
        `).run(input.draftId, input.chapterNumber, chapterNotes)
      }
    })()
  }

  static listFinalizedContinuityBefore(chapterNumber: number): FinalizedContinuityProjection[] {
    const db = getProjectDb()
    if (!db) return []
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
      throw new Error('连续性投影目标章节无效')
    }
    return db.prepare(`
      SELECT summary_snapshots.draft_id AS draftId,
             summary_snapshots.chapter_number AS chapterNumber,
             COALESCE(finalization_outbox.chapter_title, '') AS chapterTitle,
             summary_snapshots.chapter_notes AS chapterNotes
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status = 'finalized'
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as FinalizedContinuityProjection[]
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
