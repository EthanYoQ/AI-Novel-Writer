import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { GenerationTask } from '../services/generation/generation-harness'
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'
import type { PromptTemplate } from '../services/prompt-templates'
import type { ImportRunExecutionAuthority } from './import-run'

/** A durable import checkpoint, never a renderer-selected generation root. */
export interface ImportGenerationSlot {
  runId: string
  stage: 'global' | 'style' | 'blueprints'
  batchId: string
}
export interface ImportGenerationContext {
  slot: ImportGenerationSlot
  manifestFingerprint: string
  totalChapters: number
  totalWords: number
  core: ProjectCoreData
  prompts: Record<string, PromptTemplate>
  chapters: { number: number; title: string; content: string; contentFingerprint: string; wordCount: number }[]
}
export interface ImportGenerationRecovery {
  view: MainGenerationRunView
  modelId: string
  frozenContext: ImportGenerationContext
}
export interface ImportGenerationChannels {
  'import-generation:read': { args: [{ slot: ImportGenerationSlot }]; return: ImportGenerationRecovery | null }
  'import-generation:execute': { args: [{ handle: MainGenerationRunHandle; ordinal: number; task: GenerationTask; execution?: ImportRunExecutionAuthority }]; return: MainGenerationExecuteReceipt }
}
