import type { GenerationTask } from '../services/generation/generation-harness'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../services/generation/generation-runtime'
import type { WritingSkillStage } from './writing-skills'

/** Selection and semantic intent only. Main owns identity, source hashes and budgets. */
export interface BeginGenerationRequest {
  operation: string
  uiActionNonce: string
  modelId: string
  chapterNumber?: number
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  output: 'visible-text' | 'structured-data'
  parentRootActionId?: string
}
export interface ExecuteGenerationRequest {
  handle: MainGenerationRunHandle
  invocationNonce: string
  task: GenerationTask
}
export interface GenerationOwnerChannels {
  'generation:begin': { args: [BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:execute': { args: [ExecuteGenerationRequest]; return: MainGenerationExecuteReceipt }
  'generation:read': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:list': { args: []; return: MainGenerationRunView[] }
  'generation:cancel': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:pause': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:resume': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:restart': { args: [MainGenerationRunHandle, BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:discard-candidate': { args: [MainGenerationRunHandle, string]; return: MainGenerationRunView }
}
export interface GenerationOwnerEvents { 'generation:snapshot': MainGenerationSnapshot }
