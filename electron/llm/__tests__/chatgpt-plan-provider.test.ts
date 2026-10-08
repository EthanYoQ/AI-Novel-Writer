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
      body: JSON.stringify({ model: 'test-model', input: [{ role: 'user', content: '寫作' }], store: false, stream: true }),
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
})
