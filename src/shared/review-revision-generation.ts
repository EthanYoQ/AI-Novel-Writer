import type { MainGenerationRunHandle, MainGenerationSnapshot } from '../services/generation/generation-runtime'
import type { GenerationAuthorInput, VisibleCompositionReceipt } from './generation-owner-contract'
import type { ExpectedDraftSource, NovelConfig } from './ipc-channels'
import type { DraftStatus } from './draft-status'
import type { Locale } from '../i18n/types'
import type { WritingLanguage } from './writing-language'
import type { FrozenChapterGoals } from './chapter-goal-review'
import type { BlueprintForPreflight, ConsistencyFinding } from './consistency-preflight'
import type { FinalizedContinuityProjection, FinalizedSourceIdentity } from './finalized-continuity'
import type { HumanConfirmedReviewSnapshot } from './human-confirmed-review'

export type ReviewRevisionOperation = 'review-chapter' | 'refine-draft' | 'refine-from-review'
/** Asserts the author's selected version; prose and all stored facts are loaded by main. */
export interface PrepareReviewRevisionRequest {
  operation: ReviewRevisionOperation
  draftId: number
  expectedDraft: { chapterNumber: number; version: number; status: DraftStatus; contentHash: string }
  reviewSourceId?: number
  confirmedReviewContent?: string
  authorInputs: GenerationAuthorInput[]
  uiLocale: Locale
}
/**
 * 一条材料的来源身份：主进程捕获的、S10A 选择契约所需的最小集合。
 *
 * 它是**只增不减**字段。渲染层只能消费主进程给出的身份，绝不自行编造来源；
 * 缺少身份的材料不能进入上下文（必需项缺失时整体显式失败）。
 * `provenance` 用选择契约的词汇，未知来源不得被洗成 author。
 */
export interface ReviewMaterialIdentity {
  projectId: string
  epoch: string
  sourceId: string
  revision: number
  /** SHA-256 of the unmodified UTF-8 bytes of the material source. */
  contentHash: string
  provenance: 'finalized' | 'legacy' | 'author' | 'derived' | 'unknown'
}
export interface ReviewFinalizedMaterial {
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  source?: FinalizedSourceIdentity
  /** Only current projections may supply derived facts; other rows supply original prose. */
  projection?: FinalizedContinuityProjection
  /** 主进程捕获的来源身份；渲染层据此做准入，不据此编造事实。 */
  identity?: ReviewMaterialIdentity
}
/** Main-issued frozen prompt and normalization inputs; not a second writable fact store. */
export interface ReviewRevisionContext {
  version: 1
  operation: ReviewRevisionOperation
  source: ExpectedDraftSource
  sourceHash: string
  config: NovelConfig
  writingLanguage: WritingLanguage
  uiLocale: Locale
  authorInputs: GenerationAuthorInput[]
  characterStates: string
  worldbuilding: string
  history: ReviewFinalizedMaterial[]
  blueprints: BlueprintForPreflight[]
  frozenGoals: FrozenChapterGoals
  preflightFindings: ConsistencyFinding[]
  confirmation?: { reviewSourceId: number; content: string; originalReviewContentHash: string; snapshot: HumanConfirmedReviewSnapshot }
}
export interface PreparedReviewRevisionContext {
  contextId: string
  context: ReviewRevisionContext
  /** Derived by main from the saved original AI review, never supplied as authority by renderer. */
  parentRootActionId?: string
  modelId?: string
}
export interface ReviewGenerationCommitRequest {
  contextId: string
  handle: MainGenerationRunHandle
  artifact: { artifactId: string; revision: number; textHash: string }
}
export interface RevisionGenerationCommitRequest {
  contextId: string
  handle: MainGenerationRunHandle
  expectedCompositionHash: string
}
export interface ReviewRevisionCommitReceipt {
  success: true
  kind: 'review' | 'revision'
  id: number
  index: number
  content: string
  contentHash: string
  source: ExpectedDraftSource
  revisionStatus?: 'pending' | 'merged' | 'discarded'
}
export interface ReviewRevisionRecovery {
  handle: MainGenerationRunHandle
  context: ReviewRevisionContext
  modelId: string
  sourceStatus: 'current' | 'conflict'
  contextId?: string
  saved?: ReviewRevisionCommitReceipt
  composition?: VisibleCompositionReceipt
  lastCompositionFinishReason?: string | null
  latestArtifact?: MainGenerationSnapshot
  latestArtifactFinishReason?: string | null
  attemptedPurposes: string[]
}
export interface ReviewRevisionGenerationInvokeChannels {
  'review-revision:prepare': { args: [request: PrepareReviewRevisionRequest]; return: PreparedReviewRevisionContext }
  'review-revision:commit-review': { args: [request: ReviewGenerationCommitRequest]; return: ReviewRevisionCommitReceipt }
  'review-revision:commit-revision': { args: [request: RevisionGenerationCommitRequest]; return: ReviewRevisionCommitReceipt }
  'review-revision:read-recovery': { args: [request: { handle: MainGenerationRunHandle }]; return: ReviewRevisionRecovery }
}
