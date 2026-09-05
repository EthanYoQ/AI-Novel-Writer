import { createHash } from 'node:crypto'

import { getProjectDb } from '../database'
import { NarrativeThreadRepository } from './narrative-thread-repository'
import {
  assertPlotTreeSnapshot,
  assertStoredPlotTreeSnapshot,
  type PlotTreeSnapshot,
  type PlotTreeSourceBundle,
} from '../../src/shared/plot-tree'
import { resolveWritingLanguage } from '../../src/shared/writing-language'

function requireDb(): NonNullable<ReturnType<typeof getProjectDb>> {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function sourceRevision(
  sources: Omit<PlotTreeSourceBundle, 'sourceRevision' | 'snapshot'>,
): string {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex')
}

export class PlotTreeRepository {
  static read(): PlotTreeSourceBundle {
    const db = requireDb()
    const core = db.prepare(`
      SELECT writing_language, synopsis, plot_tree_snapshot
      FROM project_core WHERE id = 'main'
    `).get() as {
      writing_language: string
      synopsis: string
      plot_tree_snapshot: string
    } | undefined
    if (!core) throw new Error('项目配置不存在')

    const blueprintRows = db.prepare(`
      SELECT chapter_number, title, purpose, key_events
      FROM blueprints ORDER BY chapter_number ASC
    `).all() as Array<{
      chapter_number: number
      title: string
      purpose: string
      key_events: string
    }>
    const finalizedRows = db.prepare(`
      SELECT drafts.id AS draft_id,
             drafts.chapter_number,
             COALESCE(finalization_outbox.chapter_title, blueprints.title, '') AS title,
             COALESCE(
               NULLIF(summary_snapshots.chapter_notes, ''),
               CASE WHEN TRIM(COALESCE(blueprints.notes_updated_at, '')) <> ''
                 THEN blueprints.notes ELSE '' END
             ) AS summary
      FROM drafts
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      LEFT JOIN summary_snapshots ON summary_snapshots.draft_id = drafts.id
      LEFT JOIN blueprints ON blueprints.chapter_number = drafts.chapter_number
      WHERE drafts.status = 'finalized'
      ORDER BY drafts.chapter_number ASC, drafts.id ASC
    `).all() as Array<{
      draft_id: number
      chapter_number: number
      title: string
      summary: string
    }>
    const narrativeThreads = NarrativeThreadRepository.list().map(thread => ({
      id: thread.id,
      title: thread.title,
      type: thread.type,
      targetStartChapter: thread.targetStartChapter,
      targetEndChapter: thread.targetEndChapter,
      authorIntent: thread.authorIntent,
      status: thread.status,
      events: thread.events.map(event => ({
        id: event.id,
        chapterNumber: event.chapterNumber,
        type: event.type,
        evidence: event.evidence,
        reason: event.reason,
      })),
    }))
    const blueprints = blueprintRows.map(row => ({
      chapterNumber: row.chapter_number,
      title: row.title,
      purpose: row.purpose,
      keyEvents: row.key_events,
    }))
    const finalizedChapters = finalizedRows.map(row => ({
      draftId: row.draft_id,
      chapterNumber: row.chapter_number,
      title: row.title,
      summary: row.summary,
    }))
    const facts = {
      writingLanguage: resolveWritingLanguage(core.writing_language),
      synopsis: {
        content: core.synopsis,
      },
      blueprints,
      finalizedChapters,
      narrativeThreads,
    }
    const bundle: PlotTreeSourceBundle = {
      ...facts,
      sourceRevision: sourceRevision(facts),
      snapshot: null,
    }
    if (core.plot_tree_snapshot) {
      try {
        bundle.snapshot = assertStoredPlotTreeSnapshot(JSON.parse(core.plot_tree_snapshot))
      } catch {
        bundle.snapshot = null
      }
    }
    return bundle
  }

  static save(snapshot: PlotTreeSnapshot, expectedSourceRevision: string): PlotTreeSnapshot {
    const db = requireDb()
    const sources = this.read()
    if (sources.sourceRevision !== expectedSourceRevision) {
      throw new Error('剧情资料在生成期间已更新')
    }
    const validated = assertPlotTreeSnapshot(snapshot, sources)
    const result = db.prepare(`
      UPDATE project_core SET plot_tree_snapshot = ? WHERE id = 'main'
    `).run(JSON.stringify(validated))
    if (result.changes !== 1) throw new Error('剧情树快照保存失败')
    return validated
  }

  static clear(): void {
    const result = requireDb().prepare(`
      UPDATE project_core SET plot_tree_snapshot = '' WHERE id = 'main'
    `).run()
    if (result.changes !== 1) throw new Error('剧情树快照清除失败')
  }
}
