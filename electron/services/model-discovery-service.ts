import type {
  DiscoveredModel,
  ModelDiscoveryResult,
  ModelProfile,
} from '../../src/shared/ipc-channels'

interface ModelDiscoveryServiceDependencies {
  loadModel: (profileId: string) => ModelProfile | null
  fetchImpl?: typeof fetch
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
  const normalized = value.trim()
  if (!normalized || (credential && normalized.includes(credential))) return null
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

  const models: DiscoveredModel[] = []
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== 'object') return null
    const id = safeProviderText((item as { id?: unknown }).id, credential)
    if (!id) return null
    const providerName = (item as { name?: unknown }).name
    const name = providerName === undefined ? id : safeProviderText(providerName, credential)
    if (!name) return null
    models.push({ id, name, value: id })
  }
  return models
}

function parseGeminiModels(payload: unknown, credential: string): DiscoveredModel[] | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { models?: unknown }).models)) {
    return null
  }

  const models: DiscoveredModel[] = []
  for (const item of (payload as { models: unknown[] }).models) {
    if (!item || typeof item !== 'object') return null
    const id = safeProviderText((item as { name?: unknown }).name, credential)
    if (!id) return null
    const providerName = (item as { displayName?: unknown }).displayName
    const name = providerName === undefined ? id : safeProviderText(providerName, credential)
    if (!name) return null
    const value = id.startsWith('models/') ? id.slice('models/'.length) : id
    if (!value) return null
    models.push({ id, name, value })
  }
  return models
}

/**
 * Main-process model configuration boundary for explicit provider discovery.
 * Callers supply only a saved profile ID; endpoint and credential stay inside
 * the main process and provider details are reduced to a fixed safe result.
 */
export class ModelDiscoveryService {
  constructor(private readonly dependencies: ModelDiscoveryServiceDependencies) {}

  async discoverModels(profileId: string): Promise<ModelDiscoveryResult> {
    let model: ModelProfile | null
    try {
      model = this.dependencies.loadModel(profileId)
    } catch {
      return { success: false, errorCode: 'invalid_response' }
    }
    if (!model) {
      return { success: false, errorCode: 'unsupported' }
    }

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
          return { success: false, errorCode: 'invalid_response' }
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
        return { success: false, errorCode: 'invalid_response' }
      }
      const models = parseOpenAIModels(payload, model.apiKey)
      if (!models) return { success: false, errorCode: 'invalid_response' }
      if (models.length === 0) return { success: false, errorCode: 'empty' }
      return { success: true, models }
    } catch {
      return { success: false, errorCode: 'network' }
    }
  }
}
