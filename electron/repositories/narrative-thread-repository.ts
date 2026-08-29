import { getProjectDb } from '../database'
import type {
  NarrativeThreadEvent,
  NarrativeThreadEventInput,
  NarrativeThreadChapterContext,
  NarrativeThreadPlanInput,
  NarrativeThreadPlanRecord,
  NarrativeThreadStatus,
  NarrativeThreadView,
} from '../../src/shared/narrative-thread'

function requireDb() {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function validatePlan(input: NarrativeThreadPlanInput): NarrativeThreadPlanInput {
  const title = input.title.trim()
  const type = input.type.trim()
  const authorIntent = input.authorIntent.trim()
  if (!title || title.length > 120 || !type || type.length > 60
    || !authorIntent || authorIntent.length > 1000) {
    throw new Error('叙事线索计划参数无效')
  }
  if (!Number.isSafeInteger(input.targetStartChapter) || input.targetStartChapter < 1
    || !Number.isSafeInteger(input.targetEndChapter) || input.targetEndChapter < input.targetStartChapter) {
    throw new Error('叙事线索目标章节范围无效')
  }
  return { ...input, title, type, authorIntent }
}

function rowToPlan(row: Record<string, unknown>): NarrativeThreadPlanRecord {
  return {
    id: row.id as number,
    title: row.title as string,
    type: row.type as string,
    targetStartChapter: row.target_start_chapter as number,
    targetEndChapter: row.target_end_chapter as number,
    authorIntent: row.author_intent as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export class NarrativeThreadRepository {
  static createPlan(input: NarrativeThreadPlanInput): NarrativeThreadPlanRecord {
    const value = validatePlan(input)
    const result = requireDb().prepare(`
      INSERT INTO narrative_thread_plans (
        title, type, target_start_chapter, target_end_chapter, author_intent
      ) VALUES (?, ?, ?, ?, ?)
    `).run(value.title, value.type, value.targetStartChapter, value.targetEndChapter, value.authorIntent)
    return this.getPlan(Number(result.lastInsertRowid))!
  }

  static updatePlan(id: number, input: NarrativeThreadPlanInput): NarrativeThreadPlanRecord {
    const value = validatePlan(input)
    const result = requireDb().prepare(`
      UPDATE narrative_thread_plans
      SET title = ?, type = ?, target_start_chapter = ?, target_end_chapter = ?,
          author_intent = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(value.title, value.type, value.targetStartChapter, value.targetEndChapter, value.authorIntent, id)
    if (result.changes !== 1) throw new Error('叙事线索计划不存在')
    return this.getPlan(id)!
  }

  static deletePlan(id: number): void {
    const result = requireDb().prepare('DELETE FROM narrative_thread_plans WHERE id = ?').run(id)
    if (result.changes !== 1) throw new Error('叙事线索计划不存在')
  }

  static getPlan(id: number): NarrativeThreadPlanRecord | null {
    const row = requireDb().prepare('SELECT * FROM narrative_thread_plans WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? rowToPlan(row) : null
  }

  static confirmEvent(input: NarrativeThreadEventInput): NarrativeThreadEvent {
    const db = requireDb()
    const evidence = input.evidence.trim()
    const reason = input.reason.trim()
    if (!['planted', 'progressing', 'resolved', 'abandoned'].includes(input.type)
      || !evidence || evidence.length > 240 || !reason || reason.length > 500) {
      throw new Error('叙事线索事件参数无效')
    }
    const source = db.prepare(`
      SELECT drafts.id AS draft_id, drafts.chapter_number,
             COALESCE(finalization_outbox.chapter_title, '') AS chapter_title,
             finalization_outbox.content_snapshot
      FROM drafts
      JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE drafts.id = ? AND drafts.status = 'finalized'
    `).get(input.draftId) as { draft_id: number; chapter_number: number; chapter_title: string; content_snapshot: string } | undefined
    if (!source) throw new Error('线索事件只能绑定已定稿章节')
    const normalizedEvidence = evidence.replace(/\s+/gu, '')
    const normalizedContent = source.content_snapshot.replace(/\s+/gu, '')
    if (!normalizedContent.includes(normalizedEvidence)) {
      throw new Error('短证据必须来自绑定的定稿正文')
    }
    if (!this.getPlan(input.planId)) throw new Error('叙事线索计划不存在')
    const result = db.prepare(`
      INSERT INTO narrative_thread_confirmations (
        plan_id, draft_id, event_type, evidence, reason
      ) VALUES (?, ?, ?, ?, ?)
    `).run(input.planId, input.draftId, input.type, evidence, reason)
    const created = db.prepare('SELECT created_at AS createdAt FROM narrative_thread_confirmations WHERE id = ?')
      .get(result.lastInsertRowid) as { createdAt: string }
    return {
      id: Number(result.lastInsertRowid),
      ...input,
      evidence,
      reason,
      chapterNumber: source.chapter_number,
      chapterTitle: source.chapter_title,
      createdAt: created.createdAt,
    }
  }

  static list(): NarrativeThreadView[] {
    const db = requireDb()
    const currentFinalizedChapter = (db.prepare(`
      SELECT COALESCE(MAX(chapter_number), 0) AS chapterNumber
      FROM drafts WHERE status = 'finalized'
    `).get() as { chapterNumber: number }).chapterNumber
    const plans = db.prepare('SELECT * FROM narrative_thread_plans ORDER BY id ASC')
      .all() as Record<string, unknown>[]
    return plans.map((row) => {
      const plan = rowToPlan(row)
      const eventRows = db.prepare(`
        SELECT confirmations.id, confirmations.plan_id AS planId,
               confirmations.draft_id AS draftId, confirmations.event_type AS type,
               confirmations.evidence, confirmations.reason, confirmations.created_at AS createdAt,
               drafts.chapter_number AS chapterNumber,
               COALESCE(finalization_outbox.chapter_title, '') AS chapterTitle
        FROM narrative_thread_confirmations confirmations
        JOIN drafts ON drafts.id = confirmations.draft_id AND drafts.status = 'finalized'
        JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
        WHERE confirmations.plan_id = ?
        ORDER BY drafts.chapter_number ASC, confirmations.id ASC
      `).all(plan.id) as NarrativeThreadEvent[]
      const status = (eventRows.at(-1)?.type ?? 'planned') as NarrativeThreadStatus
      const terminal = status === 'resolved' || status === 'abandoned'
      const lastChapter = eventRows.at(-1)?.chapterNumber ?? plan.targetStartChapter
      return {
        ...plan,
        status,
        dormantChapters: terminal ? 0 : Math.max(0, currentFinalizedChapter - lastChapter),
        overdue: !terminal && currentFinalizedChapter > plan.targetEndChapter,
        events: eventRows,
      }
    })
  }

  static listRelevantActive(context: NarrativeThreadChapterContext): NarrativeThreadView[] {
    const currentText = `${context.title}\n${context.keyEvents}`
    const characters = context.characters.map(character => character.trim()).filter(Boolean)
    return this.list().filter((thread) => {
      if (thread.status === 'resolved' || thread.status === 'abandoned') return false
      if (context.chapterNumber >= thread.targetStartChapter && context.chapterNumber <= thread.targetEndChapter) {
        return true
      }
      const threadText = [
        thread.title,
        thread.type,
        thread.authorIntent,
        ...thread.events.flatMap(event => [event.evidence, event.reason]),
      ].join('\n')
      return characters.some(character => threadText.includes(character))
        || (thread.title.length >= 2 && currentText.includes(thread.title))
    })
  }
}
