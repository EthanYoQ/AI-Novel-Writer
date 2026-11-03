import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { GeminiProvider } from '../gemini-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import samples from './provider-context-length-samples.json'

// DeepSeek 与硅基流动 2026-10-25 实测返回的错误体（删去 request_id）；流式与非流式相同。
// Gemini 没有 key，未实测；取自 Gemini API 对超长输入的公开报错形状。
const DEEPSEEK_400 = JSON.stringify(samples.deepseek)
const SILICONFLOW_400 = JSON.stringify(samples.siliconflow)
// 同一个 32K 模型、短提示词、max_tokens 65,536（2026-10-26 实测）。
const SILICONFLOW_MAX_TOKENS_400 = JSON.stringify(samples.siliconflowMaxTokens)
const GEMINI_400 = JSON.stringify(samples.gemini)
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
    ['硅基流动（最大输出超过上下文）', { ...openai, provider: 'siliconflow' as const, baseUrl: 'https://api.siliconflow.cn/v1' }, SILICONFLOW_MAX_TOKENS_400],
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

  it('不是 400 时不读错误体，直接取消', async () => {
    const text = vi.fn(async () => 'never read'), cancel = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text, body: { cancel } }))
    const onError = vi.fn()
    await new OpenAIProvider().generateStream(openai, [{ role: 'user', content: '写正文' }], { temperature: 0.7, maxTokens: 512,
      signal: new AbortController().signal, visibleOnly: true, onChunk: vi.fn(), onDone: vi.fn(), onError })
    expect(onError.mock.calls[0]?.[0]).toBe('LLM_REQUEST_FAILED')
    expect(text).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalled()
  })
})

it('读错误体时被取消，按取消报告', async () => {
  const controller = new AbortController()
  const text = vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError') })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text, body: { cancel: vi.fn(async () => {}) } }))
  const onError = vi.fn()
  await new OpenAIProvider().generateStream(openai, [{ role: 'user', content: '写正文' }], { temperature: 0.7, maxTokens: 512,
    signal: controller.signal, visibleOnly: true, onChunk: vi.fn(), onDone: vi.fn(), onError })
  expect(onError.mock.calls[0]?.[0]).toBe('LLM_CANCELLED')
})
