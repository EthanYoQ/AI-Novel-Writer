import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../openai-provider'
import { resolveOpenAIChatCompletionsUrl } from '../openai-compatible-endpoint'
import { resolveGenerationParameters } from '../generation-parameter-policy'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const novelAIModel: ModelProfile = {
  id: 'novelai-test',
  name: 'NovelAI Test',
  provider: 'novelai',
  protocol: 'openai',
  modelName: 'novelai-model',
  apiKey: 'pst-test-token',
  baseUrl: 'https://text.novelai.net/oa',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
}

const fixedTemperatureKimiModel: ModelProfile = {
  ...novelAIModel,
  id: 'kimi-k3',
  name: 'Kimi K3',
  provider: 'custom',
  modelName: 'kimi-k3',
  baseUrl: 'https://api.moonshot.cn/v1',
  temperature: 0.7,
}

const legacyDeepSeekV4Model: ModelProfile = {
  ...novelAIModel,
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  modelName: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  capabilities: {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    reasoning: false,
    structuredOutput: true,
    usage: true,
  },
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const request = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(String(request.body)) as Record<string, unknown>
}

function sseReader(...messages: string[]) {
  const encoder = new TextEncoder()
  const reads: Array<{ done: boolean; value?: Uint8Array }> = messages.map(message => ({
    done: false,
    value: encoder.encode(message),
  }))
  reads.push({ done: true, value: undefined })
  return { read: vi.fn(async () => reads.shift()) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveOpenAIChatCompletionsUrl', () => {
  it.each([
    ['domain root', 'https://api.openai.com', 'https://api.openai.com/v1/chat/completions'],
    ['full chat path', 'https://gateway.example/api/v4/chat', 'https://gateway.example/api/v4/chat/completions'],
    ['full endpoint', 'https://gateway.example/api/v4/chat/completions', 'https://gateway.example/api/v4/chat/completions'],
    ['v1 prefix', 'https://gateway.example/v1', 'https://gateway.example/v1/chat/completions'],
    ['v3 prefix', 'https://gateway.example/api/plan/v3', 'https://gateway.example/api/plan/v3/chat/completions'],
    ['v4 prefix', 'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['arbitrary versioned prefix', 'https://gateway.example/tenant/openai/v27', 'https://gateway.example/tenant/openai/v27/chat/completions'],
    ['generic path prefix', 'https://gateway.example/tenant/openai', 'https://gateway.example/tenant/openai/chat/completions'],
    ['trailing slashes', 'https://gateway.example/api/plan/v3///', 'https://gateway.example/api/plan/v3/chat/completions'],
  ])('resolves the %s without replacing its configured prefix', (_case, baseUrl, expectedUrl) => {
    expect(resolveOpenAIChatCompletionsUrl(baseUrl, 'custom')).toBe(expectedUrl)
  })
})

describe('OpenAIProvider NovelAI compatibility', () => {
  it('preserves an explicitly configured endpoint prefix for normal and streaming generation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => sseReader('data: [DONE]\n') },
      })
    vi.stubGlobal('fetch', fetchMock)
    const model = {
      ...novelAIModel,
      provider: 'custom' as const,
      baseUrl: 'https://gateway.example/tenant/openai',
    }

    await new OpenAIProvider().generate(model, [{ role: 'user', content: '普通正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })
    await new OpenAIProvider().generateStream(model, [{ role: 'user', content: '流式正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/tenant/openai/chat/completions',
      'https://gateway.example/tenant/openai/chat/completions',
    ])
  })

  it('uses the OpenAI-compatible URL and Bearer token without unsupported JSON response formatting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new OpenAIProvider().generate(novelAIModel, [{ role: 'user', content: '写一段正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })).resolves.toMatchObject({ success: true, content: '正文', finishReason: 'stop' })

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://text.novelai.net/oa/v1/chat/completions')
    expect(request.headers).toMatchObject({ Authorization: 'Bearer pst-test-token' })

    const body = requestBody(fetchMock)
    expect(body).toMatchObject({ stream: false })
    expect(body).not.toHaveProperty('enable_thinking')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('response_format')
  })

  it('applies the same NovelAI request compatibility to streaming generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
          'data: [DONE]\n',
        ),
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    const onDone = vi.fn()
    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '流式正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://text.novelai.net/oa/v1/chat/completions')
    expect(request.headers).toMatchObject({ Authorization: 'Bearer pst-test-token' })

    const body = requestBody(fetchMock)
    expect(body).toMatchObject({ stream: true })
    expect(body).not.toHaveProperty('enable_thinking')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('response_format')
    expect(onDone).toHaveBeenCalledWith('', undefined, 'stop')
  })

  it('applies the same verified reasoning effort to normal and streaming xAI requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '正文' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => sseReader('data: [DONE]\n') },
      })
    vi.stubGlobal('fetch', fetchMock)

    const xaiModel: ModelProfile = {
      ...novelAIModel,
      provider: 'xai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      reasoningOverride: 'high',
    }
    const resolved = resolveGenerationParameters(xaiModel, {
      maxTokens: 512,
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })
    await new OpenAIProvider().generate(xaiModel, [{ role: 'user', content: '返回正文' }], resolved)
    await new OpenAIProvider().generateStream(xaiModel, [{ role: 'user', content: '返回正文' }], {
      ...resolved,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body)).reasoning_effort).toBe('high')
    }
  })

  it('disables DeepSeek V4 default thinking for fluent drafts in normal and streaming requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => sseReader('data: [DONE]\n') },
      })
    vi.stubGlobal('fetch', fetchMock)

    const resolved = resolveGenerationParameters(legacyDeepSeekV4Model, {
      maxTokens: 512,
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })
    await new OpenAIProvider().generate(
      legacyDeepSeekV4Model,
      [{ role: 'user', content: '返回正文' }],
      resolved,
    )
    await new OpenAIProvider().generateStream(
      legacyDeepSeekV4Model,
      [{ role: 'user', content: '返回正文' }],
      {
        ...resolved,
        signal: new AbortController().signal,
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    )

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body).not.toHaveProperty('reasoning_effort')
    }
  })

  it('maps auto DeepSeek V4 drafts to enabled high effort in normal and streaming requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => sseReader('data: [DONE]\n') },
      })
    vi.stubGlobal('fetch', fetchMock)

    const resolved = resolveGenerationParameters(legacyDeepSeekV4Model, {
      maxTokens: 512,
      creativeStrategy: 'auto',
      reasoningStage: 'drafting',
    })
    await new OpenAIProvider().generate(
      legacyDeepSeekV4Model,
      [{ role: 'user', content: '返回正文' }],
      resolved,
    )
    await new OpenAIProvider().generateStream(
      legacyDeepSeekV4Model,
      [{ role: 'user', content: '返回正文' }],
      {
        ...resolved,
        signal: new AbortController().signal,
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    )

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body))).toMatchObject({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      })
    }
  })

  it('omits Kimi K3 fixed sampling and generic thinking fields for non-stream generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '正文' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAIProvider().generate(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: '写正文' }],
      resolveGenerationParameters(fixedTemperatureKimiModel, { maxTokens: 512 }),
    )

    const body = requestBody(fetchMock)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
  })

  it('omits Kimi K3 fixed sampling and generic thinking fields for stream generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => sseReader('data: [DONE]\n') },
    })
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAIProvider().generateStream(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: '写正文' }],
      {
        ...resolveGenerationParameters(fixedTemperatureKimiModel, { maxTokens: 512 }),
        signal: new AbortController().signal,
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    )

    const body = requestBody(fetchMock)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
  })

  it('preserves an explicit non-stream length finish reason for downstream rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '被截断的正文' }, finish_reason: 'length' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new OpenAIProvider().generate(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })).resolves.toMatchObject({
      success: false,
      content: '被截断的正文',
      finishReason: 'length',
    })
  })

  it('does not treat an HTTP response without finish_reason as a completed generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '传输已结束但完成原因未知' } }] }),
    }))

    await expect(new OpenAIProvider().generate(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })).resolves.toMatchObject({
      success: false,
      content: '传输已结束但完成原因未知',
      finishReason: 'unknown',
    })
  })

  it('forwards an explicit stream length finish reason instead of reporting a complete response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"choices":[{"delta":{"content":"被截断"},"finish_reason":"length"}]}\n',
          'data: [DONE]\n',
        ),
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    const onError = vi.fn()

    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError,
    })

    expect(onDone).toHaveBeenCalledWith('被截断', undefined, 'length')
    expect(onError).not.toHaveBeenCalled()
  })

  it('preserves an explicit unrecognized stream finish reason as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"provider_custom"}]}\n',
          'data: [DONE]\n',
        ),
      },
    }))
    const onDone = vi.fn()
    const onError = vi.fn()

    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError,
    })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'unknown')
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([
    ['sensitive', 'content_filter'],
    ['model_context_window_exceeded', 'length'],
    ['network_error', 'error'],
    ['tool_calls', 'unknown'],
  ] as const)('maps Z.ai stream finish_reason %s to provider-neutral %s', async (providerReason, expectedReason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          `data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"${providerReason}"}]}\n`,
          'data: [DONE]\n',
        ),
      },
    }))
    const onDone = vi.fn()
    const onError = vi.fn()

    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError,
    })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, expectedReason)
    expect(onError).not.toHaveBeenCalled()
  })

  it('treats [DONE] without finish_reason as unknown model completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"choices":[{"delta":{"content":"正文"}}]}\n',
          'data: [DONE]\n',
        ),
      },
    }))
    const onDone = vi.fn()

    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'unknown')
  })

  it('requests and forwards the final OpenAI stream usage metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":21,"total_tokens":34}}\n',
          'data: [DONE]\n',
        ),
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()

    await new OpenAIProvider().generateStream({
      ...novelAIModel,
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
    }, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    expect(requestBody(fetchMock)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(onDone).toHaveBeenCalledWith('正文', {
      promptTokens: 13,
      completionTokens: 21,
      totalTokens: 34,
    }, 'stop')
  })

  it('rejects an OpenAI stream that ends before [DONE], even if text was received', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader('data: {"choices":[{"delta":{"content":"半句"}}]}\n'),
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    const onError = vi.fn()

    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError,
    })

    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('完成标记前结束'))
  })
})
