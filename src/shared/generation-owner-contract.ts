import type { GenerationTask } from '../services/generation/generation-harness'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot, MainGenerationReasoningEvent } from '../services/generation/generation-runtime'
import type { WritingSkillStage } from './writing-skills'
import type { GenerationKnowledgeSnapshot } from './generation-knowledge'
import type { ImportGenerationSlot } from './import-generation'
import type { ImportRunExecutionAuthority } from './import-run'

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
/**
 * S10B 章节材料准入裁决的脱敏收据。
 *
 * 只允许编号、稳定 id、原因码与内容哈希：没有材料正文、没有作者文字、没有路径、
 * 没有凭据。渲染层是唯一能产生它的人（`buildMaterialDecisionReceipt`），主进程按固定
 * 形状逐字段校验后原样冻进 `RunBinding.sourceManifest`，并把它的哈希折进
 * `contextSnapshotHash`——恢复因此无法对着**另一份**准入裁决继续。
 *
 * `contentHash` 是渲染层选择合同冻结的来源内容哈希，与主进程 `sourceRefs` 自己读库得到的
 * 源身份所有权分开：主进程不重算正文，只校验闭集、计数与来源身份后绑定。
 */
export const MATERIAL_DECISION_RECEIPT_VERSION = 1
export const MATERIAL_DECISION_UNIT_METHOD_VERSION = 'utf8-bytes-v1' as const
export const MATERIAL_DECISION_MAX_INPUT_UNITS = 8 * 1024 * 1024
export const MATERIAL_DECISION_MAX_SOURCES = 1_024
export const MATERIAL_DECISION_CATEGORIES = [
  'author', 'finalized-history', 'future-plan', 'derived-locator', 'reference',
] as const
export type MaterialDecisionCategory = typeof MATERIAL_DECISION_CATEGORIES[number]
export const MATERIAL_DECISION_OMISSION_REASONS = [
  'unknown-provenance', 'locator-statement-not-evidence', 'candidate-not-admitted',
  'invalid-source-ref', 'plot-tree-not-manuscript', 'duplicate-content',
  'duplicate-source-ref', 'budget',
  'source-invalid', 'evidence-not-locatable', 'no-relevant-passage',
  'deduplicated-against-finalized',
] as const
export type MaterialDecisionOmissionReason = typeof MATERIAL_DECISION_OMISSION_REASONS[number]

/** v1 只接收当前写/审/修材料装配器能铸造的稳定、非正文来源 ID。 */
export const MATERIAL_DECISION_SOURCE_ID = /^(?:author:required|(?:finalized|candidate|review:confirmed):[1-9]\d*|reference:(?:0|[1-9]\d*))$/u

export interface MaterialDecisionIncludedSource {
  sourceId: string
  revision: number
  contentHash: string
  category: MaterialDecisionCategory
  required: boolean
  /** 该来源实际进入材料的 UTF-8 字节数（同一来源的多个片段在此合并）。 */
  units: number
}
export interface MaterialDecisionOmittedSource {
  sourceId: string
  revision: number
  contentHash: string
  /** `SourceOmissionReason` 的闭合码；调用方已在源头限定取值，这里只放码不放正文。 */
  reason: MaterialDecisionOmissionReason
  category: MaterialDecisionCategory
  required: boolean
}
export interface MaterialDecisionReceipt {
  version: typeof MATERIAL_DECISION_RECEIPT_VERSION
  /** 只有「必需材料全部纳入」的裁决才会走到生成，因此收据只存在这一种容量裁决。 */
  verdict: 'admitted'
  /** 精确初始 user message 的 UTF-8 SHA-256；main 在首个物理请求前复核。 */
  promptHash: string
  /** admittedUnits 只统计被选来源块，不冒充完整 user prompt 的总字节数。 */
  capacity: { maxInputUnits: number; methodVersion: typeof MATERIAL_DECISION_UNIT_METHOD_VERSION; admittedUnits: number }
  coverage: { required: number; included: number; complete: boolean }
  included: MaterialDecisionIncludedSource[]
  omitted: MaterialDecisionOmittedSource[]
}
/** 渲染层完成材料选择后、最终 prompt 尚未组装时的内部裁决。 */
export type MaterialDecisionDraft = Omit<MaterialDecisionReceipt, 'promptHash'>
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
  selectedDrafts: { draftId: number; chapterNumber: number; version: number; contentHash: string; content: string; required?: boolean }[]
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
  importSlot?: ImportGenerationSlot
  /** Admission authority only; never persisted in the source manifest. */
  importExecution?: ImportRunExecutionAuthority
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
  reviewRevisionContextId?: string
  /** Main-issued registration from an actual, confirmed Agent tool action. */
  agentWorkflowRegistrationId?: string
  /**
   * S10B 章节材料准入裁决（脱敏收据）。写稿在 begin 时提供；审稿/修稿在运行已开出、
   * 首个物理请求尚未产生时通过受控绑定 IPC 补入。主进程校验后冻进 sourceManifest。
   */
  materialDecision?: MaterialDecisionReceipt
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
  'generation:bind-material-decision': { args: [{ handle: MainGenerationRunHandle; materialDecision: MaterialDecisionReceipt }]; return: MainGenerationRunView }
  'generation:execute': { args: [ExecuteGenerationRequest]; return: MainGenerationExecuteReceipt }
  'generation:read': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:list': { args: []; return: MainGenerationRunView[] }
  'generation:cancel': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:pause': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:resume': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:restart': { args: [MainGenerationRunHandle, BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:discard-candidate': { args: [MainGenerationRunHandle, string]; return: MainGenerationRunView }
}
export interface GenerationOwnerEvents {
  'generation:snapshot': MainGenerationSnapshot
  /** Volatile provider text for the active Writer display; never part of a run view or receipt. */
  'generation:reasoning': MainGenerationReasoningEvent
}

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
