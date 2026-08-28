export type ImportRunLocale = 'zh-CN' | 'en-US'
export type ImportPurpose = 'reference' | 'author-manuscript'

export type ImportRunStage =
  | 'parsing'
  | 'prepared'
  | 'knowledge'
  | 'global'
  | 'style'
  | 'blueprints'
  | 'refresh'
  | 'completed'

export type ImportRunStatus = 'ready' | 'running' | 'failed' | 'cancelled' | 'completed'
export type ImportRunDirectCheckpointStage = 'knowledge' | 'refresh'
export type ImportRunEffectKind =
  | 'project-global-facts'
  | 'project-writing-style'
  | 'chapter-blueprint-range'

export type ImportRunEffectReceiptState = 'prepared' | 'committed'
export const IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION = 1 as const
export const IMPORT_RUN_KNOWLEDGE_BATCH_SIZE = 10
export const IMPORT_RUN_BLUEPRINT_BATCH_SIZE = 5

export function isImportRunDirectCheckpointStage(stage: unknown): stage is ImportRunDirectCheckpointStage {
  return stage === 'knowledge' || stage === 'refresh'
}

export interface ImportRunExecutionAuthority {
  owner: string
  epoch: number
}

export interface ImportRunExecutionLease extends ImportRunExecutionAuthority {
  expiresAt: number
}

export interface ImportRunStartResult {
  run: ImportRunSnapshot
  execution: ImportRunExecutionLease
}

export interface ImportRunEffectReceipt {
  schemaVersion: typeof IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION
  runId: string
  effectNamespace: string
  effectKey: string
  stage: ImportRunStage
  batchId: string
  kind: ImportRunEffectKind
  payloadHash: string
  state: ImportRunEffectReceiptState
  payload: unknown
  effectReceipt?: unknown
  createdAt: string
  updatedAt: string
}

export interface ImportRunChapterBatchCheckpoint {
  startChapter: number
  endChapter: number
  contentFingerprintPrefixes: string[]
}

const IMPORT_RUN_CONTENT_FINGERPRINT = /^[a-f0-9]{64}$/u
const IMPORT_RUN_CHAPTER_BATCH_CHECKPOINT = /^([1-9]\d*)-([1-9]\d*)-([a-f0-9]{8}(?:\.[a-f0-9]{8})*)$/u

/** Canonical identity shared by blueprint batching, durable receipts, and repository checkpoints. */
export function createImportRunChapterBatchCheckpointId(
  chapters: readonly Pick<ImportRunChapterInput, 'number' | 'contentFingerprint'>[],
): string {
  if (chapters.length === 0) throw new Error('导入章节批次不能为空')
  for (const [index, chapter] of chapters.entries()) {
    if (!Number.isSafeInteger(chapter.number) || chapter.number < 1) throw new Error('导入章节批次章号无效')
    if (!IMPORT_RUN_CONTENT_FINGERPRINT.test(chapter.contentFingerprint)) throw new Error('导入章节批次内容指纹无效')
    if (index > 0 && chapter.number !== chapters[index - 1]!.number + 1) {
      throw new Error('导入章节批次必须连续')
    }
  }
  return `${chapters[0]!.number}-${chapters.at(-1)!.number}-${chapters
    .map(chapter => chapter.contentFingerprint.slice(0, 8))
    .join('.')}`
}

export function parseImportRunChapterBatchCheckpointId(
  checkpointId: string,
): ImportRunChapterBatchCheckpoint | null {
  const match = IMPORT_RUN_CHAPTER_BATCH_CHECKPOINT.exec(checkpointId)
  if (!match) return null
  const startChapter = Number(match[1])
  const endChapter = Number(match[2])
  const contentFingerprintPrefixes = match[3]!.split('.')
  if (
    !Number.isSafeInteger(startChapter)
    || !Number.isSafeInteger(endChapter)
    || endChapter < startChapter
    || contentFingerprintPrefixes.length !== endChapter - startChapter + 1
  ) return null
  return { startChapter, endChapter, contentFingerprintPrefixes }
}

export function expectedImportRunEffectKey(
  kind: ImportRunEffectKind,
  stage: ImportRunStage,
  batchId: string,
): string | null {
  if (kind === 'project-global-facts' && stage === 'global' && batchId === 'done') return 'global-facts'
  if (kind === 'project-writing-style' && stage === 'style' && batchId === 'done') return 'writing-style'
  if (
    kind === 'chapter-blueprint-range'
    && stage === 'blueprints'
    && parseImportRunChapterBatchCheckpointId(batchId)
  ) {
    return `blueprints:${batchId}`
  }
  return null
}

/** Common binding checks used before storage commit and renderer replay. */
export function assertImportRunEffectReceiptMetadata(
  receipt: ImportRunEffectReceipt,
  run: ImportRunSnapshot,
): void {
  const expectedNamespace = `import:${run.purpose}:${run.id}`
  const expectedKey = expectedImportRunEffectKey(receipt.kind, receipt.stage, receipt.batchId)
  if (
    receipt.schemaVersion !== IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION
    || receipt.runId !== run.id
    || run.effectNamespace !== expectedNamespace
    || receipt.effectNamespace !== expectedNamespace
    || !expectedKey
    || receipt.effectKey !== expectedKey
  ) throw new Error('导入 effect receipt 元数据损坏')
}

export interface ImportRunPrepareEffectReceiptRequest {
  runId: string
  stage: ImportRunStage
  batchId: string
  effectKey: string
  kind: ImportRunEffectKind
  payload: unknown
}

export interface ImportRunEffectCommitResult {
  receipt: ImportRunEffectReceipt
  run: ImportRunSnapshot
  cancelApplied: boolean
}

/** Display-only source facts. Paths, grants, credentials, and provider data are forbidden. */
export interface ImportSourceDisplayMetadata {
  displayName: string
  mediaType: string
  size: number
}

/** Main-process-only aliases captured while the external file grant is issued. */
export interface ImportSourceFileIdentity {
  canonicalLocation: string
  fileIdentity?: string
}

export interface ImportRunChapterInput {
  number: number
  /** Index into the main-process source list; never supplied by renderer input. */
  sourceIndex?: number
  /** Stable chapter affiliation within one source. */
  sourceChapterNumber?: number
  title: string
  contentFingerprint: string
  contentSize: number
  /** Project-owned frozen snapshot; external grants are deliberately not persisted. */
  content: string
}

/** Renderer-safe frozen chapter snapshot; source affiliations remain main-process-only. */
export interface ImportRunChapterSnapshot {
  number: number
  title: string
  contentFingerprint: string
  contentSize: number
  content: string
}

export interface ImportRunPrepareRequest {
  runId: string
  purpose: ImportPurpose
  sourceFingerprint: string
  /** Opaque per-source IDs aligned with sourceDisplay. Main-process only. */
  sourceIds?: string[]
  /** Legacy single-source collection fingerprints aligned with sourceIds. Main-process only. */
  sourceFingerprints?: string[]
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  chapters: ImportRunChapterInput[]
}

export interface ImportRunBeginParsingRequest {
  runId: string
  purpose: ImportPurpose
  sourceFingerprint: string
  sourceIds: string[]
  sourceFingerprints?: string[]
  legacySourceFingerprints?: string[]
  legacyCollectionFingerprint?: string
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
}

/** Renderer-safe inspection metadata. Chapter content and source identities stay in main memory. */
export interface ImportInspectionSummary {
  inspectionId: string
  sourceCount: number
  sourceDisplayNames: string[]
  chapterCount: number
  totalWords: number
  totalBytes: number
  preview: Array<{ number: number; title: string; wordCount: number }>
}

export interface ImportRunPrepareFromInspectionRequest {
  inspectionId: string
  runId: string
  purpose: 'reference'
  locale: ImportRunLocale
}

/** Current-project selection binds parsing to one frozen project lease before any source is read. */
export interface ImportNovelFileSelectionRequest {
  runId: string
  purpose: 'reference'
  locale: ImportRunLocale
  expectedProjectPath: string
}

export interface ImportRunSnapshot {
  id: string
  purpose: ImportPurpose
  rootRunId: string
  effectNamespace: string
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  stage: ImportRunStage
  status: ImportRunStatus
  completedBatches: Partial<Record<ImportRunStage, string[]>>
  lastError: string
  resumable: boolean
  cancelRequested: boolean
  totalChapters: number
  totalContentSize: number
  manifestChapterCount: number
  manifestContentSize: number
  manifestWordCount: number
  completedChapters: number
  completedSources?: number
  totalSources?: number
  progressCompleted?: number
  progressTotal?: number
  baseRunId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type ImportRunClassification = 'exact-duplicate' | 'new' | 'conflict' | 'resumable'

export interface ImportRunPreparationResult {
  classification: ImportRunClassification
  run?: ImportRunSnapshot
  newChapterNumbers: number[]
  conflictChapterNumbers: number[]
  duplicateChapterNumbers: number[]
}
