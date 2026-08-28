import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import type { ImportRunPrepareRequest } from '../../../src/shared/import-run'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let root = ''

function chapter(number: number, content = `reference-${number}`) {
  return {
    number,
    title: `Chapter ${number}`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content, 'utf8'),
  }
}

function request(chapters = [chapter(1)], overrides: Partial<ImportRunPrepareRequest> = {}): ImportRunPrepareRequest {
  return {
    runId: 'import-run-1',
    purpose: 'reference',
    sourceFingerprint: 'a'.repeat(64),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 42 }],
    locale: 'en-US',
    chapters,
    ...overrides,
  }
}

function installLegacyRun(snapshots: string[], totalChapters: number): void {
  closeProjectDatabase()
  const legacy = new Database(path.join(root, '.vela', 'vela.db'))
  legacy.exec(`
    DROP TABLE import_runs;
    CREATE TABLE import_runs (
      id TEXT PRIMARY KEY,
      source_fingerprint TEXT NOT NULL,
      manifest_fingerprint TEXT NOT NULL,
      source_display_json TEXT NOT NULL DEFAULT '[]',
      locale TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'knowledge',
      status TEXT NOT NULL DEFAULT 'ready',
      completed_batches_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT NOT NULL DEFAULT '',
      resumable INTEGER NOT NULL DEFAULT 1,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      total_chapters INTEGER NOT NULL,
      total_content_size INTEGER NOT NULL DEFAULT 0,
      completed_chapters INTEGER NOT NULL DEFAULT 0,
      base_run_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL
    );
    INSERT INTO import_runs (
      id, source_fingerprint, manifest_fingerprint, locale, total_chapters, total_content_size
    ) VALUES ('legacy-run', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'en-US', ${totalChapters}, 999);
  `)
  const insert = legacy.prepare(`
    INSERT INTO import_run_chapters (
      run_id, chapter_number, title, content_fingerprint, content_size, content_snapshot
    ) VALUES ('legacy-run', ?, ?, ?, ?, ?)
  `)
  snapshots.forEach((content, index) => insert.run(
    index + 1,
    `Legacy ${index + 1}`,
    createHash('sha256').update(content).digest('hex'),
    Buffer.byteLength(content, 'utf8'),
    content,
  ))
  legacy.close()
  initProjectDatabase(root)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-run-'))
  initProjectDatabase(root)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ImportRunRepository', () => {
  it('migrates the pre-purpose import-run schema before creating purpose indexes', () => {
    closeProjectDatabase()
    const legacy = new Database(path.join(root, '.vela', 'vela.db'))
    legacy.exec(`
      DROP TABLE import_runs;
      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        source_display_json TEXT NOT NULL DEFAULT '[]',
        locale TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'knowledge',
        status TEXT NOT NULL DEFAULT 'ready',
        completed_batches_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT NOT NULL DEFAULT '',
        resumable INTEGER NOT NULL DEFAULT 1,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        total_chapters INTEGER NOT NULL,
        total_content_size INTEGER NOT NULL DEFAULT 0,
        completed_chapters INTEGER NOT NULL DEFAULT 0,
        base_run_id TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL
      );
    `)
    legacy.close()

    expect(() => initProjectDatabase(root)).not.toThrow()
    const columns = getProjectDb()!.prepare('PRAGMA table_info(import_runs)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'purpose', 'root_run_id', 'effect_namespace', 'execution_epoch', 'manifest_chapter_count',
    ]))
  })

  it('backfills a legacy manifest word count from its frozen chapter snapshots', () => {
    installLegacyRun(['甲😀', 'second'], 2)

    expect(ImportRunRepository.get('legacy-run')).toMatchObject({
      manifestChapterCount: 2,
      manifestWordCount: '甲😀'.length + 'second'.length,
      resumable: true,
    })
  })

  it('marks a legacy run non-resumable when its frozen snapshots cannot reconstruct the manifest', () => {
    installLegacyRun(['only one frozen chapter'], 2)

    expect(ImportRunRepository.get('legacy-run')).toMatchObject({
      status: 'failed',
      resumable: false,
      lastError: expect.stringContaining('cannot be resumed'),
      manifestWordCount: 0,
    })
    expect(() => ImportRunRepository.startOrResume('legacy-run', 'renderer-a'))
      .toThrow(/cannot be resumed|不可恢复/i)
  })

  it('rejects an empty frozen manifest before it can become a zero-word resumable run', () => {
    expect(() => ImportRunRepository.prepare(request([chapter(1, '')])))
      .toThrow(/快照无效/)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_runs').get())
      .toEqual({ count: 0 })
  })

  it('migrates a bounded chapter snapshot and never persists paths, grants, or credentials', () => {
    const prepared = ImportRunRepository.prepare(request())

    expect(prepared).toMatchObject({ classification: 'new', run: { id: 'import-run-1', stage: 'knowledge', status: 'ready' } })
    expect(ImportRunRepository.listChapterBatch('import-run-1', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 1, content: 'reference-1' })])
    const serialized = JSON.stringify(prepared)
    expect(serialized).not.toContain('grantId')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('C:\\')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_run_chapters').get())
      .toEqual({ count: 1 })
  })

  it('fails closed for the reserved author-manuscript purpose', () => {
    expect(() => ImportRunRepository.prepare(request([chapter(1)], {
      runId: 'unsupported-author',
      purpose: 'author-manuscript',
    }))).toThrow(/不支持作者手稿/)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_runs').get()).toEqual({ count: 0 })
  })

  it('records batch checkpoints idempotently and exposes a resumable failure', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2)]))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution

    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-2', execution)).toMatchObject({ newlyCompleted: true })
    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-2', execution)).toMatchObject({ newlyCompleted: false })
    ImportRunRepository.fail('import-run-1', 'knowledge', 'provider unavailable', execution)

    expect(ImportRunRepository.listResumable()).toEqual([
      expect.objectContaining({
        id: 'import-run-1',
        stage: 'knowledge',
        status: 'failed',
        resumable: true,
        completedBatches: { knowledge: ['1-2'] },
        lastError: 'provider unavailable',
      }),
    ])
  })

  it('reopens the same project database with the frozen run and checkpoint intact', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2)]))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-2', execution)
    ImportRunRepository.fail('import-run-1', 'global', 'restart fixture', execution)

    closeProjectDatabase()
    initProjectDatabase(root)

    expect(ImportRunRepository.get('import-run-1')).toMatchObject({
      stage: 'global', status: 'failed', resumable: true,
      completedBatches: { knowledge: ['1-2'] },
    })
    expect(ImportRunRepository.listChapterBatch('import-run-1', { afterChapterNumber: 0, limit: 1 }))
      .toEqual([expect.objectContaining({ number: 1, content: 'reference-1' })])
  })

  it('classifies only completed observable effects as duplicate, new, or conflict', () => {
    ImportRunRepository.prepare(request([chapter(1)]))
    let execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.fail('import-run-1', 'global', 'interrupted', execution)
    expect(ImportRunRepository.prepare(request([chapter(1)], { runId: 'failed-reselection' })).classification)
      .toBe('resumable')

    execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.complete('import-run-1', execution)
    expect(ImportRunRepository.prepare(request([chapter(1)], { runId: 'duplicate' }))).toMatchObject({
      classification: 'exact-duplicate',
      run: undefined,
    })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_runs').get()).toEqual({ count: 1 })

    expect(ImportRunRepository.prepare(request([chapter(1), chapter(2)], { runId: 'incremental' }))).toMatchObject({
      classification: 'new',
      newChapterNumbers: [2],
      run: { id: 'incremental' },
    })
    expect(ImportRunRepository.listChapterBatch('incremental', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 2 })])
    execution = ImportRunRepository.startOrResume('incremental', 'test-runner').execution
    ImportRunRepository.complete('incremental', execution)
    expect(ImportRunRepository.prepare(request([chapter(1), chapter(2), chapter(3)], { runId: 'second-incremental' })))
      .toMatchObject({ classification: 'new', newChapterNumbers: [3] })

    expect(ImportRunRepository.prepare(request([chapter(1, 'changed')], { runId: 'conflict' }))).toMatchObject({
      classification: 'conflict',
      conflictChapterNumbers: [1],
      run: undefined,
    })
  })

  it('applies cancellation only when a completed batch reaches a safe boundary', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2)]))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.requestCancel('import-run-1', execution)

    expect(ImportRunRepository.get('import-run-1')).toMatchObject({ status: 'running', cancelRequested: true })
    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1', execution)).toMatchObject({
      cancelApplied: true,
      run: { status: 'cancelled', resumable: true },
    })
  })

  it('accepts 5000 chapters with paged reads and rejects 5001 or aggregate overflow before writes', () => {
    const maximum = Array.from({ length: 5_000 }, (_, index) => chapter(index + 1, 'x'))
    const prepared = ImportRunRepository.prepare(request(maximum, { runId: 'maximum-run' }))
    expect(prepared.run).toMatchObject({ totalChapters: 5_000, manifestChapterCount: 5_000 })
    expect(ImportRunRepository.listChapterBatch('maximum-run', { afterChapterNumber: 0, limit: 1_000 }))
      .toHaveLength(100)

    expect(() => ImportRunRepository.prepare(request(
      [...maximum, chapter(5_001, 'x')],
      { runId: 'too-many' },
    ))).toThrow(/章节清单/)
    const sharedLargeContent = 'x'.repeat(15 * 1024 * 1024)
    expect(() => ImportRunRepository.prepare(request(
      Array.from({ length: 9 }, (_, index) => chapter(index + 1, sharedLargeContent)),
      { runId: 'too-large' },
    ))).toThrow(/总字节数/)
    expect(getProjectDb()!.prepare(`
      SELECT COUNT(*) AS count FROM import_runs WHERE id IN ('too-many', 'too-large')
    `).get()).toEqual({ count: 0 })
  })
})
