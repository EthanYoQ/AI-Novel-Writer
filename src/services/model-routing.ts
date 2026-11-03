import { useLLMStore } from '../stores/llm-store'
import { routeStageModel, stageOfOperation, type GenerationOperation } from '../shared/model-stage-routing'

export function routeModelId(operation: GenerationOperation): string | null {
  return routeStageModel(stageOfOperation(operation), useLLMStore.getState()).modelId
}
