import { InBandReasoningStream, ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { resolveOpenAIChatCompletionsUrl } from './openai-compatible-endpoint'
import { VisibleStreamFilter } from './visible-stream'
import { resolveModelProfileReasoningMapping } from '../../src/shared/provider-presets'
import { version as appVersion } from '../../package.json'
import { StreamTransportDiagnostics } from './transport-diagnostics'
import { providerFailureCode } from './provider-context-length'

const OPENCODE_GO_USER_AGENT = `ai-novel-writer/${appVersion}`

function isOpencodeGoBaseUrl(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl.trim())
    const configuredPath = endpoint.pathname.replace(/\/+$/u, '')
    return endpoint.protocol === 'https:'
      && endpoint.hostname === 'opencode.ai'
      && (configuredPath === '/zen/go' || configuredPath.startsWith('/zen/go/'))
  } catch {
    return false
  }
}

// opencode Go requires a stable per-conversation session id for routing and
// prompt caching. The caller supplies that conversation scope; a missing scope
// degrades to a per-request id so one-off operations never share session
// affinity with creative runs.

export class OpenAIProvider implements ILLMProvider {
  private normalizeFinishReason(reason: string | null | undefined): LLMFinishReason {
    if (reason === 'stop') return 'stop'
    if (reason === 'length') return 'length'
    if (reason === 'model_context_window_exceeded') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    if (reason === 'sensitive') return 'content_filter'
    if (reason === 'network_error') return 'error'
    return 'unknown'
  }

  private stripThinking(content: string): string {
    return content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .replace(/^[\s\S]*?<\/think>\s*/i, '')
      .replace(/<\/?think>/gi, '')
      .trim()
  }

  private buildRequestBody(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const isNovelAI = model.provider === 'novelai'
    const body: Record<string, unknown> = {
      model: model.modelName,
      messages,
      [opts.outputTokenParameter ?? 'max_tokens']: opts.maxTokens ?? model.maxTokens,
      stream,
    }

    // Temperature has already been resolved by generation-parameter-policy.
    // Never fall back to model.temperature here: undefined is an intentional
    // instruction to omit the field for provider/model combinations that own it.
    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature
    }

    if (opts.reasoning?.adapter === 'openai-reasoning-effort' && !isNovelAI) {
      body.reasoning_effort = opts.reasoning.reasoningEffort
    }

    if (opts.reasoning?.adapter === 'openai-thinking-budget' && !isNovelAI
      && resolveModelProfileReasoningMapping(model)?.adapter === 'openai-thinking-budget') {
      body.enable_thinking = opts.reasoning.thinkingBudget > 0
      // A disabled request omits the numeric field: zero need not be a legal provider budget.
      if (opts.reasoning.thinkingBudget > 0) body.thinking_budget = opts.reasoning.thinkingBudget
    }

    if (opts.reasoning?.adapter === 'siliconflow-v4-thinking'
      && resolveModelProfileReasoningMapping(model)?.adapter === 'siliconflow-v4-thinking') {
      body.enable_thinking = true
      body.reasoning_effort = opts.reasoning.reasoningEffort
    }

    if (opts.reasoning?.adapter === 'deepseek-v4-thinking'
      && resolveModelProfileReasoningMapping(model)?.adapter === 'deepseek-v4-thinking') {
      body.thinking = { type: opts.reasoning.thinking }
      if (opts.reasoning.thinking === 'enabled' && opts.reasoning.reasoningEffort !== undefined) {
        body.reasoning_effort = opts.reasoning.reasoningEffort
      }
    }

    if (opts.responseFormat && !isNovelAI) {
      body.response_format = opts.responseFormat
    }

    // The OpenAI streaming API only sends the final usage chunk when this is
    // explicitly requested. Keep NovelAI's narrower compatibility payload.
    if (stream && !isNovelAI) {
      body.stream_options = { include_usage: true }
    }

    return body
  }

  private buildRequestHeaders(model: ModelProfile, conversationId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    }
    if (isOpencodeGoBaseUrl(model.baseUrl)) {
      headers['x-opencode-session'] = conversationId || crypto.randomUUID()
      headers['User-Agent'] = OPENCODE_GO_USER_AGENT
    }
    return headers
  }

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const url = resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider)
      const body = this.buildRequestBody(model, messages, opts, false)

      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildRequestHeaders(model, opts.conversationId),
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: res.status, body: text } }
      }

      const data = await res.json() as {
        choices: Array<{
          message: { content: string; reasoning_content?: string }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }

      const finalContent = this.stripThinking(data.choices?.[0]?.message?.content ?? '')
      const finishReason = this.normalizeFinishReason(data.choices?.[0]?.finish_reason)
      const usage = data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined

      if (finishReason === 'stop') {
        return {
          success: true,
          content: finalContent,
          finishReason,
          usage,
        }
      }

      return {
        success: false,
        content: finalContent,
        finishReason,
        error: 'LLM_RESPONSE_INCOMPLETE',
        usage,
      }
    } catch (error) {
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    const transport = new StreamTransportDiagnostics(opts.onDiagnostics)
    let fullText = ''
    const visible = new VisibleStreamFilter()
    const reasoning = (chunk: string) => { transport.output('reasoningEvents'); opts.onReasoning?.(chunk) }
    const inBandReasoning = new InBandReasoningStream(reasoning)
    let usage: TokenUsage | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let protocolError: string | undefined
    const fail = (error: string) => {
      const visibleCandidate = opts.visibleOnly ? visible.text : this.stripThinking(fullText)
      opts.onError(error, visibleCandidate || undefined, usage)
    }

    try {
      const url = resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider)
      const body = this.buildRequestBody(model, messages, opts, true)

      const res = await transport.response(fetch(url, {
        method: 'POST',
        headers: this.buildRequestHeaders(model, opts.conversationId),
        body: JSON.stringify(body),
        signal: opts.signal,
      }))

      if (!res.ok) {
        transport.fail('HTTP_ERROR')
        fail(await providerFailureCode(res, opts.signal))
        return
      }

      reader = res.body?.getReader()
      if (!reader) {
        transport.fail('RESPONSE_BODY_MISSING')
        fail('LLM_STREAM_UNREADABLE')
        return
      }
      transport.streaming()

      const decoder = new TextDecoder()
      let isThinking = false
      let lineBuffer = ''
      let dataLines: string[] = []
      let sawDone = false
      let finishReason: LLMFinishReason = 'unknown'
      let fatalError: string | null = null

      const processEvent = (data: string) => {
        if (fatalError || sawDone) return
        const json = data.trim()
        if (!json) return
        if (json === '[DONE]') {
          sawDone = true
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(json)
        } catch {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const payload = parsed as Record<string, unknown>
        if (Object.hasOwn(payload, 'error')) {
          fatalError = 'LLM_STREAM_PROVIDER_ERROR'
          return
        }

        const reportedUsage = payload.usage
        if (reportedUsage !== null && typeof reportedUsage === 'object' && !Array.isArray(reportedUsage)) {
          const rawUsage = reportedUsage as Record<string, unknown>
          const details = rawUsage.completion_tokens_details
          const reasoning = details && typeof details === 'object' && !Array.isArray(details)
            ? (details as Record<string, unknown>).reasoning_tokens : undefined
          opts.onUsageEvidence?.({
            usage: {
              promptTokens: typeof rawUsage.prompt_tokens === 'number' ? rawUsage.prompt_tokens : null,
              completionTokens: typeof rawUsage.completion_tokens === 'number' ? rawUsage.completion_tokens : null,
              totalTokens: typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : null,
            },
            reasoningTokens: typeof reasoning === 'number' ? reasoning : null,
            accounting: 'included-in-completion', totalIncludesReasoning: true, protocol: 'openai',
          })
          if (
            typeof rawUsage.prompt_tokens === 'number'
            && typeof rawUsage.completion_tokens === 'number'
            && typeof rawUsage.total_tokens === 'number'
          ) {
            usage = {
              promptTokens: rawUsage.prompt_tokens,
              completionTokens: rawUsage.completion_tokens,
              totalTokens: rawUsage.total_tokens,
            }
          }
        }

        if (payload.choices === undefined) return
        if (!Array.isArray(payload.choices)) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const rawChoice = payload.choices[0]
        if (rawChoice === undefined) return
        if (rawChoice === null || typeof rawChoice !== 'object' || Array.isArray(rawChoice)) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const choice = rawChoice as Record<string, unknown>
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string') {
            fatalError = 'LLM_STREAM_INVALID'
            return
          }
          finishReason = this.normalizeFinishReason(choice.finish_reason)
        }

        if (choice.delta === undefined) return
        if (choice.delta === null || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const delta = choice.delta as Record<string, unknown>
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null
          && typeof delta.reasoning_content !== 'string') {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }

        if (delta.reasoning_content) reasoning(delta.reasoning_content as string)
        if (typeof delta.content === 'string') inBandReasoning.push(delta.content)

        if (opts.visibleOnly) {
          if (typeof delta.content === 'string') {
            const chunk = visible.push(delta.content)
            if (chunk) { transport.output('visibleEvents'); opts.onChunk(chunk) }
          }
          return
        }

        let emitChunk = ''
        if (delta.reasoning_content) {
          if (!isThinking) {
            isThinking = true
            emitChunk += '<think>\n'
          }
          emitChunk += delta.reasoning_content
        }
        if (delta.content !== undefined && delta.content !== null) {
          if (isThinking) {
            isThinking = false
            emitChunk += '\n</think>\n\n'
          }
          emitChunk += delta.content
        }
        if (emitChunk) {
          if (delta.content) transport.output('visibleEvents')
          fullText += emitChunk
          opts.onChunk(emitChunk)
        }
      }

      const processLine = (line: string) => {
        if (line === '') {
          if (dataLines.length > 0) processEvent(dataLines.join('\n'))
          dataLines = []
          return
        }
        if (line.startsWith(':')) return
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== 'data') return
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        dataLines.push(value)
      }

      const processText = (text: string, final = false) => {
        lineBuffer += text
        let consumed = 0
        for (let index = 0; index < lineBuffer.length;) {
          const character = lineBuffer[index]
          if (character !== '\r' && character !== '\n') {
            index += 1
            continue
          }
          if (character === '\r' && index + 1 === lineBuffer.length && !final) break
          processLine(lineBuffer.slice(consumed, index))
          index += character === '\r' && lineBuffer[index + 1] === '\n' ? 2 : 1
          consumed = index
          if (fatalError || sawDone) break
        }
        lineBuffer = lineBuffer.slice(consumed)
        if (final && !fatalError && !sawDone) {
          if (lineBuffer) processLine(lineBuffer)
          lineBuffer = ''
          processLine('')
        }
      }

      while (!fatalError && !sawDone) {
        const { done, value } = await transport.read(reader)
        if (done) break
        processText(decoder.decode(value, { stream: true }))
      }

      if (!fatalError && !sawDone) {
        processText(decoder.decode(), true)
      }

      if (fatalError) {
        transport.errorCode(fatalError === 'LLM_STREAM_PROVIDER_ERROR' ? 'PROVIDER_STREAM_ERROR' : 'STREAM_INVALID')
        protocolError = fatalError
        throw new Error(fatalError)
      }

      if (!sawDone) {
        transport.errorCode('STREAM_INCOMPLETE')
        protocolError = 'LLM_STREAM_INCOMPLETE'
        throw new Error(protocolError)
      }

      if (isThinking) {
        const closeTag = '\n</think>\n\n'
        opts.onChunk(closeTag)
        fullText += closeTag
      }

      transport.completed()
      opts.onDone(opts.visibleOnly ? visible.text : this.stripThinking(fullText), usage, finishReason)
    } catch (error) {
      transport.interrupted(error, opts.signal.aborted)
      if (opts.signal.aborted) {
        fail('LLM_CANCELLED')
      } else {
        fail(protocolError ?? (transport.networkFailure ? 'LLM_STREAM_NETWORK_FAILED' : 'LLM_STREAM_FAILED'))
      }
    } finally {
      // Do not wait for a remote stream to settle before releasing the local task.
      void reader?.cancel?.().catch(() => {})
      reader?.releaseLock?.()
    }
  }
}
