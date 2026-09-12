import type { GenerationTask } from '../services/generation/generation-harness'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../services/generation/generation-runtime'
import type { WritingSkillStage } from './writing-skills'

/** Raw text explicitly supplied for this author action, never inferred candidate text. */
export interface GenerationAuthorInput { id: string; text: string }
export interface DirectoryGenerationProgress {
  operationId: string
  payloadHash: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: { startChapter: number; endChapter: number }
  committedRange: { startChapter: number; endChapter: number }
  remainingRange: { startChapter: number; endChapter: number } | null
  continuationHandle?: MainGenerationRunHandle
  /** Read projection from the original run's immutable source manifest. */
  authorInputs?: readonly GenerationAuthorInput[]
}
export interface VisibleCompositionReceipt {
  algorithm: 'visible-append-v1'
  text: string
  textHash: string
  artifactIds: string[]
  sources: { artifactId: string; revision: number; textHash: string }[]
  authorInputs?: GenerationAuthorInput[]
}

/** Selection and semantic intent only. Main owns identity, source hashes and budgets. */
export interface BeginGenerationRequest {
  operation: string
  uiActionNonce: string
  modelId: string
  chapterNumber?: number
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  selectedBlueprintChapterNumbers?: number[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  authorInputs?: GenerationAuthorInput[]
  output: 'visible-text' | 'structured-data'
  /** Finite semantic exceptions frozen before dispatch; no renderer-time contract changes. */
  outputOverrides?: { purpose: string; output: 'visible-text' | 'structured-data' }[]
  parentRootActionId?: string
  /** Explicit next-stage navigation from an atomically committed directory range. */
  continueDirectoryOperationId?: string
}
export interface ExecuteGenerationRequest {
  handle: MainGenerationRunHandle
  invocationNonce: string
  task: GenerationTask
}
export interface GenerationOwnerChannels {
  'generation:list-directory-progress': { args: []; return: DirectoryGenerationProgress[] }
  'generation:compose-visible': { args: [MainGenerationRunHandle, string[], string]; return: VisibleCompositionReceipt }
  'generation:read-visible-composition': { args: [MainGenerationRunHandle]; return: VisibleCompositionReceipt | null }
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

export function generationOutputContract(selection: BeginGenerationRequest): string | Readonly<Record<string, unknown>> {
  const overrides = selection.outputOverrides
  if (!['visible-text', 'structured-data'].includes(selection.output)
    || overrides !== undefined && (!Array.isArray(overrides) || overrides.length === 0 || overrides.length > 8
      || overrides.some(item => !item || Object.keys(item).some(key => !['purpose', 'output'].includes(key))
        || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(item.purpose)
        || !['visible-text', 'structured-data'].includes(item.output))
      || new Set(overrides.map(item => item.purpose)).size !== overrides.length))
    throw new Error('GENERATION_OUTPUT_CONTRACT_INVALID')
  return overrides ? { primary: selection.output, overrides: structuredClone(overrides) } : selection.output
}
