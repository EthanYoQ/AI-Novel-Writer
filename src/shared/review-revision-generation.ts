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
import type { ReviewCycleRecheckContext } from './review-cycle'
import { renderHumanConfirmedReviewBrief } from './human-confirmed-review'
import { writingLanguageText } from './writing-language'

export type ReviewRevisionOperation = 'review-chapter' | 'refine-draft' | 'refine-from-review'
/** Asserts the author's selected version; prose and all stored facts are loaded by main. */
export interface PrepareReviewRevisionRequest {
  operation: ReviewRevisionOperation
  draftId: number
  expectedDraft: { chapterNumber: number; version: number; status: DraftStatus; contentHash: string }
  reviewSourceId?: number
  confirmedReviewContent?: string
  reviewCycleId?: string
  expectedMergedHash?: string
  authorInputs: GenerationAuthorInput[]
  uiLocale: Locale
}
/**
 * 一条材料的来源身份：主进程捕获的、S10A 选择契约所需的最小集合。
 *
 * 它是**只增不减**字段。渲染层只能消费主进程给出的身份，绝不自行编造来源；
 * 缺少身份的材料不能进入上下文（必需项缺失时整体显式失败）。
 * `provenance` 用选择契约的词汇，未知来源不得被洗成 author。
 *
 * **它必须与会话无关**：这里绝不保存 `epoch`（会话租约）。同一项目重开后租约必然改变，
 * 把租约冻进来源清单会让比较与准入在重开后假失败（见
 * `generation-source-binding.ts` 跨会话比较时对 `SourceRef.epoch` 的剥离，
 * 两者是同一条规则）。活跃租约由使用方在构造 `SourceRef` 时按当前会话补上。
 */
export interface ReviewMaterialIdentity {
  projectId: string
  sourceId: string
  revision: number
  /** SHA-256 of the unmodified UTF-8 bytes of the material source. */
  contentHash: string
  provenance: 'finalized' | 'legacy' | 'author' | 'derived' | 'generated' | 'unknown'
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
  /** Exact saved predecessor bound by the source draft, never an inferred latest version. */
  predecessor?: ReviewFinalizedMaterial
  blueprints: BlueprintForPreflight[]
  frozenGoals: FrozenChapterGoals
  preflightFindings: ConsistencyFinding[]
  confirmation?: { reviewSourceId: number; content: string; originalReviewContentHash: string; snapshot: HumanConfirmedReviewSnapshot }
  recheck?: ReviewCycleRecheckContext
}

/** Task approval does not turn an AI-proposed replacement into an author fact. */
export function reviewRevisionAiBrief(context: ReviewRevisionContext): string {
  const snapshot = context.confirmation?.snapshot
  return snapshot ? renderHumanConfirmedReviewBrief({ ...snapshot, authorGuidance: '',
    items: snapshot.items.filter(item => item.origin === 'ai') }, context.writingLanguage) : ''
}

/** One immutable author-material block shared by renderer admission and main hash validation. */
export function reviewRevisionAuthorMaterial(context: ReviewRevisionContext): string {
  const text = (zh: string, en: string) => writingLanguageText(context.writingLanguage, zh, en)
  const snapshot = context.confirmation?.snapshot
  // Keep each source label, but emit an identical text/prefix only at its longest source.
  // The frozen originals stay intact for recovery and source validation.
  const sources: [string, string | undefined][] = [
    ['config.worldSetting', context.config.worldSetting],
    ['config.coreOutline', context.config.coreOutline],
    ['worldbuilding', context.worldbuilding],
  ]
  sources.sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))
  const authorText = (source: string, value: string | undefined) => {
    const original = value && sources.find(([, candidate]) => candidate?.startsWith(value))
    return original && original[0] !== source
      ? text(`（本来源原文与 ${original[0]} 的完整前缀相同，见该来源原文。）`,
        `(This source exactly matches a complete prefix of ${original[0]}; see that original text.)`)
      : value
  }
  return [
    text('【作者确认项目配置｜约束而非已发生事实】', '[Author-confirmed project configuration | constraints, not established history]'),
    JSON.stringify({ ...context.config, ...(context.operation === 'refine-draft' ? { writingStyle: undefined } : {}), globalGuidance: undefined,
      coreOutline: authorText('config.coreOutline', context.config.coreOutline),
      worldSetting: authorText('config.worldSetting', context.config.worldSetting) }, null, 2),
    text('【作者全局创作指导｜约束而非已发生事实】', '[Author global creative guidance | constraints, not established history]'),
    context.config.globalGuidance,
    text('【世界观设定】', '[Worldbuilding]'), authorText('worldbuilding', context.worldbuilding),
    text('【作者角色状态｜以标注时点为准】', '[Author character state | scoped to its annotated time]'), context.characterStates,
    text('【本章作者指导｜约束】', '[Current chapter author guidance | constraints]'),
    JSON.stringify(context.blueprints.filter(blueprint => blueprint.chapterNumber === context.source.chapterNumber), null, 2),
    text('【后续蓝图/计划｜非既定历史】', '[Future blueprints/plans | not established history]'),
    JSON.stringify(context.blueprints.filter(blueprint => blueprint.chapterNumber !== context.source.chapterNumber), null, 2),
    text('【本章冻结目标｜须由正文证明】', '[Frozen chapter goals | require manuscript evidence]'),
    JSON.stringify(context.frozenGoals),
    ...context.authorInputs.map(input => input.text),
    ...(snapshot ? [renderHumanConfirmedReviewBrief({ ...snapshot,
      items: snapshot.items.filter(item => item.origin === 'author') }, context.writingLanguage)] : []),
  ].filter(Boolean).join('\n\n')
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
  reviewCycle?: { cycleId: string; revisionStatus: 'merge-committed'; recheckCount: 0 | 1;
    disposition: 'required' | 'not-required' | 'completed' }
}
export interface ReviewRevisionRecovery {
  handle: MainGenerationRunHandle
  context: ReviewRevisionContext
  modelId: string
  sourceStatus: 'current' | 'conflict'
  /** False when a terminal candidate failed deterministic save validation and is copy-only. */
  canResume: boolean
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
