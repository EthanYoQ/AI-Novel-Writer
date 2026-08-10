import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../openai-provider'
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

describe('OpenAIProvider NovelAI compatibility', () => {
  it('uses the OpenAI-compatible URL and Bearer token without unsupported JSON response formatting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '正文' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new OpenAIProvider().generate(novelAIModel, [{ role: 'user', content: '写一段正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      thinking: true,
      responseFormat: { type: 'json_object' },
    })).resolves.toMatchObject({ success: true, content: '正文' })

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://text.novelai.net/oa/v1/chat/completions')
    expect(request.headers).toMatchObject({ Authorization: 'Bearer pst-test-token' })

    const body = requestBody(fetchMock)
    expect(body).toMatchObject({ stream: false, enable_thinking: true })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('response_format')
  })

  it('applies the same NovelAI request compatibility to streaming generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => sseReader('data: [DONE]\n') },
    })
    vi.stubGlobal('fetch', fetchMock)

    const onDone = vi.fn()
    await new OpenAIProvider().generateStream(novelAIModel, [{ role: 'user', content: '流式正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      thinking: true,
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
    expect(body).toMatchObject({ stream: true, enable_thinking: true })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('response_format')
    expect(onDone).toHaveBeenCalledWith('', undefined, 'stop')
  })

  it('keeps the existing thinking and JSON response parameters for other OpenAI-compatible providers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '正文' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAIProvider().generate({
      ...novelAIModel,
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
    }, [{ role: 'user', content: '返回 JSON' }], {
      temperature: 0.2,
      maxTokens: 512,
      thinking: true,
      responseFormat: { type: 'json_object' },
    })

    const body = requestBody(fetchMock)
    expect(body).toMatchObject({
      temperature: 0.2,
      thinking: { type: 'enabled' },
      response_format: { type: 'json_object' },
    })
    expect(body).not.toHaveProperty('enable_thinking')
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
      resolveGenerationParameters(fixedTemperatureKimiModel, { maxTokens: 512, thinking: true }),
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
        ...resolveGenerationParameters(fixedTemperatureKimiModel, { maxTokens: 512, thinking: true }),
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
