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
