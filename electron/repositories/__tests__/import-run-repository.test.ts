import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import type { ImportRunPrepareRequest } from '../../../src/shared/import-run'
import {
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../../../src/services/workflows/import-run-orchestrator'

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

function markRunCompleted(runId: string): void {
  getProjectDb()!.prepare(`
    UPDATE import_runs
    SET stage = 'completed', status = 'completed', resumable = 0,
        execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        completed_chapters = total_chapters, completed_at = datetime('now')
    WHERE id = ?
  `).run(runId)
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

  it('migrates legacy chapter rows to opaque source affiliations and stable mappings', () => {
    ImportRunRepository.prepare(request())
    markRunCompleted('import-run-1')
    closeProjectDatabase()

    const legacy = new Database(path.join(root, '.vela', 'vela.db'))
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      DROP TABLE import_source_chapter_map;
      ALTER TABLE import_run_chapters RENAME TO import_run_chapters_current;
      CREATE TABLE import_run_chapters (
        run_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content_fingerprint TEXT NOT NULL,
        content_size INTEGER NOT NULL,
        content_snapshot TEXT NOT NULL,
        PRIMARY KEY (run_id, chapter_number)
      );
      INSERT INTO import_run_chapters (
        run_id, chapter_number, title, content_fingerprint, content_size, content_snapshot
      )
      SELECT run_id, chapter_number, title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters_current;
      DROP TABLE import_run_chapters_current;
    `)
    legacy.close()

    initProjectDatabase(root)
    const columns = getProjectDb()!.prepare('PRAGMA table_info(import_run_chapters)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'source_id', 'source_chapter_number',
    ]))
    expect(getProjectDb()!.prepare(`
      SELECT source_id, source_chapter_number FROM import_run_chapters WHERE run_id = 'import-run-1'
    `).get()).toEqual({ source_id: `legacy:${'a'.repeat(64)}`, source_chapter_number: 1 })
    expect(getProjectDb()!.prepare(`
      SELECT chapter_number FROM import_source_chapter_map
      WHERE purpose = 'reference' AND source_chapter_number = 1
    `).get()).toEqual({ chapter_number: 1 })
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

  it('derives resumable knowledge progress from validated checkpoints across reopen and later stages', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2), chapter(3)]))
    let execution = ImportRunRepository.startOrResume('import-run-1', 'progress-runner').execution
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-2', execution)
    expect(ImportRunRepository.get('import-run-1')).toMatchObject({
      completedChapters: 2, progressCompleted: 2, progressTotal: 3,
    })
    ImportRunRepository.fail('import-run-1', 'knowledge', 'pause', execution)

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.get('import-run-1')).toMatchObject({ completedChapters: 2 })

    execution = ImportRunRepository.startOrResume('import-run-1', 'progress-runner-2').execution
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', '3-3', execution)
    expect(ImportRunRepository.advanceStage('import-run-1', 'knowledge', 'global', execution)).toMatchObject({
      completedChapters: 3, progressCompleted: 0, progressTotal: 1,
    })
  })

  it('reopens the same project database with the frozen run and checkpoint intact', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2)]))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-2', execution)
    ImportRunRepository.advanceStage('import-run-1', 'knowledge', 'global', execution)
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
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.fail('import-run-1', 'knowledge', 'interrupted', execution)
    expect(ImportRunRepository.prepare(request([chapter(1)], { runId: 'failed-reselection' })).classification)
      .toBe('resumable')

    markRunCompleted('import-run-1')
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
    markRunCompleted('incremental')
    expect(ImportRunRepository.prepare(request([chapter(1), chapter(2), chapter(3)], { runId: 'second-incremental' })))
      .toMatchObject({ classification: 'new', newChapterNumbers: [3] })

    expect(ImportRunRepository.prepare(request([chapter(1, 'changed')], { runId: 'conflict' }))).toMatchObject({
      classification: 'conflict',
      conflictChapterNumbers: [1],
      run: undefined,
    })
  })

  it('imports only chapters from newly added sources and keeps their global chapter numbers stable', async () => {
    const sourceA = '11111111-1111-4111-8111-111111111111'
    const sourceB = '22222222-2222-4222-8222-222222222222'
    const fromSource = (sourceIndex: number, sourceChapterNumber: number, content: string) => ({
      ...chapter(sourceChapterNumber, content),
      sourceIndex,
      sourceChapterNumber,
    })

    ImportRunRepository.prepare(request([fromSource(0, 1, 'A chapter')], {
      sourceDisplay: [{ displayName: 'a.txt', mediaType: 'text/plain', size: 9 }],
    }))
    markRunCompleted('import-run-1')

    const extended = ImportRunRepository.prepare(request([
      fromSource(0, 1, 'A chapter'),
      fromSource(1, 1, 'B chapter'),
    ], {
      runId: 'a-plus-b',
      sourceFingerprint: 'b'.repeat(64),
      sourceIds: [sourceA, sourceB],
      sourceFingerprints: ['a'.repeat(64), 'd'.repeat(64)],
      sourceDisplay: [
        { displayName: 'a.txt', mediaType: 'text/plain', size: 9 },
        { displayName: 'b.txt', mediaType: 'text/plain', size: 9 },
      ],
    }))

    expect(extended).toMatchObject({
      classification: 'new',
      newChapterNumbers: [2],
      duplicateChapterNumbers: [1],
    })
    expect(ImportRunRepository.listChapterBatch('a-plus-b', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 2, content: 'B chapter' })])
    const importedByWorkflow: Array<{ number: number; content: string }> = []
    const workflowOwner = 'repository-workflow-proof'
    const workflowDependencies: ImportRunOrchestratorDependencies = {
      getRun: async runId => ImportRunRepository.get(runId),
      startOrResume: async (runId, owner) => ImportRunRepository.startOrResume(runId, owner),
      renewExecution: async (runId, lease) => ImportRunRepository.renewExecution(runId, lease),
      getEffectReceipt: vi.fn(async () => null),
      prepareEffectReceipt: vi.fn(async () => { throw new Error('not used in knowledge stage') }),
      commitEffectReceipt: vi.fn(async () => { throw new Error('not used in knowledge stage') }),
      replayCommittedEffect: vi.fn(async () => undefined),
      listChapters: async (runId, afterChapterNumber, limit) => (
        ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
      ),
      importReference: async item => { importedByWorkflow.push({ number: item.number, content: item.content }) },
      inferGlobal: vi.fn(async () => undefined),
      analyzeStyle: vi.fn(async () => undefined),
      inferBlueprints: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      completeBatch: async (runId, stage, batchId, lease) => (
        ImportRunRepository.completeBatch(runId, stage, batchId, lease)
      ),
      advanceStage: async (runId, stage, nextStage, lease) => (
        ImportRunRepository.advanceStage(runId, stage, nextStage, lease)
      ),
      fail: async (runId, stage, error, lease) => ImportRunRepository.fail(runId, stage, error, lease),
      cancelAtBoundary: async (runId, lease) => ImportRunRepository.cancelAtBoundary(runId, lease),
      complete: async (runId, lease) => ImportRunRepository.complete(runId, lease),
    }
    await new ImportRunOrchestrator(workflowDependencies).executeStage(
      'a-plus-b',
      'knowledge',
      workflowOwner,
      { cancelled: false },
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    )
    expect(importedByWorkflow).toEqual([{ number: 2, content: 'B chapter' }])
    expect(ImportRunRepository.get('a-plus-b')).toMatchObject({ stage: 'global' })
    markRunCompleted('a-plus-b')

    expect(ImportRunRepository.prepare(request([fromSource(0, 1, 'B chapter')], {
      runId: 'only-b',
      sourceFingerprint: 'c'.repeat(64),
      sourceIds: [sourceB],
      sourceFingerprints: ['d'.repeat(64)],
      sourceDisplay: [{ displayName: 'renamed-b.txt', mediaType: 'text/plain', size: 9 }],
    }))).toMatchObject({
      classification: 'exact-duplicate',
      duplicateChapterNumbers: [2],
    })
  })

  it('applies cancellation only when a completed batch reaches a safe boundary', () => {
    ImportRunRepository.prepare(request([chapter(1), chapter(2)]))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    ImportRunRepository.requestCancel('import-run-1', execution)

    expect(ImportRunRepository.get('import-run-1')).toMatchObject({ status: 'running', cancelRequested: true })
    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', '1-1', execution)).toMatchObject({
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
