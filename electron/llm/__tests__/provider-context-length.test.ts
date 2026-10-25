import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { GeminiProvider } from '../gemini-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

// 2026-10-25 实测的错误体，只删掉了 request_id。DeepSeek 官方 deepseek-v4-flash 发约 120 万 token；
// 硅基流动 Qwen/Qwen2.5-7B-Instruct（32K 上下文）发约 15.5 万 token。流式与非流式返回相同。
const DEEPSEEK_400 = '{"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1200051 tokens (1200035 in the messages, 16 in the completion). Please reduce the length of the messages or completion. (request_id: <redacted>)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'
const SILICONFLOW_400 = '{"code":20015,"message":"number of input tokens (155525) has exceeded max_seq_len (32768) limit.","data":null}'
// 没有 Gemini key，未实测；文本取自 Gemini API 对超长输入的公开报错形状。
const GEMINI_400 = '{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}'
const UNRELATED_400 = '{"error":{"message":"Invalid model name","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'

const openai: ModelProfile = { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'sk-synthetic', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 65_536, purposes: ['generation'] }
const gemini: ModelProfile = { ...openai, id: 'gemini', name: 'Gemini', provider: 'gemini', protocol: 'gemini', modelName: 'gemini-3.5-flash',
  baseUrl: 'https://generativelanguage.googleapis.com' }

afterEach(() => { vi.unstubAllGlobals() })

async function streamError(model: ModelProfile, status: number, body: string): Promise<string | undefined> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': 'application/json' } })))
  const onError = vi.fn()
  const provider = model.protocol === 'gemini' ? new GeminiProvider() : new OpenAIProvider()
  await provider.generateStream(model, [{ role: 'user', content: '写正文' }], { temperature: 0.7, maxTokens: 512,
    signal: new AbortController().signal, visibleOnly: true, onChunk: vi.fn(), onDone: vi.fn(), onError })
  return onError.mock.calls[0]?.[0]
}

describe('服务商返回上下文超长时，流式请求报 LLM_CONTEXT_LENGTH_EXCEEDED', () => {
  it.each([
    ['DeepSeek 官方', openai, DEEPSEEK_400],
    ['硅基流动', { ...openai, provider: 'siliconflow' as const, baseUrl: 'https://api.siliconflow.cn/v1' }, SILICONFLOW_400],
    ['Gemini', gemini, GEMINI_400],
  ])('%s 的 400 错误体', async (_name, model, body) => {
    expect(await streamError(model, 400, body)).toBe('LLM_CONTEXT_LENGTH_EXCEEDED')
  })

  it.each([
    ['与长度无关的 400', 400, UNRELATED_400],
    ['服务端 503', 503, 'upstream unavailable'],
  ])('%s 仍报 LLM_REQUEST_FAILED', async (_name, status, body) => {
    expect(await streamError(openai, status, body)).toBe('LLM_REQUEST_FAILED')
    expect(await streamError(gemini, status, body)).toBe('LLM_REQUEST_FAILED')
  })
})
