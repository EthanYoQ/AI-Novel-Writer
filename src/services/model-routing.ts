import { useLLMStore } from '../stores/llm-store'
import { routeStageModel, stageOfOperation, type GenerationOperation, type ModelStage, type StageModelRoute } from '../shared/model-stage-routing'

export function routeForStage(stage: ModelStage): StageModelRoute {
  const { models, defaultModelId, stageModelIds } = useLLMStore.getState()
  return routeStageModel(stage, { models, defaultModelId, stageModelIds })
}

export function routeModelId(operation: GenerationOperation): string | null {
  return routeForStage(stageOfOperation(operation)).modelId
}
