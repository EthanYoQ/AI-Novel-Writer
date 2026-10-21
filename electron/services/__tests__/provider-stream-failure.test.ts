import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiProvider } from '../../llm/gemini-provider'
import { OpenAIProvider } from '../../llm/openai-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { providerStreamFailureCode } from '../main-generation-owner'

const openAIModel: ModelProfile = {
  id: 'openai-test', name: 'OpenAI Test', provider: 'custom', protocol: 'openai', modelName: 'test-model',
  apiKey: 'test-key', baseUrl: 'https://api.example.com/v1', temperature: 0.7, maxTokens: 512, purposes: ['generation'],
}
const geminiModel: ModelProfile = { ...openAIModel, id: 'gemini-test', provider: 'gemini', protocol: 'gemini', baseUrl: 'https://gemini.example.com' }

function streamBody(...chunks: string[]) {
  const encoder = new TextEncoder()
  const reads = chunks.map(chunk => ({ done: false, value: encoder.encode(chunk) }))
  return { getReader: () => ({
    read: vi.fn(async () => reads.shift() ?? { done: true, value: undefined }),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  }) }
}

/** 用真实 provider 跑一次流式请求，把它交出的报错按主进程生成的分类判一次。 */
async function classify(provider: OpenAIProvider | GeminiProvider, model: ModelProfile, response: unknown): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  const onError = vi.fn()
  await provider.generateStream(model, [{ role: 'user', content: 'write' }], {
    temperature: 0, maxTokens: 64, signal: new AbortController().signal, visibleOnly: true,
    onChunk: vi.fn(), onDone: vi.fn(), onError,
  })
  expect(onError).toHaveBeenCalledOnce()
  return providerStreamFailureCode(String(onError.mock.calls[0]![0]))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// main-generation-owner 曾按「无法读取响应流」「完成标记前结束」的中文原文判断网络失败（#474 B6），provider 改交码后仍要分对。
describe('main generation provider failure classification', () => {
  it('treats a missing response body as a network failure', async () => {
    await expect(classify(new OpenAIProvider(), openAIModel, { ok: true, status: 200, body: null })).resolves.toBe('NETWORK_ERROR')
    await expect(classify(new GeminiProvider(), geminiModel, { ok: true, status: 200, body: null })).resolves.toBe('NETWORK_ERROR')
  })

  it('treats a stream that ends before the completion marker as a network failure', async () => {
    const body = streamBody('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n')
    await expect(classify(new OpenAIProvider(), openAIModel, { ok: true, status: 200, body })).resolves.toBe('NETWORK_ERROR')
  })

  it('treats a damaged stream as a provider failure', async () => {
    const body = streamBody('data: {not json}\n\n')
    await expect(classify(new OpenAIProvider(), openAIModel, { ok: true, status: 200, body })).resolves.toBe('GENERATION_PROVIDER_FAILED')
  })

  it('treats an HTTP error as a provider failure', async () => {
    const response = { ok: false, status: 500, body: streamBody() }
    await expect(classify(new OpenAIProvider(), openAIModel, response)).resolves.toBe('GENERATION_PROVIDER_FAILED')
    await expect(classify(new GeminiProvider(), geminiModel, { ...response, text: async () => 'boom' })).resolves.toBe('GENERATION_PROVIDER_FAILED')
  })

  it('keeps raw transport errors from the network stack as network failures', () => {
    expect(providerStreamFailureCode('TypeError: fetch failed')).toBe('NETWORK_ERROR')
    expect(providerStreamFailureCode('Error: read ECONNRESET')).toBe('NETWORK_ERROR')
  })
})
