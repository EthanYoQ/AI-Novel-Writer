import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { DatabaseChannels } from './ipc-channels'
import type { PlotTreeSnapshot, PlotTreeSourceBundle } from './plot-tree'
import type { NarrativeThreadPlanRecord, NarrativeThreadEvent, NarrativeThreadView } from './narrative-thread'
import type { NarrativeThreadPlanCandidate, NarrativeThreadEventCandidate } from './narrative-thread-generation-pure'
import type { FinalizedSourceIdentity } from './finalized-continuity'
import type { WritingLanguage } from './writing-language'

export type GraphGenerationInput = { kind: 'plot' } | { kind: 'plan'; chapterNumber: number } | { kind: 'event'; planId: number; draftId: number }
type BlueprintData = DatabaseChannels['db:blueprint-get-all']['return'][number]
export type GraphGenerationContext = {
  projectId: string
  originEpoch: string
  /** Main-issued stable context/owner lookup key, not a renderer fact hash. */
  key: string
  createdAt: string
  input: GraphGenerationInput
  writingLanguage: WritingLanguage
} & ({ kind: 'plot'; sources: PlotTreeSourceBundle; targetBaselineHash: string }
  | { kind: 'plan'; blueprint: BlueprintData; totalChapters: number }
  | { kind: 'event'; plan: NarrativeThreadView; source: FinalizedSourceIdentity; content: string; contentRevision: number; projectionGeneration: number })
export type GraphGenerationResult = { kind: 'plot'; snapshot: PlotTreeSnapshot; derivation: 'model' | 'normalized' | 'deterministic' }
  | { kind: 'plan'; candidates: NarrativeThreadPlanCandidate[] }
  | { kind: 'event'; candidates: NarrativeThreadEventCandidate[] }
export interface GraphGenerationArtifact { artifactId: string; revision: number; textHash: string }
export type GraphGenerationEffect = { success: true; index: number } & (
  { kind: 'plot'; snapshot: PlotTreeSnapshot; derivation: 'model' | 'normalized' | 'deterministic' }
  | { kind: 'plan'; plan: NarrativeThreadPlanRecord }
  | { kind: 'event'; event: NarrativeThreadEvent })
export interface GraphGenerationRecovery {
  view: MainGenerationRunView
  modelId: string
  context: GraphGenerationContext
  attemptCount: number
  sourceStatus: 'current' | 'conflict'
  artifact?: GraphGenerationArtifact
  result?: GraphGenerationResult
  effects: GraphGenerationEffect[]
}
export interface GraphGenerationChannels {
  'graph-generation:begin': { args: [{ input: GraphGenerationInput; modelId: string; uiActionNonce: string }]; return: GraphGenerationRecovery }
  'graph-generation:read': { args: [{ handle: MainGenerationRunHandle }]; return: GraphGenerationRecovery }
  'graph-generation:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'graph-generation:confirm': { args: [{ handle: MainGenerationRunHandle; artifact: GraphGenerationArtifact; index: number }]; return: GraphGenerationEffect }
  'graph-generation:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}
