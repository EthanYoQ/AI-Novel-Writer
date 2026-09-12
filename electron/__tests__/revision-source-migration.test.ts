import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeLegacyNormalizationFixture as closeProjectDatabase, getLegacyNormalizationFixtureDb as getProjectDb, openLegacyNormalizationFixture } from '../../test/helpers/legacy-baseline-fixture'

// Historical normalization regressions use an explicit fixture handle. Production
// rejects these unqualified old roots; canonical activation is tested separately.
vi.mock('../database', async () => {
  const actual = await vi.importActual<typeof import('../database')>('../database')
  const fixture = await import('../../test/helpers/legacy-baseline-fixture')
  return { ...actual, getProjectDb: fixture.getLegacyNormalizationFixtureDb, getCurrentProjectPath: fixture.getLegacyNormalizationFixturePath }
})

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

function makeLegacyProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-legacy-revision-source-'))
  roots.push(projectRoot)
  const velaRoot = path.join(projectRoot, '.vela')
  fs.mkdirSync(velaRoot, { recursive: true })
  const db = new Database(path.join(velaRoot, 'vela.db'))
  db.exec(`
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'write',
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL,
      revision_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      content_id INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY,
      base_draft_id INTEGER NOT NULL,
      review_index INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      created_at TEXT
    );
    INSERT INTO contents (id, body) VALUES (1, '后来可能变化的原稿'), (2, '旧修订'), (3, '旧审稿');
    INSERT INTO drafts (id, chapter_number, version, status, content_id) VALUES (1, 1, 1, 'draft', 1);
    INSERT INTO revisions (id, base_draft_id, revision_index, revision_type, content_id)
      VALUES (1, 1, 1, 'refine', 2);
    INSERT INTO reviews (id, base_draft_id, review_index, content_id) VALUES (1, 1, 1, 3);
  `)
  db.close()
  return projectRoot
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('revision and review source migration', () => {
  it('adds nullable frozen-source columns without rebasing legacy rows onto the current draft', () => {
    const projectRoot = makeLegacyProject()

    openLegacyNormalizationFixture(projectRoot)
    const db = getProjectDb()!
    for (const table of ['revisions', 'reviews']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
        'source_draft_chapter_number',
        'source_draft_version',
        'source_draft_status',
        'source_content',
      ]))
      expect(db.prepare(`
        SELECT source_draft_chapter_number, source_draft_version, source_draft_status, source_content
        FROM ${table} WHERE id = 1
      `).get()).toEqual({
        source_draft_chapter_number: null,
        source_draft_version: null,
        source_draft_status: null,
        source_content: null,
      })
    }
  })
})
