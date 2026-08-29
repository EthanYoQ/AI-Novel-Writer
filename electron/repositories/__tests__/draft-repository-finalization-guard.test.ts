import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../database'
import { DraftRepository } from '../draft-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'write',
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, '定稿快照正文')
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 'finalized', 1, 6)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
  vi.clearAllMocks()
})

describe('DraftRepository finalized immutability guard', () => {
  it('lists the finalized outbox chapter title as authoritative draft metadata', () => {
    db.prepare(`
      INSERT INTO finalization_outbox (finalization_id, draft_id, chapter_number, chapter_title)
      VALUES (?, ?, ?, ?)
    `).run('finalization-1', 1, 1, '蓝镜初亮')

    expect(DraftRepository.listAll()).toMatchObject([{
      id: 1,
      chapterNumber: 1,
      chapterTitle: '蓝镜初亮',
      status: 'finalized',
    }])
  })

  it('keeps the finalized title in chapter-scoped metadata reloads', () => {
    db.prepare(`
      INSERT INTO finalization_outbox (finalization_id, draft_id, chapter_number, chapter_title)
      VALUES (?, ?, ?, ?)
    `).run('finalization-1', 1, 1, '蓝镜初亮')

    expect(DraftRepository.listByChapter(1)[0]?.chapterTitle).toBe('蓝镜初亮')
    expect(DraftRepository.getMeta(1)?.chapterTitle).toBe('蓝镜初亮')
    expect(DraftRepository.getLatestByChapter(1)?.chapterTitle).toBe('蓝镜初亮')
    expect(DraftRepository.getFinalizedByChapter(1)?.chapterTitle).toBe('蓝镜初亮')
  })

  it('lists draft metadata across chapters without relying on blueprint rows', () => {
    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(2, '第二章定稿正文')
    db.prepare(`
      INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(2, 2, 1, 'finalized', 2, 7)

    expect(DraftRepository.listAll()).toMatchObject([
      { id: 1, chapterNumber: 1, version: 1, status: 'finalized' },
      { id: 2, chapterNumber: 2, version: 1, status: 'finalized' },
    ])
  })

  it('does not allow a generic content update to silently mutate finalized database fact', () => {
    expect(() => DraftRepository.updateContent(1, '后续编辑正文', 6))
      .toThrow('不可变事实')
    expect(db.prepare('SELECT body FROM contents WHERE id = 1').get())
      .toEqual({ body: '定稿快照正文' })
    expect(db.prepare('SELECT word_count FROM drafts WHERE id = 1').get())
      .toEqual({ word_count: 6 })
  })

  it('does not allow a generic status update to reopen finalized fact', () => {
    expect(() => DraftRepository.updateStatus(1, 'draft'))
      .toThrow('不可变事实')
    expect(db.prepare('SELECT status FROM drafts WHERE id = 1').get())
      .toEqual({ status: 'finalized' })
  })
})
