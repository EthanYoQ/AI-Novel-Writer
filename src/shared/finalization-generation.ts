import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { FinalizedCharacterContext, FinalizedSourceIdentity } from './finalized-continuity'
import type { FinalizedCharacterArtifact, FinalizedCharacterGenerationReceipt } from './finalized-character-generation'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

export interface FinalizationGenerationSlot {
  source: FinalizedSourceIdentity
  stepKey: 'chapter_notes' | 'character_cards'
}
export interface FinalizationGenerationContext {
  slot: FinalizationGenerationSlot
  identity: FinalizedCharacterContext
  chapterTitle: string
  chapterEntities: string[]
  writingLanguage: WritingLanguage
  template: PromptTemplate
  /** Actual prior derived notes, used only as a commit-time comparison baseline. */
  notesBaseline: { blueprint: { exists: boolean; notes: string }; continuityHash: string }
}
export type FinalizationGenerationEffect = {
  success: true
  stepKey: 'chapter_notes'
  chapterNotes: string
  factCount: number
  blueprintUpdated: boolean
} | (FinalizedCharacterGenerationReceipt & { success: true; stepKey: 'character_cards' })
export interface FinalizationGenerationRecovery {
  attemptCount: number
  /** 本运行（不是整个 root）最近一次尝试。章节要点与角色状态共用一个 root，作者重试据此判断本运行是否还有在途请求、上次结果能否提交。 */
  latestAttempt?: { attemptId: string; inFlight: boolean; finishReason: string | null; failureCode: string | null }
  view: MainGenerationRunView
  modelId: string
  context: FinalizationGenerationContext
  sourceStatus: 'current' | 'conflict'
  effect?: FinalizationGenerationEffect
}
export interface FinalizationGenerationChannels {
  'finalization-generation:read': { args: [{ slot: FinalizationGenerationSlot }]; return: FinalizationGenerationRecovery | null }
  /**
   * retryRunId：作者点重试时看到的那次运行。它没有留下可以提交的结果时，主进程在同一 root 另开运行，
   * 按 modelId（作者现在的分工模型）重新生成；有可提交的结果时沿用它。
   */
  'finalization-generation:begin': { args: [{ slot: FinalizationGenerationSlot; modelId: string; parentRootActionId?: string; retryRunId?: string }]; return: FinalizationGenerationRecovery }
  /** recoverFrom：以最近一次未成功尝试的 attemptId 为幂等键重新请求一次。界面重试改用 begin 的 retryRunId，不再发它。 */
  'finalization-generation:execute': { args: [{ handle: MainGenerationRunHandle; retryOf?: FinalizedCharacterArtifact; recoverFrom?: string }]; return: MainGenerationExecuteReceipt }
  'finalization-generation:commit': { args: [{ handle: MainGenerationRunHandle; artifact: FinalizedCharacterArtifact }]; return: FinalizationGenerationEffect }
  'finalization-generation:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}
