import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { DRAFT_UNIT_ALGORITHM_VERSION, countDraftUnits } from '../../../src/shared/draft-units'
import { migrateDraftUnitCounts } from '../draft-unit-migration'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function createFixtureDatabase(): BetterSqlite3.Database {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      FOREIGN KEY(content_id) REFERENCES contents(id)
    );
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      FOREIGN KEY(content_id) REFERENCES contents(id)
    );
    CREATE TABLE import_runs (
      id TEXT PRIMARY KEY,
      manifest_chapter_count INTEGER NOT NULL,
      manifest_word_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE import_run_chapters (
      run_id TEXT NOT NULL,
      chapter_number INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL,
      PRIMARY KEY(run_id, chapter_number)
    );
    CREATE TABLE import_run_sources (
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      chapter_count INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL,
      PRIMARY KEY(run_id, source_id)
    );
    CREATE TABLE import_run_source_chapters (
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL,
      PRIMARY KEY(run_id, source_id, source_chapter_number)
    );
  `)
  return database
}

describe('draft-unit cached-count migration', () => {
  it('recalculates drafts, revisions, source snapshots, sources, and complete run manifests', () => {
    db = createFixtureDatabase()
    const first = 'Café 林岚 𠀀'
    const second = 'naïve résumé'
    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, first)
    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(2, second)
    db.prepare('INSERT INTO drafts (id, content_id, word_count) VALUES (1, 1, 999)').run()
    db.prepare('INSERT INTO revisions (id, content_id, word_count) VALUES (1, 2, 999)').run()
    db.prepare("INSERT INTO import_runs (id, manifest_chapter_count, manifest_word_count) VALUES ('run-1', 2, 999)").run()
    db.prepare("INSERT INTO import_run_sources (run_id, source_id, status, chapter_count, word_count) VALUES ('run-1', 'source-1', 'completed', 2, 999)").run()
    db.prepare(`
      INSERT INTO import_run_source_chapters (
        run_id, source_id, source_chapter_number, word_count, content_snapshot
      ) VALUES ('run-1', 'source-1', 1, 999, ?), ('run-1', 'source-1', 2, 999, ?)
    `).run(first, second)

    expect(migrateDraftUnitCounts(db)).toEqual({
      drafts: 1,
      revisions: 1,
      sourceChapters: 2,
      sources: 1,
      importRuns: 1,
    })

    expect(db.prepare('SELECT word_count FROM drafts WHERE id = 1').get()).toEqual({
      word_count: countDraftUnits(first),
    })
    expect(db.prepare('SELECT word_count FROM revisions WHERE id = 1').get()).toEqual({
      word_count: countDraftUnits(second),
    })
    expect(db.prepare("SELECT word_count FROM import_run_sources WHERE run_id = 'run-1'").get()).toEqual({
      word_count: countDraftUnits(first) + countDraftUnits(second),
    })
    expect(db.prepare("SELECT manifest_word_count FROM import_runs WHERE id = 'run-1'").get()).toEqual({
      manifest_word_count: countDraftUnits(first) + countDraftUnits(second),
    })
    expect(db.prepare("SELECT version FROM text_metric_versions WHERE metric = 'draft-units'").get()).toEqual({
      version: DRAFT_UNIT_ALGORITHM_VERSION,
    })
  })

  it('preserves a completed source aggregate when its frozen source chapters are incomplete', () => {
    db = createFixtureDatabase()
    db.prepare(`
      INSERT INTO import_run_sources (run_id, source_id, status, chapter_count, word_count)
      VALUES ('partial-source', 'source-1', 'completed', 2, 37)
    `).run()
    db.prepare(`
      INSERT INTO import_run_source_chapters (
        run_id, source_id, source_chapter_number, word_count, content_snapshot
      ) VALUES ('partial-source', 'source-1', 1, 999, 'only one snapshot')
    `).run()

    migrateDraftUnitCounts(db)

    expect(db.prepare(`
      SELECT word_count FROM import_run_sources
      WHERE run_id = 'partial-source' AND source_id = 'source-1'
    `).get()).toEqual({ word_count: 37 })
  })

  it('preserves an incomplete author-style aggregate that lacks every frozen manifest chapter', () => {
    db = createFixtureDatabase()
    db.prepare("INSERT INTO import_runs (id, manifest_chapter_count, manifest_word_count) VALUES ('partial', 2, 37)").run()
    db.prepare("INSERT INTO import_run_chapters (run_id, chapter_number, content_snapshot) VALUES ('partial', 2, 'new chapter')").run()

    migrateDraftUnitCounts(db)

    expect(db.prepare("SELECT manifest_word_count FROM import_runs WHERE id = 'partial'").get())
      .toEqual({ manifest_word_count: 37 })
  })

  it('does not rerun the same metric version on every project open', () => {
    db = createFixtureDatabase()
    db.prepare('INSERT INTO contents (id, body) VALUES (1, ?)').run('Café')
    db.prepare('INSERT INTO drafts (id, content_id, word_count) VALUES (1, 1, 999)').run()
    migrateDraftUnitCounts(db)

    db.prepare('UPDATE drafts SET word_count = 123 WHERE id = 1').run()
    expect(migrateDraftUnitCounts(db)).toEqual({
      drafts: 0,
      revisions: 0,
      sourceChapters: 0,
      sources: 0,
      importRuns: 0,
    })
    expect(db.prepare('SELECT word_count FROM drafts WHERE id = 1').get()).toEqual({ word_count: 123 })
  })
})
