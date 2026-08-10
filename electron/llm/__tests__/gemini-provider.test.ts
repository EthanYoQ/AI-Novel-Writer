import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiProvider } from '../gemini-provider'
import { resolveGenerationParameters } from '../generation-parameter-policy'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const model: ModelProfile = {
  id: 'gemini-test',
  name: 'Gemini Test',
  provider: 'gemini',
  protocol: 'gemini',
  modelName: 'gemini-2.5-flash',
  apiKey: 'test-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
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

describe('GeminiProvider', () => {
  it('sends the resolved generic profile temperature in both payload forms', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '正文' }] } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
      })
    vi.stubGlobal('fetch', fetchMock)
    const resolved = resolveGenerationParameters(model, { maxTokens: 512 })

    await new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], resolved)
    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      ...resolved,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body)).generationConfig.temperature).toBe(model.temperature)
    }
  })

  it('omits temperature from both payload forms when the resolved policy leaves it undefined', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '正文' }] } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
      })
    vi.stubGlobal('fetch', fetchMock)

    await new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: undefined,
      maxTokens: 512,
    })
    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: undefined,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body)).generationConfig).not.toHaveProperty('temperature')
    }
  })

  it('requests application JSON when the caller requires a JSON object', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await new GeminiProvider().generate(model, [{ role: 'user', content: '返回 JSON' }], {
      temperature: 0.2,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      generationConfig: { responseMimeType: 'application/json' },
    })
  })

  it('requests application JSON for streamed JSON generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
    })
    vi.stubGlobal('fetch', fetchMock)

    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '返回 JSON' }], {
      temperature: 0.2,
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      generationConfig: { responseMimeType: 'application/json' },
    })
  })

  it('maps Gemini MAX_TOKENS to a structured length completion state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '被截断' }] }, finishReason: 'MAX_TOKENS' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })).resolves.toMatchObject({
      success: false,
      content: '被截断',
      finishReason: 'length',
    })
  })

  it('keeps omitted Gemini usage fields unknown instead of inventing zeros', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '完成' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10 },
      }),
    }))

    await expect(new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })).resolves.toMatchObject({
      usage: { promptTokens: 10, completionTokens: null, totalTokens: null },
    })
  })

  it('forwards Gemini stream MAX_TOKENS while treating omitted finishReason as compatible STOP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"candidates":[{"content":{"parts":[{"text":"正文"}]}}]}\n',
          'data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n',
        ),
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()

    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'length')

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => sseReader('data: {"candidates":[{"content":{"parts":[{"text":"完整"}]}}]}\n') },
    })
    const compatibleOnDone = vi.fn()
    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: compatibleOnDone,
      onError: vi.fn(),
    })
    expect(compatibleOnDone).toHaveBeenCalledWith('完整', undefined, 'stop')
  })
})
