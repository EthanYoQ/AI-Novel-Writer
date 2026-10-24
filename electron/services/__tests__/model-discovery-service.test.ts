import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { ModelDiscoveryService } from '../model-discovery-service'
import { applyModelProfileSelection } from '../../../src/shared/model-profile-draft'
import { resolveGenerationParameters } from '../../llm/generation-parameter-policy'
import { OpenAIProvider } from '../../llm/openai-provider'

const servers: Server[] = []

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'saved-openai',
    name: 'Saved OpenAI-compatible profile',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'manual-model',
    apiKey: crypto.randomUUID(),
    baseUrl: '',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
  vi.restoreAllMocks()
})

describe('ModelDiscoveryService', () => {
  it('keeps explicit capacity fields but does not infer context from max_tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { id: 'new-model', context_length: 64000, max_output_tokens: 12000, capabilities: { reasoning: true } },
      { id: 'ambiguous-model', max_tokens: 999999 },
    ] }) })
    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(profile({ baseUrl: 'https://example.test/v1' }))
    expect(result).toMatchObject({ success: true, models: [
      { value: 'new-model', capabilities: { contextWindowTokens: 64000, maxOutputTokens: 12000, reasoning: true } },
      { value: 'ambiguous-model' },
    ] })
    if (!result.success) throw new Error('Expected discovered models')
    expect(result.models[1]).not.toHaveProperty('capabilities')
    const selected = applyModelProfileSelection(profile({ baseUrl: 'https://example.test/v1', maxTokens: 16000 }),
      { modelName: result.models[0].value }, result.models[0].capabilities)
    const post = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) })
    vi.stubGlobal('fetch', post)
    await new OpenAIProvider().generate(selected, [], resolveGenerationParameters(selected, {}))
    const body = JSON.parse(post.mock.calls[0][1].body)
    expect(body.max_tokens).toBe(12000)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('enable_thinking')
  })
  it('discovers OpenAI-compatible models from the current form without leaking its credential', async () => {
    const credential = crypto.randomUUID()
    let requestUrl = ''
    let authorization = ''
    const baseUrl = await listen(createServer((request, response) => {
      requestUrl = request.url ?? ''
      authorization = String(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'gateway/model-a' },
          { id: 'gateway/model-b', name: 'Model B' },
        ],
      }))
    }))
    const saved = profile({ apiKey: credential, baseUrl: `${baseUrl}/v1` })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(requestUrl).toBe('/v1/models')
    expect(requestUrl).not.toContain(credential)
    expect(authorization).toBe(`Bearer ${credential}`)
    expect(result).toEqual({
      success: true,
      models: [
        { id: 'gateway/model-a', name: 'gateway/model-a', value: 'gateway/model-a' },
        { id: 'gateway/model-b', name: 'Model B', value: 'gateway/model-b' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(credential)
  })

  it('uses the current Gemini form and keeps its credential in the request header', async () => {
    const credential = crypto.randomUUID()
    let requestUrl = ''
    let googleApiKey = ''
    let authorization = ''
    const baseUrl = await listen(createServer((request, response) => {
      requestUrl = request.url ?? ''
      googleApiKey = String(request.headers['x-goog-api-key'] ?? '')
      authorization = String(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
          { name: 'models/text-embedding-004' },
        ],
      }))
    }))
    const saved = profile({
      id: 'saved-gemini',
      provider: 'gemini',
      protocol: 'gemini',
      apiKey: credential,
      baseUrl,
    })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(requestUrl).toBe('/v1beta/models')
    expect(requestUrl).not.toContain(credential)
    expect(googleApiKey).toBe(credential)
    expect(authorization).toBe('')
    expect(result).toEqual({
      success: true,
      models: [
        {
          id: 'models/gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          value: 'gemini-2.5-flash',
        },
        {
          id: 'models/text-embedding-004',
          name: 'models/text-embedding-004',
          value: 'text-embedding-004',
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('refuses a cross-origin $protocol redirect without sending a second request', async ({ protocol, provider }) => {
    const credential = crypto.randomUUID()
    let redirectedRequests = 0
    let redirectedRequest = ''
    const targetBaseUrl = await listen(createServer((request, response) => {
      redirectedRequests += 1
      redirectedRequest = JSON.stringify({ url: request.url, headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(protocol === 'gemini' ? { models: [] } : { data: [] }))
    }))
    const sourceBaseUrl = await listen(createServer((_request, response) => {
      response.writeHead(302, { location: `${targetBaseUrl}/redirect-target` })
      response.end()
    }))
    const saved = profile({
      id: `redirect-${protocol}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl: sourceBaseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    expect(redirectedRequests).toBe(0)
    const observableOutput = JSON.stringify({
      result,
      redirectedRequest,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(sourceBaseUrl)
    expect(observableOutput).not.toContain(targetBaseUrl)
  })

  it.each([
    { phase: 'fetch', protocol: 'openai' as const, provider: 'custom' as const },
    { phase: 'body', protocol: 'openai' as const, provider: 'custom' as const },
    { phase: 'fetch', protocol: 'gemini' as const, provider: 'gemini' as const },
    { phase: 'body', protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('times out a stalled $protocol $phase without exposing provider details', async ({ phase, protocol, provider }) => {
    const credential = crypto.randomUUID()
    const providerDetail = `provider-detail-${credential}`
    const baseUrl = 'https://provider.invalid/private-models'
    const saved = profile({
      id: `timeout-${protocol}-${phase}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waitForAbortOrFallback = (signal: AbortSignal | null) => new Promise<void>((resolve, reject) => {
      const fallback = setTimeout(resolve, 100)
      signal?.addEventListener('abort', () => {
        clearTimeout(fallback)
        reject(new Error(providerDetail))
      }, { once: true })
    })
    const payload = protocol === 'gemini'
      ? { models: [{ name: 'models/safe-model' }] }
      : { data: [{ id: 'safe-model' }] }
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal ?? null
      if (phase === 'fetch') await waitForAbortOrFallback(signal)
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (phase === 'body') await waitForAbortOrFallback(signal)
          return payload
        },
      } as Response
    }

    const result = await new ModelDiscoveryService({
      fetchImpl,
      timeoutMs: 25,
    }).discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerDetail)
    expect(observableOutput).not.toContain(baseUrl)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('returns auth without echoing $protocol provider details', async ({ protocol, provider }) => {
    const credential = crypto.randomUUID()
    const providerDetail = `denied-${credential}`
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: providerDetail }))
    }))
    const saved = profile({
      id: `auth-${protocol}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'auth' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerDetail)
    expect(observableOutput).not.toContain(baseUrl)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('classifies a malformed $protocol success response as invalid_response', async ({ protocol, provider }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{not valid json')
    }))
    const saved = profile({
      id: `invalid-${protocol}`,
      provider,
      protocol,
      baseUrl,
    })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'invalid_response' })
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const, status: 404 },
    { protocol: 'openai' as const, provider: 'custom' as const, status: 405 },
    { protocol: 'gemini' as const, provider: 'gemini' as const, status: 404 },
    { protocol: 'gemini' as const, provider: 'gemini' as const, status: 405 },
  ])('classifies $protocol HTTP $status as unsupported', async ({ protocol, provider, status }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' })
      response.end('provider-specific route detail')
    }))
    const saved = profile({ id: `unsupported-${protocol}-${status}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'unsupported' })
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: { data: [] },
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: { models: [] },
    },
  ])('reports an empty $protocol model list without inventing entries', async ({ protocol, provider, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `empty-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'no_models' })
  })

  it('tells a list with no model for this purpose apart from an empty list', async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
      ] }))
    }))
    const saved = profile({ id: 'unsuitable-gemini', provider: 'gemini', protocol: 'gemini', baseUrl, purposes: ['generation'] })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'no_suitable_models' })
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: { data: Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}` })) },
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: { models: Array.from({ length: 501 }, (_, index) => ({ name: `models/model-${index}` })) },
    },
  ])('rejects a $protocol list beyond the 500-entry IPC bound', async ({ protocol, provider, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `oversized-list-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'invalid_response' })
  })

  it.each([
    {
      label: 'OpenAI-compatible ID over 512 UTF-8 bytes',
      protocol: 'openai' as const,
      provider: 'custom' as const,
      invalidText: '模'.repeat(171),
      payload: (invalidText: string) => ({ data: [{ id: 'safe-model' }, { id: invalidText }] }),
    },
    {
      label: 'OpenAI-compatible display name with a control character',
      protocol: 'openai' as const,
      provider: 'custom' as const,
      invalidText: 'unsafe\u0000name',
      payload: (invalidText: string) => ({ data: [{ id: 'safe-model' }, { id: 'other-model', name: invalidText }] }),
    },
    {
      label: 'Gemini ID with a control character',
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      invalidText: 'models/unsafe\u0000model',
      payload: (invalidText: string) => ({ models: [{ name: 'models/safe-model' }, { name: invalidText }] }),
    },
    {
      label: 'Gemini display name over 512 UTF-8 bytes',
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      invalidText: '名'.repeat(171),
      payload: (invalidText: string) => ({ models: [{ name: 'models/safe-model' }, { name: 'models/other-model', displayName: invalidText }] }),
    },
  ])('rejects a single unsafe $label without returning any list entry', async ({ protocol, provider, invalidText, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload(invalidText)))
    }))
    const saved = profile({ id: `unsafe-entry-${protocol}`, provider, protocol, baseUrl })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain(invalidText)
    expect(JSON.stringify(result)).not.toContain('safe-model')
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: {
        data: [
          { id: 'duplicate-model', name: 'First display name' },
          { id: 'duplicate-model', name: 'Second display name' },
          { id: 'other-model' },
        ],
      },
      expected: [
        { id: 'duplicate-model', name: 'First display name', value: 'duplicate-model' },
        { id: 'other-model', name: 'other-model', value: 'other-model' },
      ],
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: {
        models: [
          { name: 'models/duplicate-model', displayName: 'First display name' },
          { name: 'duplicate-model', displayName: 'Second display name' },
          { name: 'models/other-model' },
        ],
      },
      expected: [
        { id: 'models/duplicate-model', name: 'First display name', value: 'duplicate-model' },
        { id: 'models/other-model', name: 'models/other-model', value: 'other-model' },
      ],
    },
  ])('keeps the first $protocol entry for each saved selection value', async ({ protocol, provider, payload, expected }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `deduplicate-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: true, models: expected })
  })

  it('reduces a fetch failure to network without returning the URL, credential, or provider error', async () => {
    const credential = crypto.randomUUID()
    const baseUrl = 'https://provider.invalid/private-path'
    const providerError = `request to ${baseUrl} failed with ${credential}`
    const saved = profile({ apiKey: credential, baseUrl })
    const fetchImpl: typeof fetch = async () => {
      throw new Error(providerError)
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(baseUrl)
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerError)
  })

  describe('按用途筛选端点返回的模型', () => {
    // 节选自 2026-10-24 真实 Gemini models 接口：TTS、图像、转写、音乐与实时模型同样声明 generateContent。
    const geminiCatalog = {
      models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/nano-banana-pro-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-transcribe', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/lyria-3.5', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-2.5-computer-use-preview-10-2025', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/deep-research-preview-04-2026', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/antigravity-preview-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-robotics-er-2-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-pro-preview-customtools', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-native-audio-latest', supportedGenerationMethods: ['countTokens', 'bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
        { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent', 'countTokens'] },
        { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent', 'countTokens'] },
        { name: 'models/gateway-without-methods' },
      ],
    }
    const geminiFetch = () => vi.fn().mockResolvedValue({ ok: true, json: async () => geminiCatalog })
    const values = (result: Awaited<ReturnType<ModelDiscoveryService['discoverModels']>>) =>
      result.success ? result.models.map(model => model.value) : result

    it('生成用途只留下能写作的 generateContent 模型', async () => {
      const result = await new ModelDiscoveryService({ fetchImpl: geminiFetch() }).discoverModels(profile({
        provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', purposes: ['generation'],
      }))
      expect(values(result)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro-preview-customtools', 'gateway-without-methods'])
    })

    it('向量用途只留下 embedContent 模型', async () => {
      const result = await new ModelDiscoveryService({ fetchImpl: geminiFetch() }).discoverModels(profile({
        provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', purposes: ['embedding'],
      }))
      expect(values(result)).toEqual(['gemini-embedding-001', 'gemini-embedding-2', 'gateway-without-methods'])
    })

    it('OpenAI 兼容端点的向量用途把向量模型排在对话模型前面', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
        { id: 'Qwen/Qwen3.8-27B' }, { id: 'BAAI/bge-m3' }, { id: 'deepseek-v4-flash' }, { id: 'Qwen/Qwen3-Embedding-8B' },
      ] }) })
      const service = new ModelDiscoveryService({ fetchImpl })
      const embedding = await service.discoverModels(profile({ baseUrl: 'https://example.test/v1', purposes: ['embedding'] }))
      expect(values(embedding)).toEqual(['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3.8-27B', 'deepseek-v4-flash'])
      const generation = await service.discoverModels(profile({ baseUrl: 'https://example.test/v1', purposes: ['generation'] }))
      expect(values(generation)).toEqual(['Qwen/Qwen3.8-27B', 'BAAI/bge-m3', 'deepseek-v4-flash', 'Qwen/Qwen3-Embedding-8B'])
    })
  })

  it('refuses an endpoint that would place the saved credential in the request URL', async () => {
    const credential = crypto.randomUUID()
    let requestCount = 0
    const baseUrl = await listen(createServer((_request, response) => {
      requestCount += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'must-not-be-returned' }] }))
    }))
    const saved = profile({
      apiKey: credential,
      baseUrl: `${baseUrl}/v1/${encodeURIComponent(credential)}`,
    })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'invalid_response' })
    expect(requestCount).toBe(0)
    expect(JSON.stringify(result)).not.toContain(credential)
  })
})
