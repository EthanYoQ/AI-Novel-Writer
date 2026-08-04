import { DEFAULT_EMBEDDING_OPTIONS } from './embedding-options'
import type { ModelProfile } from './ipc-channels'
import { createProviderCatalog } from './provider-presets'

/** 创建新模型配置时的输入；不会读取或修改已保存的配置。 */
export interface CreateModelProfileDraftOptions {
  id: string
  purposes: ModelProfile['purposes']
}

/**
 * 为设置界面创建完整的新模型草稿。
 *
 * 生成模型保留 OpenAI 起点；向量模型默认使用 SiliconFlow 的免费 BAAI/bge-m3。
 */
export function createModelProfileDraft({
  id,
  purposes,
}: CreateModelProfileDraftOptions): ModelProfile {
  const isEmbedding = purposes.includes('embedding')
  const provider = isEmbedding ? 'siliconflow' : 'openai'
  const preset = createProviderCatalog().find((candidate) => candidate.provider === provider)
  if (!preset) throw new Error(`Missing built-in provider preset: ${provider}`)

  const modelPreset = isEmbedding ? undefined : preset.models[0]
  const modelName = isEmbedding
    ? (preset.embeddingModels[0] ?? '')
    : (modelPreset?.name ?? '')
  const capabilities = isEmbedding
    ? preset.embeddingModelCapabilities?.[modelName]
    : modelPreset?.capabilities
  const maxTokens = capabilities?.maxOutputTokens ?? modelPreset?.maxTokens ?? 4096

  return {
    id,
    name: isEmbedding ? `${preset.displayName ?? preset.provider} ${modelName}` : '',
    provider,
    protocol: preset.protocol as ModelProfile['protocol'],
    modelName,
    apiKey: '',
    baseUrl: preset.baseUrl,
    temperature: 0.7,
    maxTokens,
    capabilities: capabilities ? { ...capabilities } : undefined,
    purposes: [...purposes],
    ...(isEmbedding ? { embeddingOptions: { ...DEFAULT_EMBEDDING_OPTIONS } } : {}),
  }
}
