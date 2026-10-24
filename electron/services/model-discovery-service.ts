import type {
  DiscoveredModel,
  ModelDiscoveryRequest,
  ModelDiscoveryResult,
} from '../../src/shared/ipc-channels'

interface ModelDiscoveryServiceDependencies {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type DiscoveryPurpose = 'generation' | 'embedding'

const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000
const MAX_DISCOVERED_MODEL_ENTRIES = 500
const MAX_DISCOVERED_MODEL_TEXT_BYTES = 512

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true
    }
  }
  return false
}

function resolveOpenAIModelsUrl(baseUrl: string): string {
  const endpoint = new URL(baseUrl.trim())
  let configuredPath = endpoint.pathname.replace(/\/+$/u, '')

  if (configuredPath.endsWith('/chat/completions')) {
    configuredPath = configuredPath.slice(0, -'/chat/completions'.length)
  } else if (configuredPath.endsWith('/chat')) {
    configuredPath = configuredPath.slice(0, -'/chat'.length)
  }
  if (!configuredPath) configuredPath = '/v1'

  endpoint.pathname = `${configuredPath}/models`
  endpoint.search = ''
  endpoint.hash = ''
  endpoint.username = ''
  endpoint.password = ''
  return endpoint.toString()
}

function resolveGeminiModelsUrl(baseUrl: string): string {
  const endpoint = new URL(baseUrl.trim())
  const configuredPath = endpoint.pathname.replace(/\/+$/u, '')

  if (configuredPath.endsWith('/v1beta/models')) {
    endpoint.pathname = configuredPath
  } else if (configuredPath.endsWith('/v1beta')) {
    endpoint.pathname = `${configuredPath}/models`
  } else {
    endpoint.pathname = `${configuredPath}/v1beta/models`
  }
  endpoint.search = ''
  endpoint.hash = ''
  endpoint.username = ''
  endpoint.password = ''
  return endpoint.toString()
}

function safeProviderText(value: unknown, credential: string): string | null {
  if (typeof value !== 'string') return null
  if (Buffer.byteLength(value, 'utf8') > MAX_DISCOVERED_MODEL_TEXT_BYTES) return null
  if (containsControlCharacter(value)) return null
  const normalized = value.trim()
  if (!normalized || urlContainsCredential(normalized, credential)) return null
  return normalized
}

function urlContainsCredential(url: string, credential: string): boolean {
  if (!credential) return false
  if (url.includes(credential) || url.includes(encodeURIComponent(credential))) return true
  try {
    return decodeURIComponent(url).includes(credential)
  } catch {
    return false
  }
}

function classifyHttpFailure(status: number): ModelDiscoveryResult {
  if (status === 401 || status === 403) {
    return { success: false, errorCode: 'auth' }
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { success: false, errorCode: 'network' }
  }
  return { success: false, errorCode: 'unsupported' }
}

function parseOpenAIModels(payload: unknown, credential: string): DiscoveredModel[] | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    return null
  }

  const entries = (payload as { data: unknown[] }).data
  if (entries.length > MAX_DISCOVERED_MODEL_ENTRIES) return null
  const models: DiscoveredModel[] = []
  const seenValues = new Set<string>()
  for (const item of entries) {
    if (!item || typeof item !== 'object') return null
    const id = safeProviderText((item as { id?: unknown }).id, credential)
    if (!id) return null
    const providerName = (item as { name?: unknown }).name
    const name = providerName === undefined ? id : safeProviderText(providerName, credential)
    if (!name) return null
    if (seenValues.has(id)) continue
    seenValues.add(id)
    const raw = item as Record<string, unknown>
    const flags = raw.capabilities && typeof raw.capabilities === 'object'
      ? raw.capabilities as Record<string, unknown> : {}
    const capabilities: NonNullable<DiscoveredModel['capabilities']> = {}
    const context = raw.context_window ?? raw.context_length
    if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) capabilities.contextWindowTokens = context
    const output = raw.max_output_tokens
    if (typeof output === 'number' && Number.isSafeInteger(output) && output > 0) capabilities.maxOutputTokens = output
    for (const key of ['reasoning', 'structuredOutput', 'usage'] as const) {
      if (typeof flags[key] === 'boolean') capabilities[key] = flags[key]
    }
    models.push({ id, name, value: id, ...(Object.keys(capabilities).length ? { capabilities } : {}) })
  }
  return models
}

/**
 * TTS、图像（Nano Banana）、转写、音乐（Lyria）、音频模型，以及电脑操作、深度研究、Antigravity 与机器人这类代理模型，
 * 在 models 接口里同样声明 generateContent，只能按 Google 的命名区分；它们不是用来写正文的。
 */
const GEMINI_NON_WRITING_MODEL = /(?:^|[-_.])(?:tts|image|live|transcribe|audio|lyria|nano-banana|computer-use|deep-research|antigravity|robotics)(?:$|[-_.])/iu
const OPENAI_COMPATIBLE_EMBEDDING_MODEL = /embed|bge/iu

function geminiModelServesPurpose(item: object, value: string, purpose: DiscoveryPurpose): boolean {
  const methods = (item as { supportedGenerationMethods?: unknown }).supportedGenerationMethods
  // 自建网关可能不返回方法字段，这时无法判断用途，保留给作者自己选。
  if (Array.isArray(methods) && !methods.includes(purpose === 'embedding' ? 'embedContent' : 'generateContent')) return false
  return purpose === 'embedding' || !GEMINI_NON_WRITING_MODEL.test(value)
}

/** listed 是端点列出的模型数，用来区分「端点没有模型」和「没有适合当前用途的模型」。 */
function parseGeminiModels(payload: unknown, credential: string, purpose: DiscoveryPurpose): { models: DiscoveredModel[], listed: number } | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { models?: unknown }).models)) {
    return null
  }

  const entries = (payload as { models: unknown[] }).models
  if (entries.length > MAX_DISCOVERED_MODEL_ENTRIES) return null
  const models: DiscoveredModel[] = []
  const seenValues = new Set<string>()
  for (const item of entries) {
    if (!item || typeof item !== 'object') return null
    const id = safeProviderText((item as { name?: unknown }).name, credential)
    if (!id) return null
    const providerName = (item as { displayName?: unknown }).displayName
    const name = providerName === undefined ? id : safeProviderText(providerName, credential)
    if (!name) return null
    const value = id.startsWith('models/') ? id.slice('models/'.length) : id
    if (!value) return null
    if (seenValues.has(value)) continue
    seenValues.add(value)
    if (geminiModelServesPurpose(item, value, purpose)) models.push({ id, name, value })
  }
  return { models, listed: seenValues.size }
}

/**
 * Main-process model discovery boundary. The current form reaches this trusted
 * boundary without being saved, and provider details are reduced to a fixed result.
 */
export class ModelDiscoveryService {
  constructor(private readonly dependencies: ModelDiscoveryServiceDependencies = {}) {}

  async discoverModels(model: ModelDiscoveryRequest): Promise<ModelDiscoveryResult> {
    const purpose: DiscoveryPurpose = Array.isArray(model.purposes) && model.purposes.includes('embedding') ? 'embedding' : 'generation'
    const configuredTimeoutMs = this.dependencies.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)

    try {
      if (model.protocol === 'gemini') {
        const requestUrl = resolveGeminiModelsUrl(model.baseUrl)
        if (urlContainsCredential(requestUrl, model.apiKey)) {
          return { success: false, errorCode: 'invalid_response' }
        }
        const response = await (this.dependencies.fetchImpl ?? fetch)(
          requestUrl,
          {
            method: 'GET',
            redirect: 'error',
            signal: abortController.signal,
            headers: {
              Accept: 'application/json',
              'x-goog-api-key': model.apiKey,
            },
          },
        )
        if (!response.ok) return classifyHttpFailure(response.status)

        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return abortController.signal.aborted
            ? { success: false, errorCode: 'network' }
            : { success: false, errorCode: 'invalid_response' }
        }
        const parsed = parseGeminiModels(payload, model.apiKey, purpose)
        if (!parsed) return { success: false, errorCode: 'invalid_response' }
        if (parsed.listed === 0) return { success: false, errorCode: 'no_models' }
        if (parsed.models.length === 0) return { success: false, errorCode: 'no_suitable_models' }
        return { success: true, models: parsed.models }
      }

      const requestUrl = resolveOpenAIModelsUrl(model.baseUrl)
      if (urlContainsCredential(requestUrl, model.apiKey)) {
        return { success: false, errorCode: 'invalid_response' }
      }
      const response = await (this.dependencies.fetchImpl ?? fetch)(
        requestUrl,
        {
          method: 'GET',
          redirect: 'error',
          signal: abortController.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${model.apiKey}`,
          },
        },
      )
      if (!response.ok) return classifyHttpFailure(response.status)

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return abortController.signal.aborted
          ? { success: false, errorCode: 'network' }
          : { success: false, errorCode: 'invalid_response' }
      }
      const models = parseOpenAIModels(payload, model.apiKey)
      if (!models) return { success: false, errorCode: 'invalid_response' }
      if (models.length === 0) return { success: false, errorCode: 'no_models' }
      // OpenAI 兼容接口不说明模型用途，只能按名字认出向量模型。
      if (purpose === 'embedding') {
        const isEmbedding = (candidate: DiscoveredModel) => OPENAI_COMPATIBLE_EMBEDDING_MODEL.test(candidate.value)
        return { success: true, models: [...models.filter(isEmbedding), ...models.filter(candidate => !isEmbedding(candidate))] }
      }
      return { success: true, models }
    } catch {
      return { success: false, errorCode: 'network' }
    } finally {
      clearTimeout(timeout)
    }
  }
}
