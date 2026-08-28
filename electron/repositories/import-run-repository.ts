import { createHash } from 'node:crypto'

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
  ImportRunExecutionLease,
  ImportRunStartResult,
  ImportSourceDisplayMetadata,
  ImportPurpose,
} from '../../src/shared/import-run'
import { getProjectDb } from '../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from './blueprint-repository'
import { ImportGlobalFactsRepository } from './import-global-facts-repository'
import type { ImportGlobalFactsRequest } from '../../src/shared/import-global-facts'
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
  title: string
  content_fingerprint: string
  content_size: number
  content_snapshot: string
}

interface ImportRunEffectReceiptRow {
  run_id: string
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
export const MAX_IMPORT_RUN_CHAPTERS = 5_000
export const MAX_IMPORT_RUN_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_CHAPTER_BYTES = 16 * 1024 * 1024
const MAX_PAGE_SIZE = 100
const INSERT_BATCH_SIZE = 50
const MAX_DISPLAY_SOURCES = MAX_IMPORT_RUN_CHAPTERS
const DEFAULT_EXECUTION_LEASE_MS = 15 * 60_000
const MAX_EFFECT_RECEIPT_PAYLOAD_BYTES = 16 * 1024 * 1024

function db() {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current
}

function canonicalManifest(purpose: ImportPurpose, chapters: ImportRunChapterInput[]): string {
  return JSON.stringify({ purpose, chapters: chapters.map(chapter => ({
    number: chapter.number,
    title: chapter.title,
    contentFingerprint: chapter.contentFingerprint,
    contentSize: chapter.contentSize,
  })) })
}

function hashManifest(purpose: ImportPurpose, chapters: ImportRunChapterInput[]): string {
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

function rowToEffectReceipt(row: ImportRunEffectReceiptRow): ImportRunEffectReceipt {
  return {
    runId: row.run_id,
    effectNamespace: row.effect_namespace,
    effectKey: row.effect_key,
    stage: row.stage,
    batchId: row.batch_id,
    kind: row.kind,
    payloadHash: row.payload_hash,
    state: row.state,
    payload: parseJson(row.payload_json, null),
    effectReceipt: row.effect_receipt_json ? parseJson(row.effect_receipt_json, null) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function normalizeChapters(items: ImportRunChapterInput[]): ImportRunChapterInput[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_IMPORT_RUN_CHAPTERS) {
    throw new Error('导入章节清单无效')
  }
  const numbers = new Set<number>()
  let aggregateBytes = 0
  const normalized = items.map(item => {
    if (!Number.isSafeInteger(item.number) || item.number < 1 || numbers.has(item.number)) {
      throw new Error('导入章节号无效或重复')
    }
    numbers.add(item.number)
    const bytes = Buffer.byteLength(item.content, 'utf8')
    if (
      typeof item.title !== 'string'
      || item.title.length > 500
      || !SHA256.test(item.contentFingerprint)
      || !Number.isSafeInteger(item.contentSize)
      || item.contentSize !== bytes
      || bytes > MAX_CHAPTER_BYTES
    ) throw new Error(`导入章节 ${item.number} 快照无效`)
    aggregateBytes += bytes
    if (aggregateBytes > MAX_IMPORT_RUN_TOTAL_BYTES) throw new Error('导入正文总字节数超过安全上限')
    return { ...item, title: item.title.trim() }
  })
  return normalized.sort((left, right) => left.number - right.number)
}

function readRunRow(runId: string): ImportRunRow | undefined {
  return db().prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as ImportRunRow | undefined
}

function assertExecution(runId: string, execution: ImportRunExecutionLease, now = Date.now()): ImportRunRow {
  const row = readRunRow(runId)
  if (
    !row
    || row.execution_owner !== execution.owner
    || row.execution_epoch !== execution.epoch
    || row.lease_expires_at !== execution.expiresAt
    || row.lease_expires_at <= now
  ) throw new Error('导入执行租约已失效，已拒绝旧执行器写入')
  return row
}

function applyBatchCheckpoint(
  row: ImportRunRow,
  stage: ImportRunStage,
  batchId: string,
): { newlyCompleted: boolean; cancelApplied: boolean } {
  const completed = parseJson<Partial<Record<ImportRunStage, string[]>>>(row.completed_batches_json, {})
  const stageBatches = completed[stage] ?? []
  const newlyCompleted = !stageBatches.includes(batchId)
  if (newlyCompleted) completed[stage] = [...stageBatches, batchId]
  const cancelApplied = row.cancel_requested === 1
  db().prepare(`
    UPDATE import_runs
    SET completed_batches_json = ?,
        status = CASE WHEN ? = 1 THEN 'cancelled' ELSE status END,
        resumable = 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(completed), cancelApplied ? 1 : 0, row.id)
  return { newlyCompleted, cancelApplied }
}

function completedChapterManifest(
  purpose: ImportPurpose,
  sourceFingerprint: string,
): Map<number, { title: string; contentFingerprint: string; contentSize: number }> {
  const rows = db().prepare(`
    SELECT chapters.chapter_number, chapters.title, chapters.content_fingerprint, chapters.content_size
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id = chapters.run_id
    WHERE runs.purpose = ? AND runs.source_fingerprint = ? AND runs.status = 'completed'
    ORDER BY runs.completed_at ASC, runs.rowid ASC, chapters.chapter_number ASC
  `).all(purpose, sourceFingerprint) as Array<{
    chapter_number: number
    title: string
    content_fingerprint: string
    content_size: number
  }>
  return new Map(rows.map(row => [row.chapter_number, {
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    contentSize: row.content_size,
  }]))
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
  static prepare(candidate: ImportRunPrepareRequest): ImportRunPreparationResult {
    const runId = candidate.runId?.trim()
    if (!runId || runId.length > 160 || !SHA256.test(candidate.sourceFingerprint)) {
      throw new Error('导入运行身份无效')
    }
    if (candidate.purpose !== 'reference') throw new Error('当前版本不支持作者手稿导入')
    if (candidate.locale !== 'zh-CN' && candidate.locale !== 'en-US') throw new Error('导入运行语言无效')
    const sourceDisplay = normalizeDisplay(candidate.sourceDisplay)
    const chapters = normalizeChapters(candidate.chapters)
    const manifestFingerprint = hashManifest(candidate.purpose, chapters)
    const manifestContentSize = chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0)
    const manifestWordCount = chapters.reduce((sum, chapter) => sum + chapter.content.length, 0)

    return db().transaction(() => {
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
      const completedManifest = completed
        ? completedChapterManifest(candidate.purpose, candidate.sourceFingerprint)
        : new Map<number, { title: string; contentFingerprint: string; contentSize: number }>()
      const conflictChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(chapter.number)
          return previous !== undefined && (
            previous.title !== chapter.title
            || previous.contentFingerprint !== chapter.contentFingerprint
            || previous.contentSize !== chapter.contentSize
          )
        })
        .map(chapter => chapter.number)
      const duplicateChapterNumbers = chapters
        .filter(chapter => {
          const previous = completedManifest.get(chapter.number)
          return previous !== undefined
            && previous.title === chapter.title
            && previous.contentFingerprint === chapter.contentFingerprint
            && previous.contentSize === chapter.contentSize
        })
        .map(chapter => chapter.number)
      const newChapters = chapters.filter(chapter => !completedManifest.has(chapter.number))

      if (conflictChapterNumbers.length > 0) {
        return {
          classification: 'conflict' as const,
          run: undefined,
          newChapterNumbers: newChapters.map(chapter => chapter.number),
          conflictChapterNumbers,
          duplicateChapterNumbers,
        }
      }
      if (completed && newChapters.length === 0 && completed.manifest_fingerprint === manifestFingerprint) {
        return {
          classification: 'exact-duplicate' as const,
          run: undefined,
          newChapterNumbers: [],
          conflictChapterNumbers: [],
          duplicateChapterNumbers,
        }
      }

      const chaptersToPersist = completed ? newChapters : chapters
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
          run_id, chapter_number, title, content_fingerprint, content_size, content_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (let offset = 0; offset < chaptersToPersist.length; offset += INSERT_BATCH_SIZE) {
        for (const chapter of chaptersToPersist.slice(offset, offset + INSERT_BATCH_SIZE)) {
          insertChapter.run(
            runId,
            chapter.number,
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
      SELECT chapter_number, title, content_fingerprint, content_size, content_snapshot
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
    return row ? rowToEffectReceipt(row) : null
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
      if (run.stage !== request.stage) throw new Error('导入 effect receipt 阶段 checkpoint 已过期')
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
        return rowToEffectReceipt(existing)
      }
      db().prepare(`
        INSERT INTO import_run_receipts (
          run_id, effect_namespace, effect_key, stage, batch_id, kind, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.runId,
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
      if (row.effect_namespace !== run.effect_namespace) throw new Error('导入 effect receipt namespace 不匹配')
      if (row.state === 'committed') {
        return {
          receipt: rowToEffectReceipt(row),
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
      const checkpoint = applyBatchCheckpoint(run, stage, batchId)
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
      if (!row || !['ready', 'running', 'failed', 'cancelled'].includes(row.status)) {
        throw new Error('导入运行当前不可启动')
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

  static restart(runId: string, nextRunId: string): ImportRunSnapshot {
    const normalizedNextId = nextRunId.trim()
    if (!normalizedNextId || normalizedNextId.length > 160) throw new Error('新导入运行 ID 无效')
    return db().transaction(() => {
      const source = readRunRow(runId)
      if (!source || source.status === 'completed' || source.resumable !== 1) {
        throw new Error('导入运行当前不可重新开始')
      }
      if (readRunRow(normalizedNextId)) throw new Error('新导入运行 ID 已存在')
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
          run_id, chapter_number, title, content_fingerprint, content_size, content_snapshot
        )
        SELECT ?, chapter_number, title, content_fingerprint, content_size, content_snapshot
        FROM import_run_chapters WHERE run_id = ? ORDER BY chapter_number
      `).run(normalizedNextId, runId)
      db().prepare(`
        UPDATE import_runs
        SET resumable = 0, cancel_requested = 0, last_error = 'Restarted by user',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(runId)
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
    assertExecution(runId, execution)
    const result = db().prepare(`
      UPDATE import_runs
      SET status = 'cancelled', resumable = 1, cancel_requested = 1,
          updated_at = datetime('now')
      WHERE id = ? AND status IN ('ready', 'running', 'failed')
    `).run(runId)
    if (result.changes === 0) throw new Error('导入运行当前不可在安全边界取消')
    return this.get(runId)!
  }

  static completeBatch(runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease): {
    newlyCompleted: boolean
    cancelApplied: boolean
    run: ImportRunSnapshot
  } {
    if (!batchId.trim() || batchId.length > 160) throw new Error('导入批次 ID 无效')
    return db().transaction(() => {
      const row = assertExecution(runId, execution)
      const { newlyCompleted, cancelApplied } = applyBatchCheckpoint(row, stage, batchId)
      return { newlyCompleted, cancelApplied, run: this.get(runId)! }
    })()
  }

  static advanceStage(runId: string, completedStage: ImportRunStage, nextStage: ImportRunStage, execution: ImportRunExecutionLease): ImportRunSnapshot {
    const row = assertExecution(runId, execution)
    if (!row || row.stage !== completedStage) throw new Error('导入阶段 checkpoint 已过期')
    const completedChapters = completedStage === 'blueprints' ? row.total_chapters : row.completed_chapters
    db().prepare(`
      UPDATE import_runs
      SET stage = ?, completed_chapters = ?, status = 'running', last_error = '',
          resumable = 1, updated_at = datetime('now')
      WHERE id = ? AND stage = ?
    `).run(nextStage, completedChapters, runId, completedStage)
    return this.get(runId)!
  }

  static fail(runId: string, stage: ImportRunStage, error: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    assertExecution(runId, execution)
    const result = db().prepare(`
      UPDATE import_runs
      SET stage = ?, status = 'failed', last_error = ?, resumable = 1,
          updated_at = datetime('now') WHERE id = ? AND status <> 'completed'
    `).run(stage, error.slice(0, 2_000), runId)
    if (result.changes === 0) throw new Error('导入运行当前不可标记失败')
    return this.get(runId)!
  }

  static complete(runId: string, execution: ImportRunExecutionLease): ImportRunSnapshot {
    assertExecution(runId, execution)
    const result = db().prepare(`
      UPDATE import_runs
      SET stage = 'completed', status = 'completed', completed_chapters = total_chapters,
          resumable = 0, cancel_requested = 0, last_error = '',
          completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status <> 'completed'
    `).run(runId)
    if (result.changes === 0) {
      const existing = this.get(runId)
      if (existing?.status === 'completed') return existing
      throw new Error('导入运行当前不可完成')
    }
    return this.get(runId)!
  }
}
