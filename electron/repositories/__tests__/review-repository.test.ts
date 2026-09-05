import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../database'
import { ContentRepository } from '../content-repository'
import { ReviewRepository } from '../review-repository'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL
    );
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'write',
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      review_index INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT,
      UNIQUE(base_draft_id, review_index)
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
  const draftContentId = ContentRepository.create('原稿')
  db.prepare('INSERT INTO drafts (content_id) VALUES (?)').run(draftContentId)
})

afterEach(() => db.close())

describe('ReviewRepository.create', () => {
  it('atomically rejects stale frozen source content without allocating a review or content', () => {
    const contentsBefore = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }

    expect(() => ReviewRepository.create({
      baseDraftId: 1,
      content: '{"summary":"stale"}',
      expectedSource: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '过期原稿',
      },
    })).toThrow('SOURCE_DRAFT_CHANGED')

    expect(ReviewRepository.listByDraft(1)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get())
      .toEqual(contentsBefore)
  })

  it('validates the frozen source and allocates the review index in one transaction', () => {
    const first = ReviewRepository.create({
      baseDraftId: 1,
      content: '{"summary":"first"}',
      expectedSource: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })
    const second = ReviewRepository.create({
      baseDraftId: 1,
      content: '{"summary":"second"}',
      expectedSource: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })

    expect(ReviewRepository.listByDraft(1).map(review => [review.id, review.reviewIndex]))
      .toEqual([[first.id, 1], [second.id, 2]])
    expect([first.reviewIndex, second.reviewIndex]).toEqual([1, 2])
  })
})
