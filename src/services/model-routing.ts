import { useLLMStore } from '../stores/llm-store'
import { routeStageModel, stageOfOperation, type GenerationOperation, type ModelStage, type StageModelRoute } from '../shared/model-stage-routing'

/** 按环节解析当前设置（读 llm-store 快照，不持有状态）。 */
export function routeForStage(stage: ModelStage): StageModelRoute {
  const { models, defaultModelId, stageModelIds } = useLLMStore.getState()
  return routeStageModel(stage, { models, defaultModelId, stageModelIds })
}

/** 这个 operation 没有显式模型时该用哪个：环节指定 → 默认模型 → null。 */
export function routeModelId(operation: GenerationOperation): string | null {
  return routeForStage(stageOfOperation(operation)).modelId
}
