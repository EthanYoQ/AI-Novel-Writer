import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { parseImportRunChapterBatchCheckpointId, type ImportRunStage } from '../../src/shared/import-run'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M04_IMPORT_EFFECT_LEDGER_SQL = `
CREATE TABLE import_effect_ledger (
 run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
 stage TEXT NOT NULL,
 batch_id TEXT NOT NULL,
 effect_namespace TEXT NOT NULL,
 effect_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('complete','partial','unknown')),
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('receipt','knowledge-receipt','legacy-checkpoint','terminal')),
 diagnostic_code TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(run_id,stage,batch_id),
 UNIQUE(effect_namespace,effect_key),
 CHECK((state='unknown' AND diagnostic_code<>'') OR (state<>'unknown'))
);
CREATE INDEX idx_import_effect_ledger_state ON import_effect_ledger(run_id,state,stage);`

interface LegacyRunRow {
  id: string
  effect_namespace: string
  stage: ImportRunStage
  status: string
  completed_batches_json: string
  completed_chapters: number
}

interface ReceiptRow {
  run_id: string
  effect_namespace: string
  effect_key: string
  stage: ImportRunStage
  batch_id: string
  state: 'prepared' | 'committed'
}

const insertLedger = (db: Database.Database, entry: {
  runId: string
  stage: ImportRunStage
  batchId: string
  effectNamespace: string
  effectKey: string
  state: 'complete' | 'partial' | 'unknown'
  evidenceKind: 'receipt' | 'knowledge-receipt' | 'legacy-checkpoint' | 'terminal'
  diagnosticCode?: string
}): void => {
  db.prepare(`INSERT INTO import_effect_ledger(
    run_id,stage,batch_id,effect_namespace,effect_key,state,evidence_kind,diagnostic_code
  ) VALUES(?,?,?,?,?,?,?,?)`).run(entry.runId, entry.stage, entry.batchId, entry.effectNamespace,
    entry.effectKey, entry.state, entry.evidenceKind, entry.diagnosticCode ?? '')
}

function provenKnowledgeCheckpoint(db: Database.Database, runId: string, batchId: string): boolean {
  const checkpoint = parseImportRunChapterBatchCheckpointId(batchId)
  if (!checkpoint) return false
  const rows = db.prepare(`
    SELECT runs.purpose AS run_purpose,
           chapters.chapter_number, chapters.source_id, chapters.source_chapter_number,
           chapters.content_fingerprint, receipts.purpose, receipts.source_id AS receipt_source_id,
           receipts.source_chapter_number AS receipt_source_chapter_number,
           receipts.content_fingerprint AS receipt_content_fingerprint,
           receipts.document_id AS receipt_document_id, receipts.state,
           documents.document_id, documents.content_hash AS document_content_hash,
           documents.state AS document_state
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id=chapters.run_id
    LEFT JOIN import_run_knowledge_receipts AS receipts
      ON receipts.run_id=chapters.run_id AND receipts.chapter_number=chapters.chapter_number
    LEFT JOIN import_reference_documents AS documents
      ON documents.document_id=receipts.document_id
    WHERE chapters.run_id=? AND chapters.chapter_number BETWEEN ? AND ?
    ORDER BY chapters.chapter_number
  `).all(runId, checkpoint.startChapter, checkpoint.endChapter) as Array<{
    run_purpose: string
    chapter_number: number
    source_id: string
    source_chapter_number: number
    content_fingerprint: string
    purpose: string | null
    receipt_source_id: string | null
    receipt_source_chapter_number: number | null
    receipt_content_fingerprint: string | null
    receipt_document_id: string | null
    state: string | null
    document_id: string | null
    document_content_hash: string | null
    document_state: string | null
  }>
  return rows.length === checkpoint.contentFingerprintPrefixes.length && rows.every((row, index) => {
    const affiliationHash = createHash('sha256').update(JSON.stringify({
      purpose: row.run_purpose,
      sourceId: row.source_id,
      sourceChapterNumber: row.source_chapter_number,
      contentFingerprint: row.content_fingerprint,
    })).digest('hex')
    const stableKey = `reference:${affiliationHash}`
    const expectedDocumentId = createHash('sha256')
      .update(`reference-import:${stableKey}`, 'utf8')
      .digest('hex')
    return row.run_purpose === 'reference'
      && row.chapter_number === checkpoint.startChapter + index
      && row.content_fingerprint.startsWith(checkpoint.contentFingerprintPrefixes[index]!)
      && row.purpose === row.run_purpose
      && row.receipt_source_id === row.source_id
      && row.receipt_source_chapter_number === row.source_chapter_number
      && row.receipt_content_fingerprint === row.content_fingerprint
      && row.state === 'committed'
      && row.receipt_document_id === expectedDocumentId
      && row.document_id === expectedDocumentId
      && row.document_content_hash === row.content_fingerprint
      && row.document_state === 'committed'
  })
}

/** The central runner owns the transaction and user_version. Old completion fields remain byte-for-byte evidence. */
export function applyM04ImportEffectLedger(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('IMPORT_EFFECT_LEDGER_MIGRATION_TRANSACTION_REQUIRED')
  for (const table of [
    'import_runs', 'import_run_receipts', 'import_run_chapters',
    'import_run_knowledge_receipts', 'import_reference_documents',
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error('IMPORT_EFFECT_LEDGER_MIGRATION_SCHEMA_UNRECOGNIZED')
    }
  }
  db.exec(M04_IMPORT_EFFECT_LEDGER_SQL)

  const receipts = db.prepare(`SELECT run_id,effect_namespace,effect_key,stage,batch_id,state
    FROM import_run_receipts ORDER BY run_id,stage,batch_id`).all() as ReceiptRow[]
  const receiptKeys = new Set<string>()
  for (const receipt of receipts) {
    receiptKeys.add(JSON.stringify([receipt.run_id, receipt.stage, receipt.batch_id]))
    insertLedger(db, {
      runId: receipt.run_id,
      stage: receipt.stage,
      batchId: receipt.batch_id,
      effectNamespace: receipt.effect_namespace,
      effectKey: receipt.effect_key,
      state: receipt.state === 'committed' ? 'complete' : 'partial',
      evidenceKind: 'receipt',
      ...(receipt.state === 'prepared' ? { diagnosticCode: 'EFFECT_PREPARED_NOT_COMMITTED' } : {}),
    })
  }

  const runs = db.prepare(`SELECT id,effect_namespace,stage,status,completed_batches_json,completed_chapters
    FROM import_runs ORDER BY rowid`).all() as LegacyRunRow[]
  for (const run of runs) {
    let checkpoints: Record<string, unknown>
    try {
      const parsed = JSON.parse(run.completed_batches_json) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      checkpoints = parsed as Record<string, unknown>
    } catch {
      insertLedger(db, { runId: run.id, stage: run.stage, batchId: '__legacy_checkpoint_json__',
        effectNamespace: run.effect_namespace, effectKey: 'legacy:checkpoint-json', state: 'unknown',
        evidenceKind: 'legacy-checkpoint', diagnosticCode: 'LEGACY_CHECKPOINT_JSON_INVALID' })
      continue
    }

    let inserted = receipts.some(receipt => receipt.run_id === run.id)
    for (const [rawStage, rawBatches] of Object.entries(checkpoints)) {
      const stage = rawStage as ImportRunStage
      if (!Array.isArray(rawBatches)) {
        insertLedger(db, { runId: run.id, stage: run.stage, batchId: `__legacy_stage_${rawStage}__`,
          effectNamespace: run.effect_namespace, effectKey: `legacy:invalid-stage:${rawStage}`, state: 'unknown',
          evidenceKind: 'legacy-checkpoint', diagnosticCode: 'LEGACY_CHECKPOINT_JSON_INVALID' })
        inserted = true
        continue
      }
      for (const rawBatchId of rawBatches) {
        if (typeof rawBatchId !== 'string' || !rawBatchId || receiptKeys.has(JSON.stringify([run.id, stage, rawBatchId]))) continue
        const knowledgeComplete = stage === 'knowledge' && provenKnowledgeCheckpoint(db, run.id, rawBatchId)
        insertLedger(db, {
          runId: run.id,
          stage,
          batchId: rawBatchId,
          effectNamespace: run.effect_namespace,
          effectKey: `legacy:${stage}:${rawBatchId}`,
          state: knowledgeComplete ? 'complete' : 'unknown',
          evidenceKind: knowledgeComplete ? 'knowledge-receipt' : 'legacy-checkpoint',
          ...(knowledgeComplete ? {} : { diagnosticCode: stage === 'knowledge'
            ? 'LEGACY_KNOWLEDGE_EFFECT_UNPROVEN'
            : 'LEGACY_CHECKPOINT_WITHOUT_DURABLE_EFFECT' }),
        })
        inserted = true
      }
    }
    if (!inserted && run.stage === 'completed' && run.status === 'completed') {
      insertLedger(db, { runId: run.id, stage: 'completed', batchId: '__run__',
        effectNamespace: run.effect_namespace, effectKey: 'terminal:completed', state: 'complete',
        evidenceKind: 'terminal' })
    } else if (!inserted && (run.completed_chapters > 0 || !['parsing', 'prepared', 'knowledge'].includes(run.stage))) {
      insertLedger(db, { runId: run.id, stage: run.stage, batchId: '__legacy_progress__',
        effectNamespace: run.effect_namespace, effectKey: `legacy:progress:${run.stage}`, state: 'unknown',
        evidenceKind: 'legacy-checkpoint', diagnosticCode: 'LEGACY_PROGRESS_WITHOUT_EFFECT_EVIDENCE' })
    }
  }
}

export function verifyM04ImportEffectLedger(db: Database.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const missing = db.prepare(`
      SELECT 1 FROM import_run_receipts AS receipts
      LEFT JOIN import_effect_ledger AS ledger
        ON ledger.run_id=receipts.run_id AND ledger.stage=receipts.stage AND ledger.batch_id=receipts.batch_id
      WHERE ledger.run_id IS NULL
        OR ledger.evidence_kind<>'receipt'
        OR ledger.state<>CASE receipts.state WHEN 'committed' THEN 'complete' ELSE 'partial' END
      LIMIT 1
    `).get()
    if (missing) return false
    const invalid = db.prepare(`
      SELECT 1 FROM import_effect_ledger AS ledger
      LEFT JOIN import_run_receipts AS receipts
        ON receipts.run_id=ledger.run_id AND receipts.stage=ledger.stage AND receipts.batch_id=ledger.batch_id
      WHERE (ledger.state='unknown' AND ledger.diagnostic_code='')
        OR (ledger.evidence_kind='receipt' AND (receipts.run_id IS NULL
          OR ledger.state<>CASE receipts.state WHEN 'committed' THEN 'complete' ELSE 'partial' END))
      LIMIT 1
    `).get()
    if (invalid) return false
    const knowledge = db.prepare(`SELECT run_id,batch_id,evidence_kind FROM import_effect_ledger
      WHERE stage='knowledge' AND state='complete'`).all() as Array<{
        run_id: string
        batch_id: string
        evidence_kind: string
      }>
    return knowledge.every(entry => entry.evidence_kind === 'knowledge-receipt'
      && provenKnowledgeCheckpoint(db, entry.run_id, entry.batch_id))
  } catch { return false }
}

export function createM04Migration(deps: {
  database: (reader: SchemaReader) => Database.Database
  verifyKnownSchema: (reader: SchemaReader) => boolean
}): MigrationImplementation {
  return { id: 'M04', from: 4, to: 5, owner: 'S12',
    migrate: reader => applyM04ImportEffectLedger(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM04ImportEffectLedger(deps.database(reader)) }
}
