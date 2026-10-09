import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { CharacterProposalBatch } from './character-proposal'
import type { LegacyRosterSource, AdoptLegacyCardsRequest, AdoptLegacyCardsReceipt } from '../../electron/services/legacy-roster-source'

export interface LegacyRosterGenerationContext {
  projectId: string
  originEpoch: string
  key: string
  createdAt: string
  source: LegacyRosterSource
}
export interface LegacyRosterGenerationArtifact { artifactId: string; revision: number; textHash: string }
export interface LegacyRosterGenerationRecovery {
  view: MainGenerationRunView
  modelId: string
  context: LegacyRosterGenerationContext
  sourceStatus: 'current' | 'conflict'
  attemptCount: number
  artifact?: LegacyRosterGenerationArtifact
  proposal?: CharacterProposalBatch
}
export interface LegacyRosterGenerationChannels {
  'legacy-roster:read-source': { args: []; return: LegacyRosterSource }
  'legacy-roster:adopt-existing': { args: [AdoptLegacyCardsRequest]; return: AdoptLegacyCardsReceipt }
  'legacy-roster:begin': { args: [{ modelId: string; uiActionNonce: string }]; return: LegacyRosterGenerationRecovery }
  'legacy-roster:read': { args: [{ handle: MainGenerationRunHandle }]; return: LegacyRosterGenerationRecovery }
  'legacy-roster:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'legacy-roster:stage': { args: [{ handle: MainGenerationRunHandle; artifact: LegacyRosterGenerationArtifact }]; return: CharacterProposalBatch }
  'legacy-roster:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}
