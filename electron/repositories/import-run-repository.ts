import { createHash } from 'node:crypto'

import {
  assertImportRunEffectReceiptMetadata,
  IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
  IMPORT_RUN_BLUEPRINT_BATCH_SIZE,
  IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
  parseImportRunChapterBatchCheckpointId,
} from '../../src/shared/import-run'
import type {
  ImportRunChapterInput,
  ImportRunChapterSnapshot,
  ImportRunBeginParsingRequest,
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunPreparationResult,
  ImportRunPreparationInspection,
  ImportRunPrepareEffectReceiptRequest,
  ImportRunPrepareRequest,
  ImportRunSnapshot,
  ImportRunStage,
  ImportRunStatus,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportRunStartResult,
  ImportSourceDisplayMetadata,
  ImportPurpose,
} from '../../src/shared/import-run'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from './blueprint-repository'
import { ImportGlobalFactsRepository } from './import-global-facts-repository'
import type { ImportGlobalFactsRequest } from '../../src/shared/import-global-facts'
import {
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_SOURCE_FILES,
  MAX_IMPORT_TOTAL_BYTES,
} from '../../src/shared/import-limits'
import { ProjectCoreRepository } from './project-core-repository'
import { FinalizedDraftImportRepository } from './finalized-draft-import-repository'

interface ImportRunRow {
  id: string
  purpose: ImportPurpose
  root_run_id: string
  effect_namespace: string
  source_fingerprint: string
  manifest_fingerprint: string
  authority_fingerprint: string
  legacy_source_fingerprint: string
  source_display_json: string
  locale: 'zh-CN' | 'en-US'
  stage: ImportRunStage
  status: ImportRunStatus
  completed_batches_json: string
  last_error: string
  resumable: number
  cancel_requested: number
  execution_owner: string
  execution_epoch: number
  lease_expires_at: number
  total_chapters: number
  total_content_size: number
  manifest_chapter_count: number
  manifest_content_size: number
  manifest_word_count: number
  completed_chapters: number
  base_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ImportRunChapterRow {
  chapter_number: number
  source_id: string
  source_chapter_number: number
  title: string
  content_fingerprint: string
  content_size: number
  content_snapshot: string
}

interface ImportRunCheckpointChapterRow {
  chapter_number: number
  content_fingerprint: string
}

interface NormalizedImportRunChapter extends ImportRunChapterInput {
  sourceId: string
  sourceChapterNumber: number
}

const IMPORT_PREPARATION_PREVIEW_LIMIT = 8

function createPreparationInspection(
  inspectionId: string,
  purpose: ImportPurpose,
  sourceDisplay: readonly ImportSourceDisplayMetadata[],
  chapters: readonly { number: number; title: string; wordCount: number; contentSize: number }[],
  classification: Pick<
    ImportRunPreparationResult,
    'newChapterNumbers' | 'conflictChapterNumbers' | 'duplicateChapterNumbers'
  >,
): ImportRunPreparationInspection {
  const conflicts = new Set(classification.conflictChapterNumbers)
  const duplicates = new Set(classification.duplicateChapterNumbers)
  const fresh = new Set(classification.newChapterNumbers)
  const preview = chapters.slice(0, IMPORT_PREPARATION_PREVIEW_LIMIT).map(chapter => ({
    number: chapter.number,
    title: chapter.title,
    wordCount: chapter.wordCount,
    targetStatus: conflicts.has(chapter.number)
      ? 'conflict' as const
      : duplicates.has(chapter.number)
        ? 'duplicate' as const
        : fresh.has(chapter.number)
          ? 'new' as const
          : 'duplicate' as const,
  }))
  return {
    inspectionId,
    purpose,
    sourceCount: sourceDisplay.length,
    sourceDisplayNames: sourceDisplay.map(source => source.displayName),
    chapterCount: chapters.length,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    totalBytes: chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0),
    preview,
    previewRemaining: Math.max(0, chapters.length - preview.length),
  }
}

interface ImportRunEffectReceiptRow {
  run_id: string
  schema_version: number
  effect_namespace: string
  effect_key: string
  stage: ImportRunStage
  batch_id: string
  kind: ImportRunEffectKind
  payload_json: string
  payload_hash: string
  state: 'prepared' | 'committed'
  effect_receipt_json: string | null
  created_at: string
  updated_at: string
}

interface ImportRunSourceRow {
  run_id: string
  source_index: number
  source_id: string
  source_fingerprint: string
  legacy_source_fingerprint: string
  display_json: string
  status: 'pending' | 'completed' | 'failed'
  manifest_fingerprint: string
  chapter_count: number
  content_size: number
  word_count: number
  last_error: string
}

const SHA256 = /^[a-f0-9]{64}$/u
const OPAQUE_SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_CHAPTER_BYTES = 16 * 1024 * 1024
const MAX_PAGE_SIZE = 100
const INSERT_BATCH_SIZE = 50
const MAX_DISPLAY_SOURCES = MAX_IMPORT_SOURCE_FILES
const DEFAULT_EXECUTION_LEASE_MS = 15 * 60_000
const MAX_EFFECT_RECEIPT_PAYLOAD_BYTES = 16 * 1024 * 1024
const AUTHOR_CHAPTER_CHECKPOINT = /^chapter:([1-9]\d*)$/u
const IMPORT_RUN_STAGE_VALUES = new Set<ImportRunStage>([
  'parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints',
  'author-commit', 'author-publish', 'author-postprocess',
  'refresh', 'completed',
])
const REFERENCE_NEXT_STAGE: Readonly<Partial<Record<ImportRunStage, ImportRunStage>>> = {
  prepared: 'knowledge',
  knowledge: 'global',
  global: 'style',
  style: 'blueprints',
  blueprints: 'refresh',
}
const AUTHOR_NEXT_STAGE: Readonly<Partial<Record<ImportRunStage, ImportRunStage>>> = {
  'author-commit': 'author-publish',
  'author-publish': 'author-postprocess',
  'author-postprocess': 'refresh',
}

function nextStageForRun(row: ImportRunRow, stage: ImportRunStage): ImportRunStage | undefined {
  return (row.purpose === 'author-manuscript' ? AUTHOR_NEXT_STAGE : REFERENCE_NEXT_STAGE)[stage]
}

type ImportRunCheckpointSource = 'direct' | 'receipt'

function db() {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current
}

function canonicalManifest(purpose: ImportPurpose, chapters: NormalizedImportRunChapter[]): string {
  return JSON.stringify({ purpose, chapters: chapters.map(chapter => ({
    number: chapter.number,
    sourceId: chapter.sourceId,
    sourceChapterNumber: chapter.sourceChapterNumber,
    title: chapter.title,
    contentFingerprint: chapter.contentFingerprint,
    contentSize: chapter.contentSize,
  })) })
}

function hashManifest(purpose: ImportPurpose, chapters: NormalizedImportRunChapter[]): string {
  return createHash('sha256').update(canonicalManifest(purpose, chapters), 'utf8').digest('hex')
}

function parseJson<T>(source: string, fallback: T): T {
  try {
    return JSON.parse(source) as T
  } catch {
    return fallback
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

function canonicalPayload(payload: unknown): { json: string; hash: string } {
  if (!payload || typeof payload !== 'object') throw new Error('导入 effect receipt 载荷无效')
  const json = JSON.stringify(canonicalize(payload))
  if (Buffer.byteLength(json, 'utf8') > MAX_EFFECT_RECEIPT_PAYLOAD_BYTES) {
    throw new Error('导入 effect receipt 载荷超过安全上限')
  }
  return { json, hash: createHash('sha256').update(json, 'utf8').digest('hex') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function assertEffectPayloadSchema(kind: ImportRunEffectKind, payload: unknown): void {
  if (!isRecord(payload)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (
      !exactKeys(payload, ['operationId', 'runId', 'authorityFingerprint', 'manifestFingerprint'])
      || typeof payload.operationId !== 'string'
      || typeof payload.runId !== 'string'
      || !SHA256.test(String(payload.authorityFingerprint))
      || !SHA256.test(String(payload.manifestFingerprint))
    ) throw new Error()
    return
  }
  if (kind === 'project-writing-style') {
    if (!exactKeys(payload, ['writingStyle']) || typeof payload.writingStyle !== 'string' || !payload.writingStyle.trim()) {
      throw new Error()
    }
    return
  }
  if (kind === 'project-global-facts') {
    if (
      !exactKeys(payload, ['operationId', 'expectedRosterRevision', 'core', 'characterEntries'])
      || typeof payload.operationId !== 'string'
      || !Number.isSafeInteger(payload.expectedRosterRevision)
      || !isRecord(payload.core)
      || !Array.isArray(payload.characterEntries)
      || payload.characterEntries.length === 0
    ) throw new Error()
    return
  }
  if (
    !exactKeys(payload, ['mode', 'operationId', 'startChapter', 'endChapter', 'blueprints'])
    || payload.mode !== 'replace-range'
    || typeof payload.operationId !== 'string'
    || !Number.isSafeInteger(payload.startChapter)
    || !Number.isSafeInteger(payload.endChapter)
    || !Array.isArray(payload.blueprints)
    || payload.blueprints.length === 0
  ) throw new Error()
}

function assertEffectPayloadBinding(
  kind: ImportRunEffectKind,
  runId: string,
  batchId: string,
  payload: unknown,
): void {
  if (kind === 'author-finalized-batch') {
    if (batchId !== 'done') throw new Error()
    return
  }
  if (kind === 'project-global-facts') {
    if (!isRecord(payload) || payload.operationId !== `novel-import-global-${runId}`) throw new Error()
    return
  }
  if (kind !== 'chapter-blueprint-range') return
  const checkpoint = parseImportRunChapterBatchCheckpointId(batchId)
  if (
    !checkpoint
    || !isRecord(payload)
    || payload.startChapter !== checkpoint.startChapter
    || payload.endChapter !== checkpoint.endChapter
    || payload.operationId !== `import-blueprints-${runId}-${checkpoint.startChapter}-${checkpoint.endChapter}`
  ) throw new Error()
}

function assertAuthorEffectRunBinding(
  run: ImportRunRow,
  kind: ImportRunEffectKind,
  payload: unknown,
  allowCommittedLaterStage = false,
): void {
  if (kind !== 'author-finalized-batch') return
  const stageMatches = run.stage === 'author-commit'
    || (allowCommittedLaterStage && [
      'author-publish', 'author-postprocess', 'refresh', 'completed',
    ].includes(run.stage))
  if (
    run.purpose !== 'author-manuscript'
    || !stageMatches
    || !isRecord(payload)
    || payload.runId !== run.id
    || payload.operationId !== `author-import:${run.id}`
    || payload.authorityFingerprint !== run.authority_fingerprint
    || payload.manifestFingerprint !== run.manifest_fingerprint
  ) throw new Error('作者原稿提交 receipt 未绑定冻结导入运行')
}

function assertCommittedEffectSchema(kind: ImportRunEffectKind, payload: unknown, effectReceipt: unknown): void {
  if (!isRecord(payload) || !isRecord(effectReceipt)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (
      effectReceipt.operationId !== payload.operationId
      || typeof effectReceipt.payloadHash !== 'string'
      || !Array.isArray(effectReceipt.chapterNumbers)
      || !Array.isArray(effectReceipt.drafts)
      || effectReceipt.chapterNumbers.length !== effectReceipt.drafts.length
    ) throw new Error()
    return
  }
  if (kind === 'project-writing-style') {
    if (!exactKeys(effectReceipt, ['writingStyle']) || effectReceipt.writingStyle !== payload.writingStyle) throw new Error()
    return
  }
  if (kind === 'project-global-facts') {
    if (
      !exactKeys(effectReceipt, ['operationId', 'payloadHash', 'idempotent', 'core', 'roster'])
      || effectReceipt.operationId !== payload.operationId
      || typeof effectReceipt.payloadHash !== 'string'
      || typeof effectReceipt.idempotent !== 'boolean'
      || !isRecord(effectReceipt.core)
      || !isRecord(effectReceipt.roster)
    ) throw new Error()
    return
  }
  if (
    !exactKeys(effectReceipt, [
      'mode', 'operationId', 'payloadHash', 'idempotent', 'startChapter', 'endChapter',
      'chapterNumbers', 'snapshot', 'characterSyncInput', 'characterSyncOperation',
    ])
    || effectReceipt.operationId !== payload.operationId
    || effectReceipt.mode !== payload.mode
    || effectReceipt.startChapter !== payload.startChapter
    || effectReceipt.endChapter !== payload.endChapter
    || typeof effectReceipt.payloadHash !== 'string'
    || typeof effectReceipt.idempotent !== 'boolean'
    || !Array.isArray(effectReceipt.chapterNumbers)
    || !Array.isArray(effectReceipt.snapshot)
    || !Array.isArray(effectReceipt.characterSyncInput)
    || !isRecord(effectReceipt.characterSyncOperation)
  ) throw new Error()
}

function assertCommittedEffectAuthority(
  kind: ImportRunEffectKind,
  payload: unknown,
  effectReceipt: unknown,
): void {
  if (kind === 'project-writing-style') return
  if (!isRecord(effectReceipt)) throw new Error()
  if (kind === 'author-finalized-batch') {
    if (!isRecord(payload) || typeof payload.operationId !== 'string' || typeof payload.runId !== 'string') throw new Error()
    const chapters = (db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number,
             title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number ASC
    `).all(payload.runId) as ImportRunChapterRow[]).map(chapterRowToSnapshot).map(chapter => ({
      chapterNumber: chapter.number,
      title: chapter.title,
      content: chapter.content,
      wordCount: chapter.content.length,
    }))
    const authoritative = FinalizedDraftImportRepository.getCommittedOperation(payload.operationId, chapters)
    if (!authoritative || JSON.stringify(canonicalize(authoritative)) !== JSON.stringify(canonicalize(effectReceipt))) {
      throw new Error()
    }
    return
  }
  const authoritative = kind === 'project-global-facts'
    ? ImportGlobalFactsRepository.getCommittedOperation((payload as ImportGlobalFactsRequest).operationId)
    : BlueprintRepository.getCommittedRangeOperation((payload as BlueprintRangeCommitRequest).operationId)
  if (!authoritative) throw new Error()
  const stored = canonicalize({ ...effectReceipt, idempotent: false })
  const readBack = canonicalize({ ...authoritative, idempotent: false })
  if (JSON.stringify(stored) !== JSON.stringify(readBack)) throw new Error()
}

function corruptedReceipt(): never {
  throw new Error('导入 effect receipt 损坏，已拒绝重放')
}

function rowToEffectReceipt(row: ImportRunEffectReceiptRow, run: ImportRunRow): ImportRunEffectReceipt {
  try {
    if (row.state !== 'prepared' && row.state !== 'committed') corruptedReceipt()
    const payload = JSON.parse(row.payload_json) as unknown
    const canonical = canonicalPayload(payload)
    if (canonical.json !== row.payload_json || canonical.hash !== row.payload_hash) corruptedReceipt()
    assertEffectPayloadSchema(row.kind, payload)
    assertEffectPayloadBinding(row.kind, row.run_id, row.batch_id, payload)
    assertAuthorEffectRunBinding(run, row.kind, payload, row.state === 'committed')
    const effectReceipt = row.effect_receipt_json ? JSON.parse(row.effect_receipt_json) as unknown : undefined
    if ((row.state === 'prepared' && effectReceipt !== undefined) || (row.state === 'committed' && effectReceipt === undefined)) {
      corruptedReceipt()
    }
    if (row.state === 'committed') {
      assertCommittedEffectSchema(row.kind, payload, effectReceipt)
      assertCommittedEffectAuthority(row.kind, payload, effectReceipt)
    }
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: row.schema_version as typeof IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: row.run_id,
      effectNamespace: row.effect_namespace,
      effectKey: row.effect_key,
      stage: row.stage,
      batchId: row.batch_id,
      kind: row.kind,
      payloadHash: row.payload_hash,
      state: row.state,
      payload,
      effectReceipt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    assertImportRunEffectReceiptMetadata(receipt, rowToSnapshot(run))
    return receipt
  } catch (error) {
    if (error instanceof Error && error.message.includes('receipt 损坏')) throw error
    return corruptedReceipt()
  }
}

function validateEffectStage(kind: ImportRunEffectKind, stage: ImportRunStage): void {
  const expected: Record<ImportRunEffectKind, ImportRunStage> = {
    'project-global-facts': 'global',
    'project-writing-style': 'style',
    'chapter-blueprint-range': 'blueprints',
    'author-finalized-batch': 'author-commit',
  }
  if (expected[kind] !== stage) throw new Error('导入 effect receipt 类型与阶段不匹配')
}

function sourceProgress(runId: string): { completedSources: number; totalSources: number; completedChapters: number } {
  const progress = db().prepare(`
    SELECT COUNT(*) AS total_sources,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sources,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN chapter_count ELSE 0 END), 0) AS completed_chapters
    FROM import_run_sources WHERE run_id = ?
  `).get(runId) as { total_sources: number; completed_sources: number; completed_chapters: number }
  return {
    totalSources: progress.total_sources,
    completedSources: progress.completed_sources,
    completedChapters: progress.completed_chapters,
  }
}

function unfinishedSourceDisplay(runId: string): ImportSourceDisplayMetadata[] {
  const rows = db().prepare(`
    SELECT display_json
    FROM import_run_sources
    WHERE run_id = ? AND status <> 'completed'
    ORDER BY source_index
  `).all(runId) as Array<{ display_json: string }>
  return rows.map(row => parseJson<ImportSourceDisplayMetadata>(
    row.display_json,
    { displayName: '', mediaType: '', size: 0 },
  ))
}

function completedCheckpointChapters(row: ImportRunRow, stage: 'knowledge' | 'blueprints'): number {
  const covered = new Set<number>()
  for (const batchId of completedBatches(row)[stage] ?? []) {
    for (const chapterNumber of checkpointChapterNumbers(row, stage, batchId)) covered.add(chapterNumber)
  }
  return covered.size
}

function persistedProgress(row: ImportRunRow): {
  completedSources: number
  totalSources: number
  completedChapters: number
  progressCompleted: number
  progressTotal: number
} {
  const sources = sourceProgress(row.id)
  if (row.stage === 'parsing') {
    return {
      ...sources,
      progressCompleted: sources.completedSources,
      progressTotal: sources.totalSources,
    }
  }
  const completedChapters = row.stage === 'prepared'
    ? 0
    : row.stage === 'knowledge'
      ? completedCheckpointChapters(row, 'knowledge')
      : row.total_chapters
  if (row.stage === 'knowledge' || row.stage === 'prepared') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedChapters,
      progressTotal: row.total_chapters,
    }
  }
  if (row.stage === 'blueprints') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedCheckpointChapters(row, 'blueprints'),
      progressTotal: row.total_chapters,
    }
  }
  if (row.stage === 'global' || row.stage === 'style' || row.stage === 'refresh') {
    return {
      ...sources,
      completedChapters,
      progressCompleted: completedBatches(row)[row.stage]?.includes('done') ? 1 : 0,
      progressTotal: 1,
    }
  }
  return {
    ...sources,
    completedChapters,
    progressCompleted: row.total_chapters,
    progressTotal: row.total_chapters,
  }
}

function rowToSnapshot(row: ImportRunRow): ImportRunSnapshot {
  const progress = persistedProgress(row)
  return {
    id: row.id,
    purpose: row.purpose,
    rootRunId: row.root_run_id,
    effectNamespace: row.effect_namespace,
    ...(row.purpose === 'author-manuscript' ? {
      manifestFingerprint: row.manifest_fingerprint,
      ...(row.authority_fingerprint ? { authorityFingerprint: row.authority_fingerprint } : {}),
    } : {}),
    sourceDisplay: parseJson<ImportSourceDisplayMetadata[]>(row.source_display_json, []),
    unfinishedSourceDisplay: unfinishedSourceDisplay(row.id),
    locale: row.locale,
    stage: row.stage,
    status: row.status,
    completedBatches: parseJson(row.completed_batches_json, {}),
    lastError: row.last_error,
    resumable: row.resumable === 1,
    cancelRequested: row.cancel_requested === 1,
    totalChapters: row.total_chapters,
    totalContentSize: row.total_content_size,
    manifestChapterCount: row.manifest_chapter_count,
    manifestContentSize: row.manifest_content_size,
    manifestWordCount: row.manifest_word_count,
    completedChapters: progress.completedChapters,
    completedSources: progress.completedSources,
    totalSources: progress.totalSources,
    progressCompleted: progress.progressCompleted,
    progressTotal: progress.progressTotal,
    baseRunId: row.base_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  }
}

function chapterRowToSnapshot(row: ImportRunChapterRow): ImportRunChapterSnapshot {
  assertFrozenChapterSnapshot(row)
  return {
    number: row.chapter_number,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
    content: row.content_snapshot,
  }
}

function assertFrozenChapterSnapshot(row: Pick<
  ImportRunChapterRow,
  'content_fingerprint' | 'content_size' | 'content_snapshot'
>): void {
  const actualSize = Buffer.byteLength(row.content_snapshot, 'utf8')
  const actualFingerprint = createHash('sha256').update(row.content_snapshot, 'utf8').digest('hex')
  if (
    !Number.isSafeInteger(row.content_size)
    || row.content_size < 1
    || row.content_size > MAX_CHAPTER_BYTES
    || actualSize !== row.content_size
    || !SHA256.test(row.content_fingerprint)
    || actualFingerprint !== row.content_fingerprint
  ) throw new Error('导入冻结章节快照损坏，已拒绝继续')
}

function normalizeDisplay(items: ImportSourceDisplayMetadata[]): ImportSourceDisplayMetadata[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_DISPLAY_SOURCES) {
    throw new Error('导入来源展示信息无效')
  }
  return items.map(item => {
    const displayName = item.displayName?.trim()
    const mediaType = item.mediaType?.trim()
    if (!displayName || displayName.length > 255 || displayName.includes('/') || displayName.includes('\\')) {
      throw new Error('导入来源展示名无效')
    }
    if (!mediaType || mediaType.length > 100 || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error('导入来源展示信息无效')
    }
    return { displayName, mediaType, size: item.size }
  })
}

function normalizeSourceIds(
  items: string[] | undefined,
  sourceDisplay: ImportSourceDisplayMetadata[],
  sourceFingerprint: string,
): string[] {
  if (items === undefined) return [`legacy:${sourceFingerprint}`]
  if (!Array.isArray(items) || items.length !== sourceDisplay.length || items.length === 0) {
    throw new Error('导入来源身份与展示信息不匹配')
  }
  const normalized = items.map(item => item?.trim())
  if (normalized.some(item => !OPAQUE_SOURCE_ID.test(item)) || new Set(normalized).size !== normalized.length) {
    throw new Error('导入来源身份无效或重复')
  }
  return normalized
}

function normalizeSourceFingerprints(items: string[] | undefined, sourceIds: string[]): string[] {
  if (items === undefined) return []
  if (
    !Array.isArray(items)
    || items.length !== sourceIds.length
    || items.some(item => !SHA256.test(item))
  ) throw new Error('导入来源单文件指纹无效')
  return items
}

function normalizeChapters(
  items: ImportRunChapterInput[],
  sourceIds: string[],
): NormalizedImportRunChapter[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_IMPORT_CHAPTERS) {
    throw new Error('导入章节清单无效')
  }
  const sourceChapters = new Set<string>()
  let aggregateBytes = 0
  const normalized = items.map(item => {
    const sourceIndex = item.sourceIndex ?? 0
    const sourceChapterNumber = item.sourceChapterNumber ?? item.number
    if (
      !Number.isSafeInteger(item.number)
      || item.number < 1
      || !Number.isSafeInteger(sourceIndex)
      || sourceIndex < 0
      || sourceIndex >= sourceIds.length
      || !Number.isSafeInteger(sourceChapterNumber)
      || sourceChapterNumber < 1
    ) throw new Error('导入章节归属无效')
    const sourceId = sourceIds[sourceIndex]
    const affiliation = `${sourceId}:${sourceChapterNumber}`
    if (sourceChapters.has(affiliation)) throw new Error('导入章节来源归属重复')
    sourceChapters.add(affiliation)
    const bytes = Buffer.byteLength(item.content, 'utf8')
    if (
      typeof item.title !== 'string'
      || item.title.length > 500
      || !SHA256.test(item.contentFingerprint)
      || !Number.isSafeInteger(item.contentSize)
      || item.contentSize !== bytes
      || bytes === 0
      || bytes > MAX_CHAPTER_BYTES
    ) throw new Error(`导入章节 ${item.number} 快照无效`)
    aggregateBytes += bytes
    if (aggregateBytes > MAX_IMPORT_TOTAL_BYTES) throw new Error('导入正文总字节数超过安全上限')
    return { ...item, title: item.title.trim(), sourceIndex, sourceId, sourceChapterNumber }
  })
  return normalized
}

function readRunRow(runId: string): ImportRunRow | undefined {
  return db().prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as ImportRunRow | undefined
}

function assertExecutionAuthority(
  runId: string,
  authority: ImportRunExecutionAuthority,
  now = Date.now(),
): ImportRunRow {
  const row = readRunRow(runId)
  if (
    !row
    || row.status !== 'running'
    || typeof authority?.owner !== 'string'
    || !authority.owner
    || !Number.isSafeInteger(authority.epoch)
    || row.execution_owner !== authority.owner
    || row.execution_epoch !== authority.epoch
    || row.lease_expires_at <= now
  ) throw new Error('导入执行租约已失效，已拒绝旧执行器写入')
  return row
}

function completedBatches(row: ImportRunRow): Partial<Record<ImportRunStage, string[]>> {
  const parsed = parseJson<unknown>(row.completed_batches_json, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('导入运行 checkpoint 损坏')
  }
  for (const [stage, batches] of Object.entries(parsed)) {
    if (!IMPORT_RUN_STAGE_VALUES.has(stage as ImportRunStage)) {
      throw new Error('导入运行 checkpoint 损坏')
    }
    if (!Array.isArray(batches) || batches.some(batch => typeof batch !== 'string')) {
      throw new Error('导入运行 checkpoint 损坏')
    }
  }
  return parsed as Partial<Record<ImportRunStage, string[]>>
}

function chapterRowsForRange(
  runId: string,
  startChapter: number,
  endChapter: number,
): ImportRunCheckpointChapterRow[] {
  return db().prepare(`
    SELECT chapter_number, content_fingerprint
    FROM import_run_chapters
    WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
    ORDER BY chapter_number ASC
  `).all(runId, startChapter, endChapter) as ImportRunCheckpointChapterRow[]
}

function checkpointRange(batchId: string): { startChapter: number; endChapter: number } {
  const parsed = parseImportRunChapterBatchCheckpointId(batchId)
  if (!parsed) throw new Error('导入批次 ID 无效')
  return parsed
}

function checkpointChapterNumbers(row: ImportRunRow, stage: 'knowledge' | 'blueprints', batchId: string): number[] {
  if (stage === 'knowledge') {
    const parsed = parseImportRunChapterBatchCheckpointId(batchId)
    if (!parsed || parsed.contentFingerprintPrefixes.length > IMPORT_RUN_KNOWLEDGE_BATCH_SIZE) {
      throw new Error('导入批次 ID 无效')
    }
    const chapters = chapterRowsForRange(row.id, parsed.startChapter, parsed.endChapter)
    if (
      chapters.length !== parsed.contentFingerprintPrefixes.length
      || chapters.some((chapter, index) => (
        chapter.chapter_number !== parsed.startChapter + index
        || !chapter.content_fingerprint.startsWith(parsed.contentFingerprintPrefixes[index]!)
      ))
    ) throw new Error('导入批次 ID 无效')
    const receipts = db().prepare(`
      SELECT chapter_number, purpose, source_id, source_chapter_number,
             content_fingerprint, document_id, state
      FROM import_run_knowledge_receipts
      WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
      ORDER BY chapter_number ASC
    `).all(row.id, parsed.startChapter, parsed.endChapter) as Array<{
      chapter_number: number
      purpose: string
      source_id: string
      source_chapter_number: number
      content_fingerprint: string
      document_id: string
      state: string
    }>
    const affiliations = db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number, content_fingerprint
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number BETWEEN ? AND ?
      ORDER BY chapter_number ASC
    `).all(row.id, parsed.startChapter, parsed.endChapter) as Array<{
      chapter_number: number
      source_id: string
      source_chapter_number: number
      content_fingerprint: string
    }>
    if (receipts.length !== affiliations.length || receipts.some((receipt, index) => {
      const affiliation = affiliations[index]!
      return receipt.chapter_number !== affiliation.chapter_number
        || receipt.purpose !== row.purpose
        || receipt.source_id !== affiliation.source_id
        || receipt.source_chapter_number !== affiliation.source_chapter_number
        || receipt.content_fingerprint !== affiliation.content_fingerprint
        || !SHA256.test(receipt.document_id)
        || receipt.state !== 'committed'
    })) throw new Error('参照知识 receipt 未完成或与冻结章节不匹配')
    return chapters.map(chapter => chapter.chapter_number)
  }

  const parsed = parseImportRunChapterBatchCheckpointId(batchId)
  if (!parsed || parsed.contentFingerprintPrefixes.length > IMPORT_RUN_BLUEPRINT_BATCH_SIZE) {
    throw new Error('导入批次 ID 无效')
  }
  const chapters = chapterRowsForRange(row.id, parsed.startChapter, parsed.endChapter)
  if (
    chapters.length !== parsed.contentFingerprintPrefixes.length
    || chapters.some((chapter, index) => (
      chapter.chapter_number !== parsed.startChapter + index
      || !chapter.content_fingerprint.startsWith(parsed.contentFingerprintPrefixes[index]!)
    ))
  ) throw new Error('导入批次 ID 无效')
  return chapters.map(chapter => chapter.chapter_number)
}

function authorCheckpointChapterNumber(row: ImportRunRow, batchId: string): number {
  const match = AUTHOR_CHAPTER_CHECKPOINT.exec(batchId)
  const chapterNumber = match ? Number(match[1]) : 0
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new Error('原稿导入批次 ID 无效')
  const chapter = db().prepare(`
    SELECT chapter_number FROM import_run_chapters WHERE run_id = ? AND chapter_number = ?
  `).get(row.id, chapterNumber) as { chapter_number: number } | undefined
  if (!chapter) throw new Error('原稿导入批次 ID 无效')
  return chapterNumber
}

function assertCheckpointCanApply(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
  source: ImportRunCheckpointSource,
): void {
  if (row.status !== 'running' || row.stage !== stage) throw new Error('导入批次与当前阶段不匹配')
  if (stage === 'parsing' || stage === 'prepared' || stage === 'completed') throw new Error('导入批次 ID 无效')
  const receiptStage = stage === 'global'
    || stage === 'style'
    || stage === 'blueprints'
    || stage === 'author-commit'
  if ((receiptStage && source !== 'receipt') || (!receiptStage && source !== 'direct')) {
    throw new Error(receiptStage ? '该导入阶段必须通过 receipt 提交' : '该导入阶段不接受 receipt 提交')
  }
  if (stage === 'global' || stage === 'style' || stage === 'author-commit' || stage === 'refresh') {
    if (batchId !== 'done') throw new Error('导入批次 ID 无效')
    return
  }

  if (stage === 'author-publish' || stage === 'author-postprocess') {
    const chapterNumber = authorCheckpointChapterNumber(row, batchId)
    const existing = completedBatches(row)[stage] ?? []
    if (existing.some(existingBatchId => (
      existingBatchId !== batchId
      && authorCheckpointChapterNumber(row, existingBatchId) === chapterNumber
    ))) throw new Error('原稿导入批次与已完成 checkpoint 重叠')
    return
  }
  if (stage !== 'knowledge' && stage !== 'blueprints') throw new Error('导入批次 ID 无效')
  checkpointChapterNumbers(row, stage, batchId)
  const range = checkpointRange(batchId)
  const existing = completedBatches(row)[stage] ?? []
  for (const existingBatchId of existing) {
    if (existingBatchId === batchId) continue
    const existingRange = checkpointRange(existingBatchId)
    if (range.startChapter <= existingRange.endChapter && existingRange.startChapter <= range.endChapter) {
      throw new Error('导入批次与已完成 checkpoint 重叠')
    }
  }
}

function assertStageCheckpointComplete(row: ImportRunRow, stage: ImportRunStage): void {
  const batches = completedBatches(row)[stage] ?? []
  if (stage === 'global' || stage === 'style' || stage === 'author-commit' || stage === 'refresh') {
    if (batches.length !== 1 || batches[0] !== 'done') throw new Error('导入阶段 checkpoint 未完成')
    return
  }
  if (stage === 'author-publish' || stage === 'author-postprocess') {
    const allChapters = chapterRowsForRange(row.id, 1, Number.MAX_SAFE_INTEGER)
    const covered = new Set(batches.map(batchId => authorCheckpointChapterNumber(row, batchId)))
    if (
      covered.size !== allChapters.length
      || allChapters.some(chapter => !covered.has(chapter.chapter_number))
    ) throw new Error('原稿导入阶段 checkpoint 未完成')
    return
  }
  if (stage !== 'knowledge' && stage !== 'blueprints') throw new Error('导入阶段 checkpoint 未完成')

  const allChapters = chapterRowsForRange(row.id, 1, Number.MAX_SAFE_INTEGER)
  const covered = new Set<number>()
  for (const batchId of batches) {
    for (const chapterNumber of checkpointChapterNumbers(row, stage, batchId)) {
      if (covered.has(chapterNumber)) throw new Error('导入阶段 checkpoint 重叠')
      covered.add(chapterNumber)
    }
  }
  if (
    covered.size !== allChapters.length
    || allChapters.some(chapter => !covered.has(chapter.chapter_number))
  ) throw new Error('导入阶段 checkpoint 未完成')
}

function assertExecution(runId: string, execution: ImportRunExecutionLease, now = Date.now()): ImportRunRow {
  const row = assertExecutionAuthority(runId, execution, now)
  if (row.lease_expires_at !== execution.expiresAt) {
    throw new Error('导入执行租约已失效，已拒绝旧执行器写入')
  }
  return row
}

function applyBatchCheckpoint(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
  source: ImportRunCheckpointSource,
): { newlyCompleted: boolean; cancelApplied: boolean } {
  assertCheckpointCanApply(row, stage, batchId, source)
  const completed = completedBatches(row)
  const stageBatches = completed[stage] ?? []
  const newlyCompleted = !stageBatches.includes(batchId)
  if (newlyCompleted) completed[stage] = [...stageBatches, batchId]
  const cancelApplied = row.cancel_requested === 1
  db().prepare(`
    UPDATE import_runs
    SET completed_batches_json = ?,
        status = CASE WHEN ? = 1 THEN 'cancelled' ELSE status END,
        resumable = 1,
        execution_owner = CASE WHEN ? = 1 THEN '' ELSE execution_owner END,
        execution_epoch = execution_epoch + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
        lease_expires_at = CASE WHEN ? = 1 THEN 0 ELSE lease_expires_at END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(completed),
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    cancelApplied ? 1 : 0,
    row.id,
  )
  return { newlyCompleted, cancelApplied }
}

function sourceChapterKey(sourceId: string, sourceChapterNumber: number): string {
  return `${sourceId}:${sourceChapterNumber}`
}

function completedChapterManifest(
  purpose: ImportPurpose,
  sourceIds: string[],
): Map<string, { number: number; title: string; contentFingerprint: string; contentSize: number }> {
  const placeholders = sourceIds.map(() => '?').join(', ')
  const rows = db().prepare(`
    SELECT source_map.chapter_number, chapters.source_id, chapters.source_chapter_number,
           chapters.title, chapters.content_fingerprint, chapters.content_size
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id = chapters.run_id
    JOIN import_source_chapter_map AS source_map
      ON source_map.purpose = runs.purpose
      AND source_map.source_id = chapters.source_id
      AND source_map.source_chapter_number = chapters.source_chapter_number
    WHERE runs.purpose = ? AND runs.status = 'completed'
      AND chapters.source_id IN (${placeholders})
    ORDER BY runs.completed_at ASC, runs.rowid ASC, chapters.chapter_number ASC
  `).all(purpose, ...sourceIds) as Array<{
    chapter_number: number
    source_id: string
    source_chapter_number: number
    title: string
    content_fingerprint: string
    content_size: number
  }>
  return new Map(rows.map(row => [sourceChapterKey(row.source_id, row.source_chapter_number), {
    number: row.chapter_number,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
  }]))
}

function assignStableChapterNumbers(
  purpose: ImportPurpose,
  chapters: NormalizedImportRunChapter[],
): {
  chapters: NormalizedImportRunChapter[]
  newMappings: Array<{ sourceId: string; sourceChapterNumber: number; chapterNumber: number }>
} {
  const readMapping = db().prepare(`
    SELECT chapter_number FROM import_source_chapter_map
    WHERE purpose = ? AND source_id = ? AND source_chapter_number = ?
  `)
  let nextChapterNumber = (db().prepare(`
    SELECT COALESCE(MAX(chapter_number), 0) AS value
    FROM import_source_chapter_map WHERE purpose = ?
  `).get(purpose) as { value: number }).value
  const newMappings: Array<{ sourceId: string; sourceChapterNumber: number; chapterNumber: number }> = []
  const numbered = chapters.map(chapter => {
    const row = readMapping.get(
      purpose,
      chapter.sourceId,
      chapter.sourceChapterNumber,
    ) as { chapter_number: number } | undefined
    const number = row?.chapter_number ?? ++nextChapterNumber
    if (!row) newMappings.push({
      sourceId: chapter.sourceId,
      sourceChapterNumber: chapter.sourceChapterNumber,
      chapterNumber: number,
    })
    return { ...chapter, number }
  })
  return { chapters: numbered.sort((left, right) => left.number - right.number), newMappings }
}

function adoptLegacyCompletedRun(
  purpose: ImportPurpose,
  legacyFingerprint: string,
  candidateChapters: NormalizedImportRunChapter[],
): void {
  if (candidateChapters.length === 0) return
  const legacySourceId = `legacy:${legacyFingerprint}`
  const legacyRun = db().prepare(`
    SELECT id FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND status = 'completed'
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(purpose, legacyFingerprint) as { id: string } | undefined
  if (!legacyRun) return
  const legacyChapters = db().prepare(`
    SELECT chapter_number, source_chapter_number, title, content_fingerprint, content_size
    FROM import_run_chapters
    WHERE run_id = ? AND source_id = ?
    ORDER BY chapter_number
  `).all(legacyRun.id, legacySourceId) as Array<{
    chapter_number: number
    source_chapter_number: number
    title: string
    content_fingerprint: string
    content_size: number
  }>
  const orderedCandidates = [...candidateChapters].sort((left, right) => (
    left.number - right.number || left.sourceChapterNumber - right.sourceChapterNumber
  ))
  if (
    legacyChapters.length !== orderedCandidates.length
    || legacyChapters.some((chapter, index) => {
      const candidate = orderedCandidates[index]
      return chapter.title !== candidate.title
        || chapter.content_fingerprint !== candidate.contentFingerprint
        || chapter.content_size !== candidate.contentSize
    })
  ) return

  const updateMapping = db().prepare(`
    UPDATE import_source_chapter_map
    SET source_id = ?, source_chapter_number = ?
    WHERE purpose = ? AND source_id = ? AND source_chapter_number = ?
  `)
  const updateChapters = db().prepare(`
    UPDATE import_run_chapters
    SET source_id = ?, source_chapter_number = ?
    WHERE source_id = ? AND source_chapter_number = ?
      AND run_id IN (SELECT id FROM import_runs WHERE purpose = ? AND source_fingerprint = ?)
  `)
  legacyChapters.forEach((chapter, index) => {
    const candidate = orderedCandidates[index]
    updateMapping.run(
      candidate.sourceId,
      candidate.sourceChapterNumber,
      purpose,
      legacySourceId,
      chapter.source_chapter_number,
    )
    updateChapters.run(
      candidate.sourceId,
      candidate.sourceChapterNumber,
      legacySourceId,
      chapter.source_chapter_number,
      purpose,
      legacyFingerprint,
    )
  })
}

function matchingResumableRun(purpose: ImportPurpose, sourceFingerprint: string, manifestFingerprint: string): ImportRunRow | undefined {
  return db().prepare(`
    SELECT * FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND manifest_fingerprint = ?
      AND stage <> 'parsing' AND resumable = 1
      AND status IN ('ready', 'running', 'failed', 'cancelled')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint, manifestFingerprint) as ImportRunRow | undefined
}

function discardProvisionalParsingRun(runId: string): void {
  const result = db().prepare(`
    DELETE FROM import_runs
    WHERE id = ? AND stage = 'parsing' AND status IN ('ready', 'failed')
  `).run(runId)
  if (result.changes !== 1) throw new Error('导入解析临时运行无法安全终止')
}

function latestCompletedRun(purpose: ImportPurpose, sourceFingerprint: string): ImportRunRow | undefined {
  return db().prepare(`
    SELECT * FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND status = 'completed'
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint) as ImportRunRow | undefined
}

function overlappingResumableSourceRun(runId: string, purpose: ImportPurpose): ImportRunRow | undefined {
  return db().prepare(`
    SELECT DISTINCT other_runs.*
    FROM import_runs AS other_runs
    JOIN import_run_sources AS other_sources ON other_sources.run_id = other_runs.id
    JOIN import_run_sources AS current_sources
      ON current_sources.run_id = ?
      AND current_sources.source_fingerprint = other_sources.source_fingerprint
    WHERE other_runs.id <> ?
      AND other_runs.purpose = ?
      AND other_runs.stage <> 'parsing'
      AND other_runs.resumable = 1
      AND other_runs.status IN ('ready', 'running', 'failed', 'cancelled')
    ORDER BY other_runs.updated_at DESC, other_runs.rowid DESC
    LIMIT 1
  `).get(runId, runId, purpose) as ImportRunRow | undefined
}

export class ImportRunRepository {
  static parsedSourceStatus(runId: string, sourceId: string): 'pending' | 'completed' | 'failed' | undefined {
    const row = db().prepare(`
      SELECT status FROM import_run_sources WHERE run_id = ? AND source_id = ?
    `).get(runId, sourceId) as { status: 'pending' | 'completed' | 'failed' } | undefined
    return row?.status
  }

  static assertExecutionAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    now = Date.now(),
  ): void {
    assertExecutionAuthority(runId, authority, now)
  }

  static resolveReferenceImportAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    chapterNumber: number,
    now = Date.now(),
  ): {
    chapterNumber: number
    title: string
    content: string
    contentFingerprint: string
    stableKey: string
  } {
    const run = assertExecutionAuthority(runId, authority, now)
    if (
      run.purpose !== 'reference'
      || run.stage !== 'knowledge'
      || run.cancel_requested === 1
      || !Number.isSafeInteger(chapterNumber)
      || chapterNumber < 1
    ) {
      throw new Error('参照知识写入未绑定当前导入的冻结章节')
    }
    const chapter = db().prepare(`
      SELECT source_id, source_chapter_number, title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number = ?
    `).get(runId, chapterNumber) as {
      source_id: string
      source_chapter_number: number
      title: string
      content_fingerprint: string
      content_size: number
      content_snapshot: string
    } | undefined
    if (!chapter) throw new Error('参照知识写入未绑定当前导入的冻结章节')
    assertFrozenChapterSnapshot(chapter)
    const affiliationHash = createHash('sha256').update(JSON.stringify({
      purpose: run.purpose,
      sourceId: chapter.source_id,
      sourceChapterNumber: chapter.source_chapter_number,
      contentFingerprint: chapter.content_fingerprint,
    })).digest('hex')
    return {
      chapterNumber,
      title: chapter.title,
      content: chapter.content_snapshot,
      contentFingerprint: chapter.content_fingerprint,
      stableKey: `reference:${affiliationHash}`,
    }
  }

  static commitReferenceImportReceipt(
    runId: string,
    authority: ImportRunExecutionAuthority,
    chapterNumber: number,
    documentId: string,
  ): void {
    if (!SHA256.test(documentId)) throw new Error('参照知识文档身份无效')
    db().transaction(() => {
      const binding = this.resolveReferenceImportAuthority(runId, authority, chapterNumber)
      const expectedDocumentId = createHash('sha256')
        .update(`reference-import:${binding.stableKey}`, 'utf8')
        .digest('hex')
      const committedDocument = db().prepare(`
        SELECT document_id, content_hash, state
        FROM import_reference_documents WHERE document_id = ?
      `).get(expectedDocumentId) as {
        document_id: string
        content_hash: string
        state: string
      } | undefined
      if (
        documentId !== expectedDocumentId
        || committedDocument?.document_id !== expectedDocumentId
        || committedDocument.content_hash !== binding.contentFingerprint
        || committedDocument.state !== 'committed'
      ) throw new Error('参照知识文档尚未按冻结章节完整提交')
      const row = db().prepare(`
        SELECT source_id, source_chapter_number
        FROM import_run_chapters WHERE run_id = ? AND chapter_number = ?
      `).get(runId, chapterNumber) as { source_id: string; source_chapter_number: number }
      const existing = db().prepare(`
        SELECT document_id, purpose, source_id, source_chapter_number, content_fingerprint, state
        FROM import_run_knowledge_receipts WHERE run_id = ? AND chapter_number = ?
      `).get(runId, chapterNumber) as {
        document_id: string
        purpose: string
        source_id: string
        source_chapter_number: number
        content_fingerprint: string
        state: string
      } | undefined
      if (existing && (
        existing.document_id !== documentId
        || existing.purpose !== 'reference'
        || existing.source_id !== row.source_id
        || existing.source_chapter_number !== row.source_chapter_number
        || existing.content_fingerprint !== binding.contentFingerprint
        || existing.state !== 'committed'
      )) throw new Error('参照知识 receipt 已绑定不同效果')
      if (!existing) db().prepare(`
        INSERT INTO import_run_knowledge_receipts (
          run_id, chapter_number, purpose, source_id, source_chapter_number,
          content_fingerprint, document_id, state
        ) VALUES (?, ?, 'reference', ?, ?, ?, ?, 'committed')
      `).run(
        runId,
        chapterNumber,
        row.source_id,
        row.source_chapter_number,
        binding.contentFingerprint,
        documentId,
      )
    })()
  }

  static beginParsing(candidate: ImportRunBeginParsingRequest): ImportRunSnapshot {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference') throw new Error('当前版本不支持作者手稿导入')
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const sourceIds = normalizeSourceIds(candidate.sourceIds, sourceDisplay, candidate.sourceFingerprint)
    const sourceFingerprints = normalizeSourceFingerprints(candidate.sourceFingerprints, sourceIds)
    if (sourceFingerprints.length !== sourceIds.length) throw new Error('导入来源单文件指纹无效')
    const legacySourceFingerprints = candidate.legacySourceFingerprints ?? sourceIds.map(() => '')
    if (legacySourceFingerprints.length !== sourceIds.length || legacySourceFingerprints.some(value => value !== '' && !SHA256.test(value))) {
      throw new Error('旧导入来源单文件指纹无效')
    }
    if (candidate.legacyCollectionFingerprint && !SHA256.test(candidate.legacyCollectionFingerprint)) {
      throw new Error('旧导入来源集合指纹无效')
    }

    return db().transaction(() => {
      const explicitRun = readRunRow(runId)
      if (explicitRun) {
        const persistedSources = db().prepare(`
          SELECT source_index, source_id, source_fingerprint, legacy_source_fingerprint,
                 display_json, status
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).all(explicitRun.id) as Array<{
          source_index: number
          source_id: string
          source_fingerprint: string
          legacy_source_fingerprint: string
          display_json: string
          status: 'pending' | 'completed' | 'failed'
        }>
        if (
          explicitRun.purpose !== candidate.purpose
          || explicitRun.stage !== 'parsing'
          || explicitRun.resumable !== 1
          || explicitRun.locale !== candidate.locale
        ) throw new Error('指定的导入运行当前不可重新授权未完成来源')

        const persistedById = new Map(persistedSources.map(source => [source.source_id, source]))
        if (sourceIds.some((sourceId, index) => {
          const persisted = persistedById.get(sourceId)
          return !persisted
            || persisted.status === 'completed'
            || persisted.source_fingerprint !== sourceFingerprints[index]
        })) throw new Error('未完成导入的来源清单与本次重新授权不一致')

        const updateSource = db().prepare(`
          UPDATE import_run_sources
          SET legacy_source_fingerprint = ?, display_json = ?, updated_at = datetime('now')
          WHERE run_id = ? AND source_id = ? AND source_fingerprint = ? AND status <> 'completed'
        `)
        sourceIds.forEach((sourceId, index) => {
          const changed = updateSource.run(
            legacySourceFingerprints[index],
            JSON.stringify(sourceDisplay[index]),
            explicitRun.id,
            sourceId,
            sourceFingerprints[index],
          )
          if (changed.changes !== 1) throw new Error('未完成导入的来源清单与本次重新授权不一致')
          const persisted = persistedById.get(sourceId)!
          persisted.legacy_source_fingerprint = legacySourceFingerprints[index]
          persisted.display_json = JSON.stringify(sourceDisplay[index])
        })
        const fullDisplay = persistedSources.map(source => parseJson<ImportSourceDisplayMetadata>(
          source.display_json,
          { displayName: '', mediaType: '', size: 0 },
        ))
        db().prepare(`
          UPDATE import_runs SET source_display_json = ?, updated_at = datetime('now') WHERE id = ?
        `).run(JSON.stringify(fullDisplay), explicitRun.id)
        return this.get(explicitRun.id)!
      }

      const existing = db().prepare(`
        SELECT * FROM import_runs
        WHERE purpose = ? AND source_fingerprint = ? AND stage = 'parsing' AND resumable = 1
        ORDER BY updated_at DESC, rowid DESC LIMIT 1
      `).get(candidate.purpose, candidate.sourceFingerprint) as ImportRunRow | undefined
      if (existing) {
        const sources = db().prepare(`
          SELECT source_id, source_fingerprint, legacy_source_fingerprint, display_json
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).all(existing.id) as Array<{ source_id: string; source_fingerprint: string; legacy_source_fingerprint: string; display_json: string }>
        const sourcesById = new Map(sources.map(source => [source.source_id, source]))
        if (
          sources.length !== sourceIds.length
          || sourceIds.some((sourceId, index) => (
            sourcesById.get(sourceId)?.source_fingerprint !== sourceFingerprints[index]
          ))
        ) throw new Error('未完成导入的来源清单与本次重新授权不一致')
        db().prepare(`
          UPDATE import_run_sources
          SET source_index = source_index + ?
          WHERE run_id = ?
        `).run(MAX_IMPORT_SOURCE_FILES, existing.id)
        const updateSource = db().prepare(`
          UPDATE import_run_sources
          SET source_index = ?, legacy_source_fingerprint = ?, display_json = ?, updated_at = datetime('now')
          WHERE run_id = ? AND source_id = ? AND source_fingerprint = ?
        `)
        sourceIds.forEach((sourceId, index) => {
          const changed = updateSource.run(
            index,
            legacySourceFingerprints[index],
            JSON.stringify(sourceDisplay[index]),
            existing.id,
            sourceId,
            sourceFingerprints[index],
          )
          if (changed.changes !== 1) throw new Error('未完成导入的来源清单与本次重新授权不一致')
        })
        db().prepare(`
          UPDATE import_runs SET source_display_json = ?, updated_at = datetime('now') WHERE id = ?
        `).run(JSON.stringify(sourceDisplay), existing.id)
        return this.get(existing.id)!
      }
      if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')
      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint, legacy_source_fingerprint,
          source_display_json, locale, stage, status, total_chapters, total_content_size,
          manifest_chapter_count, manifest_content_size, manifest_word_count, completed_chapters
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsing', 'ready', 0, 0, 0, 0, 0, 0)
      `).run(
        runId,
        candidate.purpose,
        runId,
        `import:${candidate.purpose}:${runId}`,
        candidate.sourceFingerprint,
        '0'.repeat(64),
        candidate.legacyCollectionFingerprint ?? '',
        JSON.stringify(sourceDisplay),
        candidate.locale,
      )
      const insertSource = db().prepare(`
        INSERT INTO import_run_sources (
          run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      sourceIds.forEach((sourceId, index) => insertSource.run(
        runId,
        index,
        sourceId,
        sourceFingerprints[index],
        legacySourceFingerprints[index],
        JSON.stringify(sourceDisplay[index]),
      ))
      return this.get(runId)!
    })()
  }

  static commitParsedSource(
    runId: string,
    sourceId: string,
    chapters: ImportRunChapterInput[],
  ): ImportRunSnapshot {
    if (!OPAQUE_SOURCE_ID.test(sourceId)) throw new Error('导入解析来源身份无效')
    if (!Array.isArray(chapters) || chapters.length === 0) throw new Error('导入解析来源没有可导入的正文')
    if (chapters.some(chapter => (
      createHash('sha256').update(chapter.content, 'utf8').digest('hex') !== chapter.contentFingerprint
    ))) throw new Error('导入解析来源内容指纹与冻结快照不一致')
    const normalized = normalizeChapters(chapters, [sourceId])
    const manifestFingerprint = hashManifest('reference', normalized.map((chapter, index) => ({
      ...chapter,
      number: index + 1,
    })))
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.purpose !== 'reference' || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可写入来源')
      }
      const source = db().prepare(`
        SELECT * FROM import_run_sources WHERE run_id = ? AND source_id = ?
      `).get(runId, sourceId) as ImportRunSourceRow | undefined
      if (!source) throw new Error('导入解析来源不存在')
      if (source.status === 'completed') {
        if (source.manifest_fingerprint !== manifestFingerprint) throw new Error('已完成来源与本次重新授权内容不一致')
        return this.get(runId)!
      }
      db().prepare('DELETE FROM import_run_source_chapters WHERE run_id = ? AND source_id = ?')
        .run(runId, sourceId)
      const insert = db().prepare(`
        INSERT INTO import_run_source_chapters (
          run_id, source_id, source_chapter_number, title, content_fingerprint,
          content_size, word_count, content_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const chapter of normalized) {
        insert.run(
          runId,
          sourceId,
          chapter.sourceChapterNumber,
          chapter.title,
          chapter.contentFingerprint,
          chapter.contentSize,
          chapter.content.length,
          chapter.content,
        )
      }
      db().prepare(`
        UPDATE import_run_sources
        SET status = 'completed', manifest_fingerprint = ?, chapter_count = ?,
            content_size = ?, word_count = ?, last_error = '', updated_at = datetime('now')
        WHERE run_id = ? AND source_id = ?
      `).run(
        manifestFingerprint,
        normalized.length,
        normalized.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        normalized.reduce((sum, chapter) => sum + chapter.content.length, 0),
        runId,
        sourceId,
      )
      db().prepare(`
        UPDATE import_runs
        SET status = 'ready', last_error = '',
            total_chapters = (SELECT COALESCE(SUM(chapter_count), 0) FROM import_run_sources WHERE run_id = ? AND status = 'completed'),
            total_content_size = (SELECT COALESCE(SUM(content_size), 0) FROM import_run_sources WHERE run_id = ? AND status = 'completed'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(runId, runId, runId)
      return this.get(runId)!
    })()
  }

  static failParsedSource(runId: string, sourceId: string, error: string): ImportRunSnapshot {
    if (typeof error !== 'string' || !error.trim()) throw new Error('导入解析失败原因无效')
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可标记失败')
      }
      const changed = db().prepare(`
        UPDATE import_run_sources
        SET status = 'failed', last_error = ?, updated_at = datetime('now')
        WHERE run_id = ? AND source_id = ? AND status <> 'completed'
      `).run(error.slice(0, 2_000), runId, sourceId)
      if (changed.changes !== 1) throw new Error('导入解析来源当前不可标记失败')
      db().prepare(`
        UPDATE import_runs SET status = 'failed', last_error = ?, resumable = 1,
          updated_at = datetime('now') WHERE id = ?
      `).run(error.slice(0, 2_000), runId)
      return this.get(runId)!
    })()
  }

  static finalizeParsing(runId: string): ImportRunPreparationResult {
    return db().transaction(() => {
      const run = readRunRow(runId)
      if (!run || run.stage !== 'parsing' || !['ready', 'failed'].includes(run.status)) {
        throw new Error('导入解析运行当前不可完成')
      }
      const sources = db().prepare(`
        SELECT * FROM import_run_sources WHERE run_id = ? ORDER BY source_index
      `).all(runId) as ImportRunSourceRow[]
      if (sources.length === 0 || sources.some(source => source.status !== 'completed')) {
        throw new Error('导入来源解析尚未完成，请重新授权未完成来源')
      }
      const metadata = db().prepare(`
        SELECT sources.source_index, chapters.source_id, chapters.source_chapter_number,
               chapters.title, chapters.content_fingerprint, chapters.content_size, chapters.word_count
        FROM import_run_source_chapters AS chapters
        JOIN import_run_sources AS sources
          ON sources.run_id = chapters.run_id AND sources.source_id = chapters.source_id
        WHERE chapters.run_id = ?
        ORDER BY sources.source_index, chapters.source_chapter_number
      `).all(runId) as Array<{
        source_index: number
        source_id: string
        source_chapter_number: number
        title: string
        content_fingerprint: string
        content_size: number
        word_count: number
      }>
      if (
        metadata.length === 0
        || metadata.length > MAX_IMPORT_CHAPTERS
        || metadata.length !== sources.reduce((sum, source) => sum + source.chapter_count, 0)
        || sources.reduce((sum, source) => sum + source.content_size, 0) > MAX_IMPORT_TOTAL_BYTES
      ) throw new Error('导入解析 manifest 无效')
      const normalized = metadata.map((chapter, index): NormalizedImportRunChapter => ({
        number: index + 1,
        sourceIndex: chapter.source_index,
        sourceId: chapter.source_id,
        sourceChapterNumber: chapter.source_chapter_number,
        title: chapter.title,
        contentFingerprint: chapter.content_fingerprint,
        contentSize: chapter.content_size,
        content: '',
      }))
      sources.forEach((source, sourceIndex) => {
        if (source.legacy_source_fingerprint) {
          adoptLegacyCompletedRun(
            run.purpose,
            source.legacy_source_fingerprint,
            normalized.filter(chapter => chapter.sourceIndex === sourceIndex),
          )
        }
      })
      if (run.legacy_source_fingerprint) {
        adoptLegacyCompletedRun(run.purpose, run.legacy_source_fingerprint, normalized)
      }
      const assignment = assignStableChapterNumbers(run.purpose, normalized)
      const chapters = assignment.chapters
      const sourceDisplay = sources.map(source => parseJson<ImportSourceDisplayMetadata>(
        source.display_json,
        { displayName: '', mediaType: '', size: 0 },
      ))
      const wordCounts = new Map(metadata.map(chapter => [
        sourceChapterKey(chapter.source_id, chapter.source_chapter_number),
        chapter.word_count,
      ]))
      const previewChapters = chapters.map(chapter => ({
        number: chapter.number,
        title: chapter.title,
        wordCount: wordCounts.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber)) ?? 0,
        contentSize: chapter.contentSize,
      }))
      const inspectionFor = (
        newChapterNumbers: number[],
        conflictChapterNumbers: number[],
        duplicateChapterNumbers: number[],
      ) => createPreparationInspection(runId, run.purpose, sourceDisplay, previewChapters, {
        newChapterNumbers, conflictChapterNumbers, duplicateChapterNumbers,
      })
      const manifestFingerprint = hashManifest(run.purpose, chapters)
      const resumable = matchingResumableRun(run.purpose, run.source_fingerprint, manifestFingerprint)
      if (resumable && resumable.id !== runId) {
        const duplicateChapterNumbers = chapters.map(chapter => chapter.number)
        discardProvisionalParsingRun(runId)
        return {
          classification: 'resumable' as const,
          run: rowToSnapshot(resumable),
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      if (overlappingResumableSourceRun(runId, run.purpose)) {
        throw new Error(run.locale === 'en-US'
          ? 'Another resumable import already contains the same source. Complete or cancel that import, then try again.'
          : '另一个可恢复导入已包含相同来源，请先完成或取消该导入后重试')
      }
      const sourceIds = sources.map(source => source.source_id)
      const completed = latestCompletedRun(run.purpose, run.source_fingerprint)
      const completedManifest = completedChapterManifest(run.purpose, sourceIds)
      const conflictChapterNumbers = chapters.filter(chapter => {
        const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
        return previous !== undefined && (
          previous.title !== chapter.title
          || previous.contentFingerprint !== chapter.contentFingerprint
          || previous.contentSize !== chapter.contentSize
        )
      }).map(chapter => chapter.number)
      const duplicateChapterNumbers = chapters.filter(chapter => {
        const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
        return previous !== undefined
          && previous.title === chapter.title
          && previous.contentFingerprint === chapter.contentFingerprint
          && previous.contentSize === chapter.contentSize
      }).map(chapter => chapter.number)
      const newChapters = chapters.filter(chapter => (
        !completedManifest.has(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
      ))
      if (conflictChapterNumbers.length > 0) {
        discardProvisionalParsingRun(runId)
        return {
          classification: 'conflict' as const, run: undefined,
          newChapterNumbers: newChapters.map(chapter => chapter.number),
          conflictChapterNumbers, duplicateChapterNumbers,
          inspection: inspectionFor(
            newChapters.map(chapter => chapter.number), conflictChapterNumbers, duplicateChapterNumbers,
          ),
        }
      }
      if (newChapters.length === 0) {
        db().prepare('DELETE FROM import_runs WHERE id = ?').run(runId)
        return {
          classification: 'exact-duplicate' as const, run: undefined,
          newChapterNumbers: [], conflictChapterNumbers: [], duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      const insertMapping = db().prepare(`
        INSERT INTO import_source_chapter_map (purpose, source_id, source_chapter_number, chapter_number)
        VALUES (?, ?, ?, ?)
      `)
      assignment.newMappings.forEach(mapping => insertMapping.run(
        run.purpose, mapping.sourceId, mapping.sourceChapterNumber, mapping.chapterNumber,
      ))
      const insertChapter = db().prepare(`
        INSERT INTO import_run_chapters (
          run_id, chapter_number, source_id, source_chapter_number,
          title, content_fingerprint, content_size, content_snapshot
        )
        SELECT ?, ?, source_id, source_chapter_number, title, content_fingerprint, content_size, content_snapshot
        FROM import_run_source_chapters
        WHERE run_id = ? AND source_id = ? AND source_chapter_number = ?
      `)
      for (const chapter of newChapters) {
        insertChapter.run(runId, chapter.number, runId, chapter.sourceId, chapter.sourceChapterNumber)
      }
      db().prepare(`
        UPDATE import_runs
        SET stage = 'prepared', status = 'ready', manifest_fingerprint = ?,
            total_chapters = ?, total_content_size = ?, manifest_chapter_count = ?,
            manifest_content_size = ?, manifest_word_count = ?, completed_chapters = 0,
            base_run_id = ?, last_error = '', updated_at = datetime('now')
        WHERE id = ? AND stage = 'parsing'
      `).run(
        manifestFingerprint,
        newChapters.length,
        newChapters.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        chapters.length,
        sources.reduce((sum, source) => sum + source.content_size, 0),
        sources.reduce((sum, source) => sum + source.word_count, 0),
        completed?.id ?? null,
        runId,
      )
      return {
        classification: 'new' as const, run: this.get(runId)!,
        newChapterNumbers: newChapters.map(chapter => chapter.number),
        conflictChapterNumbers: [], duplicateChapterNumbers,
        inspection: inspectionFor(
          newChapters.map(chapter => chapter.number), [], duplicateChapterNumbers,
        ),
      }
    })()
  }

  static prepare(candidate: ImportRunPrepareRequest): ImportRunPreparationResult {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference' && candidate.purpose !== 'author-manuscript') {
      throw new Error('导入用途无效')
    }
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const sourceIds = normalizeSourceIds(candidate.sourceIds, sourceDisplay, candidate.sourceFingerprint)
    const sourceFingerprints = normalizeSourceFingerprints(candidate.sourceFingerprints, sourceIds)
    const normalizedChapters = normalizeChapters(candidate.chapters, sourceIds)

    return db().transaction(() => {
      if (candidate.purpose === 'author-manuscript') {
        if (
          !candidate.authorityFingerprint
          || !SHA256.test(candidate.authorityFingerprint)
          || !candidate.expectedManifestFingerprint
          || !SHA256.test(candidate.expectedManifestFingerprint)
        ) throw new Error('作者原稿缺少已确认的权威预览')
        const authorChapters = normalizedChapters
          .map(chapter => ({
            chapterNumber: chapter.number,
            title: chapter.title,
            content: chapter.content,
            wordCount: chapter.content.length,
          }))
          .sort((left, right) => left.chapterNumber - right.chapterNumber)
        const preview = FinalizedDraftImportRepository.preview(authorChapters)
        if (preview.manifestFingerprint !== candidate.expectedManifestFingerprint) {
          throw new Error('作者原稿清单与已确认预览不一致')
        }
        const resumable = matchingResumableRun(
          candidate.purpose,
          candidate.sourceFingerprint,
          preview.manifestFingerprint,
        )
        if (resumable) {
          return {
            classification: 'resumable' as const,
            run: rowToSnapshot(resumable),
            newChapterNumbers: [],
            conflictChapterNumbers: [],
            duplicateChapterNumbers: authorChapters.map(chapter => chapter.chapterNumber),
          }
        }
        if (preview.authorityFingerprint !== candidate.authorityFingerprint) {
          throw new Error('项目权威章节已变化，作者原稿预览已过期')
        }
        if (preview.classification === 'conflict') {
          throw new Error(preview.authorityInvalid
            ? `现有权威正文章节不连续；请先修复第 ${preview.firstGapChapterNumber ?? '?'} 章附近的数据`
            : preview.conflictChapterNumbers.length > 0
              ? `作者原稿与现有正文冲突：第 ${preview.conflictChapterNumbers.join('、')} 章`
              : `作者原稿存在缺章；请从第 ${preview.firstGapChapterNumber ?? '?'} 章连续导入`)
        }
        if (preview.classification === 'exact-duplicate') {
          return {
            classification: 'exact-duplicate' as const,
            run: undefined,
            newChapterNumbers: [],
            conflictChapterNumbers: [],
            duplicateChapterNumbers: preview.duplicateChapterNumbers,
          }
        }
        if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')
        const newChapterSet = new Set(preview.newChapterNumbers)
        const chaptersToPersist = normalizedChapters
          .filter(chapter => newChapterSet.has(chapter.number))
          .sort((left, right) => left.number - right.number)
        const manifestContentSize = normalizedChapters.reduce((sum, chapter) => sum + chapter.contentSize, 0)
        const manifestWordCount = normalizedChapters.reduce((sum, chapter) => sum + chapter.content.length, 0)
        db().prepare(`
          INSERT INTO import_runs (
            id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
            authority_fingerprint, source_display_json, locale, stage, status,
            total_chapters, total_content_size, completed_chapters, base_run_id,
            manifest_chapter_count, manifest_content_size, manifest_word_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'author-commit', 'ready', ?, ?, 0, NULL, ?, ?, ?)
        `).run(
          runId,
          candidate.purpose,
          runId,
          `import:${candidate.purpose}:${runId}`,
          candidate.sourceFingerprint,
          preview.manifestFingerprint,
          candidate.authorityFingerprint,
          JSON.stringify(sourceDisplay),
          candidate.locale,
          chaptersToPersist.length,
          chaptersToPersist.reduce((sum, chapter) => sum + chapter.contentSize, 0),
          normalizedChapters.length,
          manifestContentSize,
          manifestWordCount,
        )
        const insertChapter = db().prepare(`
          INSERT INTO import_run_chapters (
            run_id, chapter_number, source_id, source_chapter_number,
            title, content_fingerprint, content_size, content_snapshot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const chapter of chaptersToPersist) {
          insertChapter.run(
            runId,
            chapter.number,
            chapter.sourceId,
            chapter.sourceChapterNumber,
            chapter.title,
            chapter.contentFingerprint,
            chapter.contentSize,
            chapter.content,
          )
        }
        const created = readRunRow(runId)
        if (!created) throw new Error('作者原稿导入运行创建失败')
        return {
          classification: 'new' as const,
          run: rowToSnapshot(created),
          newChapterNumbers: preview.newChapterNumbers,
          conflictChapterNumbers: [],
          duplicateChapterNumbers: preview.duplicateChapterNumbers,
        }
      }

      sourceFingerprints.forEach((fingerprint, sourceIndex) => {
        adoptLegacyCompletedRun(
          candidate.purpose,
          fingerprint,
          normalizedChapters.filter(chapter => chapter.sourceIndex === sourceIndex),
        )
      })
      adoptLegacyCompletedRun(candidate.purpose, candidate.sourceFingerprint, normalizedChapters)
      const assignment = assignStableChapterNumbers(candidate.purpose, normalizedChapters)
      const chapters = assignment.chapters
      const manifestFingerprint = hashManifest(candidate.purpose, chapters)
      const manifestContentSize = chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0)
      const manifestWordCount = chapters.reduce((sum, chapter) => sum + chapter.content.length, 0)
      const previewChapters = chapters.map(chapter => ({
        number: chapter.number,
        title: chapter.title,
        wordCount: chapter.content.length,
        contentSize: chapter.contentSize,
      }))
      const inspectionFor = (
        newChapterNumbers: number[],
        conflictChapterNumbers: number[],
        duplicateChapterNumbers: number[],
      ) => createPreparationInspection(candidate.runId, candidate.purpose, sourceDisplay, previewChapters, {
        newChapterNumbers, conflictChapterNumbers, duplicateChapterNumbers,
      })
      const resumable = matchingResumableRun(candidate.purpose, candidate.sourceFingerprint, manifestFingerprint)
      if (resumable) {
        const duplicateChapterNumbers = chapters.map(chapter => chapter.number)
        return {
          classification: 'resumable' as const,
          run: rowToSnapshot(resumable),
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }

      const completed = latestCompletedRun(candidate.purpose, candidate.sourceFingerprint)
      const completedManifest = completedChapterManifest(candidate.purpose, sourceIds)
      const conflictChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
          return previous !== undefined && (
            previous.title !== chapter.title
            || previous.contentFingerprint !== chapter.contentFingerprint
            || previous.contentSize !== chapter.contentSize
          )
        })
        .map(chapter => chapter.number)
      const duplicateChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
          return previous !== undefined
            && previous.title === chapter.title
            && previous.contentFingerprint === chapter.contentFingerprint
            && previous.contentSize === chapter.contentSize
        })
        .map(chapter => chapter.number)
      const newChapters = chapters.filter(chapter => (
        !completedManifest.has(sourceChapterKey(chapter.sourceId, chapter.sourceChapterNumber))
      ))

      if (conflictChapterNumbers.length > 0) {
        return {
          classification: 'conflict' as const,
          run: undefined,
          newChapterNumbers: newChapters.map(chapter => chapter.number),
          conflictChapterNumbers,
          duplicateChapterNumbers,
          inspection: inspectionFor(
            newChapters.map(chapter => chapter.number), conflictChapterNumbers, duplicateChapterNumbers,
          ),
        }
      }
      const chaptersToPersist = newChapters
      if (chaptersToPersist.length === 0) {
        return {
          classification: 'exact-duplicate' as const,
          run: undefined,
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
          inspection: inspectionFor([], [], duplicateChapterNumbers),
        }
      }
      if (readRunRow(runId)) throw new Error('导入运行 ID 已存在')

      const insertMapping = db().prepare(`
        INSERT INTO import_source_chapter_map (
          purpose, source_id, source_chapter_number, chapter_number
        ) VALUES (?, ?, ?, ?)
      `)
      for (const mapping of assignment.newMappings) {
        insertMapping.run(
          candidate.purpose,
          mapping.sourceId,
          mapping.sourceChapterNumber,
          mapping.chapterNumber,
        )
      }

      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint, source_display_json,
          locale, stage, status, total_chapters, total_content_size, completed_chapters, base_run_id
          , manifest_chapter_count, manifest_content_size, manifest_word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'knowledge', 'ready', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        runId,
        candidate.purpose,
        runId,
        `import:${candidate.purpose}:${runId}`,
        candidate.sourceFingerprint,
        manifestFingerprint,
        JSON.stringify(sourceDisplay),
        candidate.locale,
        chaptersToPersist.length,
        chaptersToPersist.reduce((sum, chapter) => sum + chapter.contentSize, 0),
        completed?.id ?? null,
        chapters.length,
        manifestContentSize,
        manifestWordCount,
      )
      const insertChapter = db().prepare(`
        INSERT INTO import_run_chapters (
          run_id, chapter_number, source_id, source_chapter_number,
          title, content_fingerprint, content_size, content_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (let offset = 0; offset < chaptersToPersist.length; offset += INSERT_BATCH_SIZE) {
        for (const chapter of chaptersToPersist.slice(offset, offset + INSERT_BATCH_SIZE)) {
          insertChapter.run(
            runId,
            chapter.number,
            chapter.sourceId,
            chapter.sourceChapterNumber,
            chapter.title,
            chapter.contentFingerprint,
            chapter.contentSize,
            chapter.content,
          )
        }
      }
      const created = readRunRow(runId)
      if (!created) throw new Error('导入运行创建失败')
      return {
        classification: 'new' as const,
        run: rowToSnapshot(created),
        newChapterNumbers: chaptersToPersist.map(chapter => chapter.number),
        conflictChapterNumbers: [],
        duplicateChapterNumbers,
        inspection: inspectionFor(
          chaptersToPersist.map(chapter => chapter.number), [], duplicateChapterNumbers,
        ),
      }
    })()
  }

  static get(runId: string): ImportRunSnapshot | null {
    const row = readRunRow(runId)
    return row ? rowToSnapshot(row) : null
  }

  static listResumable(): ImportRunSnapshot[] {
    const rows = db().prepare(`
      SELECT * FROM import_runs
      WHERE resumable = 1 AND status IN ('ready', 'running', 'failed', 'cancelled')
      ORDER BY updated_at DESC, rowid DESC
    `).all() as ImportRunRow[]
    return rows.map(rowToSnapshot)
  }

  static listChapterBatch(
    runId: string,
    options: { afterChapterNumber: number; limit: number },
  ): ImportRunChapterSnapshot[] {
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(options.limit)))
    const rows = db().prepare(`
      SELECT chapter_number, source_id, source_chapter_number,
             title, content_fingerprint, content_size, content_snapshot
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number > ?
      ORDER BY chapter_number ASC LIMIT ?
    `).all(runId, options.afterChapterNumber, limit) as ImportRunChapterRow[]
    return rows.map(chapterRowToSnapshot)
  }

  static getEffectReceipt(
    runId: string,
    stage: ImportRunStage,
    batchId: string,
  ): ImportRunEffectReceipt | null {
    const row = db().prepare(`
      SELECT * FROM import_run_receipts
      WHERE run_id = ? AND stage = ? AND batch_id = ?
    `).get(runId, stage, batchId) as ImportRunEffectReceiptRow | undefined
    if (!row) return null
    const run = readRunRow(runId)
    if (!run) return corruptedReceipt()
    return rowToEffectReceipt(row, run)
  }

  static prepareEffectReceipt(
    request: ImportRunPrepareEffectReceiptRequest,
    execution: ImportRunExecutionLease,
    now = Date.now(),
  ): ImportRunEffectReceipt {
    const effectKey = request.effectKey?.trim()
    const batchId = request.batchId?.trim()
    if (!effectKey || effectKey.length > 200 || !batchId || batchId.length > 160) {
      throw new Error('导入 effect receipt 键无效')
    }
    validateEffectStage(request.kind, request.stage)
    const payload = canonicalPayload(request.payload)
    return db().transaction(() => {
      const run = assertExecution(request.runId, execution, now)
      assertAuthorEffectRunBinding(run, request.kind, request.payload)
      assertCheckpointCanApply(run, request.stage, batchId, 'receipt')
      const existing = db().prepare(`
        SELECT * FROM import_run_receipts
        WHERE run_id = ? AND stage = ? AND batch_id = ?
      `).get(request.runId, request.stage, batchId) as ImportRunEffectReceiptRow | undefined
      if (existing) {
        if (
          existing.effect_namespace !== run.effect_namespace
          || existing.effect_key !== effectKey
          || existing.kind !== request.kind
          || existing.payload_hash !== payload.hash
        ) throw new Error('导入 effect receipt 已绑定不同载荷')
        return rowToEffectReceipt(existing, run)
      }
      db().prepare(`
        INSERT INTO import_run_receipts (
          run_id, schema_version, effect_namespace, effect_key, stage, batch_id, kind, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.runId,
        IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
        run.effect_namespace,
        effectKey,
        request.stage,
        batchId,
        request.kind,
        payload.json,
        payload.hash,
      )
      return this.getEffectReceipt(request.runId, request.stage, batchId)!
    })()
  }

  static commitEffectReceipt(
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
    now = Date.now(),
  ): ImportRunEffectCommitResult {
    return db().transaction(() => {
      const run = assertExecution(runId, execution, now)
      const row = db().prepare(`
        SELECT * FROM import_run_receipts
        WHERE run_id = ? AND stage = ? AND batch_id = ?
      `).get(runId, stage, batchId) as ImportRunEffectReceiptRow | undefined
      if (!row) throw new Error('导入 effect receipt 不存在')
      assertCheckpointCanApply(run, stage, batchId, 'receipt')
      const validatedReceipt = rowToEffectReceipt(row, run)
      if (row.state === 'committed') {
        return {
          receipt: validatedReceipt,
          run: this.get(runId)!,
          cancelApplied: run.cancel_requested === 1,
        }
      }
      let effectReceipt: unknown
      switch (row.kind) {
        case 'project-global-facts':
          effectReceipt = ImportGlobalFactsRepository.commit(
            parseJson<ImportGlobalFactsRequest>(row.payload_json, {} as ImportGlobalFactsRequest),
          )
          break
        case 'project-writing-style': {
          const payload = parseJson<{ writingStyle?: unknown }>(row.payload_json, {})
          if (typeof payload.writingStyle !== 'string' || !payload.writingStyle.trim()) {
            throw new Error('导入文风 receipt 载荷无效')
          }
          ProjectCoreRepository.update({ writingStyle: payload.writingStyle.trim() })
          effectReceipt = { writingStyle: payload.writingStyle.trim() }
          break
        }
        case 'chapter-blueprint-range':
          effectReceipt = BlueprintRepository.commitRange(
            parseJson<BlueprintRangeCommitRequest>(row.payload_json, {} as BlueprintRangeCommitRequest),
          )
          break
        case 'author-finalized-batch': {
          assertAuthorEffectRunBinding(run, row.kind, validatedReceipt.payload)
          const projectRoot = getCurrentProjectPath()
          if (!projectRoot) throw new Error('项目数据库未打开')
          const chapters = (db().prepare(`
            SELECT chapter_number, source_id, source_chapter_number,
                   title, content_fingerprint, content_size, content_snapshot
            FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number ASC
          `).all(runId) as ImportRunChapterRow[]).map(chapterRowToSnapshot).map(chapter => ({
            chapterNumber: chapter.number,
            title: chapter.title,
            content: chapter.content,
            wordCount: chapter.content.length,
          }))
          const commitManifestFingerprint = FinalizedDraftImportRepository.preview(chapters).manifestFingerprint
          effectReceipt = FinalizedDraftImportRepository.commit(projectRoot, {
            operationId: `author-import:${runId}`,
            expectedAuthorityFingerprint: run.authority_fingerprint,
            expectedManifestFingerprint: run.manifest_fingerprint,
            expectedCommitManifestFingerprint: commitManifestFingerprint,
            chapters,
          })
          break
        }
        default:
          throw new Error('导入 effect receipt 类型不受支持')
      }
      const checkpoint = applyBatchCheckpoint(run, stage, batchId, 'receipt')
      db().prepare(`
        UPDATE import_run_receipts
        SET state = 'committed', effect_receipt_json = ?, updated_at = datetime('now')
        WHERE run_id = ? AND stage = ? AND batch_id = ? AND state = 'prepared'
      `).run(JSON.stringify(effectReceipt), runId, stage, batchId)
      return {
        receipt: this.getEffectReceipt(runId, stage, batchId)!,
        run: this.get(runId)!,
        cancelApplied: checkpoint.cancelApplied,
      }
    })()
  }

  static startOrResume(
    runId: string,
    owner: string,
    now = Date.now(),
    leaseMs = DEFAULT_EXECUTION_LEASE_MS,
  ): ImportRunStartResult {
    const normalizedOwner = owner.trim()
    if (!normalizedOwner || normalizedOwner.length > 160 || leaseMs < 1) throw new Error('导入执行器身份无效')
    return db().transaction(() => {
      const row = readRunRow(runId)
      if (!row || row.resumable !== 1 || !['ready', 'running', 'failed', 'cancelled'].includes(row.status)) {
        throw new Error(row?.resumable === 0 && row.last_error
          ? row.last_error
          : '导入运行当前不可启动')
      }
      if (row.stage === 'parsing') {
        throw new Error('导入解析尚未完成，请重新选择并授权未完成来源')
      }
      const activeProjectRun = db().prepare(`
        SELECT id FROM import_runs
        WHERE id <> ? AND status = 'running' AND execution_owner <> '' AND lease_expires_at > ?
        LIMIT 1
      `).get(runId, now) as { id: string } | undefined
      if (activeProjectRun) throw new Error('项目中另一导入运行正在执行')
      if (row.execution_owner && row.execution_owner !== normalizedOwner && row.lease_expires_at > now) {
        throw new Error('导入运行正在由另一执行器运行')
      }
      const sameActiveOwner = row.execution_owner === normalizedOwner && row.lease_expires_at > now
      const epoch = sameActiveOwner ? row.execution_epoch : row.execution_epoch + 1
      const expiresAt = now + leaseMs
      db().prepare(`
        UPDATE import_runs
        SET stage = CASE WHEN stage = 'prepared' THEN 'knowledge' ELSE stage END,
            status = 'running', resumable = 1, cancel_requested = 0,
            last_error = '', execution_owner = ?, execution_epoch = ?, lease_expires_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(normalizedOwner, epoch, expiresAt, runId)
      return {
        run: this.get(runId)!,
        execution: { owner: normalizedOwner, epoch, expiresAt },
      }
    })()
  }

  static renewExecution(runId: string, execution: ImportRunExecutionLease, now = Date.now(), leaseMs = DEFAULT_EXECUTION_LEASE_MS): ImportRunExecutionLease {
    assertExecution(runId, execution, now)
    const expiresAt = now + leaseMs
    db().prepare(`UPDATE import_runs SET lease_expires_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(expiresAt, runId)
    return { ...execution, expiresAt }
  }

  static restart(runId: string, nextRunId: string, now = Date.now()): ImportRunSnapshot {
    const normalizedNextId = nextRunId.trim()
    if (!normalizedNextId || normalizedNextId.length > 160) throw new Error('新导入运行 ID 无效')
    return db().transaction(() => {
      const source = readRunRow(runId)
      const restartable = source?.status === 'failed'
        || source?.status === 'cancelled'
        || (source?.status === 'running' && source.lease_expires_at <= now)
      if (!source || !restartable || source.resumable !== 1) {
        throw new Error('导入运行当前不可重新开始')
      }
      if (source.purpose === 'author-manuscript') {
        throw new Error('作者原稿导入不能重新开始；请继续原运行以完成发布和后处理')
      }
      if (readRunRow(normalizedNextId)) throw new Error('新导入运行 ID 已存在')
      const fenced = db().prepare(`
        UPDATE import_runs
        SET resumable = 0, cancel_requested = 0, last_error = 'Restarted by user',
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now')
        WHERE id = ? AND execution_epoch = ?
      `).run(runId, source.execution_epoch)
      if (fenced.changes !== 1) throw new Error('导入运行重新开始时已被其他执行器接管')
      const restartStage = source.stage
      const restartingParsing = restartStage === 'parsing'
      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
          authority_fingerprint, legacy_source_fingerprint, source_display_json, locale,
          stage, status, total_chapters, total_content_size, completed_chapters, base_run_id
          , manifest_chapter_count, manifest_content_size, manifest_word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        normalizedNextId,
        source.purpose,
        source.root_run_id,
        `import:${source.purpose}:${normalizedNextId}`,
        source.source_fingerprint,
        restartingParsing ? '0'.repeat(64) : source.manifest_fingerprint,
        source.authority_fingerprint,
        source.legacy_source_fingerprint,
        source.source_display_json,
        source.locale,
        restartStage,
        restartingParsing ? 0 : source.total_chapters,
        restartingParsing ? 0 : source.total_content_size,
        restartingParsing ? null : source.base_run_id,
        restartingParsing ? 0 : source.manifest_chapter_count,
        restartingParsing ? 0 : source.manifest_content_size,
        restartingParsing ? 0 : source.manifest_word_count,
      )
      if (restartingParsing) {
        db().prepare(`
          INSERT INTO import_run_sources (
            run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
            manifest_fingerprint, chapter_count, content_size, word_count, last_error
          )
          SELECT ?, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json,
                 'pending', '', 0, 0, 0,
                 ''
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).run(normalizedNextId, runId)
      } else {
        db().prepare(`
          INSERT INTO import_run_sources (
            run_id, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
            manifest_fingerprint, chapter_count, content_size, word_count, last_error
          )
          SELECT ?, source_index, source_id, source_fingerprint, legacy_source_fingerprint, display_json, status,
                 manifest_fingerprint, chapter_count, content_size, word_count, last_error
          FROM import_run_sources WHERE run_id = ? ORDER BY source_index
        `).run(normalizedNextId, runId)
        db().prepare(`
          INSERT INTO import_run_chapters (
            run_id, chapter_number, source_id, source_chapter_number,
            title, content_fingerprint, content_size, content_snapshot
          )
          SELECT ?, chapter_number, source_id, source_chapter_number,
                 title, content_fingerprint, content_size, content_snapshot
          FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number
        `).run(normalizedNextId, runId)
      }
      return this.get(normalizedNextId)!
    })()
  }

  static requestCancel(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    assertExecution(runId, execution)
    const result = db().prepare(`
      UPDATE import_runs SET cancel_requested = 1, updated_at = datetime('now')
      WHERE id = ? AND status IN ('ready', 'running')
    `).run(runId)
    if (result.changes === 0) throw new Error('导入运行当前不可取消')
    return this.get(runId)!
  }

  static cancelAtBoundary(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      assertExecution(runId, execution)
      const result = db().prepare(`
        UPDATE import_runs
        SET status = 'cancelled', resumable = 1, cancel_requested = 1,
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now')
        WHERE id = ? AND status IN ('ready', 'running', 'failed')
      `).run(runId)
      if (result.changes === 0) throw new Error('导入运行当前不可在安全边界取消')
      return this.get(runId)!
    })()
  }

  static completeBatch(runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease): {
    newlyCompleted: boolean
    cancelApplied: boolean
    run: ImportRunSnapshot
  } {
    if (!batchId.trim() || batchId.length > 160) throw new Error('导入批次 ID 无效')
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      const { newlyCompleted, cancelApplied } = applyBatchCheckpoint(row, stage, batchId, 'direct')
      return { newlyCompleted, cancelApplied, run: this.get(runId)! }
    })()
  }

  static advanceStage(runId: string, completedStage: ImportRunStage, nextStage: ImportRunStage, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== completedStage) {
        throw new Error('导入阶段与当前阶段不匹配')
      }
      if (nextStageForRun(row, completedStage) !== nextStage) throw new Error('导入下一阶段转换无效')
      assertStageCheckpointComplete(row, completedStage)
      const completedChapters = completedStage === 'blueprints' || completedStage === 'author-postprocess'
        ? row.total_chapters
        : row.completed_chapters
      const result = db().prepare(`
        UPDATE import_runs
        SET stage = ?, completed_chapters = ?, status = 'running', last_error = '',
            resumable = 1, updated_at = datetime('now')
        WHERE id = ? AND stage = ? AND status = 'running'
      `).run(nextStage, completedChapters, runId, completedStage)
      if (result.changes !== 1) throw new Error('导入阶段转换已过期')
      return this.get(runId)!
    })()
  }

  static fail(runId: string, stage: ImportRunStage, error: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== stage) throw new Error('导入失败阶段与当前阶段不匹配')
      if (typeof error !== 'string') throw new Error('导入失败原因无效')
      const result = db().prepare(`
        UPDATE import_runs
        SET status = 'failed', last_error = ?, resumable = 1,
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now') WHERE id = ? AND stage = ? AND status = 'running'
      `).run(error.slice(0, 2_000), runId, stage)
      if (result.changes === 0) throw new Error('导入运行当前不可标记失败')
      return this.get(runId)!
    })()
  }

  static complete(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      if (row.status !== 'running' || row.stage !== 'refresh') {
        throw new Error('导入运行只能从 refresh 刷新阶段完成')
      }
      assertStageCheckpointComplete(row, 'refresh')
      const result = db().prepare(`
        UPDATE import_runs
        SET stage = 'completed', status = 'completed', completed_chapters = total_chapters,
            resumable = 0, cancel_requested = 0, last_error = '',
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND stage = 'refresh' AND status = 'running'
      `).run(runId)
      if (result.changes === 0) throw new Error('导入运行当前不可完成')
      return this.get(runId)!
    })()
  }
}
