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
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL,
      revision_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      source_draft_chapter_number INTEGER,
      source_draft_version INTEGER,
      source_draft_status TEXT,
      source_content TEXT,
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

const expectedSource = {
  id: 1,
  chapterNumber: 1,
  version: 1,
  status: 'draft' as const,
  content: '原稿',
}

describe('RevisionRepository.replacePending', () => {
  it('rejects creating a new revision without a frozen source', () => {
    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '无来源修订',
      wordCount: 6,
    })).toThrow('SOURCE_DRAFT_CHANGED')
    expect(RevisionRepository.listByDraft(1)).toEqual([])
  })

  it.each([
    ['id', { id: 999, chapterNumber: 1, version: 1, status: 'draft', content: '原稿' }],
    ['chapter', { id: 1, chapterNumber: 2, version: 1, status: 'draft', content: '原稿' }],
    ['version', { id: 1, chapterNumber: 1, version: 2, status: 'draft', content: '原稿' }],
    ['status', { id: 1, chapterNumber: 1, version: 1, status: 'reviewed', content: '原稿' }],
    ['content', { id: 1, chapterNumber: 1, version: 1, status: 'draft', content: '过期原稿' }],
  ] as const)('atomically rejects a stale frozen source %s without allocating content', (_field, expectedSource) => {
    const contentsBefore = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }

    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '不应保存的修订',
      wordCount: 7,
      expectedSource,
    })).toThrow('SOURCE_DRAFT_CHANGED')

    expect(RevisionRepository.listByDraft(1)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get())
      .toEqual(contentsBefore)
  })

  it('validates the frozen source and creates the replacement in one transaction', () => {
    const replacement = RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '合法新修订',
      wordCount: 6,
      expectedSource: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })

    expect(replacement).toEqual({ id: 1, revisionIndex: 1 })
    expect(RevisionRepository.getFull(replacement.id)).toMatchObject({
      content: '合法新修订',
      sourceDraft: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })
  })

  it('creates the replacement and discards every previous pending revision in one transaction', () => {
    const first = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '旧修订一',
      wordCount: 5,
      expectedSource,
    })
    const second = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'review-fix',
      content: '旧修订二',
      wordCount: 5,
      expectedSource,
    })

    const replacement = RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '完整新修订',
      wordCount: 6,
      expectedSource,
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
      expectedSource,
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
      expectedSource,
    })).toThrow('replacement rejected')

    expect(RevisionRepository.getPending(1).map(item => item.id)).toEqual([original.id])
    const contentsAfter = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }
    expect(contentsAfter.count).toBe(contentsBefore.count)
  })
})

describe('RevisionRepository.mergeIntoDraft', () => {
  function mergeRequest(revisionId: number) {
    return {
      revisionId,
      targetDraftId: 1,
      expectedDraftContent: '原稿',
      mergedContent: '人工确认后的合并正文',
      wordCount: 10,
    }
  }

  it('atomically persists the merged body, revised status, and revision relationship', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })

    const receipt = RevisionRepository.mergeIntoDraft(mergeRequest(revision.id))

    expect(receipt).toEqual({
      revisionId: revision.id,
      targetDraftId: 1,
      status: 'revised',
      wordCount: 10,
      idempotent: false,
    })
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({
      status: 'revised',
      word_count: 10,
      body: '人工确认后的合并正文',
    })
    expect(RevisionRepository.getFull(revision.id)).toMatchObject({
      status: 'merged',
      mergedToDraftId: 1,
    })
  })

  it.each([
    ['正文写入', 'contents'],
    ['草稿状态写入', 'drafts'],
    ['修订关系写入', 'revisions'],
  ])('rolls back every fact when %s fails', (_label, table) => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    db.exec(`
      CREATE TRIGGER reject_merge_${table} BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END;
    `)

    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id)))
      .toThrow(`injected ${table} failure`)
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({ status: 'draft', word_count: 0, body: '原稿' })
    expect(RevisionRepository.getFull(revision.id)).toMatchObject({
      status: 'pending',
      mergedToDraftId: null,
    })
  })

  it('returns the same read-back result after a lost receipt without writing again', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    const request = mergeRequest(revision.id)
    RevisionRepository.mergeIntoDraft(request)

    expect(RevisionRepository.mergeIntoDraft(request)).toEqual({
      revisionId: revision.id,
      targetDraftId: 1,
      status: 'revised',
      wordCount: 10,
      idempotent: true,
    })

    db.prepare('UPDATE contents SET body = ? WHERE id = 1').run('合并成功后的用户新编辑')
    expect(() => RevisionRepository.mergeIntoDraft(request)).toThrow('随后发生变化')
    expect(db.prepare('SELECT body FROM contents WHERE id = 1').get())
      .toEqual({ body: '合并成功后的用户新编辑' })
  })

  it('rejects a stale base, foreign revision, and finalized target without changing data', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      expectedDraftContent: '过期原稿',
    })).toThrow('正文已变化')

    const secondContentId = ContentRepository.create('另一个草稿')
    db.prepare('INSERT INTO drafts (content_id) VALUES (?)').run(secondContentId)
    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      targetDraftId: 2,
      expectedDraftContent: '另一个草稿',
    })).toThrow('不属于目标草稿')

    db.prepare("UPDATE drafts SET status = 'finalized' WHERE id = 1").run()
    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id)))
      .toThrow('不是可修改状态')
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({ status: 'finalized', word_count: 0, body: '原稿' })
    expect(RevisionRepository.getFull(revision.id)?.status).toBe('pending')
  })

  it('rejects rebasing an old revision onto a newly saved draft even when the renderer calls that body expected', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '基于 A 的 AI 修订候选',
      wordCount: 10,
      expectedSource,
    })
    db.prepare('UPDATE contents SET body = ? WHERE id = 1').run('原稿+B')

    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      expectedDraftContent: '原稿+B',
    })).toThrow('生成时源稿')

    expect(db.prepare('SELECT body FROM contents WHERE id = 1').get()).toEqual({ body: '原稿+B' })
    expect(RevisionRepository.getFull(revision.id)?.status).toBe('pending')
  })
})
