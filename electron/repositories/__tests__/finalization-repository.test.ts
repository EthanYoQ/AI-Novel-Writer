import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizationRepository } from '../finalization-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
  getCurrentProjectPath: vi.fn(() => null),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database
const roots: string[] = []

function seedDraft(): void {
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(11, '数据库中的旧正文')
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, status, content_id, word_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(17, 1, 'draft', 11, 7)
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function commitSnapshot(contentRevision = 8): ReturnType<typeof FinalizationRepository.commit> {
  return FinalizationRepository.commit({
    finalizationId: 'finalization-1',
    draftId: 17,
    chapterNumber: 1,
    chapterTitle: '第一章',
    content: 'Finalized snapshot shown to the user',
    contentHash: hash('Finalized snapshot shown to the user'),
    contentRevision,
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
      version INTEGER NOT NULL DEFAULT 1,
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
      knowledge_document_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
  vi.mocked(getCurrentProjectPath).mockReturnValue(null)
  seedDraft()
})

afterEach(() => {
  db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

function freezeFinalization(id: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-finalization-freeze-'))
  roots.push(root)
  const storage = path.join(root, '.ai-novel')
  fs.mkdirSync(storage)
  fs.writeFileSync(path.join(storage, 'portable-runtime-freeze.json'), JSON.stringify({
    version: 1, originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'snapshot-1',
    nonReplayable: true, requiresRuntimeFreezeGuard: true, avatarReferenceProjections: [], records: [{
      projectionId: `history:finalization_outbox:${id}`, table: 'finalization_outbox', recordId: id,
      terminalState: 'pending', projection: {}, projectionHash: 'a'.repeat(64), excludedFields: [],
      nonReplayable: true, originalReceiptVerified: false,
    }],
  }), { mode: 0o600 })
  return root
}

describe('FinalizationRepository transaction seam', () => {
  it('persists the first positive source revision unchanged in the outbox', () => {
    expect(commitSnapshot(1).contentRevision).toBe(1)
    expect(db.prepare('SELECT content_revision FROM finalization_outbox WHERE draft_id=17').get())
      .toEqual({ content_revision: 1 })
  })

  it('does not link a knowledge document to a frozen imported outbox', () => {
    commitSnapshot()
    const root = freezeFinalization('finalization-1')
    vi.mocked(getCurrentProjectPath).mockReturnValue(root)
    expect(() => FinalizationRepository.linkKnowledgeDocument(17, 'knowledge-document')).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(db.prepare('SELECT knowledge_document_id FROM finalization_outbox WHERE draft_id=17').get())
      .toEqual({ knowledge_document_id: '' })
  })

  it('commits content, word count, finalized status, and pending publication outbox as one fact', () => {
    const committed = commitSnapshot()

    expect(committed).toMatchObject({
      finalizationId: 'finalization-1',
      draftId: 17,
      contentHash: hash('Finalized snapshot shown to the user'),
      contentRevision: 8,
      publicationStatus: 'pending',
    })
    expect(db.prepare('SELECT body FROM contents WHERE id = 11').get())
      .toEqual({ body: 'Finalized snapshot shown to the user' })
    expect(db.prepare('SELECT status, word_count FROM drafts WHERE id = 17').get())
      .toEqual({ status: 'finalized', word_count: countDraftUnits('Finalized snapshot shown to the user') })
    expect(db.prepare('SELECT * FROM finalization_outbox').get())
      .toMatchObject({
        finalization_id: 'finalization-1',
        draft_id: 17,
        content_hash: hash('Finalized snapshot shown to the user'),
        content_revision: 8,
        content_snapshot: 'Finalized snapshot shown to the user',
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
      content: 'Finalized snapshot shown to the user',
      contentHash: hash('Finalized snapshot shown to the user'),
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

  it('returns one frozen authoritative export row per sparse finalized chapter without blueprints', () => {
    commitSnapshot()
    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(12, 'obsolete chapter one')
    db.prepare(`
      INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(18, 1, 0, 'finalized', 12, 20)
    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(13, '第三章定稿')
    db.prepare(`
      INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(19, 3, 4, 'finalized', 13, 5)

    expect(FinalizationRepository.listAuthoritativeForExport()).toEqual([
      {
        draftId: 17,
        chapterNumber: 1,
        version: 1,
        title: '第一章',
        content: 'Finalized snapshot shown to the user',
        finalizationId: 'finalization-1',
        contentHash: hash('Finalized snapshot shown to the user'),
      },
      {
        draftId: 19,
        chapterNumber: 3,
        version: 4,
        title: '',
        content: '第三章定稿',
        finalizationId: null,
        contentHash: hash('第三章定稿'),
      },
    ])
  })

  it('revalidates the exact finalized draft, outbox identity, and body integrity frozen for export', () => {
    commitSnapshot()
    const receipt = FinalizationRepository.listAuthoritativeForExport()
      .map(({ draftId, chapterNumber, version, finalizationId, contentHash }) => ({
        draftId,
        chapterNumber,
        version,
        finalizationId,
        contentHash,
      }))

    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(true)

    db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(12, 'conflicting final')
    db.prepare(`
      INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(18, 1, 1, 'finalized', 12, 17)
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
    db.prepare('DELETE FROM drafts WHERE id = 18').run()
    db.prepare('DELETE FROM contents WHERE id = 12').run()

    db.prepare("UPDATE finalization_outbox SET content_snapshot = 'other body' WHERE draft_id = 17").run()
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
    db.prepare(`
      UPDATE finalization_outbox SET content_snapshot = ?, content_hash = 'bad-hash' WHERE draft_id = 17
    `).run('Finalized snapshot shown to the user')
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
    db.prepare('UPDATE finalization_outbox SET content_hash = ?, finalization_id = ? WHERE draft_id = 17')
      .run(hash('Finalized snapshot shown to the user'), 'replacement-finalization')
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
    db.prepare('UPDATE finalization_outbox SET finalization_id = ? WHERE draft_id = 17')
      .run('finalization-1')
    db.prepare('UPDATE drafts SET version = 2 WHERE id = 17').run()
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
    db.prepare('UPDATE drafts SET version = 1, id = 18 WHERE id = 17').run()
    expect(FinalizationRepository.matchesAuthoritativeExportReceipt(receipt)).toBe(false)
  })

  it('rejects a finalized export snapshot whose outbox identity or body disagrees with the draft fact', () => {
    commitSnapshot()
    db.prepare(`
      UPDATE finalization_outbox
      SET chapter_number = 2
      WHERE draft_id = 17
    `).run()

    expect(() => FinalizationRepository.listAuthoritativeForExport())
      .toThrow('定稿导出快照身份不一致')

    db.prepare(`
      UPDATE finalization_outbox
      SET chapter_number = 1, content_snapshot = 'other body'
      WHERE draft_id = 17
    `).run()
    expect(() => FinalizationRepository.listAuthoritativeForExport())
      .toThrow('定稿导出快照正文不一致')
  })

  it('rejects an authoritative finalized draft with no body instead of silently omitting it', () => {
    commitSnapshot()
    db.prepare('UPDATE contents SET body = ? WHERE id = 11').run('')
    db.prepare('UPDATE finalization_outbox SET content_snapshot = ? WHERE draft_id = 17').run('')

    expect(() => FinalizationRepository.listAuthoritativeForExport())
      .toThrow('第 1 章定稿正文为空')
  })
})
