import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatgptPlanProvider } from '../chatgpt-plan-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

vi.mock('../../services/chatgpt-plan', () => ({ chatgptPlanAccessToken: vi.fn(async () => 'test-token') }))

const model: ModelProfile = {
  id: 'plan', name: 'Plan', provider: 'chatgpt-plan', protocol: 'openai',
  modelName: 'test-model', apiKey: '', baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
}

const options = { temperature: 0.7, maxTokens: 4096 }
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`

describe('ChatgptPlanProvider', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('uses the public Responses API with the OAuth token and requires response.completed', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(new Response(event({ type: 'response.output_text.delta', delta: '正文' })
      + event({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } }),
    { headers: { 'Content-Type': 'text/event-stream' } }))
    const result = await new ChatgptPlanProvider().generate(model, [{ role: 'user', content: '寫作' }], options)
    expect(result).toMatchObject({ success: true, content: '正文', finishReason: 'stop', usage: {
      promptTokens: 3, completionTokens: 4, totalTokens: 7,
    } })
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      body: JSON.stringify({ model: 'test-model', input: [{ role: 'user', content: '寫作' }], store: false, stream: true, max_output_tokens: 4096 }),
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    }))
  })

  it('rejects truncated output even if text was received', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(event({ type: 'response.output_text.delta', delta: 'partial' })))
    const result = await new ChatgptPlanProvider().generate(model, [{ role: 'user', content: '寫作' }], options)
    expect(result.success).toBe(false)
    expect(result.finishReason).toBe('error')
    expect(result.content).toBe('partial')
  })

  it.each(['response.failed', 'error'])('rejects %s after partial output without exposing provider messages', async type => {
    vi.mocked(fetch).mockResolvedValue(new Response(event({ type: 'response.output_text.delta', delta: 'partial' })
      + event({ type, response: { error: { message: 'private prompt' } } })))
    const result = await new ChatgptPlanProvider().generate(model, [], options)
    expect(result).toMatchObject({ success: false, content: 'partial', finishReason: 'error', error: type })
  })

  it('preserves length evidence for incomplete output', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(event({ type: 'response.output_text.delta', delta: 'partial' })
      + event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })))
    expect(await new ChatgptPlanProvider().generate(model, [], options)).toMatchObject({ success: false, content: 'partial', finishReason: 'length' })
  })

  it('uses the fixed endpoint even when the saved endpoint or API key changes', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(event({ type: 'response.completed' })))
    await new ChatgptPlanProvider().generate({ ...model, baseUrl: 'https://untrusted.invalid', apiKey: 'ignored' }, [], {
      temperature: undefined, maxTokens: 100,
      responseFormat: { type: 'json_object' },
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'high' },
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_output_tokens: 100, text: { format: { type: 'json_object' } }, reasoning: { effort: 'high' } })
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature')
  })

  it('filters split in-band reasoning and preserves usage evidence', async () => {
    const frames = [event({ type: 'response.output_text.delta', delta: '<thi' }),
      event({ type: 'response.output_text.delta', delta: 'nk>private</think>visible' }),
      event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })]
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) {
        // Split CRLF boundaries across transport chunks.
        const crlf = frame.replaceAll('\n', '\r\n')
        for (const character of crlf) controller.enqueue(encoder.encode(character))
      }
      controller.close()
    } })))
    const onChunk = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onUsageEvidence = vi.fn()
    await new ChatgptPlanProvider().generateStream(model, [], { ...options, signal: new AbortController().signal,
      visibleOnly: true, onChunk, onDone, onError, onUsageEvidence })
    expect(onChunk).toHaveBeenCalledExactlyOnceWith('visible')
    expect(onDone).toHaveBeenCalledWith('visible', { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, 'stop')
    expect(onUsageEvidence).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
