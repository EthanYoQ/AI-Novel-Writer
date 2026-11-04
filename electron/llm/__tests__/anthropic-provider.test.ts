import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProvider, resolveAnthropicMessagesUrl } from '../anthropic-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const model: ModelProfile = {
  id: 'anthropic-test',
  name: 'Anthropic Test',
  provider: 'bigmodel-anthropic',
  protocol: 'anthropic',
  modelName: 'glm-4.6',
  apiKey: 'test-key',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
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

function anthropicEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveAnthropicMessagesUrl', () => {
  it.each([
    ['https://open.bigmodel.cn/api/anthropic', 'https://open.bigmodel.cn/api/anthropic/v1/messages'],
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1/', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'],
    ['https://proxy.example/anthropic/messages', 'https://proxy.example/anthropic/v1/messages'],
  ])('builds the Messages URL from %s', (baseUrl, expected) => {
    expect(resolveAnthropicMessagesUrl(baseUrl)).toBe(expected)
  })
})

describe('AnthropicProvider', () => {
  it('sends system messages separately, merges consecutive turns, and maps usage', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '正文' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await new AnthropicProvider().generate(model, [
      { role: 'system', content: '你是小说作者' },
      { role: 'user', content: '第一段' },
      { role: 'user', content: '第二段' },
      { role: 'assistant', content: '前情' },
      { role: 'user', content: '写正文' },
    ], { temperature: 0.7, maxTokens: 1024 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(request.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({
      model: 'glm-4.6',
      max_tokens: 1024,
      temperature: 0.7,
      system: '你是小说作者',
      messages: [
        { role: 'user', content: '第一段\n\n第二段' },
        { role: 'assistant', content: '前情' },
        { role: 'user', content: '写正文' },
      ],
    })
    expect(response).toEqual({
      success: true,
      content: '正文',
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
    })
  })

  it('reports max_tokens stop as an incomplete response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '被截断的正文' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    }))

    const response = await new AnthropicProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024,
    })
    expect(response).toMatchObject({ success: false, finishReason: 'length', error: 'LLM_RESPONSE_INCOMPLETE', content: '被截断的正文' })
  })

  it('keeps the HTTP failure body for the connection test message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    }))

    const response = await new AnthropicProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024,
    })
    expect(response).toMatchObject({ success: false, finishReason: 'error', error: 'LLM_REQUEST_FAILED',
      httpFailure: { status: 401 } })
  })

  it('streams visible text, thinking, and usage evidence until message_stop', async () => {
    const events = [
      anthropicEvent('message_start', { message: { usage: { input_tokens: 15, output_tokens: 1 } } }),
      anthropicEvent('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
      anthropicEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '构思中' } }),
      anthropicEvent('content_block_stop', { index: 0 }),
      anthropicEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '正文' } }),
      anthropicEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '继续' } }),
      anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
      anthropicEvent('message_stop'),
    ].join('')
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(events) } })
    vi.stubGlobal('fetch', fetchMock)

    const onChunk = vi.fn()
    const onReasoning = vi.fn()
    const onUsageEvidence = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk, onReasoning, onUsageEvidence, onDone, onError,
    })

    expect(onError).not.toHaveBeenCalled()
    const streamed = onChunk.mock.calls.map(call => call[0]).join('')
    expect(streamed).toBe('<think>\n构思中\n</think>\n\n正文继续')
    expect(onReasoning).not.toHaveBeenCalled()
    expect(onUsageEvidence).toHaveBeenCalledWith(expect.objectContaining({
      usage: { promptTokens: 15, completionTokens: 42, totalTokens: 57 },
      accounting: 'included-in-completion', protocol: 'anthropic',
    }))
    expect(onDone).toHaveBeenCalledWith('正文继续', { promptTokens: 15, completionTokens: 42, totalTokens: 57 }, 'stop')
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.stream).toBe(true)
  })

  it('delivers only visible content when the durable owner requires visibleOnly', async () => {
    const events = [
      anthropicEvent('message_start', { message: { usage: { input_tokens: 15, output_tokens: 1 } } }),
      anthropicEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '构思中' } }),
      anthropicEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '正文' } }),
      anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
      anthropicEvent('message_stop'),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(events) } }))

    const onChunk = vi.fn()
    const onReasoning = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal, visibleOnly: true,
      onChunk, onReasoning, onDone, onError,
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onChunk.mock.calls.map(call => call[0]).join('')).toBe('正文')
    expect(onReasoning).toHaveBeenCalledWith('构思中')
    expect(onDone).toHaveBeenCalledWith('正文', expect.anything(), 'stop')
  })

  it('fails with the provider error code when the stream emits an error event', async () => {
    const events = [
      anthropicEvent('message_start', { message: { usage: { input_tokens: 15, output_tokens: 1 } } }),
      anthropicEvent('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(events) } }))

    const onError = vi.fn()
    const onDone = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk: vi.fn(), onDone, onError,
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('LLM_STREAM_PROVIDER_ERROR', undefined, expect.anything())
  })

  it('reports an incomplete stream when message_stop never arrives', async () => {
    const events = [
      anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '正文' } }),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(events) } }))

    const onError = vi.fn()
    const onDone = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk: vi.fn(), onDone, onError,
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('LLM_STREAM_INCOMPLETE', '正文', undefined)
  })

  it('maps the documented prompt-too-long failure to the context-length code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200005 tokens > 200000 maximum"}}',
    }))

    const onError = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk: vi.fn(), onDone: vi.fn(), onError,
    })
    expect(onError).toHaveBeenCalledWith('LLM_CONTEXT_LENGTH_EXCEEDED', undefined, undefined)
  })

  it('omits temperature when the policy resolves it to undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '正文' }], stop_reason: 'end_turn' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await new AnthropicProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: undefined, maxTokens: 2048,
    })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).not.toHaveProperty('temperature')
    expect(body.max_tokens).toBe(2048)
  })
})
