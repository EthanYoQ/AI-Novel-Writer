import type {
  DiscoveredModel,
  ModelDiscoveryRequest,
  ModelDiscoveryResult,
} from '../../src/shared/ipc-channels'

interface ModelDiscoveryServiceDependencies {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

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
    models.push({ id, name, value: id })
  }
  return models
}

function parseGeminiModels(payload: unknown, credential: string): DiscoveredModel[] | null {
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
    models.push({ id, name, value })
  }
  return models
}

/**
 * Main-process model discovery boundary. The current form reaches this trusted
 * boundary without being saved, and provider details are reduced to a fixed result.
 */
export class ModelDiscoveryService {
  constructor(private readonly dependencies: ModelDiscoveryServiceDependencies = {}) {}

  async discoverModels(model: ModelDiscoveryRequest): Promise<ModelDiscoveryResult> {
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
        const models = parseGeminiModels(payload, model.apiKey)
        if (!models) return { success: false, errorCode: 'invalid_response' }
        if (models.length === 0) return { success: false, errorCode: 'empty' }
        return { success: true, models }
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
      if (models.length === 0) return { success: false, errorCode: 'empty' }
      return { success: true, models }
    } catch {
      return { success: false, errorCode: 'network' }
    } finally {
      clearTimeout(timeout)
    }
  }
}
