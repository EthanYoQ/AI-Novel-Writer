import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { ContentRepository } from '../content-repository'
import { RevisionRepository } from '../revision-repository'

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
      content_id INTEGER NOT NULL,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL,
      revision_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      content_id INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT,
      UNIQUE(base_draft_id, revision_index)
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
  const draftContentId = ContentRepository.create('原稿')
  db.prepare('INSERT INTO drafts (content_id) VALUES (?)').run(draftContentId)
})

afterEach(() => db.close())

describe('RevisionRepository.replacePending', () => {
  it('creates the replacement and discards every previous pending revision in one transaction', () => {
    const first = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '旧修订一',
      wordCount: 5,
    })
    const second = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'review-fix',
      content: '旧修订二',
      wordCount: 5,
    })

    const replacement = RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '完整新修订',
      wordCount: 6,
    })

    expect(replacement.revisionIndex).toBe(3)
    expect(RevisionRepository.getPending(1).map(item => item.id)).toEqual([replacement.id])
    expect(RevisionRepository.getFull(replacement.id)?.content).toBe('完整新修订')
    expect(RevisionRepository.listByDraft(1).map(item => [item.id, item.status])).toEqual([
      [first.id, 'discarded'],
      [second.id, 'discarded'],
      [replacement.id, 'pending'],
    ])
  })

  it('rolls back discards and content allocation when replacement creation fails', () => {
    const original = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '仍需保留的修订',
      wordCount: 7,
    })
    db.exec(`
      CREATE TRIGGER reject_replacement BEFORE INSERT ON revisions
      WHEN NEW.revision_index = 2
      BEGIN
        SELECT RAISE(ABORT, 'replacement rejected');
      END;
    `)
    const contentsBefore = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }

    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '失败的新修订',
      wordCount: 6,
    })).toThrow('replacement rejected')

    expect(RevisionRepository.getPending(1).map(item => item.id)).toEqual([original.id])
    const contentsAfter = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }
    expect(contentsAfter.count).toBe(contentsBefore.count)
  })
})
