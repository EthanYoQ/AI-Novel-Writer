import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiProvider } from '../gemini-provider'
import { resolveGenerationParameters } from '../generation-parameter-policy'
import { settleProviderUsage } from '../../services/generation-run-service'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'

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

const reasoningModel: ModelProfile = {
  ...model,
  modelName: 'gemini-2.5-flash-lite',
  maxTokens: 65_536,
  reasoningOverride: 'high',
  reasoningMapping: { adapter: 'gemini-thinking-budget', supportedEfforts: ['off', 'high'], providerValues: { off: 0, high: 24_576 } },
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
  vi.restoreAllMocks()
})

describe('GeminiProvider', () => {
  it('applies the same verified thinking budget to normal and streaming requests', async () => {
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
    const resolved = resolveGenerationParameters(reasoningModel, {
      maxTokens: 512,
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })

    await new GeminiProvider().generate(reasoningModel, [{ role: 'user', content: '写正文' }], resolved)
    await new GeminiProvider().generateStream(reasoningModel, [{ role: 'user', content: '写正文' }], {
      ...resolved,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body)).generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 24_576,
      })
    }
  })
  it.each([
    { modelName: 'gemini-3.5-flash-lite', strategy: 'fluent-drafting' as const, stage: 'drafting' as const, thinkingLevel: 'minimal' },
    { modelName: 'gemini-3.8-flash', strategy: 'deep-planning' as const, stage: 'review' as const, thinkingLevel: 'high' },
  ])('sends Gemini 3 thinkingLevel $thinkingLevel for $modelName in normal and streaming requests', async ({ modelName, strategy, stage, thinkingLevel }) => {
    const gemini3: ModelProfile = { ...model, provider: 'gemini', modelName, baseUrl: 'https://generativelanguage.googleapis.com', maxTokens: 65_536 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '正文' }] }, finishReason: 'STOP' }] }) })
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) } })
    vi.stubGlobal('fetch', fetchMock)
    const resolved = resolveGenerationParameters(gemini3, { maxTokens: 512, creativeStrategy: strategy, reasoningStage: stage })

    await new GeminiProvider().generate(gemini3, [{ role: 'user', content: '写正文' }], resolved)
    await new GeminiProvider().generateStream(gemini3, [{ role: 'user', content: '写正文' }], {
      ...resolved, signal: new AbortController().signal, onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, request] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(request.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel })
    }
  })

  it('lets the caller cancel a non-streaming request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new GeminiProvider().generate(model, [{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 16, signal: controller.signal })
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal)
  })

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

  it('does not treat a Gemini HTTP response without finishReason as a completed generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '传输已结束但完成原因未知' }] } }],
      }),
    }))

    await expect(new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
    })).resolves.toMatchObject({
      success: false,
      content: '传输已结束但完成原因未知',
      finishReason: 'unknown',
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
      success: true,
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: null, totalTokens: null },
    })
  })

  it('forwards an explicit Gemini stream STOP as completed evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader(
          'data: {"candidates":[{"content":{"parts":[{"text":"正文"}]},"finishReason":"STOP"}]}\n',
        ),
      },
    }))
    const onDone = vi.fn()

    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'stop')
  })

  it('forwards Gemini stream MAX_TOKENS as a length completion', async () => {
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
  })

  it('reports unknown when a Gemini stream ends without a final finishReason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => sseReader('data: {"candidates":[{"content":{"parts":[{"text":"完整"}]}}]}\n') },
    }))
    const onDone = vi.fn()

    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2,
      maxTokens: 512,
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      onDone,
      onError: vi.fn(),
    })

    expect(onDone).toHaveBeenCalledWith('完整', undefined, 'unknown')
  })
})

// Gemini 流式要和 OpenAI 一样经 onDiagnostics 上报 HTTP 状态、阶段与结束原因（#484）。
describe('Gemini stream transport diagnostics', () => {
  async function stream(response: unknown, signal = new AbortController().signal) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const snapshots: GenerationTransportDiagnostics[] = [], onDone = vi.fn(), onError = vi.fn()
    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2, maxTokens: 512, signal, visibleOnly: true,
      onChunk: vi.fn(), onDone, onError, onReasoning: vi.fn(), onDiagnostics: value => snapshots.push(value),
    })
    return { snapshots, onDone, onError }
  }

  it('reports status, timing, output events and completion for a finished stream', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const reader = sseReader(
      'data: {"candidates":[{"content":{"parts":[{"text":"先想","thought":true}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"正文"}]},"finishReason":"STOP"}]}\n',
    )
    const read = reader.read
    reader.read = vi.fn(async () => { clock += 1000; return read() })
    const { snapshots, onDone } = await stream({ ok: true, status: 200, body: { getReader: () => reader } })

    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'stop')
    expect(snapshots[0]).toMatchObject({ phase: 'request', elapsedMs: 0 })
    expect(snapshots.at(-1)).toEqual({ startedAt: expect.any(Number), elapsedMs: 3000, firstResponseMs: 1000, lastResponseMs: 2000,
      lastOutputMs: 2000, httpStatus: 200, phase: 'complete', endReason: 'completed', visibleEvents: 1, reasoningEvents: 1 })
  })

  it('reports an HTTP failure with its status', async () => {
    const { snapshots, onError } = await stream({ ok: false, status: 503, body: { cancel: async () => {} } })
    expect(onError).toHaveBeenCalledWith('LLM_REQUEST_FAILED')
    expect(snapshots.at(-1)).toMatchObject({ httpStatus: 503, phase: 'response', endReason: 'failed', errorCode: 'HTTP_ERROR' })
  })

  it('reports a missing response body', async () => {
    const { snapshots } = await stream({ ok: true, status: 200, body: null })
    expect(snapshots.at(-1)).toMatchObject({ httpStatus: 200, endReason: 'failed', errorCode: 'RESPONSE_BODY_MISSING' })
  })

  it('keeps only the safe cause code when reading the stream fails', async () => {
    const reader = { read: vi.fn(async () => {
      throw new TypeError('private URL and credentials', { cause: Object.assign(new Error('private raw cause'), { code: 'UND_ERR_SOCKET' }) })
    }) }
    const { snapshots } = await stream({ ok: true, status: 200, body: { getReader: () => reader } })
    expect(snapshots.at(-1)).toMatchObject({ phase: 'stream', endReason: 'failed', errorName: 'TypeError', causeCode: 'UND_ERR_SOCKET' })
    expect(JSON.stringify(snapshots)).not.toContain('private')
  })

  it('marks an invalid owner stream', async () => {
    const { snapshots } = await stream({ ok: true, status: 200, body: { getReader: () => sseReader('data: {not json}\n') } })
    expect(snapshots.at(-1)).toMatchObject({ phase: 'stream', endReason: 'failed', errorCode: 'STREAM_INVALID' })
  })

  // 作者取消后读流可能以非 AbortError 结束；取消要按调用方的 signal 判断，不能报成可重试的网络失败（PR #493 审计）。
  it('reports a caller cancellation even when the read rejects with a transport error', async () => {
    const controller = new AbortController()
    const reader = { read: vi.fn(async () => {
      controller.abort()
      throw new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
    }) }
    const { snapshots, onError } = await stream({ ok: true, status: 200, body: { getReader: () => reader } }, controller.signal)
    expect(onError).toHaveBeenCalledWith('LLM_CANCELLED', '', undefined)
    expect(snapshots.at(-1)).toMatchObject({ endReason: 'cancelled' })
  })

  it('does not report an abort the caller did not request as a cancellation', async () => {
    const reader = { read: vi.fn(async () => { throw new DOMException('aborted elsewhere', 'AbortError') }) }
    const { snapshots, onError } = await stream({ ok: true, status: 200, body: { getReader: () => reader } })
    expect(onError.mock.calls[0]![0]).not.toBe('LLM_CANCELLED')
    expect(snapshots.at(-1)).toMatchObject({ endReason: 'failed', errorName: 'AbortError' })
  })

  it('marks a stream stopped by the caller as cancelled', async () => {
    const controller = new AbortController()
    const reader = { read: vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) }
    const { snapshots, onError } = await stream({ ok: true, status: 200, body: { getReader: () => reader } }, controller.signal)
    expect(onError).toHaveBeenCalledWith('LLM_CANCELLED', '', undefined)
    expect(snapshots.at(-1)).toMatchObject({ endReason: 'cancelled', errorName: 'AbortError' })
  })
})

// 实测 gemini-3.8-flash 流式：总量 910 = 输入 20 + 正文 60 + 思考 830（#484）。
describe('Gemini thinking token usage', () => {
  const usageMetadata = { promptTokenCount: 20, candidatesTokenCount: 60, thoughtsTokenCount: 830, totalTokenCount: 910 }

  it('counts thinking tokens in the output of a normal request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: '正文' }] }, finishReason: 'STOP' }], usageMetadata }) }))
    const response = await new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], { temperature: 0.2, maxTokens: 512 })
    expect(response.usage).toEqual({ promptTokens: 20, completionTokens: 890, totalTokens: 910 })
  })

  it('counts thinking tokens in the streamed output and keeps the separately billed evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => sseReader(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '正文' }] }, finishReason: 'STOP' }], usageMetadata })}
`,
    ) } }))
    const onDone = vi.fn(), onUsageEvidence = vi.fn()
    await new GeminiProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
      temperature: 0.2, maxTokens: 512, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError: vi.fn(), onUsageEvidence,
    })
    expect(onDone).toHaveBeenCalledWith('正文', { promptTokens: 20, completionTokens: 890, totalTokens: 910 }, 'stop')
    const evidence = onUsageEvidence.mock.calls.at(-1)![0]
    expect(evidence).toEqual({ usage: { promptTokens: 20, completionTokens: 60, totalTokens: 910 }, reasoningTokens: 830,
      accounting: 'separately-billed', totalIncludesReasoning: true, protocol: 'gemini' })
    // 预算按这份证据结算：思考单独计费，实际用量就是 Google 报的总量。
    expect(settleProviderUsage({ ...evidence.usage, reasoningTokens: evidence.reasoningTokens, accounting: evidence.accounting,
      totalIncludesReasoning: evidence.totalIncludesReasoning, trusted: true },
    { estimatorVersion: 'test', safetyMarginTokens: 0, reasoning: 'separately-billed', canBoundTotalLiability: true }))
      .toMatchObject({ trusted: true, inputTokens: 20, completionTokens: 60, reasoningTokens: 830, actualTokens: 910 })
  })

  // usageMetadata 是未校验的 JSON；网关改写出的非数字不能拼成字符串或 NaN 流进调用记录（PR #493 审计）。
  it('ignores usage counts that are not numbers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: '正文' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: '20', candidatesTokenCount: '60', thoughtsTokenCount: 830, totalTokenCount: 910 } }) }))
    const response = await new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], { temperature: 0.2, maxTokens: 512 })
    expect(response.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: 910 })
  })

  it('keeps output usage when a model reports no thinking tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: '正文' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 60, totalTokenCount: 80 } }) }))
    const response = await new GeminiProvider().generate(model, [{ role: 'user', content: '写正文' }], { temperature: 0.2, maxTokens: 512 })
    expect(response.usage).toEqual({ promptTokens: 20, completionTokens: 60, totalTokens: 80 })
  })
})
