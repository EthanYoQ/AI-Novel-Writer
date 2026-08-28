import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../database'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

function makeLegacyProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-legacy-finalization-'))
  roots.push(projectRoot)
  const velaRoot = path.join(projectRoot, '.vela')
  fs.mkdirSync(velaRoot, { recursive: true })
  const legacyDb = new Database(path.join(velaRoot, 'vela.db'))
  const snapshot = '旧版本已提交的正文'
  legacyDb.exec(`
    CREATE TABLE contents (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL
    );
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
    CREATE TABLE finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      content_revision INTEGER NOT NULL,
      target_file_name TEXT NOT NULL,
      publication_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT NOT NULL DEFAULT '',
      published_at TEXT DEFAULT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE chapter_deletion_operations (
      operation_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      finalization_id TEXT NOT NULL,
      target_file_name TEXT NOT NULL DEFAULT '',
      knowledge_document_id TEXT NOT NULL DEFAULT '',
      post_process_run_ids TEXT NOT NULL DEFAULT '[]',
      manuscript_status TEXT NOT NULL DEFAULT 'pending',
      manuscript_error TEXT NOT NULL DEFAULT '',
      knowledge_status TEXT NOT NULL DEFAULT 'pending',
      knowledge_error TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT NOT NULL DEFAULT ''
    );
  `)
  legacyDb.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, snapshot)
  legacyDb.prepare(`
    INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 'finalized', 1, snapshot.length)
  legacyDb.prepare(`
    INSERT INTO finalization_outbox (
      finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, target_file_name, publication_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-finalization-1',
    1,
    1,
    '第一章',
    createHash('sha256').update(snapshot, 'utf8').digest('hex'),
    3,
    '第1章 第一章.txt',
    'pending',
  )
  legacyDb.prepare(`
    INSERT INTO chapter_deletion_operations (
      operation_id, draft_id, chapter_number, finalization_id, status
    ) VALUES (?, ?, ?, ?, ?)
  `).run('legacy-deletion-1', 99, 9, 'legacy-finalization-9', 'failed')
  legacyDb.close()
  return projectRoot
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('finalization outbox migration', () => {
  it('adds and backfills the immutable content snapshot for a pre-snapshot database', () => {
    const projectRoot = makeLegacyProject()

    initProjectDatabase(projectRoot)
    const db = getProjectDb()
    expect(db).not.toBeNull()
    const columns = db!.prepare('PRAGMA table_info(finalization_outbox)').all() as Array<{ name: string }>

    expect(columns.map(column => column.name)).toContain('content_snapshot')
    expect(columns.map(column => column.name)).toContain('knowledge_document_id')
    expect(db!.prepare(`
      SELECT knowledge_document_id FROM finalization_outbox WHERE finalization_id = ?
    `).get('legacy-finalization-1')).toEqual({ knowledge_document_id: '' })
    expect(db!.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'chapter_deletion_operations'
    `).get()).toEqual({ name: 'chapter_deletion_operations' })
    const deletionColumns = db!.prepare('PRAGMA table_info(chapter_deletion_operations)').all() as Array<{ name: string }>
    expect(deletionColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'legacy_knowledge_authorization',
      'legacy_knowledge_authorized_at',
    ]))
    expect(deletionColumns.map(column => column.name)).not.toContain('legacy_knowledge_confirmed_at')
    expect(deletionColumns.map(column => column.name)).not.toContain('legacy_knowledge_consumed_at')
    expect(db!.prepare(`
      SELECT legacy_knowledge_authorization, legacy_knowledge_authorized_at
      FROM chapter_deletion_operations WHERE operation_id = ?
    `).get('legacy-deletion-1')).toEqual({
      legacy_knowledge_authorization: 'not_required',
      legacy_knowledge_authorized_at: '',
    })
    expect(db!.prepare(`
      SELECT content_snapshot FROM finalization_outbox WHERE finalization_id = ?
    `).get('legacy-finalization-1')).toEqual({ content_snapshot: '旧版本已提交的正文' })
  })

  it('does not rewrite a legitimate empty snapshot when a current-schema database reopens', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-current-finalization-'))
    roots.push(projectRoot)
    initProjectDatabase(projectRoot)
    const first = getProjectDb()!
    const emptyHash = createHash('sha256').update('', 'utf8').digest('hex')
    first.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(10, '后来变动的正文')
    first.prepare(`
      INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(10, 1, 1, 'finalized', 10, 0)
    first.prepare(`
      INSERT INTO finalization_outbox (
        finalization_id, draft_id, chapter_number, chapter_title, content_hash,
        content_revision, content_snapshot, target_file_name, publication_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'empty-snapshot-finalization',
      10,
      1,
      '第一章',
      emptyHash,
      1,
      '',
      '第1章.txt',
      'pending',
    )

    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(getProjectDb()!.prepare(`
      SELECT content_snapshot FROM finalization_outbox WHERE finalization_id = ?
    `).get('empty-snapshot-finalization')).toEqual({ content_snapshot: '' })
  })
})
