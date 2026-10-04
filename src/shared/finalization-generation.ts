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
  view: MainGenerationRunView
  modelId: string
  context: FinalizationGenerationContext
  sourceStatus: 'current' | 'conflict'
  effect?: FinalizationGenerationEffect
}
export interface FinalizationGenerationChannels {
  'finalization-generation:read': { args: [{ slot: FinalizationGenerationSlot }]; return: FinalizationGenerationRecovery | null }
  'finalization-generation:begin': { args: [{ slot: FinalizationGenerationSlot; modelId: string; parentRootActionId?: string }]; return: FinalizationGenerationRecovery }
  'finalization-generation:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'finalization-generation:commit': { args: [{ handle: MainGenerationRunHandle; artifact: FinalizedCharacterArtifact }]; return: FinalizationGenerationEffect }
  'finalization-generation:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}
