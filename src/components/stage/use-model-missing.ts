import { useLLMStore } from '../../stores/llm-store'
import { routeStageModel, type ModelStage } from '../../shared/model-stage-routing'

/** 这个环节按分工模型解析不出可用的生成模型，和启动生成时的门槛同一套规则。模型配置载入前不下结论。 */
export function useModelMissing(stage: ModelStage): boolean {
  return useLLMStore(s => s.loaded && !routeStageModel(stage, s).modelId)
}
