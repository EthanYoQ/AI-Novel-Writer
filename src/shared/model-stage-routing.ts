/**
 * 分工模型（#517）：生成 operation 属于哪个创作环节，以及每个环节用哪个模型。
 * 纯逻辑，主进程与渲染端共用；不 import 其他模块，避免类型环与启动隔离问题。
 */

/** 前四个与写作 Skill 的阶段同名，作者在两处看到的是同一套词。 */
export const MODEL_STAGES = ['planning', 'drafting', 'review', 'refinement', 'finalization'] as const
export type ModelStage = typeof MODEL_STAGES[number]

/**
 * operation 族到环节的唯一表，同时是生成 operation 的注册表：
 * 渲染端接缝的 operation 类型由它的键派生，新 operation 不登记就过不了类型检查。
 * 族是 operation 第一个冒号之前的部分（generate-field:<字段> 归 generate-field）。
 */
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

/** 未登记的族（有人绕过了类型）直接报错，不静默落到某个环节。 */
export function stageOfOperation(operation: GenerationOperation): ModelStage {
  const family = operation.split(':')[0]
  if (!Object.hasOwn(MODEL_STAGE_BY_OPERATION, family)) throw new Error('MODEL_STAGE_UNREGISTERED')
  return MODEL_STAGE_BY_OPERATION[family as GenerationOperationFamily]
}

export function isModelStage(value: unknown): value is ModelStage {
  return typeof value === 'string' && (MODEL_STAGES as readonly string[]).includes(value)
}

/** 只存模型 id（不加重 #518）。缺键就是「跟随默认」，不另存 null。 */
export type StageModelIds = Readonly<Partial<Record<ModelStage, string>>>

/** 读边界：任何输入都解析成合法映射，丢掉未知环节、非字符串与空串；不检查模型是否存在。 */
export function parseStageModelIds(raw: unknown): StageModelIds {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Partial<Record<ModelStage, string>> = {}
  for (const [stage, modelId] of Object.entries(raw)) {
    if (isModelStage(stage) && typeof modelId === 'string' && modelId.trim()) result[stage] = modelId.trim()
  }
  return result
}

/** modelId 为 null 时删键；删空后返回 undefined，写进 JSON 时整个字段消失。 */
export function assignStageModel(current: StageModelIds, stage: ModelStage, modelId: string | null): StageModelIds | undefined {
  const next: Partial<Record<ModelStage, string>> = { ...current }
  if (modelId) next[stage] = modelId
  else delete next[stage]
  return Object.keys(next).length > 0 ? next : undefined
}

/** 删除模型时清掉指向它的环节；changed 为假时调用方不必写文件。 */
export function removeModelFromStages(current: StageModelIds, modelId: string): { next: StageModelIds | undefined; changed: boolean } {
  const kept = Object.entries(current).filter(([, assigned]) => assigned !== modelId)
  const changed = kept.length !== Object.keys(current).length
  return { next: kept.length > 0 ? Object.fromEntries(kept) : undefined, changed }
}

/** 结构类型，避免引入 ModelProfile。purposes 可缺：主进程读的是可能被手改过的 models.json。 */
export interface RoutableModel {
  readonly id: string
  readonly purposes?: readonly string[]
}

export function isGenerationModel(model: RoutableModel): boolean {
  return model.purposes?.includes('generation') === true
}

/** id 指向一个存在的生成模型时原样返回，否则 null。 */
export function availableGenerationModelId(models: readonly RoutableModel[], modelId: string | null | undefined): string | null {
  const id = modelId?.trim()
  return id && models.some(model => model.id === id && isGenerationModel(model)) ? id : null
}

export interface ModelRoutingState {
  readonly models: readonly RoutableModel[]
  readonly defaultModelId: string | null
  readonly stageModelIds: StageModelIds
}

export interface StageModelRoute {
  readonly stage: ModelStage
  /** 只有环节指定和默认模型都不可用时才是 null。 */
  readonly modelId: string | null
  readonly source: 'stage' | 'default' | 'none'
  /** 环节存了 id，但它已不存在或不再是生成模型；设置页据此提示。 */
  readonly staleAssignmentId: string | null
}

/**
 * 唯一的回退链：环节指定（可用）→ 默认模型（可用）→ null。
 * 不退到「第一个模型」：那会把正文发给作者从没选过的端点。
 */
export function routeStageModel(stage: ModelStage, state: ModelRoutingState): StageModelRoute {
  const assigned = state.stageModelIds[stage] ?? null
  const stageModelId = availableGenerationModelId(state.models, assigned)
  const staleAssignmentId = assigned && !stageModelId ? assigned : null
  if (stageModelId) return { stage, modelId: stageModelId, source: 'stage', staleAssignmentId }
  const defaultModelId = availableGenerationModelId(state.models, state.defaultModelId)
  return { stage, modelId: defaultModelId, source: defaultModelId ? 'default' : 'none', staleAssignmentId }
}
