import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { CharacterStaticProvenance, ScopedCharacterResolution } from './character-identity'
import type { CharacterRole } from './character-role'

export interface CharacterStaticFields {
  name: string
  role?: CharacterRole
  gender?: string
  age?: string
  appearance?: string
  personality?: string
  background?: string
  abilities?: string
  motivation?: string
  arc?: string
  notes?: string
}
export type CharacterProposalSource =
  | { kind: 'generation'; inputKind: 'architecture' | 'planning-material'; handle: MainGenerationRunHandle;
      artifacts: { artifactId: string; revision: number; textHash: string }[]; manifestArtifactId?: string }
  | { kind: 'directory'; operationId: string }
  | { kind: 'import'; operationId: string }
export interface CharacterProposalStageEvidence { proposalBatchId: string; sourceHash: string }
export interface CharacterProposalItem {
  selectionKey: string
  sourceId: string
  fields: CharacterStaticFields
  relationships: { targetSelectionKey?: string; targetName?: string; relation: string; raw?: unknown }[]
  rawValue?: unknown
  resolution: ScopedCharacterResolution
}
export interface CharacterProposalBatch {
  proposalBatchId: string
  revision: number
  status: 'pending-approval' | 'approved' | 'cancelled'
  items: CharacterProposalItem[]
  source: CharacterProposalSource
  approvalOperationId?: string
}
export type CharacterProposalDecision =
  | { selectionKey: string; action: 'create' }
  | { selectionKey: string; action: 'map'; characterId: string }
  | { selectionKey: string; action: 'keep-unresolved' }
export interface ApproveCharacterProposalRequest {
  proposalBatchId: string
  expectedRevision: number
  operationId: string
  selections: CharacterProposalDecision[]
  relationships?: { sourceSelectionKey: string; targetSelectionKey?: string; targetCharacterId?: string; relation: string }[]
}
export interface CharacterIdentitySnapshot {
  revision: number
  characters: { characterId: string; fields: CharacterStaticFields; retired: boolean; revision: number;
    provenance: CharacterStaticProvenance | Record<string, unknown> }[]
  aliases: { characterId: string; name: string; sourceKey: string; validFrom: number; validThrough: number | null }[]
  relationships: { relationshipId: string; sourceCharacterId: string; targetCharacterId: string; relation: string }[]
}
export interface CharacterProposalChannels {
  'character-proposal:stage': { args: [{ source: CharacterProposalSource }]; return: CharacterProposalBatch }
  'character-proposal:read': { args: [{ proposalBatchId: string }]; return: CharacterProposalBatch }
  'character-proposal:approve': { args: [ApproveCharacterProposalRequest]; return: { batch: CharacterProposalBatch; created: { selectionKey: string; characterId: string }[] } }
  'character-proposal:cancel': { args: [{ proposalBatchId: string }]; return: CharacterProposalBatch }
  'character-identity:read': { args: []; return: CharacterIdentitySnapshot }
}
