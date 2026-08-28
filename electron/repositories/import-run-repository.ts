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
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunPreparationResult,
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
import { getProjectDb } from '../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from './blueprint-repository'
import { ImportGlobalFactsRepository } from './import-global-facts-repository'
import type { ImportGlobalFactsRequest } from '../../src/shared/import-global-facts'
import {
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_SOURCE_FILES,
  MAX_IMPORT_TOTAL_BYTES,
} from '../../src/shared/import-limits'
import { ProjectCoreRepository } from './project-core-repository'

interface ImportRunRow {
  id: string
  purpose: ImportPurpose
  root_run_id: string
  effect_namespace: string
  source_fingerprint: string
  manifest_fingerprint: string
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

const SHA256 = /^[a-f0-9]{64}$/u
const OPAQUE_SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_CHAPTER_BYTES = 16 * 1024 * 1024
const MAX_PAGE_SIZE = 100
const INSERT_BATCH_SIZE = 50
const MAX_DISPLAY_SOURCES = MAX_IMPORT_SOURCE_FILES
const DEFAULT_EXECUTION_LEASE_MS = 15 * 60_000
const MAX_EFFECT_RECEIPT_PAYLOAD_BYTES = 16 * 1024 * 1024
const KNOWLEDGE_BATCH_CHECKPOINT = /^([1-9]\d*)-([1-9]\d*)$/u
const IMPORT_RUN_STAGE_VALUES = new Set<ImportRunStage>([
  'knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed',
])
const NEXT_IMPORT_RUN_STAGE: Readonly<Partial<Record<ImportRunStage, ImportRunStage>>> = {
  knowledge: 'global',
  global: 'style',
  style: 'blueprints',
  blueprints: 'refresh',
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

function assertCommittedEffectSchema(kind: ImportRunEffectKind, payload: unknown, effectReceipt: unknown): void {
  if (!isRecord(payload) || !isRecord(effectReceipt)) throw new Error()
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
  }
  if (expected[kind] !== stage) throw new Error('导入 effect receipt 类型与阶段不匹配')
}

function rowToSnapshot(row: ImportRunRow): ImportRunSnapshot {
  return {
    id: row.id,
    purpose: row.purpose,
    rootRunId: row.root_run_id,
    effectNamespace: row.effect_namespace,
    sourceFingerprint: row.source_fingerprint,
    manifestFingerprint: row.manifest_fingerprint,
    sourceDisplay: parseJson<ImportSourceDisplayMetadata[]>(row.source_display_json, []),
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
    completedChapters: row.completed_chapters,
    baseRunId: row.base_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  }
}

function chapterRowToSnapshot(row: ImportRunChapterRow): ImportRunChapterSnapshot {
  return {
    number: row.chapter_number,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
    content: row.content_snapshot,
  }
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

function knowledgeCheckpointRange(batchId: string): { startChapter: number; endChapter: number } | null {
  const match = KNOWLEDGE_BATCH_CHECKPOINT.exec(batchId)
  if (!match) return null
  const startChapter = Number(match[1])
  const endChapter = Number(match[2])
  if (
    !Number.isSafeInteger(startChapter)
    || !Number.isSafeInteger(endChapter)
    || endChapter < startChapter
  ) return null
  return { startChapter, endChapter }
}

function checkpointRange(
  stage: 'knowledge' | 'blueprints',
  batchId: string,
): { startChapter: number; endChapter: number } {
  if (stage === 'knowledge') {
    const parsed = knowledgeCheckpointRange(batchId)
    if (!parsed) throw new Error('导入批次 ID 无效')
    return parsed
  }
  const parsed = parseImportRunChapterBatchCheckpointId(batchId)
  if (!parsed) throw new Error('导入批次 ID 无效')
  return parsed
}

function checkpointChapterNumbers(row: ImportRunRow, stage: 'knowledge' | 'blueprints', batchId: string): number[] {
  if (stage === 'knowledge') {
    const range = knowledgeCheckpointRange(batchId)
    if (!range) throw new Error('导入批次 ID 无效')
    const chapters = chapterRowsForRange(row.id, range.startChapter, range.endChapter)
    if (
      chapters.length === 0
      || chapters.length > IMPORT_RUN_KNOWLEDGE_BATCH_SIZE
      || chapters[0]!.chapter_number !== range.startChapter
      || chapters.at(-1)!.chapter_number !== range.endChapter
    ) throw new Error('导入批次 ID 无效')
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

function assertCheckpointCanApply(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
  source: ImportRunCheckpointSource,
): void {
  if (row.status !== 'running' || row.stage !== stage) throw new Error('导入批次与当前阶段不匹配')
  if (stage === 'completed') throw new Error('导入批次 ID 无效')
  const receiptStage = stage === 'global' || stage === 'style' || stage === 'blueprints'
  if ((receiptStage && source !== 'receipt') || (!receiptStage && source !== 'direct')) {
    throw new Error(receiptStage ? '该导入阶段必须通过 receipt 提交' : '该导入阶段不接受 receipt 提交')
  }
  if (stage === 'global' || stage === 'style' || stage === 'refresh') {
    if (batchId !== 'done') throw new Error('导入批次 ID 无效')
    return
  }

  checkpointChapterNumbers(row, stage, batchId)
  const range = checkpointRange(stage, batchId)
  const existing = completedBatches(row)[stage] ?? []
  for (const existingBatchId of existing) {
    if (existingBatchId === batchId) continue
    const existingRange = checkpointRange(stage, existingBatchId)
    if (range.startChapter <= existingRange.endChapter && existingRange.startChapter <= range.endChapter) {
      throw new Error('导入批次与已完成 checkpoint 重叠')
    }
  }
}

function assertStageCheckpointComplete(row: ImportRunRow, stage: ImportRunStage): void {
  const batches = completedBatches(row)[stage] ?? []
  if (stage === 'global' || stage === 'style' || stage === 'refresh') {
    if (batches.length !== 1 || batches[0] !== 'done') throw new Error('导入阶段 checkpoint 未完成')
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
      AND resumable = 1 AND status IN ('ready', 'running', 'failed', 'cancelled')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint, manifestFingerprint) as ImportRunRow | undefined
}

function latestCompletedRun(purpose: ImportPurpose, sourceFingerprint: string): ImportRunRow | undefined {
  return db().prepare(`
    SELECT * FROM import_runs
    WHERE purpose = ? AND source_fingerprint = ? AND status = 'completed'
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(purpose, sourceFingerprint) as ImportRunRow | undefined
}

export class ImportRunRepository {
  static assertExecutionAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    now = Date.now(),
  ): void {
    assertExecutionAuthority(runId, authority, now)
  }

  static assertReferenceImportAuthority(
    runId: string,
    authority: ImportRunExecutionAuthority,
    idempotencyKey: string,
    content: string,
    now = Date.now(),
  ): void {
    const run = assertExecutionAuthority(runId, authority, now)
    const prefix = `${run.purpose}:${run.source_fingerprint}:`
    const binding = idempotencyKey.startsWith(prefix)
      ? /^(\d+):([a-f0-9]{64})$/u.exec(idempotencyKey.slice(prefix.length))
      : null
    if (run.purpose !== 'reference' || run.stage !== 'knowledge' || !binding) {
      throw new Error('参照知识写入未绑定当前导入的冻结章节')
    }
    const chapterNumber = Number(binding[1])
    const chapter = db().prepare(`
      SELECT content_fingerprint, content_snapshot
      FROM import_run_chapters
      WHERE run_id = ? AND chapter_number = ?
    `).get(runId, chapterNumber) as {
      content_fingerprint: string
      content_snapshot: string
    } | undefined
    if (
      !chapter
      || chapter.content_fingerprint !== binding[2]
      || chapter.content_snapshot !== content
    ) throw new Error('参照知识写入未绑定当前导入的冻结章节')
  }

  static prepare(candidate: ImportRunPrepareRequest): ImportRunPreparationResult {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference') throw new Error('当前版本不支持作者手稿导入')
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const sourceIds = normalizeSourceIds(candidate.sourceIds, sourceDisplay, candidate.sourceFingerprint)
    const sourceFingerprints = normalizeSourceFingerprints(candidate.sourceFingerprints, sourceIds)
    const normalizedChapters = normalizeChapters(candidate.chapters, sourceIds)

    return db().transaction(() => {
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
      const resumable = matchingResumableRun(candidate.purpose, candidate.sourceFingerprint, manifestFingerprint)
      if (resumable) {
        return {
          classification: 'resumable' as const,
          run: rowToSnapshot(resumable),
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers: chapters.map(chapter => chapter.number),
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
      if (row.execution_owner && row.execution_owner !== normalizedOwner && row.lease_expires_at > now) {
        throw new Error('导入运行正在由另一执行器运行')
      }
      const sameActiveOwner = row.execution_owner === normalizedOwner && row.lease_expires_at > now
      const epoch = sameActiveOwner ? row.execution_epoch : row.execution_epoch + 1
      const expiresAt = now + leaseMs
      db().prepare(`
        UPDATE import_runs
        SET status = 'running', resumable = 1, cancel_requested = 0,
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
      if (readRunRow(normalizedNextId)) throw new Error('新导入运行 ID 已存在')
      const fenced = db().prepare(`
        UPDATE import_runs
        SET resumable = 0, cancel_requested = 0, last_error = 'Restarted by user',
            execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
            updated_at = datetime('now')
        WHERE id = ? AND execution_epoch = ?
      `).run(runId, source.execution_epoch)
      if (fenced.changes !== 1) throw new Error('导入运行重新开始时已被其他执行器接管')
      db().prepare(`
        INSERT INTO import_runs (
          id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint, source_display_json, locale,
          stage, status, total_chapters, total_content_size, completed_chapters, base_run_id
          , manifest_chapter_count, manifest_content_size, manifest_word_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'knowledge', 'ready', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        normalizedNextId,
        source.purpose,
        source.root_run_id,
        `import:${source.purpose}:${normalizedNextId}`,
        source.source_fingerprint,
        source.manifest_fingerprint,
        source.source_display_json,
        source.locale,
        source.total_chapters,
        source.total_content_size,
        source.base_run_id,
        source.manifest_chapter_count,
        source.manifest_content_size,
        source.manifest_word_count,
      )
      db().prepare(`
        INSERT INTO import_run_chapters (
          run_id, chapter_number, source_id, source_chapter_number,
          title, content_fingerprint, content_size, content_snapshot
        )
        SELECT ?, chapter_number, source_id, source_chapter_number,
               title, content_fingerprint, content_size, content_snapshot
        FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number
      `).run(normalizedNextId, runId)
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
      if (NEXT_IMPORT_RUN_STAGE[completedStage] !== nextStage) throw new Error('导入下一阶段转换无效')
      assertStageCheckpointComplete(row, completedStage)
      const completedChapters = completedStage === 'blueprints' ? row.total_chapters : row.completed_chapters
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
