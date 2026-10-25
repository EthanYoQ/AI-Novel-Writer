import { WRITING_SKILL_STAGES } from './writing-skills'

export const MODEL_STAGES = [...WRITING_SKILL_STAGES, 'finalization'] as const
export type ModelStage = typeof MODEL_STAGES[number]

export const MODEL_STAGE_BY_OPERATION = {
  'generate-global-config': 'planning',
  'generate-core-seed': 'planning',
  'character-architecture': 'planning',
  'generate-world-building': 'planning',
  'generate-plot-outline': 'planning',
  'chapter-blueprint-directory': 'planning',
  'generate-field': 'planning',
  'planning-material-character-extraction': 'planning',
  'import-global-facts': 'planning',
  'import-blueprints': 'planning',
  'analyze-writing-style': 'planning',
  'legacy-character-roster-repair': 'planning',
  'plot-tree-snapshot': 'planning',
  'narrative-thread-plan-candidate': 'planning',
  'narrative-thread-event-candidate': 'planning',
  'chapter-draft': 'drafting',
  'batch-chapters': 'drafting',
  'editor-inline': 'drafting',
  'agent-round': 'drafting',
  'review-chapter': 'review',
  'refine-draft': 'refinement',
  'refine-from-review': 'refinement',
  'finalized-chapter-notes': 'finalization',
  'finalized-character-state': 'finalization',
} as const satisfies Record<string, ModelStage>

export type GenerationOperationFamily = keyof typeof MODEL_STAGE_BY_OPERATION
export type GenerationOperation =
  | Exclude<GenerationOperationFamily, 'generate-field'>
  | `generate-field:${string}`

export function stageOfOperation(operation: GenerationOperation): ModelStage {
  const family = operation.split(':')[0]
  if (!Object.hasOwn(MODEL_STAGE_BY_OPERATION, family)) throw new Error('MODEL_STAGE_UNREGISTERED')
  return MODEL_STAGE_BY_OPERATION[family as GenerationOperationFamily]
}

export function isModelStage(value: unknown): value is ModelStage {
  return typeof value === 'string' && (MODEL_STAGES as readonly string[]).includes(value)
}

/** 只存 id，不复制模型档案：档案含明文 API Key（#518）。 */
export type StageModelIds = Readonly<Partial<Record<ModelStage, string>>>

export function parseStageModelIds(raw: unknown): StageModelIds {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Partial<Record<ModelStage, string>> = {}
  for (const [stage, modelId] of Object.entries(raw)) {
    if (isModelStage(stage) && typeof modelId === 'string' && modelId.trim()) result[stage] = modelId.trim()
  }
  return result
}

export function assignStageModel(current: StageModelIds, stage: ModelStage, modelId: string | null): StageModelIds {
  const next: Partial<Record<ModelStage, string>> = { ...current }
  if (modelId) next[stage] = modelId
  else delete next[stage]
  return next
}

export function removeModelFromStages(current: StageModelIds, modelId: string): { next: StageModelIds; changed: boolean } {
  const kept = Object.entries(current).filter(([, assigned]) => assigned !== modelId)
  return { next: Object.fromEntries(kept), changed: kept.length !== Object.keys(current).length }
}

export interface RoutableModel {
  readonly id: string
  readonly purposes?: readonly string[]
}

export function isGenerationModel(model: RoutableModel): boolean {
  return model.purposes?.includes('generation') === true
}

export function availableGenerationModelId(models: readonly RoutableModel[], modelId: string | null | undefined): string | null {
  const id = modelId?.trim()
  return id && models.some(model => model.id === id && isGenerationModel(model)) ? id : null
}

export interface ModelRoutingState {
  readonly models: readonly RoutableModel[]
  readonly defaultModelId: string | null
  readonly stageModelIds: StageModelIds
}

export type StageModelRoute = { readonly stage: ModelStage; readonly staleAssignmentId: string | null } & (
  | { readonly source: 'stage' | 'default'; readonly modelId: string }
  | { readonly source: 'none'; readonly modelId: null }
)

/** 不退到「第一个模型」：那会把正文发给作者从没选过的端点。 */
export function routeStageModel(stage: ModelStage, state: ModelRoutingState): StageModelRoute {
  const assigned = state.stageModelIds[stage] ?? null
  const stageModelId = availableGenerationModelId(state.models, assigned)
  const staleAssignmentId = assigned && !stageModelId ? assigned : null
  if (stageModelId) return { stage, modelId: stageModelId, source: 'stage', staleAssignmentId }
  const defaultModelId = availableGenerationModelId(state.models, state.defaultModelId)
  return defaultModelId
    ? { stage, modelId: defaultModelId, source: 'default', staleAssignmentId }
    : { stage, modelId: null, source: 'none', staleAssignmentId }
}
