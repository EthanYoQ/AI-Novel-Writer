import { afterEach, describe, expect, it, vi } from 'vitest'

import { embedOpenAI, generateEmbeddings } from '../embedding'
import { BUILTIN_PRESETS } from '../../src/shared/provider-presets'

const model = {
  baseUrl: 'https://embedding.example/v1',
  apiKey: 'test-key',
  modelName: 'test-embedding-model',
}

function successfulResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  }
}

function openAIEmbedding(index: number) {
  return { index, embedding: [index + 0.25] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedding batch response contract', () => {
  it('rejects a short first OpenAI batch before a later oversized batch can offset the total', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successfulResponse({
        data: Array.from({ length: 49 }, (_, index) => openAIEmbedding(index)),
      }))
      .mockResolvedValueOnce(successfulResponse({
        data: Array.from({ length: 51 }, (_, index) => openAIEmbedding(index)),
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEmbeddings(
      Array.from({ length: 100 }, (_, index) => `正文-${index}`),
      'openai',
      model,
      50,
    )).rejects.toThrow(/OpenAI Embedding 响应.*数量.*49.*50/)

    // The later 51-item response cannot mask the first batch's missing item.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a Gemini response array whose count differs from its batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      embeddings: [{ values: [0.1] }, { values: [0.2] }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEmbeddings(
      ['第一段', '第二段', '第三段'],
      'gemini',
      model,
      3,
    )).rejects.toThrow(/Gemini Embedding 响应.*数量.*2.*3/)
  })

  it.each([
    {
      name: 'duplicate index',
      data: [openAIEmbedding(0), openAIEmbedding(0), openAIEmbedding(2)],
      expectedError: /index 0 重复/,
    },
    {
      name: 'out-of-range index',
      data: [openAIEmbedding(0), openAIEmbedding(1), openAIEmbedding(3)],
      expectedError: /index 3 超出范围/,
    },
    {
      name: 'missing index',
      data: [openAIEmbedding(0), openAIEmbedding(2)],
      expectedError: /index 覆盖不完整.*1/,
    },
  ])('rejects an OpenAI batch with $name before returning any vectors', async ({ data, expectedError }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ data })))

    await expect(embedOpenAI(['第一段', '第二段', '第三段'], model)).rejects.toThrow(expectedError)
  })

  it('keeps valid unordered OpenAI responses aligned to their input indexes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
    })))

    await expect(embedOpenAI(['第一段', '第二段'], model)).resolves.toEqual([
      [0.1],
      [0.2],
    ])
  })
})

describe('OpenAI embedding endpoint construction', () => {
  it.each([
    ['a complete endpoint', 'https://embedding.example/v1/embeddings', 'https://embedding.example/v1/embeddings'],
    ['a v1 base', 'https://embedding.example/v1', 'https://embedding.example/v1/embeddings'],
    ['a versioned compatible base', 'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/embeddings'],
    ['the OpenAI root', 'https://api.openai.com', 'https://api.openai.com/v1/embeddings'],
    ['the Ollama root', 'http://localhost:11434', 'http://localhost:11434/v1/embeddings'],
  ])('uses the expected endpoint for %s', async (_name, baseUrl, expectedUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl })

    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl)
  })

  it('keeps the Ollama preset aligned with the OpenAI-compatible embedding endpoint', async () => {
    const ollamaPreset = BUILTIN_PRESETS.find((preset) => preset.provider === 'ollama')
    expect(ollamaPreset?.baseUrl).toBe('http://localhost:11434/v1')

    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl: ollamaPreset!.baseUrl })

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings')
  })

  it('does not infer a v1 path for a user-configured /api base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({
      data: [openAIEmbedding(0)],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await embedOpenAI(['第一段'], { ...model, baseUrl: 'https://gateway.example/api' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/api/embeddings')
  })
})
