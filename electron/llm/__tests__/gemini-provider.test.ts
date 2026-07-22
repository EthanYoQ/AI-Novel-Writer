import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiProvider } from '../gemini-provider'
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GeminiProvider', () => {
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
})
