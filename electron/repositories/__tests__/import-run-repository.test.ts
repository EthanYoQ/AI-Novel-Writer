import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import {
  createImportRunChapterBatchCheckpointId,
  type ImportRunExecutionAuthority,
  type ImportRunPrepareRequest,
} from '../../../src/shared/import-run'
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

function commitKnowledge(runId: string, authority: ImportRunExecutionAuthority, chapters: ReturnType<typeof chapter>[]) {
  for (const item of chapters) {
    const binding = ImportRunRepository.resolveReferenceImportAuthority(runId, authority, item.number)
    const documentId = createHash('sha256').update(`reference-import:${binding.stableKey}`).digest('hex')
    getProjectDb()!.prepare(`
      INSERT OR IGNORE INTO import_reference_documents (
        document_id, idempotency_key_hash, content_hash, chunk_set_hash,
        expected_chunk_count, corpus_kind, state
      ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
    `).run(
      documentId,
      createHash('sha256').update(binding.stableKey).digest('hex'),
      binding.contentFingerprint,
      createHash('sha256').update(`chunks:${item.number}`).digest('hex'),
    )
    ImportRunRepository.commitReferenceImportReceipt(
      runId, authority, item.number, documentId,
    )
  }
  return createImportRunChapterBatchCheckpointId(chapters)
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

const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'
const SOURCE_C = '33333333-3333-4333-8333-333333333333'

function prepareParsedRun(
  runId: string,
  sources: Array<{ id: string; fingerprint: string; content: string }>,
) {
  const sourceFingerprint = createHash('sha256')
    .update(sources.map(source => source.fingerprint).join(':'))
    .digest('hex')
  ImportRunRepository.beginParsing({
    runId,
    purpose: 'reference',
    sourceFingerprint,
    sourceIds: sources.map(source => source.id),
    sourceFingerprints: sources.map(source => source.fingerprint),
    sourceDisplay: sources.map((source, index) => ({
      displayName: `source-${index + 1}.txt`,
      mediaType: 'text/plain',
      size: Buffer.byteLength(source.content, 'utf8'),
    })),
    locale: 'en-US',
  })
  for (const source of sources) {
    ImportRunRepository.commitParsedSource(runId, source.id, [chapter(1, source.content)])
  }
  return () => ImportRunRepository.finalizeParsing(runId)
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

  it('expands the shipped stage constraint without losing indexes or child foreign keys', () => {
    closeProjectDatabase()
    const legacy = new Database(path.join(root, '.vela', 'vela.db'))
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      DROP TABLE import_runs;
      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL DEFAULT 'reference'
          CHECK(purpose IN ('reference', 'author-manuscript')),
        root_run_id TEXT NOT NULL,
        effect_namespace TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        source_display_json TEXT NOT NULL DEFAULT '[]',
        locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
        stage TEXT NOT NULL DEFAULT 'knowledge'
          CHECK(stage IN ('knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed')),
        status TEXT NOT NULL DEFAULT 'ready'
          CHECK(status IN ('ready', 'running', 'failed', 'cancelled', 'completed')),
        completed_batches_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT NOT NULL DEFAULT '',
        resumable INTEGER NOT NULL DEFAULT 1 CHECK(resumable IN (0, 1)),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        execution_owner TEXT NOT NULL DEFAULT '',
        execution_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        total_chapters INTEGER NOT NULL,
        total_content_size INTEGER NOT NULL DEFAULT 0,
        manifest_chapter_count INTEGER NOT NULL,
        manifest_content_size INTEGER NOT NULL DEFAULT 0,
        manifest_word_count INTEGER NOT NULL DEFAULT 0,
        completed_chapters INTEGER NOT NULL DEFAULT 0,
        base_run_id TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (base_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
      );
    `)
    legacy.close()

    expect(() => initProjectDatabase(root)).not.toThrow()
    const db = getProjectDb()!
    const schema = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_runs'
    `).get() as { sql: string }
    expect(schema.sql).toContain('author-commit')
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_runs'
    `).all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      'idx_import_runs_source_status',
      'idx_import_runs_resumable',
      'idx_import_runs_purpose_source_status',
    ]))
    expect(db.pragma('foreign_key_check')).toEqual([])

    const manuscript = [chapter(1, 'author chapter one')]
    const preview = FinalizedDraftImportRepository.preview(manuscript.map(item => ({
      chapterNumber: item.number,
      title: item.title,
      content: item.content,
      wordCount: item.content.length,
    })))
    expect(ImportRunRepository.prepare(request(manuscript, {
      purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    })).run).toMatchObject({ stage: 'author-commit', purpose: 'author-manuscript' })
  })

  it.each([
    {
      label: '#152-only reference schema',
      extraColumn: "legacy_source_fingerprint TEXT NOT NULL DEFAULT ''",
      extraName: 'legacy_source_fingerprint',
      extraValue: 'c'.repeat(64),
      purpose: 'reference',
      stage: 'prepared',
      stages: "'parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed'",
    },
    {
      label: '#153-only author schema',
      extraColumn: "authority_fingerprint TEXT NOT NULL DEFAULT ''",
      extraName: 'authority_fingerprint',
      extraValue: 'd'.repeat(64),
      purpose: 'author-manuscript',
      stage: 'author-publish',
      stages: "'knowledge', 'global', 'style', 'blueprints', 'author-commit', 'author-publish', 'author-postprocess', 'refresh', 'completed'",
    },
  ])('migrates a $label without losing its purpose-specific state', (variant) => {
    closeProjectDatabase()
    const legacy = new Database(path.join(root, '.vela', 'vela.db'))
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      DROP TABLE import_runs;
      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL DEFAULT 'reference'
          CHECK(purpose IN ('reference', 'author-manuscript')),
        root_run_id TEXT NOT NULL,
        effect_namespace TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        ${variant.extraColumn},
        source_display_json TEXT NOT NULL DEFAULT '[]',
        locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
        stage TEXT NOT NULL DEFAULT 'knowledge' CHECK(stage IN (${variant.stages})),
        status TEXT NOT NULL DEFAULT 'ready'
          CHECK(status IN ('ready', 'running', 'failed', 'cancelled', 'completed')),
        completed_batches_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT NOT NULL DEFAULT '',
        resumable INTEGER NOT NULL DEFAULT 1 CHECK(resumable IN (0, 1)),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        execution_owner TEXT NOT NULL DEFAULT '',
        execution_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        total_chapters INTEGER NOT NULL,
        total_content_size INTEGER NOT NULL DEFAULT 0,
        manifest_chapter_count INTEGER NOT NULL,
        manifest_content_size INTEGER NOT NULL DEFAULT 0,
        manifest_word_count INTEGER NOT NULL DEFAULT 0,
        completed_chapters INTEGER NOT NULL DEFAULT 0,
        base_run_id TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (base_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
      );
      INSERT INTO import_runs (
        id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
        ${variant.extraName}, locale, stage, status, total_chapters, manifest_chapter_count
      ) VALUES (
        'split-schema-run', '${variant.purpose}', 'split-schema-run',
        'import:${variant.purpose}:split-schema-run', '${'a'.repeat(64)}', '${'b'.repeat(64)}',
        '${variant.extraValue}', 'en-US', '${variant.stage}', 'ready', 1, 1
      );
    `)
    legacy.close()

    expect(() => initProjectDatabase(root)).not.toThrow()
    const db = getProjectDb()!
    const columns = db.prepare('PRAGMA table_info(import_runs)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'authority_fingerprint', 'legacy_source_fingerprint',
    ]))
    const schema = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_runs'
    `).get() as { sql: string }
    expect(schema.sql).toContain("'parsing'")
    expect(schema.sql).toContain("'author-commit'")
    expect(db.prepare(`
      SELECT purpose, stage, authority_fingerprint, legacy_source_fingerprint
      FROM import_runs WHERE id = 'split-schema-run'
    `).get()).toEqual({
      purpose: variant.purpose,
      stage: variant.stage,
      authority_fingerprint: variant.extraName === 'authority_fingerprint' ? variant.extraValue : '',
      legacy_source_fingerprint: variant.extraName === 'legacy_source_fingerprint' ? variant.extraValue : '',
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
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
    expect(serialized).not.toContain('sourceFingerprint')
    expect(serialized).not.toContain('manifestFingerprint')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_run_chapters').get())
      .toEqual({ count: 1 })
  })

  it('prepares an author manuscript at its original chapter numbers only from a frozen authority preview', () => {
    const authorChapter = chapter(1, 'author chapter one')
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: 1,
      title: authorChapter.title,
      content: authorChapter.content,
      wordCount: authorChapter.content.length,
    }])
    const prepared = ImportRunRepository.prepare(request([authorChapter], {
      runId: 'unsupported-author',
      purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))

    expect(prepared).toMatchObject({
      classification: 'new',
      newChapterNumbers: [1],
      run: {
        purpose: 'author-manuscript',
        stage: 'author-commit',
        authorityFingerprint: preview.authorityFingerprint,
      },
    })
    expect(ImportRunRepository.listChapterBatch('unsupported-author', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 1, content: 'author chapter one' })])
  })

  it('commits and validates an author manuscript receipt against finalized draft facts', () => {
    const authorChapter = chapter(1, 'author chapter one')
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: 1,
      title: authorChapter.title,
      content: authorChapter.content,
      wordCount: authorChapter.content.length,
    }])
    const runId = 'author-receipt-run'
    ImportRunRepository.prepare(request([authorChapter], {
      runId,
      purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))
    const execution = ImportRunRepository.startOrResume(runId, 'author-runner').execution
    ImportRunRepository.prepareEffectReceipt({
      runId,
      stage: 'author-commit',
      batchId: 'done',
      effectKey: 'author-finalized-batch',
      kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`,
        runId,
        authorityFingerprint: preview.authorityFingerprint,
        manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)

    expect(ImportRunRepository.commitEffectReceipt(
      runId, 'author-commit', 'done', execution,
    )).toMatchObject({
      receipt: {
        state: 'committed',
        effectReceipt: {
          operationId: `author-import:${runId}`,
          chapterNumbers: [1],
        },
      },
      run: { completedBatches: { 'author-commit': ['done'] } },
    })

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done'))
      .toMatchObject({ state: 'committed' })

    getProjectDb()!.prepare(`
      UPDATE contents SET body = 'tampered'
      WHERE id = (
        SELECT content_id FROM drafts
        WHERE chapter_number = 1 AND status = 'finalized'
        ORDER BY id DESC LIMIT 1
      )
    `).run()
    expect(() => ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
  })

  it('binds an incremental author confirmation to the full manifest while committing only appended chapters', () => {
    const confirmed = [
      chapter(1, 'author chapter one'),
      chapter(2, 'author chapter two'),
      chapter(3, 'author chapter three'),
    ]
    FinalizedDraftImportRepository.commit(root, {
      operationId: 'existing-author-chapters',
      chapters: confirmed.slice(0, 2).map(item => ({
        chapterNumber: item.number,
        title: item.title,
        content: item.content,
        wordCount: item.content.length,
      })),
    })
    const preview = FinalizedDraftImportRepository.preview(confirmed.map(item => ({
      chapterNumber: item.number,
      title: item.title,
      content: item.content,
      wordCount: item.content.length,
    })))
    expect(preview).toMatchObject({
      classification: 'ready',
      duplicateChapterNumbers: [1, 2],
      newChapterNumbers: [3],
    })

    const runId = 'incremental-author-receipt'
    const prepared = ImportRunRepository.prepare(request(confirmed, {
      runId,
      purpose: 'author-manuscript',
      sourceFingerprint: 'b'.repeat(64),
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))
    expect(prepared).toMatchObject({
      classification: 'new',
      duplicateChapterNumbers: [1, 2],
      newChapterNumbers: [3],
      run: { manifestFingerprint: preview.manifestFingerprint, totalChapters: 1, manifestChapterCount: 3 },
    })
    expect(ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 3, content: 'author chapter three' })])

    const execution = ImportRunRepository.startOrResume(runId, 'incremental-author-runner').execution
    ImportRunRepository.prepareEffectReceipt({
      runId,
      stage: 'author-commit',
      batchId: 'done',
      effectKey: 'author-finalized-batch',
      kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`,
        runId,
        authorityFingerprint: preview.authorityFingerprint,
        manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)

    expect(ImportRunRepository.commitEffectReceipt(runId, 'author-commit', 'done', execution))
      .toMatchObject({
        receipt: { effectReceipt: { chapterNumbers: [3] } },
        run: { completedBatches: { 'author-commit': ['done'] } },
      })
    expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({
      status: 'continuous', lastChapterNumber: 3, nextChapterNumber: 4,
    })
  })

  it('rejects an incremental author commit when authority changes after the full manifest confirmation', () => {
    const confirmed = [
      chapter(1, 'author chapter one'),
      chapter(2, 'author chapter two'),
      chapter(3, 'author chapter three'),
    ]
    const finalized = (items: typeof confirmed) => items.map(item => ({
      chapterNumber: item.number,
      title: item.title,
      content: item.content,
      wordCount: item.content.length,
    }))
    FinalizedDraftImportRepository.commit(root, {
      operationId: 'stale-existing-author-chapters',
      chapters: finalized(confirmed.slice(0, 2)),
    })
    const preview = FinalizedDraftImportRepository.preview(finalized(confirmed))
    const runId = 'stale-incremental-author'
    ImportRunRepository.prepare(request(confirmed, {
      runId,
      purpose: 'author-manuscript',
      sourceFingerprint: 'd'.repeat(64),
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))

    FinalizedDraftImportRepository.commit(root, {
      operationId: 'concurrent-third-chapter',
      chapters: finalized(confirmed.slice(2)),
    })
    const execution = ImportRunRepository.startOrResume(runId, 'stale-author-runner').execution
    ImportRunRepository.prepareEffectReceipt({
      runId,
      stage: 'author-commit',
      batchId: 'done',
      effectKey: 'author-finalized-batch',
      kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`,
        runId,
        authorityFingerprint: preview.authorityFingerprint,
        manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)

    expect(() => ImportRunRepository.commitEffectReceipt(runId, 'author-commit', 'done', execution))
      .toThrow(/权威章节已变化|预览已过期/)
    expect(ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done'))
      .toMatchObject({ state: 'prepared' })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts WHERE status = ?').get('finalized'))
      .toEqual({ count: 3 })
  })

  it.each(['failed', 'cancelled'] as const)(
    'fences a %s uncommitted author run after authority changes and prepares from the fresh confirmation',
    (interruptedStatus) => {
      const manuscript = [
        chapter(1, 'author chapter one'),
        chapter(2, 'author chapter two'),
        chapter(3, 'author chapter three'),
      ]
      const finalized = (items: typeof manuscript) => items.map(item => ({
        chapterNumber: item.number,
        title: item.title,
        content: item.content,
        wordCount: item.content.length,
      }))
      FinalizedDraftImportRepository.commit(root, {
        operationId: `authority-fence-existing-${interruptedStatus}`,
        chapters: finalized(manuscript.slice(0, 1)),
      })
      const originalPreview = FinalizedDraftImportRepository.preview(finalized(manuscript))
      const oldRunId = `authority-fence-old-${interruptedStatus}`
      const sourceFingerprint = interruptedStatus === 'failed' ? '8'.repeat(64) : '9'.repeat(64)
      ImportRunRepository.prepare(request(manuscript, {
        runId: oldRunId,
        purpose: 'author-manuscript',
        sourceFingerprint,
        authorityFingerprint: originalPreview.authorityFingerprint,
        expectedManifestFingerprint: originalPreview.manifestFingerprint,
      }))
      const oldExecution = ImportRunRepository.startOrResume(
        oldRunId,
        `authority-fence-runner-${interruptedStatus}`,
      ).execution
      if (interruptedStatus === 'failed') {
        ImportRunRepository.fail(oldRunId, 'author-commit', 'pre-commit interruption', oldExecution)
      } else {
        ImportRunRepository.requestCancel(oldRunId, oldExecution)
        ImportRunRepository.cancelAtBoundary(oldRunId, oldExecution)
      }

      FinalizedDraftImportRepository.commit(root, {
        operationId: `authority-fence-external-${interruptedStatus}`,
        chapters: finalized(manuscript.slice(1, 2)),
      })
      const freshPreview = FinalizedDraftImportRepository.preview(finalized(manuscript))
      expect(freshPreview).toMatchObject({
        classification: 'ready',
        duplicateChapterNumbers: [1, 2],
        newChapterNumbers: [3],
      })
      expect(freshPreview.authorityFingerprint).not.toBe(originalPreview.authorityFingerprint)

      expect(() => ImportRunRepository.prepare(request(manuscript, {
        runId: `authority-fence-stale-${interruptedStatus}`,
        purpose: 'author-manuscript',
        sourceFingerprint,
        authorityFingerprint: originalPreview.authorityFingerprint,
        expectedManifestFingerprint: originalPreview.manifestFingerprint,
      }))).toThrow(/权威章节已变化|预览已过期/)
      expect(ImportRunRepository.get(oldRunId)).toMatchObject({
        status: interruptedStatus,
        resumable: true,
      })

      const freshRunId = `authority-fence-fresh-${interruptedStatus}`
      const prepared = ImportRunRepository.prepare(request(manuscript, {
        runId: freshRunId,
        purpose: 'author-manuscript',
        sourceFingerprint,
        authorityFingerprint: freshPreview.authorityFingerprint,
        expectedManifestFingerprint: freshPreview.manifestFingerprint,
      }))
      expect(prepared).toMatchObject({
        classification: 'new',
        duplicateChapterNumbers: [1, 2],
        newChapterNumbers: [3],
        run: { id: freshRunId, totalChapters: 1 },
      })
      expect(() => ImportRunRepository.startOrResume(oldRunId, 'stale-old-runner'))
        .toThrow(/authority changed|权威状态已变化|重新确认/i)

      const freshExecution = ImportRunRepository.startOrResume(freshRunId, 'fresh-author-runner').execution
      ImportRunRepository.prepareEffectReceipt({
        runId: freshRunId,
        stage: 'author-commit',
        batchId: 'done',
        effectKey: 'author-finalized-batch',
        kind: 'author-finalized-batch',
        payload: {
          operationId: `author-import:${freshRunId}`,
          runId: freshRunId,
          authorityFingerprint: freshPreview.authorityFingerprint,
          manifestFingerprint: freshPreview.manifestFingerprint,
        },
      }, freshExecution)
      expect(ImportRunRepository.commitEffectReceipt(
        freshRunId,
        'author-commit',
        'done',
        freshExecution,
      )).toMatchObject({
        receipt: { state: 'committed', effectReceipt: { chapterNumbers: [3] } },
      })
      expect(getProjectDb()!.prepare(
        "SELECT COUNT(*) AS count FROM drafts WHERE status = 'finalized'",
      ).get()).toEqual({ count: 3 })
    },
  )

  it('keeps a failed committed author run resumable and rejects restarting it from author-commit', () => {
    const imported = chapter(1, 'author chapter one')
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: imported.number,
      title: imported.title,
      content: imported.content,
      wordCount: imported.content.length,
    }])
    const runId = 'committed-author-recovery'
    ImportRunRepository.prepare(request([imported], {
      runId,
      purpose: 'author-manuscript',
      sourceFingerprint: 'c'.repeat(64),
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))
    let execution = ImportRunRepository.startOrResume(runId, 'author-before-failure').execution
    ImportRunRepository.prepareEffectReceipt({
      runId,
      stage: 'author-commit',
      batchId: 'done',
      effectKey: 'author-finalized-batch',
      kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`,
        runId,
        authorityFingerprint: preview.authorityFingerprint,
        manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)
    ImportRunRepository.commitEffectReceipt(runId, 'author-commit', 'done', execution)
    ImportRunRepository.advanceStage(runId, 'author-commit', 'author-publish', execution)
    ImportRunRepository.fail(runId, 'author-publish', 'publication unavailable', execution)

    const currentPreview = FinalizedDraftImportRepository.preview([{
      chapterNumber: imported.number,
      title: imported.title,
      content: imported.content,
      wordCount: imported.content.length,
    }])
    expect(ImportRunRepository.prepare(request([imported], {
      runId: 'committed-author-reselection',
      purpose: 'author-manuscript',
      sourceFingerprint: 'c'.repeat(64),
      authorityFingerprint: currentPreview.authorityFingerprint,
      expectedManifestFingerprint: currentPreview.manifestFingerprint,
    }))).toMatchObject({
      classification: 'resumable',
      run: { id: runId, stage: 'author-publish', status: 'failed' },
    })

    expect(() => ImportRunRepository.restart(runId, 'forbidden-author-restart'))
      .toThrow(/作者原稿.*继续|author.*continue/i)
    expect(ImportRunRepository.get('forbidden-author-restart')).toBeNull()
    expect(ImportRunRepository.get(runId)).toMatchObject({
      stage: 'author-publish', status: 'failed', resumable: true,
      completedBatches: { 'author-commit': ['done'] },
    })

    execution = ImportRunRepository.startOrResume(runId, 'author-after-failure').execution
    expect(ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done')).toMatchObject({
      state: 'committed',
      effectReceipt: { chapterNumbers: [1] },
    })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts WHERE status = ?').get('finalized'))
      .toEqual({ count: 1 })
    expect(execution).toMatchObject({ owner: 'author-after-failure' })
  })

  it('cancels a committed author run at a durable boundary, releases its lease, and resumes without repeating finalization', () => {
    const imported = chapter(1, 'author chapter one')
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: imported.number,
      title: imported.title,
      content: imported.content,
      wordCount: imported.content.length,
    }])
    const runId = 'cancelled-author-recovery'
    ImportRunRepository.prepare(request([imported], {
      runId,
      purpose: 'author-manuscript',
      sourceFingerprint: 'e'.repeat(64),
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))
    const firstExecution = ImportRunRepository.startOrResume(runId, 'author-before-cancel').execution
    ImportRunRepository.prepareEffectReceipt({
      runId,
      stage: 'author-commit',
      batchId: 'done',
      effectKey: 'author-finalized-batch',
      kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${runId}`,
        runId,
        authorityFingerprint: preview.authorityFingerprint,
        manifestFingerprint: preview.manifestFingerprint,
      },
    }, firstExecution)
    ImportRunRepository.commitEffectReceipt(runId, 'author-commit', 'done', firstExecution)
    ImportRunRepository.advanceStage(runId, 'author-commit', 'author-publish', firstExecution)
    ImportRunRepository.requestCancel(runId, firstExecution)

    expect(ImportRunRepository.cancelAtBoundary(runId, firstExecution)).toMatchObject({
      stage: 'author-publish', status: 'cancelled', resumable: true, cancelRequested: true,
    })
    expect(getProjectDb()!.prepare(`
      SELECT execution_owner, lease_expires_at FROM import_runs WHERE id = ?
    `).get(runId)).toEqual({ execution_owner: '', lease_expires_at: 0 })

    const resumed = ImportRunRepository.startOrResume(runId, 'author-after-cancel')
    expect(resumed).toMatchObject({
      run: { stage: 'author-publish', status: 'running', cancelRequested: false },
      execution: { owner: 'author-after-cancel' },
    })
    expect(ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done'))
      .toMatchObject({ state: 'committed', effectReceipt: { chapterNumbers: [1] } })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts WHERE status = ?').get('finalized'))
      .toEqual({ count: 1 })
  })

  it('rejects a stale or gapped author-manuscript preview without writing a run', () => {
    const first = chapter(1, 'author chapter one')
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: 1, title: first.title, content: first.content, wordCount: first.content.length,
    }])
    expect(() => ImportRunRepository.prepare(request([chapter(2, 'skips chapter one')], {
      runId: 'gapped-author', purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
    }))).toThrow(/清单.*预览|预览.*清单/)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_runs').get()).toEqual({ count: 0 })
  })

  it('records batch checkpoints idempotently and exposes a resumable failure', () => {
    const chapters = [chapter(1), chapter(2)]
    ImportRunRepository.prepare(request(chapters))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    const checkpoint = commitKnowledge('import-run-1', execution, chapters)

    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', checkpoint, execution)).toMatchObject({ newlyCompleted: true })
    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', checkpoint, execution)).toMatchObject({ newlyCompleted: false })
    ImportRunRepository.fail('import-run-1', 'knowledge', 'provider unavailable', execution)

    expect(ImportRunRepository.listResumable()).toEqual([
      expect.objectContaining({
        id: 'import-run-1',
        stage: 'knowledge',
        status: 'failed',
        resumable: true,
        completedBatches: { knowledge: [checkpoint] },
        lastError: 'provider unavailable',
      }),
    ])
  })

  it('derives resumable knowledge progress from validated checkpoints across reopen and later stages', () => {
    const chapters = [chapter(1), chapter(2), chapter(3)]
    ImportRunRepository.prepare(request(chapters))
    let execution = ImportRunRepository.startOrResume('import-run-1', 'progress-runner').execution
    const firstCheckpoint = commitKnowledge('import-run-1', execution, chapters.slice(0, 2))
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', firstCheckpoint, execution)
    expect(ImportRunRepository.get('import-run-1')).toMatchObject({
      completedChapters: 2, progressCompleted: 2, progressTotal: 3,
    })
    ImportRunRepository.fail('import-run-1', 'knowledge', 'pause', execution)

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.get('import-run-1')).toMatchObject({ completedChapters: 2 })

    execution = ImportRunRepository.startOrResume('import-run-1', 'progress-runner-2').execution
    const secondCheckpoint = commitKnowledge('import-run-1', execution, chapters.slice(2))
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', secondCheckpoint, execution)
    expect(ImportRunRepository.advanceStage('import-run-1', 'knowledge', 'global', execution)).toMatchObject({
      completedChapters: 3, progressCompleted: 0, progressTotal: 1,
    })
  })

  it('rejects a knowledge checkpoint until every exact frozen chapter receipt is committed', () => {
    const chapters = [chapter(1), chapter(2)]
    ImportRunRepository.prepare(request(chapters))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    const checkpoint = createImportRunChapterBatchCheckpointId(chapters)

    expect(() => ImportRunRepository.completeBatch(
      'import-run-1', 'knowledge', checkpoint, execution,
    )).toThrow(/receipt/)

    commitKnowledge('import-run-1', execution, [chapters[0]!])
    expect(() => ImportRunRepository.completeBatch(
      'import-run-1', 'knowledge', checkpoint, execution,
    )).toThrow(/receipt/)

    commitKnowledge('import-run-1', execution, [chapters[1]!])
    expect(ImportRunRepository.completeBatch(
      'import-run-1', 'knowledge', checkpoint, execution,
    )).toMatchObject({ newlyCompleted: true })
  })

  it('reopens the same project database with the frozen run and checkpoint intact', () => {
    const chapters = [chapter(1), chapter(2)]
    ImportRunRepository.prepare(request(chapters))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    const checkpoint = commitKnowledge('import-run-1', execution, chapters)
    ImportRunRepository.completeBatch('import-run-1', 'knowledge', checkpoint, execution)
    ImportRunRepository.advanceStage('import-run-1', 'knowledge', 'global', execution)
    ImportRunRepository.fail('import-run-1', 'global', 'restart fixture', execution)

    closeProjectDatabase()
    initProjectDatabase(root)

    expect(ImportRunRepository.get('import-run-1')).toMatchObject({
      stage: 'global', status: 'failed', resumable: true,
      completedBatches: { knowledge: [checkpoint] },
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
      inspection: {
        chapterCount: 1,
        previewRemaining: 0,
        preview: [{ number: 1, title: 'Chapter 1', wordCount: 11, targetStatus: 'duplicate' }],
      },
    })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_runs').get()).toEqual({ count: 1 })

    expect(ImportRunRepository.prepare(request([chapter(1), chapter(2)], { runId: 'incremental' }))).toMatchObject({
      classification: 'new',
      newChapterNumbers: [2],
      run: { id: 'incremental' },
      inspection: {
        chapterCount: 2,
        previewRemaining: 0,
        preview: [
          { number: 1, title: 'Chapter 1', wordCount: 11, targetStatus: 'duplicate' },
          { number: 2, title: 'Chapter 2', wordCount: 11, targetStatus: 'new' },
        ],
      },
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
      inspection: {
        preview: [{ number: 1, title: 'Chapter 1', wordCount: 7, targetStatus: 'conflict' }],
      },
    })
  })

  it('returns a bounded renderer-safe preview for a 5000-chapter manifest', () => {
    const chapters = Array.from({ length: 5_000 }, (_, index) => (
      chapter(index + 1, `private-body-${index + 1}`)
    ))

    const prepared = ImportRunRepository.prepare(request(chapters, { runId: 'bounded-preview' }))

    expect(prepared.inspection).toMatchObject({
      inspectionId: 'bounded-preview',
      chapterCount: 5_000,
      previewRemaining: 4_992,
    })
    expect(prepared.inspection?.preview).toHaveLength(8)
    expect(prepared.inspection?.preview[0]).toEqual({
      number: 1, title: 'Chapter 1', wordCount: 14, targetStatus: 'new',
    })
    const rendererPayload = JSON.stringify(prepared.inspection)
    expect(rendererPayload).not.toContain('private-body-')
    expect(rendererPayload).not.toContain('contentFingerprint')
    expect(rendererPayload).not.toContain('sourceId')
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
      importReference: async (item, _run, authority) => {
        importedByWorkflow.push({ number: item.number, content: item.content })
        commitKnowledge('a-plus-b', authority, [chapter(item.number, item.content)])
      },
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

  it('serializes overlapping prepared source sets while allowing disjoint runs', () => {
    const finalizeA = prepareParsedRun('run-a', [
      { id: SOURCE_A, fingerprint: 'a'.repeat(64), content: 'A chapter' },
    ])
    const finalizeAPlusB = prepareParsedRun('run-a-plus-b', [
      { id: SOURCE_A, fingerprint: 'a'.repeat(64), content: 'A chapter' },
      { id: SOURCE_B, fingerprint: 'b'.repeat(64), content: 'B chapter' },
    ])
    const finalizeC = prepareParsedRun('run-c', [
      { id: SOURCE_C, fingerprint: 'c'.repeat(64), content: 'C chapter' },
    ])

    expect(finalizeA()).toMatchObject({ classification: 'new', newChapterNumbers: [1] })
    expect(() => finalizeAPlusB()).toThrow(
      'Another resumable import already contains the same source. Complete or cancel that import, then try again.',
    )
    expect(ImportRunRepository.get('run-a-plus-b')).toMatchObject({ stage: 'parsing', status: 'ready' })
    expect(ImportRunRepository.listChapterBatch('run-a-plus-b', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([])
    expect(finalizeC()).toMatchObject({ classification: 'new', newChapterNumbers: [2] })

    markRunCompleted('run-a')
    expect(finalizeAPlusB()).toMatchObject({
      classification: 'new',
      newChapterNumbers: [3],
      duplicateChapterNumbers: [1],
    })
    expect(ImportRunRepository.listChapterBatch('run-a-plus-b', { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ number: 3, content: 'B chapter' })])
  })

  it('restarts a prepared import with its completed source ledger and still blocks overlapping sources', () => {
    const finalizeA = prepareParsedRun('restart-source', [
      { id: SOURCE_A, fingerprint: 'a'.repeat(64), content: 'A chapter' },
    ])
    expect(finalizeA()).toMatchObject({ classification: 'new' })
    const execution = ImportRunRepository.startOrResume('restart-source', 'restart-worker').execution
    ImportRunRepository.fail('restart-source', 'knowledge', 'provider unavailable', execution)

    expect(ImportRunRepository.restart('restart-source', 'restarted-source')).toMatchObject({
      id: 'restarted-source',
      stage: 'knowledge',
      status: 'ready',
      completedSources: 1,
      totalSources: 1,
      progressCompleted: 0,
      progressTotal: 1,
    })
    expect(ImportRunRepository.parsedSourceStatus('restarted-source', SOURCE_A)).toBe('completed')

    const finalizeOverlap = prepareParsedRun('overlapping-source', [
      { id: SOURCE_A, fingerprint: 'a'.repeat(64), content: 'changed A chapter' },
    ])
    expect(() => finalizeOverlap()).toThrow(
      'Another resumable import already contains the same source. Complete or cancel that import, then try again.',
    )
    expect(ImportRunRepository.get('overlapping-source')).toMatchObject({ stage: 'parsing', status: 'ready' })
  })

  it('applies cancellation only when a completed batch reaches a safe boundary', () => {
    const chapters = [chapter(1), chapter(2)]
    ImportRunRepository.prepare(request(chapters))
    const execution = ImportRunRepository.startOrResume('import-run-1', 'test-runner').execution
    const checkpoint = commitKnowledge('import-run-1', execution, [chapters[0]!])
    ImportRunRepository.requestCancel('import-run-1', execution)

    expect(ImportRunRepository.get('import-run-1')).toMatchObject({ status: 'running', cancelRequested: true })
    expect(ImportRunRepository.completeBatch('import-run-1', 'knowledge', checkpoint, execution)).toMatchObject({
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
