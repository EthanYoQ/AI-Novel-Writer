import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../database'
import { FinalizationService } from '../finalization-service'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database
let projectRoot: string

function seedDraft(): void {
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(11, '数据库中的旧正文')
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, status, content_id, word_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(17, 1, 'draft', 11, 7)
}

function setupSchema(): void {
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
      published_at TEXT,
      updated_at TEXT
    );
  `)
}

beforeEach(() => {
  db = new Database(':memory:')
  setupSchema()
  seedDraft()
  vi.mocked(getProjectDb).mockReturnValue(db)
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-finalization-service-'))
})

afterEach(() => {
  db.close()
  fs.rmSync(projectRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('FinalizationService publication failure seam', () => {
  it('keeps the committed finalization pending and makes it retriable when physical publication fails', async () => {
    const publish = vi.fn(async () => {
      throw new Error('disk unavailable')
    })
    const service = new FinalizationService({
      createFinalizationId: () => 'finalization-1',
      publisher: { publish },
    })

    const first = await service.finalize({
      projectRoot,
      draftId: 17,
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '用户看到的定稿快照',
      contentRevision: 8,
    })

    expect(first).toMatchObject({
      success: false,
      committed: true,
      finalizationId: 'finalization-1',
      publicationStatus: 'pending',
      contentRevision: 8,
    })
    expect(db.prepare('SELECT body FROM contents WHERE id = 11').get())
      .toEqual({ body: '用户看到的定稿快照' })
    expect(db.prepare('SELECT status FROM drafts WHERE id = 17').get())
      .toEqual({ status: 'finalized' })
    expect(db.prepare('SELECT publication_status, last_error FROM finalization_outbox').get())
      .toMatchObject({ publication_status: 'pending', last_error: expect.stringContaining('disk unavailable') })
    expect(db.prepare('SELECT content_snapshot FROM finalization_outbox').get())
      .toEqual({ content_snapshot: '用户看到的定稿快照' })

    // 即使其他路径随后错误地改写了 contents，重试也只能使用 outbox 的冻结快照。
    db.prepare('UPDATE contents SET body = ? WHERE id = ?').run('后来变动的数据库正文', 11)

    const retryPublish = vi.fn(async () => undefined)
    const retryService = new FinalizationService({ publisher: { publish: retryPublish } })
    const retried = await retryService.retry({ projectRoot, finalizationId: 'finalization-1' })
    const retriedAgain = await retryService.retry({ projectRoot, finalizationId: 'finalization-1' })

    expect(retried).toMatchObject({ success: true, committed: true, publicationStatus: 'published' })
    expect(retriedAgain).toMatchObject({ success: true, publicationStatus: 'published' })
    expect(retryPublish).toHaveBeenCalledOnce()
    expect(retryPublish).toHaveBeenCalledWith(expect.objectContaining({
      content: '用户看到的定稿快照',
    }))
    expect(db.prepare('SELECT publication_status FROM finalization_outbox').get())
      .toEqual({ publication_status: 'published' })
  })

  it('is idempotent after a lost response for the same frozen snapshot but rejects a different snapshot', async () => {
    let id = 0
    const publish = vi.fn(async () => undefined)
    const service = new FinalizationService({
      createFinalizationId: () => `finalization-${++id}`,
      publisher: { publish },
    })
    const request = {
      projectRoot,
      draftId: 17,
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '同一冻结快照',
      contentRevision: 8,
    }

    const first = await service.finalize(request)
    const replay = await service.finalize(request)
    const different = await service.finalize({
      ...request,
      content: '不是同一快照',
      contentRevision: 9,
    })

    expect(first).toMatchObject({ success: true, finalizationId: 'finalization-1' })
    expect(replay).toMatchObject({ success: true, finalizationId: 'finalization-1' })
    expect(publish).toHaveBeenCalledOnce()
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get())
      .toEqual({ count: 1 })
    expect(different).toMatchObject({ success: false, committed: false })
    expect(different.error).toContain('内容不同')
    expect(db.prepare('SELECT content_snapshot FROM finalization_outbox').get())
      .toEqual({ content_snapshot: '同一冻结快照' })
  })

  it('refuses retry before publishing when the immutable snapshot no longer matches its hash', async () => {
    const failedPublisher = new FinalizationService({
      createFinalizationId: () => 'finalization-1',
      publisher: { publish: vi.fn(async () => { throw new Error('disk unavailable') }) },
    })
    await failedPublisher.finalize({
      projectRoot,
      draftId: 17,
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '不可变正文',
      contentRevision: 8,
    })
    db.prepare('UPDATE finalization_outbox SET content_snapshot = ?').run('被篡改的快照')
    const publish = vi.fn(async () => undefined)

    const result = await new FinalizationService({ publisher: { publish } }).retry({
      projectRoot,
      finalizationId: 'finalization-1',
    })

    expect(result).toMatchObject({ success: false, committed: true })
    expect(result.error).toContain('哈希不一致')
    expect(publish).not.toHaveBeenCalled()
  })
})
