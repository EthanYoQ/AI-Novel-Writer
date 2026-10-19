import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import type { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { chatgptPlanAccessToken } from '../services/chatgpt-plan'
import { VisibleStreamFilter } from './visible-stream'

type Event = { type?: string; delta?: string; response?: {
  status?: string
  incomplete_details?: { reason?: string }
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  error?: { code?: string; message?: string }
} }

export class ChatgptPlanProvider implements ILLMProvider {
  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, _opts: LLMGenerateOptions): Promise<LLMResponse> {
    let content = ''
    let usage: TokenUsage | undefined
    const outcome: { finishReason: LLMFinishReason } = { finishReason: 'unknown' }
    let error: string | undefined
    await this.generateStream(model, messages, {
      ..._opts, signal: new AbortController().signal,
      onChunk: chunk => { content += chunk },
      onDone: (_text, resultUsage, reason) => { usage = resultUsage; outcome.finishReason = reason },
      onError: message => { error = message; outcome.finishReason = 'error' },
    })
    if (outcome.finishReason === 'stop') return { success: true, content, usage, finishReason: 'stop' }
    return { success: false, content, usage, finishReason: outcome.finishReason, error }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    let content = ''
    let usage: TokenUsage | undefined
    let completed = false
    const visible = opts.visibleOnly ? new VisibleStreamFilter() : undefined
    try {
      const input = messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'developer',
        content: message.content,
      }))
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', signal: opts.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await chatgptPlanAccessToken()}` },
        body: JSON.stringify({ model: model.modelName, input, store: false, stream: true,
          max_output_tokens: opts.maxTokens,
          // Account catalogs do not advertise sampling support. Use the model default.
          ...(opts.responseFormat ? { text: { format: opts.responseFormat } } : {}),
          ...(opts.reasoning?.adapter === 'openai-reasoning-effort'
            ? { reasoning: { effort: opts.reasoning.reasoningEffort } } : {}),
        }),
      })
      if (!response.ok || !response.body) throw new Error(`ChatGPT plan request failed (HTTP ${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!completed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary).replace(/\r/g, '')
            buffer = buffer.slice(boundary + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (!data || data === '[DONE]') continue
            let event: Event
            try { event = JSON.parse(data) as Event } catch { throw new Error('Invalid ChatGPT plan response event') }
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
              const chunk = visible ? visible.push(event.delta) : event.delta
              content += chunk
              if (chunk) opts.onChunk(chunk)
            }
            if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type ?? '')) {
              const result = event.response?.usage
              usage = result ? { promptTokens: result.input_tokens ?? null,
                completionTokens: result.output_tokens ?? null, totalTokens: result.total_tokens ?? null } : undefined
              if (usage) opts.onUsageEvidence?.({ usage, reasoningTokens: null,
                accounting: 'included-in-completion', totalIncludesReasoning: true, protocol: 'openai' })
            }
            if (event.type === 'response.completed') {
              if (event.response?.status && event.response.status !== 'completed') throw new Error('Invalid ChatGPT completion status')
              completed = true
            }
            if (event.type === 'response.incomplete') {
              opts.onDone(content, usage, event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'unknown')
              return
            }
            if (event.type === 'response.failed' || event.type === 'error') {
              // Provider messages may echo request data. Retain only the fixed event kind.
              throw new Error(event.type)
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      if (opts.signal.aborted) throw new Error('ChatGPT request cancelled')
      if (!completed) throw new Error('ChatGPT plan stream ended before response.completed')
      opts.onDone(content, usage, 'stop')
    } catch (error) {
      opts.onError(error instanceof Error ? error.message : 'ChatGPT plan request failed', content, usage)
    }
  }
}
