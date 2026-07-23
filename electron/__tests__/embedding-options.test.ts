import { afterEach, describe, expect, it, vi } from 'vitest'

import { chunkText, generateEmbeddings } from '../embedding'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedding request controls', () => {
  it('keeps every chunk within the requested character limit, including one very long sentence', () => {
    const chunks = chunkText('春'.repeat(721), 200, 20)

    expect(chunks).toHaveLength(4)
    expect(chunks.every(chunk => chunk.length <= 200)).toBe(true)
  })

  it('uses the configured batch size for OpenAI-compatible embedding requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await generateEmbeddings(
      ['一', '二', '三', '四', '五'],
      'openai',
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local', modelName: 'bge-small-zh' },
      2,
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).input).toEqual(['一', '二'])
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).input).toEqual(['五'])
  })
})
