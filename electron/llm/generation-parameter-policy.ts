import type { LLMRequest, ModelProfile } from '../../src/shared/ipc-channels'
import { resolveReasoningPolicy } from '../../src/shared/reasoning-policy'
import type { CreativeStrategy, ProviderReasoningDirective } from '../../src/shared/reasoning-types'

export interface ResolvedGenerationParameters {
  /** `undefined` means the provider must omit this request field. */
  temperature: number | undefined
  maxTokens: number
  responseFormat?: { type: 'json_object' | 'text' }
  reasoning?: ProviderReasoningDirective
}

type GenerationParameterRequest = Pick<LLMRequest, 'maxTokens' | 'responseFormat' | 'purpose'> & {
  creativeStrategy?: CreativeStrategy
}

const OFFICIAL_KIMI_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai'])
const KIMI_FIXED_TEMPERATURE_MODEL_PREFIXES = [
  'kimi-k3',
  'kimi-k2.7',
  'kimi-k2.6',
  'kimi-k2.5',
]

function hasModelFamilyPrefix(modelName: string, prefixes: readonly string[]): boolean {
  const normalized = modelName.trim().toLowerCase()
  return prefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}-`))
}

function isOfficialKimiHost(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl)
    return endpoint.protocol === 'https:'
      && OFFICIAL_KIMI_HOSTS.has(endpoint.hostname.toLowerCase())
  } catch {
    return false
  }
}

function validateKimiTemperature(temperature: number): void {
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 1) return
  throw new Error('Kimi API 的 temperature 必须在 0 到 1 之间。请在模型设置中调整后重试。')
}

/**
 * Resolves the effective provider request parameters from one model profile.
 * Model-profile temperature is the only user-visible sampling input; callers
 * may select workflow features and output budget but cannot override it.
 */
export function resolveGenerationParameters(
  model: ModelProfile,
  request: GenerationParameterRequest,
): ResolvedGenerationParameters {
  const isOfficialKimi = isOfficialKimiHost(model.baseUrl)
  const usesFixedKimiTemperature = isOfficialKimi
    && hasModelFamilyPrefix(model.modelName, KIMI_FIXED_TEMPERATURE_MODEL_PREFIXES)

  if (isOfficialKimi && !usesFixedKimiTemperature) {
    validateKimiTemperature(model.temperature)
  }

  const reasoningResolution = resolveReasoningPolicy({
    model,
    creativeStrategy: request.creativeStrategy,
    purpose: request.purpose,
  })

  return {
    temperature: usesFixedKimiTemperature ? undefined : model.temperature,
    maxTokens: request.maxTokens ?? model.maxTokens,
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    ...(reasoningResolution.providerDirective
      ? { reasoning: reasoningResolution.providerDirective }
      : {}),
  }
}
