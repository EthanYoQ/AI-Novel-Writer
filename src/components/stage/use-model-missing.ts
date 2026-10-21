import { useLLMStore } from '../../stores/llm-store'

/** 还没有默认生成模型：写作、审稿、修稿与 AI 填充都用不了。模型配置载入前不下结论。 */
export function useModelMissing(): boolean {
  return useLLMStore(s => s.loaded && !s.defaultModelId)
}
