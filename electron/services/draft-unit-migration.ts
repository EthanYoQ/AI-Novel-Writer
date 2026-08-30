import type BetterSqlite3 from 'better-sqlite3'

import {
  DRAFT_UNIT_ALGORITHM_VERSION,
  countDraftUnits,
} from '../../src/shared/draft-units'

const METRIC_KEY = 'draft-units'

export interface DraftUnitMigrationStats {
  drafts: number
  revisions: number
  sourceChapters: number
  sources: number
  importRuns: number
}

function tableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 AS value
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName))
}

function metricVersion(db: BetterSqlite3.Database): number {
  const row = db.prepare(`
    SELECT version FROM text_metric_versions WHERE metric = ?
  `).get(METRIC_KEY) as { version: number } | undefined
  return row?.version ?? 0
}

function migrateContentBackedCounts(
  db: BetterSqlite3.Database,
  tableName: 'drafts' | 'revisions',
): number {
  if (!tableExists(db, tableName) || !tableExists(db, 'contents')) return 0
  const rows = db.prepare(`
    SELECT records.id, records.word_count, contents.body
    FROM ${tableName} AS records
    JOIN contents ON contents.id = records.content_id
  `).all() as Array<{ id: number; word_count: number; body: string }>
  const update = db.prepare(`UPDATE ${tableName} SET word_count = ? WHERE id = ?`)
  let changed = 0
  for (const row of rows) {
    const wordCount = countDraftUnits(row.body)
    if (row.word_count === wordCount) continue
    update.run(wordCount, row.id)
    changed += 1
  }
  return changed
}

function migrateImportSourceChapters(db: BetterSqlite3.Database): number {
  if (!tableExists(db, 'import_run_source_chapters')) return 0
  const rows = db.prepare(`
    SELECT run_id, source_id, source_chapter_number, word_count, content_snapshot
    FROM import_run_source_chapters
  `).all() as Array<{
    run_id: string
    source_id: string
    source_chapter_number: number
    word_count: number
    content_snapshot: string
  }>
  const update = db.prepare(`
    UPDATE import_run_source_chapters
    SET word_count = ?
    WHERE run_id = ? AND source_id = ? AND source_chapter_number = ?
  `)
  let changed = 0
  for (const row of rows) {
    const wordCount = countDraftUnits(row.content_snapshot)
    if (row.word_count === wordCount) continue
    update.run(wordCount, row.run_id, row.source_id, row.source_chapter_number)
    changed += 1
  }
  return changed
}

function migrateImportSources(db: BetterSqlite3.Database): number {
  if (!tableExists(db, 'import_run_sources') || !tableExists(db, 'import_run_source_chapters')) return 0
  const rows = db.prepare(`
    SELECT sources.run_id, sources.source_id, sources.word_count, sources.chapter_count,
      COUNT(chapters.source_chapter_number) AS snapshot_count,
      COALESCE(SUM(chapters.word_count), 0) AS calculated_word_count
    FROM import_run_sources AS sources
    LEFT JOIN import_run_source_chapters AS chapters
      ON chapters.run_id = sources.run_id AND chapters.source_id = sources.source_id
    WHERE sources.status = 'completed'
    GROUP BY sources.run_id, sources.source_id, sources.word_count, sources.chapter_count
  `).all() as Array<{
    run_id: string
    source_id: string
    word_count: number
    chapter_count: number
    snapshot_count: number
    calculated_word_count: number
  }>
  const update = db.prepare(`
    UPDATE import_run_sources SET word_count = ? WHERE run_id = ? AND source_id = ?
  `)
  let changed = 0
  for (const row of rows) {
    // Preserve legacy or interrupted source aggregates when their complete
    // frozen chapter set is unavailable. Reconstructing from a partial subset
    // would silently undercount a resumable import.
    if (row.snapshot_count !== row.chapter_count) continue
    if (row.word_count === row.calculated_word_count) continue
    update.run(row.calculated_word_count, row.run_id, row.source_id)
    changed += 1
  }
  return changed
}

function completeRunWordCount(
  db: BetterSqlite3.Database,
  runId: string,
  expectedChapterCount: number,
): number | null {
  if (expectedChapterCount <= 0) return 0

  if (tableExists(db, 'import_run_source_chapters')) {
    const sourceRows = db.prepare(`
      SELECT content_snapshot
      FROM import_run_source_chapters
      WHERE run_id = ?
    `).all(runId) as Array<{ content_snapshot: string }>
    if (sourceRows.length === expectedChapterCount) {
      return sourceRows.reduce((sum, row) => sum + countDraftUnits(row.content_snapshot), 0)
    }
  }

  if (tableExists(db, 'import_run_chapters')) {
    const runRows = db.prepare(`
      SELECT content_snapshot
      FROM import_run_chapters
      WHERE run_id = ?
    `).all(runId) as Array<{ content_snapshot: string }>
    if (runRows.length === expectedChapterCount) {
      return runRows.reduce((sum, row) => sum + countDraftUnits(row.content_snapshot), 0)
    }
  }

  // Some author-manuscript runs intentionally persist only newly committed
  // chapters while the manifest also includes exact duplicates. Those missing
  // immutable source snapshots cannot be reconstructed safely; preserve the
  // existing aggregate instead of inventing a new value.
  return null
}

function migrateImportRuns(db: BetterSqlite3.Database): number {
  if (!tableExists(db, 'import_runs')) return 0
  const rows = db.prepare(`
    SELECT id, manifest_chapter_count, manifest_word_count
    FROM import_runs
  `).all() as Array<{
    id: string
    manifest_chapter_count: number
    manifest_word_count: number
  }>
  const update = db.prepare(`
    UPDATE import_runs SET manifest_word_count = ? WHERE id = ?
  `)
  let changed = 0
  for (const row of rows) {
    const wordCount = completeRunWordCount(db, row.id, row.manifest_chapter_count)
    if (wordCount === null || wordCount === row.manifest_word_count) continue
    update.run(wordCount, row.id)
    changed += 1
  }
  return changed
}

/**
 * Recalculate every reconstructable cached prose count exactly once per
 * algorithm version. The migration is transactional and fail-closed: the
 * version marker is written only after all count updates succeed.
 */
export function migrateDraftUnitCounts(db: BetterSqlite3.Database): DraftUnitMigrationStats {
  db.exec(`
    CREATE TABLE IF NOT EXISTS text_metric_versions (
      metric TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  if (metricVersion(db) >= DRAFT_UNIT_ALGORITHM_VERSION) {
    return { drafts: 0, revisions: 0, sourceChapters: 0, sources: 0, importRuns: 0 }
  }

  return db.transaction(() => {
    const stats: DraftUnitMigrationStats = {
      drafts: migrateContentBackedCounts(db, 'drafts'),
      revisions: migrateContentBackedCounts(db, 'revisions'),
      sourceChapters: migrateImportSourceChapters(db),
      sources: migrateImportSources(db),
      importRuns: migrateImportRuns(db),
    }
    db.prepare(`
      INSERT INTO text_metric_versions (metric, version, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(metric) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(METRIC_KEY, DRAFT_UNIT_ALGORITHM_VERSION)
    return stats
  })()
}
