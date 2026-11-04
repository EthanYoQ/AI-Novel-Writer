import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProvider, MAX_STREAM_EVENT_CHARS, resolveAnthropicMessagesUrl } from '../anthropic-provider'
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

function sseReader(...messages: Array<string | Uint8Array>) {
  const encoder = new TextEncoder()
  const reads: Array<{ done: boolean; value?: Uint8Array }> = messages.map(message => ({
    done: false,
    value: typeof message === 'string' ? encoder.encode(message) : message,
  }))
  reads.push({ done: true, value: undefined })
  return { read: vi.fn(async () => reads.shift()) }
}

function anthropicEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

/** 当前 TS lib 的 Uint8Array.indexOf 不接受字节数组参数，这里手写一个朴素字节查找。 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
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

  it('parses events split across reads, including inside data lines, between CR and LF, and inside UTF-8 characters', async () => {
    // 第一个事件用 CRLF 行终止符，正文里带多字节 UTF-8 字符，专门打解析边界。
    const full = [
      'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\r\n\r\n',
      anthropicEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '正文' } }),
      anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      anthropicEvent('message_stop'),
    ].join('')
    const encoder = new TextEncoder()
    const bytes = encoder.encode(full)
    // 切点一：第一处 \r 与 \n 之间。
    const cutCr = indexOfBytes(bytes, encoder.encode('\r\n')) + 1
    // 切点二：「正」的 UTF-8 字节中间（E6 AD A3 的第二个字节后）。
    const cutText = indexOfBytes(bytes, encoder.encode('"text":"正')) + '"text":"\u6b63'.length + 1
    // 切点三：其后 message_delta 的 data 行 JSON 中间。
    const cutLine = indexOfBytes(bytes, encoder.encode('"stop_reason'), cutText) + 3
    const chunks = [bytes.slice(0, cutCr), bytes.slice(cutCr, cutText), bytes.slice(cutText, cutLine), bytes.slice(cutLine)]
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true)
    expect(chunks.every(chunk => chunk.length > 0)).toBe(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(...chunks) } }))

    const onChunk = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk, onDone, onError,
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onChunk.mock.calls.map(call => call[0]).join('')).toBe('正文')
    expect(onDone).toHaveBeenCalledWith('正文', { promptTokens: 11, completionTokens: 9, totalTokens: 20 }, 'stop')
  })

  it('terminates as an invalid stream when a single line grows beyond the retention bound', async () => {
    // 一条不换行、超过上限的 data 行：解析器必须按无效流终止，而不是继续累积。
    const oversized = `data: ${'x'.repeat(MAX_STREAM_EVENT_CHARS + 1)}\n\n`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => sseReader(oversized.slice(0, 2_000_000), oversized.slice(2_000_000)) },
    }))

    const onError = vi.fn()
    const onDone = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk: vi.fn(), onDone, onError,
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('LLM_STREAM_INVALID', undefined, undefined)
  })

  it('counts the line breaks between data lines toward the event bound', async () => {
    // 合并后的事件 = 各 data 行 + 行间换行；空 data 行不占字符，却同样让事件变大、数组变长。
    const lines = [`data: ${'x'.repeat(MAX_STREAM_EVENT_CHARS - 10)}`, ...Array.from({ length: 20 }, () => 'data:')]
    const stream = `${lines.join('\n')}\n\n${anthropicEvent('message_stop')}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => sseReader(stream) } }))

    const onError = vi.fn()
    const onDone = vi.fn()
    await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 1024, signal: new AbortController().signal,
      onChunk: vi.fn(), onDone, onError,
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('LLM_STREAM_INVALID', undefined, undefined)
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
