import type { CharacterRosterCommitReceipt, CharacterRosterEntry } from './character-roster'
import type { NovelConfig } from './ipc-channels'

export interface ImportGlobalFactsCore {
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  plotStructure: NovelConfig['plotStructure']
  narrativePov: NovelConfig['narrativePOV']
  goldenFinger: string
  globalGuidance: string
  coreOutline: string
  worldSetting: string
  protagonistProfile: string
  premise: string
  worldbuilding: string
  synopsis: string
}

export interface ImportGlobalFactsRequest {
  operationId: string
  expectedRosterRevision: number
  core: ImportGlobalFactsCore
  characterEntries: CharacterRosterEntry[]
}

interface ImportGlobalFactsReceiptBase {
  operationId: string
  payloadHash: string
  idempotent: boolean
  core: ImportGlobalFactsCore
}
export type ImportGlobalFactsReceipt = ImportGlobalFactsReceiptBase & (
  | { roster: CharacterRosterCommitReceipt; characterProposal?: never; proposalSource?: never }
  | { roster?: never; characterProposal: import('./character-proposal').CharacterProposalStageEvidence; proposalSource: ImportGlobalFactsRequest }
)
