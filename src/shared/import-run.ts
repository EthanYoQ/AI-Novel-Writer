export type ImportRunLocale = 'zh-CN' | 'en-US'
export type ImportPurpose = 'reference' | 'author-manuscript'

export type ImportRunStage =
  | 'knowledge'
  | 'global'
  | 'style'
  | 'blueprints'
  | 'refresh'
  | 'completed'

export type ImportRunStatus = 'ready' | 'running' | 'failed' | 'cancelled' | 'completed'
export type ImportRunEffectKind =
  | 'project-global-facts'
  | 'project-writing-style'
  | 'chapter-blueprint-range'

export type ImportRunEffectReceiptState = 'prepared' | 'committed'
export const IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION = 1 as const

export interface ImportRunExecutionLease {
  owner: string
  epoch: number
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

export function expectedImportRunEffectKey(
  kind: ImportRunEffectKind,
  stage: ImportRunStage,
  batchId: string,
): string | null {
  if (kind === 'project-global-facts' && stage === 'global' && batchId === 'done') return 'global-facts'
  if (kind === 'project-writing-style' && stage === 'style' && batchId === 'done') return 'writing-style'
  if (kind === 'chapter-blueprint-range' && stage === 'blueprints' && /^\d+-\d+$/u.test(batchId)) {
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
  title: string
  contentFingerprint: string
  contentSize: number
  /** Project-owned frozen snapshot; external grants are deliberately not persisted. */
  content: string
}

export type ImportRunChapterSnapshot = ImportRunChapterInput

export interface ImportRunPrepareRequest {
  runId: string
  purpose: ImportPurpose
  sourceFingerprint: string
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  chapters: ImportRunChapterInput[]
}

/** Renderer-safe inspection metadata. Chapter content and source identities stay in main memory. */
export interface ImportInspectionSummary {
  inspectionId: string
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

export interface ImportRunSnapshot {
  id: string
  purpose: ImportPurpose
  rootRunId: string
  effectNamespace: string
  sourceFingerprint: string
  manifestFingerprint: string
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
