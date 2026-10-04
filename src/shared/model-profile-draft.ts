import { DEFAULT_EMBEDDING_OPTIONS } from './embedding-options'
import type { ModelProfile } from './ipc-channels'
import { createProviderCatalog, resolveModelProfileBudgetCapabilities, resolveModelProfileCapabilities, resolveModelProfileReasoningMapping } from './provider-presets'

export const DEFAULT_GENERATION_OUTPUT_TOKENS = 65_536

export function modelCapabilitySource(model: ModelProfile, key: keyof NonNullable<ModelProfile['capabilities']>) {
  const source = model.capabilitySources?.[key]
  if (source) return source
  const value = model.capabilities?.[key]
  return typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? 'manual' : 'unknown'
}

/** One explicit model selection seam; refreshing a list never calls it. */
export function applyModelProfileSelection(model: ModelProfile,
  selection: Partial<Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl' | 'modelName'>>,
  declared?: Partial<NonNullable<ModelProfile['capabilities']>>): ModelProfile {
  const next = { ...model, ...selection }
  const sameIdentity = next.modelName === model.modelName && next.baseUrl === model.baseUrl && next.protocol === model.protocol
  if (!declared && sameIdentity) return next
  const capacity = resolveModelProfileBudgetCapabilities(next)
  const features = resolveModelProfileCapabilities(next)
  const previousCap = model.capabilities?.maxOutputTokens
  const maxTokens = typeof previousCap === 'number' && Number.isSafeInteger(previousCap) && previousCap > 0
    ? Math.min(model.maxTokens, previousCap) : model.maxTokens
  // Persist operational limits separately from the catalog's provider maxima.
  // In particular, a new model cannot overwrite a smaller author output limit.
  const preset = { ...features, ...(capacity ? { contextWindowTokens: capacity.contextWindowTokens,
    maxOutputTokens: capacity.maxOutputTokens } : {}),
    ...(!features && resolveModelProfileReasoningMapping({ ...next, reasoningMapping: undefined }) ? { reasoning: true } : {}) }
  let capabilities = { contextWindowTokens: null, maxOutputTokens: maxTokens,
    reasoning: false, structuredOutput: false, usage: false } as NonNullable<ModelProfile['capabilities']>
  const capabilitySources: NonNullable<ModelProfile['capabilitySources']> = {}
  for (const key of ['contextWindowTokens', 'maxOutputTokens', 'reasoning', 'structuredOutput', 'usage'] as const) {
    const oldSource = modelCapabilitySource(model, key)
    const retainManual = sameIdentity && oldSource === 'manual'
    const retainEndpoint = sameIdentity && oldSource === 'endpoint' && declared?.[key] === undefined
    const value = retainManual || retainEndpoint ? model.capabilities?.[key] : declared?.[key] ?? preset[key]
    capabilitySources[key] = retainManual ? 'manual' : retainEndpoint || declared?.[key] !== undefined ? 'endpoint'
      : preset[key] !== undefined ? 'preset' : 'unknown'
    if (value !== undefined) capabilities = { ...capabilities, [key]: value }
  }
  return { ...next, maxTokens, capabilitySources,
    reasoningOverride: sameIdentity ? model.reasoningOverride : 'auto',
    ...(!sameIdentity && model.reasoningMapping ? { reasoningMapping: undefined } : {}),
    capabilities: Object.values(capabilitySources).some(source => source !== 'unknown') ? capabilities : undefined }
}

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
  const maxTokens = isEmbedding ? capabilities?.maxOutputTokens ?? 4096
    : Math.min(modelPreset?.budgetCapabilities?.maxOutputTokens ?? capabilities?.maxOutputTokens ?? DEFAULT_GENERATION_OUTPUT_TOKENS, DEFAULT_GENERATION_OUTPUT_TOKENS)

  const draft: ModelProfile = {
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
  return isEmbedding ? draft : applyModelProfileSelection({ ...draft, modelName: '' }, { modelName })
}
