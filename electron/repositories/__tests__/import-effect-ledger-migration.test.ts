import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { applyM04ImportEffectLedger, verifyM04ImportEffectLedger } from '../../migrations/m04-import-effect-ledger'
import { createImportRunChapterBatchCheckpointId, type ImportRunPrepareRequest } from '../../../src/shared/import-run'

const fixture = vi.hoisted(() => ({ db: null as import('better-sqlite3').Database | null }))
vi.mock('../../database', async importOriginal => {
  const actual = await importOriginal<typeof import('../../database')>()
  return { ...actual, getProjectDb: () => fixture.db, getCurrentProjectPath: () => 'C:\\fixture' }
})

import { ImportRunRepository } from '../import-run-repository'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function insertRun(id: string, values: {
  stage: string
  status?: string
  batches?: Record<string, string[]>
  completedChapters?: number
}): void {
  fixture.db!.prepare(`INSERT INTO import_runs(
    id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,
    stage,status,completed_batches_json,total_chapters,manifest_chapter_count,completed_chapters
  ) VALUES(?,'reference',?,?,?,?,'zh-CN',?,?,?,?,1,?)`).run(id, id, `import:reference:${id}`,
    hash(`source:${id}`), hash(`manifest:${id}`), values.stage, values.status ?? 'ready',
    JSON.stringify(values.batches ?? {}), 1, values.completedChapters ?? 0)
}

function request(runId: string): ImportRunPrepareRequest {
  const content = '第一章'
  return {
    runId,
    purpose: 'reference',
    sourceFingerprint: hash(`source:${runId}`),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    locale: 'zh-CN',
    chapters: [{ number: 1, title: '第一章', content, contentFingerprint: hash(content),
      contentSize: Buffer.byteLength(content) }],
  }
}

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(fixture.db)
})

afterEach(() => {
  fixture.db?.close()
  fixture.db = null
})

describe('M04 import effect ledger', () => {
  it('migrates receipt/checkpoint combinations as complete, partial, or unknown without changing old rows', () => {
    const db = fixture.db!
    insertRun('committed', { stage: 'global', batches: { global: ['done'] } })
    insertRun('prepared', { stage: 'style', batches: { style: ['done'] } })
    insertRun('unknown', { stage: 'refresh', batches: { refresh: ['done'] }, completedChapters: 1 })
    insertRun('knowledge', { stage: 'knowledge' })
    insertRun('wrong-document-knowledge', { stage: 'knowledge' })
    const contentFingerprint = hash('knowledge')
    const batchId = createImportRunChapterBatchCheckpointId([{ number: 1, contentFingerprint }])
    const affiliationHash = hash(JSON.stringify({
      purpose: 'reference', sourceId: 'source', sourceChapterNumber: 1, contentFingerprint,
    }))
    const documentId = hash(`reference-import:reference:${affiliationHash}`)
    const wrongDocumentId = hash('wrong-document')
    db.prepare(`INSERT INTO import_run_chapters(
      run_id,chapter_number,source_id,source_chapter_number,title,content_fingerprint,content_size,content_snapshot
    ) VALUES('knowledge',1,'source',1,'chapter',?,9,'knowledge')`).run(contentFingerprint)
    db.prepare(`INSERT INTO import_reference_documents(
      document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state
    ) VALUES(?,?,?,?,1,'reference','committed')`).run(
      documentId, hash('key'), contentFingerprint, hash('chunks'),
    )
    db.prepare(`INSERT INTO import_reference_documents(
      document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state
    ) VALUES(?,?,?,?,1,'reference','committed')`).run(
      wrongDocumentId, hash('wrong-key'), contentFingerprint, hash('wrong-chunks'),
    )
    db.prepare(`INSERT INTO import_run_knowledge_receipts(
      run_id,chapter_number,purpose,source_id,source_chapter_number,content_fingerprint,document_id,state
    ) VALUES('knowledge',1,'reference','source',1,?,?,'committed')`).run(contentFingerprint, documentId)
    db.prepare('UPDATE import_runs SET completed_batches_json=? WHERE id=?')
      .run(JSON.stringify({ knowledge: [batchId] }), 'knowledge')
    db.prepare(`INSERT INTO import_run_chapters(
      run_id,chapter_number,source_id,source_chapter_number,title,content_fingerprint,content_size,content_snapshot
    ) VALUES('wrong-document-knowledge',1,'source',1,'chapter',?,9,'knowledge')`).run(contentFingerprint)
    db.prepare(`INSERT INTO import_run_knowledge_receipts(
      run_id,chapter_number,purpose,source_id,source_chapter_number,content_fingerprint,document_id,state
    ) VALUES('wrong-document-knowledge',1,'reference','source',1,?,?,'committed')`)
      .run(contentFingerprint, wrongDocumentId)
    db.prepare('UPDATE import_runs SET completed_batches_json=? WHERE id=?')
      .run(JSON.stringify({ knowledge: [batchId] }), 'wrong-document-knowledge')
    const payload = JSON.stringify({ writingStyle: '简洁' })
    const insertReceipt = db.prepare(`INSERT INTO import_run_receipts(
      run_id,effect_namespace,effect_key,stage,batch_id,kind,payload_json,payload_hash,state,effect_receipt_json
    ) VALUES(?,?,?,?,?,'project-writing-style',?,?,?,?)`)
    insertReceipt.run('committed', 'import:reference:committed', 'global-facts', 'global', 'done', payload,
      hash(payload), 'committed', JSON.stringify({ writingStyle: '简洁' }))
    insertReceipt.run('prepared', 'import:reference:prepared', 'writing-style', 'style', 'done', payload,
      hash(payload), 'prepared', null)

    const oldRows = JSON.stringify({
      runs: db.prepare('SELECT * FROM import_runs ORDER BY id').all(),
      receipts: db.prepare('SELECT * FROM import_run_receipts ORDER BY run_id').all(),
      chapters: db.prepare('SELECT * FROM import_run_chapters ORDER BY run_id,chapter_number').all(),
    })
    db.transaction(() => applyM04ImportEffectLedger(db))()

    expect(db.prepare(`SELECT run_id,state,evidence_kind,diagnostic_code FROM import_effect_ledger
      ORDER BY run_id`).all()).toEqual([
      { run_id: 'committed', state: 'complete', evidence_kind: 'receipt', diagnostic_code: '' },
      { run_id: 'knowledge', state: 'complete', evidence_kind: 'knowledge-receipt', diagnostic_code: '' },
      { run_id: 'prepared', state: 'partial', evidence_kind: 'receipt', diagnostic_code: 'EFFECT_PREPARED_NOT_COMMITTED' },
      { run_id: 'unknown', state: 'unknown', evidence_kind: 'legacy-checkpoint',
        diagnostic_code: 'LEGACY_CHECKPOINT_WITHOUT_DURABLE_EFFECT' },
      { run_id: 'wrong-document-knowledge', state: 'unknown', evidence_kind: 'legacy-checkpoint',
        diagnostic_code: 'LEGACY_KNOWLEDGE_EFFECT_UNPROVEN' },
    ])
    expect(verifyM04ImportEffectLedger(db)).toBe(true)
    expect(JSON.stringify({
      runs: db.prepare('SELECT * FROM import_runs ORDER BY id').all(),
      receipts: db.prepare('SELECT * FROM import_run_receipts ORDER BY run_id').all(),
      chapters: db.prepare('SELECT * FROM import_run_chapters ORDER BY run_id,chapter_number').all(),
    })).toBe(oldRows)

    db.prepare("UPDATE import_effect_ledger SET evidence_kind='legacy-checkpoint' WHERE run_id='committed'").run()
    expect(verifyM04ImportEffectLedger(db)).toBe(false)
    db.prepare("UPDATE import_effect_ledger SET evidence_kind='receipt' WHERE run_id='committed'").run()
    expect(verifyM04ImportEffectLedger(db)).toBe(true)

    db.prepare("UPDATE import_effect_ledger SET evidence_kind='legacy-checkpoint' WHERE run_id='knowledge'").run()
    expect(verifyM04ImportEffectLedger(db)).toBe(false)
    db.prepare("UPDATE import_effect_ledger SET evidence_kind='knowledge-receipt' WHERE run_id='knowledge'").run()
    db.prepare('DELETE FROM import_reference_documents WHERE document_id=?').run(documentId)
    expect(verifyM04ImportEffectLedger(db)).toBe(false)
  })

  it('keeps prepared effects incomplete and returns the same committed effect to repeated or late callers', () => {
    const db = fixture.db!
    db.transaction(() => applyM04ImportEffectLedger(db))()
    ImportRunRepository.prepare(request('effect-run'))
    const execution = ImportRunRepository.startOrResume('effect-run', 'worker', 1_000, 10_000).execution
    db.prepare("UPDATE import_runs SET stage='style' WHERE id='effect-run'").run()
    const prepared = ImportRunRepository.prepareEffectReceipt({
      runId: 'effect-run', stage: 'style', batchId: 'done', kind: 'project-writing-style',
      effectKey: 'writing-style', payload: { writingStyle: '简洁' },
    }, execution, 1_001)
    expect(prepared.state).toBe('prepared')
    expect(ImportRunRepository.get('effect-run')).toMatchObject({
      completedBatches: {}, progressCompleted: 0,
    })
    expect(db.prepare("SELECT state FROM import_effect_ledger WHERE run_id='effect-run'").pluck().get()).toBe('partial')

    const committed = ImportRunRepository.commitEffectReceipt('effect-run', 'style', 'done', execution, 1_002)
    expect(committed.run).toMatchObject({
      completedBatches: { style: ['done'] }, progressCompleted: 1,
    })
    db.prepare("UPDATE import_runs SET stage='blueprints',lease_expires_at=0 WHERE id='effect-run'").run()
    const late = ImportRunRepository.commitEffectReceipt('effect-run', 'style', 'done', execution, 99_999)
    expect(late.receipt).toEqual(committed.receipt)
    expect(db.prepare("SELECT state FROM import_effect_ledger WHERE run_id='effect-run'").pluck().get()).toBe('complete')
    expect(db.prepare("SELECT COUNT(*) FROM import_effect_ledger WHERE run_id='effect-run'").pluck().get()).toBe(1)
  })

  it('preserves unknown history as a diagnostic and refuses to guess or redo it', () => {
    const db = fixture.db!
    insertRun('unknown-run', { stage: 'refresh', batches: { refresh: ['done'] }, completedChapters: 1 })
    db.transaction(() => applyM04ImportEffectLedger(db))()
    const execution = ImportRunRepository.startOrResume('unknown-run', 'worker').execution
    expect(() => ImportRunRepository.completeBatch('unknown-run', 'refresh', 'done', execution))
      .toThrow('导入历史效果状态未知')
    expect(db.prepare("SELECT state,diagnostic_code FROM import_effect_ledger WHERE run_id='unknown-run'").get())
      .toEqual({ state: 'unknown', diagnostic_code: 'LEGACY_CHECKPOINT_WITHOUT_DURABLE_EFFECT' })
  })

  it('authorizes writes by owner, epoch, and server TTL instead of a stale client expiresAt echo', () => {
    const db = fixture.db!
    db.transaction(() => applyM04ImportEffectLedger(db))()
    ImportRunRepository.prepare(request('heartbeat-run'))
    const now = Date.now()
    const execution = ImportRunRepository.startOrResume('heartbeat-run', 'worker', now, 10_000).execution
    const renewed = ImportRunRepository.renewExecution('heartbeat-run', execution, now + 1_000, 10_000)
    const batchId = createImportRunChapterBatchCheckpointId(request('heartbeat-run').chapters)
    expect(() => ImportRunRepository.completeBatch('heartbeat-run', 'knowledge', batchId, execution))
      .toThrow('参照知识 receipt 未完成或与冻结章节不匹配')
    expect(renewed).toMatchObject({ owner: execution.owner, epoch: execution.epoch, expiresAt: now + 11_000 })
  })
})
