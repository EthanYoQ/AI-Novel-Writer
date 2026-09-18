import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { FinalizedCharacterContext, FinalizedCharacterStateCommitReceipt, FinalizedCharacterStateOccurrence } from './finalized-continuity'

export interface FinalizedCharacterArtifact {
  artifactId: string
  revision: number
  textHash: string
}
export interface FinalizedCharacterGenerationCommit {
  contextId: string
  handle: MainGenerationRunHandle
  artifact: FinalizedCharacterArtifact
}
export interface FinalizedCharacterGenerationReceipt extends FinalizedCharacterStateCommitReceipt {
  unresolved: FinalizedCharacterStateOccurrence[]
  proposalBatchId?: string
}
export interface FinalizedCharacterGenerationChannels {
  'finalized-character:read-context': { args: [{ draftId: number }]; return: { contextId: string; context: FinalizedCharacterContext } }
  'finalized-character:commit': { args: [FinalizedCharacterGenerationCommit]; return: FinalizedCharacterGenerationReceipt }
}
