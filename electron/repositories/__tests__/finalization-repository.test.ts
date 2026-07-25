import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../finalization-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

function seedDraft(): void {
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(11, '数据库中的旧正文')
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, status, content_id, word_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(17, 1, 'draft', 11, 7)
}

function commitSnapshot(): ReturnType<typeof FinalizationRepository.commit> {
  return FinalizationRepository.commit({
    finalizationId: 'finalization-1',
    draftId: 17,
    chapterNumber: 1,
    chapterTitle: '第一章',
    content: '用户看到的定稿快照',
    contentHash: 'snapshot-hash',
    contentRevision: 8,
    targetFileName: '第1章 第一章.txt',
  })
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_revision INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL,
      target_file_name TEXT NOT NULL,
      publication_status TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      published_at TEXT
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
  seedDraft()
})

afterEach(() => {
  db.close()
  vi.clearAllMocks()
})

describe('FinalizationRepository transaction seam', () => {
  it('commits content, word count, finalized status, and pending publication outbox as one fact', () => {
    const committed = commitSnapshot()

    expect(committed).toMatchObject({
      finalizationId: 'finalization-1',
      draftId: 17,
      contentHash: 'snapshot-hash',
      contentRevision: 8,
      publicationStatus: 'pending',
    })
    expect(db.prepare('SELECT body FROM contents WHERE id = 11').get())
      .toEqual({ body: '用户看到的定稿快照' })
    expect(db.prepare('SELECT status, word_count FROM drafts WHERE id = 17').get())
      .toEqual({ status: 'finalized', word_count: '用户看到的定稿快照'.length })
    expect(db.prepare('SELECT * FROM finalization_outbox').get())
      .toMatchObject({
        finalization_id: 'finalization-1',
        draft_id: 17,
        content_hash: 'snapshot-hash',
        content_revision: 8,
        content_snapshot: '用户看到的定稿快照',
        target_file_name: '第1章 第一章.txt',
        publication_status: 'pending',
      })
  })

  it('returns the original submission when a lost response retries the same frozen snapshot', () => {
    commitSnapshot()

    const retried = FinalizationRepository.commit({
      finalizationId: 'response-lost-retry-id',
      draftId: 17,
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '用户看到的定稿快照',
      contentHash: 'snapshot-hash',
      contentRevision: 8,
      // 第二次调用在物理文件已经出现时可能计算出不同的碰撞候选；不能因此破坏幂等。
      targetFileName: '第1章 第一章 (retry).txt',
    })

    expect(retried.finalizationId).toBe('finalization-1')
    expect(retried.targetFileName).toBe('第1章 第一章.txt')
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get())
      .toEqual({ count: 1 })
  })

  it('rolls back content and status when writing the outbox fails', () => {
    db.exec(`
      CREATE TRIGGER reject_finalization_outbox
      BEFORE INSERT ON finalization_outbox
      BEGIN
        SELECT RAISE(ABORT, 'outbox rejected');
      END;
    `)

    expect(() => commitSnapshot()).toThrow('outbox rejected')
    expect(db.prepare('SELECT body FROM contents WHERE id = 11').get())
      .toEqual({ body: '数据库中的旧正文' })
    expect(db.prepare('SELECT status, word_count FROM drafts WHERE id = 17').get())
      .toEqual({ status: 'draft', word_count: 7 })
    expect(db.prepare('SELECT * FROM finalization_outbox').all()).toEqual([])
  })
})
