import type { GenerationTask } from '../services/generation/generation-harness'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../services/generation/generation-runtime'
import type { WritingSkillStage } from './writing-skills'
import type { GenerationKnowledgeSnapshot } from './generation-knowledge'

/** Raw text explicitly supplied for this author action, never inferred candidate text. */
export interface GenerationAuthorInput { id: string; text: string }
export interface DirectoryGenerationProgress {
  operationId: string
  payloadHash: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: { startChapter: number; endChapter: number }
  committedRange: { startChapter: number; endChapter: number }
  remainingRange: { startChapter: number; endChapter: number } | null
  continuationHandle?: MainGenerationRunHandle
  /** Read projection from the original run's immutable source manifest. */
  authorInputs?: readonly GenerationAuthorInput[]
}
export interface VisibleCompositionReceipt {
  algorithm: VisibleCompositionAlgorithm
  text: string
  textHash: string
  artifactIds: string[]
  sources: { artifactId: string; revision: number; textHash: string }[]
  authorInputs?: GenerationAuthorInput[]
}
export type VisibleCompositionAlgorithm = 'visible-append-v1' | 'draft-visible-v1'
export interface GenerationDraftCommitReceipt {
  success: true
  id: number
  version: number
  contentHash: string
  content: string
}
export interface GenerationDraftCommitRequest {
  handle: MainGenerationRunHandle
  expectedCompositionHash: string
  chapterNumber: number
  source: 'write'
  batchId?: string
}
export interface GenerationRecoveryContext {
  modelId: string
  handle: MainGenerationRunHandle
  operation: string
  chapterNumber?: number
  authorInputs: GenerationAuthorInput[]
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  selectedBlueprintChapterNumbers: number[]
  composition: VisibleCompositionReceipt | null
  lastCompositionFinishReason: string | null
  attemptedPurposes: string[]
  savedDraft?: GenerationDraftCommitReceipt
  batchId?: string
  knowledgeSnapshot?: GenerationKnowledgeSnapshot
  /** Present only when the originally selected drafts still match their frozen source references. */
  selectedDrafts?: PreparedDraftContext['selectedDrafts']
}
export interface PrepareDraftContextRequest {
  chapterNumber: number
  modelId: string
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  authorInputs: GenerationAuthorInput[]
  query: string
  selectedDraftIds: number[]
  batchId?: string
}
export interface PreparedDraftContext {
  preparationId: string
  knowledgeSnapshot: GenerationKnowledgeSnapshot
  selectedDrafts: { draftId: number; chapterNumber: number; version: number; contentHash: string; content: string }[]
}
export interface GenerationBatchIntent {
  mode: 'draft_review' | 'auto_finalize'
  range: { startChapter: number; endChapter: number }
  targetUnits: number
}
export interface BeginGenerationBatchRequest extends GenerationBatchIntent {
  uiActionNonce: string
  modelId: string
  authorInputs: GenerationAuthorInput[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
}
export interface GenerationBatchProgress extends GenerationBatchIntent {
  modelId: string
  batchId: string
  rootHandle: MainGenerationRunHandle
  completedChapters: { chapterNumber: number; draftId: number; version: number; contentHash: string;
    sourceRunHandle: MainGenerationRunHandle; finalizationId?: string; pendingFinalizationId?: string; postProcessComplete?: boolean }[]
  currentChapterRunHandle?: MainGenerationRunHandle
  /** Null only when all requested effects are confirmed; auto_finalize waits for its outbox. */
  nextChapterNumber: number | null
  authorInputs: GenerationAuthorInput[]
}

/** Selection and semantic intent only. Main owns identity, source hashes and budgets. */
export interface BeginGenerationRequest {
  operation: string
  uiActionNonce: string
  modelId: string
  chapterNumber?: number
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  selectedBlueprintChapterNumbers?: number[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  authorInputs?: GenerationAuthorInput[]
  output: 'visible-text' | 'structured-data'
  /** Finite semantic exceptions frozen before dispatch; no renderer-time contract changes. */
  outputOverrides?: { purpose: string; output: 'visible-text' | 'structured-data' }[]
  parentRootActionId?: string
  /** Explicit next-stage navigation from an atomically committed directory range. */
  continueDirectoryOperationId?: string
  /** Explicit batch lineage; only main creates the immutable batch intent. */
  batchId?: string
  batchIntent?: GenerationBatchIntent
  /** Main-issued before asynchronous drafting context reads. */
  preparationId?: string
  /** Main-issued context for identity-bound extraction from immutable finalized prose. */
  finalizedCharacterContextId?: string
}
export interface ExecuteGenerationRequest {
  handle: MainGenerationRunHandle
  invocationNonce: string
  task: GenerationTask
}
export interface GenerationOwnerChannels {
  'generation:prepare-draft-context': { args: [PrepareDraftContextRequest]; return: PreparedDraftContext }
  'generation:commit-draft': { args: [GenerationDraftCommitRequest]; return: GenerationDraftCommitReceipt }
  'generation:read-context': { args: [{ handle: MainGenerationRunHandle }]; return: GenerationRecoveryContext }
  'generation:begin-batch': { args: [BeginGenerationBatchRequest]; return: GenerationBatchProgress }
  'generation:read-batch': { args: [{ batchId: string }]; return: GenerationBatchProgress }
  'generation:list-batches': { args: []; return: GenerationBatchProgress[] }
  'generation:confirm-batch-finalization': { args: [{ batchId: string; chapterNumber: number; finalizationId: string }]; return: GenerationBatchProgress }
  'generation:list-directory-progress': { args: []; return: DirectoryGenerationProgress[] }
  'generation:compose-visible': { args: [MainGenerationRunHandle, string[], string, VisibleCompositionAlgorithm?]; return: VisibleCompositionReceipt }
  'generation:read-visible-composition': { args: [MainGenerationRunHandle]; return: VisibleCompositionReceipt | null }
  'generation:begin': { args: [BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:execute': { args: [ExecuteGenerationRequest]; return: MainGenerationExecuteReceipt }
  'generation:read': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:list': { args: []; return: MainGenerationRunView[] }
  'generation:cancel': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:pause': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:resume': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:restart': { args: [MainGenerationRunHandle, BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:discard-candidate': { args: [MainGenerationRunHandle, string]; return: MainGenerationRunView }
}
export interface GenerationOwnerEvents { 'generation:snapshot': MainGenerationSnapshot }

export function generationOutputContract(selection: BeginGenerationRequest): string | Readonly<Record<string, unknown>> {
  const overrides = selection.outputOverrides
  if (!['visible-text', 'structured-data'].includes(selection.output)
    || overrides !== undefined && (!Array.isArray(overrides) || overrides.length === 0 || overrides.length > 8
      || overrides.some(item => !item || Object.keys(item).some(key => !['purpose', 'output'].includes(key))
        || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(item.purpose)
        || !['visible-text', 'structured-data'].includes(item.output))
      || new Set(overrides.map(item => item.purpose)).size !== overrides.length))
    throw new Error('GENERATION_OUTPUT_CONTRACT_INVALID')
  return overrides ? { primary: selection.output, overrides: structuredClone(overrides) } : selection.output
}
