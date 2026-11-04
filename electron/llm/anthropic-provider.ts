import { InBandReasoningStream, ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { VisibleStreamFilter } from './visible-stream'
import { StreamTransportDiagnostics } from './transport-diagnostics'
import { providerFailureCode } from './provider-context-length'

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 单个 SSE 事件允许保留的最大字符数（半行缓冲与 data 行合计共用此上限）。
 * 正常事件远小于该值；超过即视为异常或恶意端点，按无效流终止，避免内存被无限占住。
 */
export const MAX_STREAM_EVENT_CHARS = 4_000_000

export function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const endpoint = new URL(baseUrl.trim())
  let configuredPath = endpoint.pathname.replace(/\/+$/u, '')

  if (configuredPath.endsWith('/v1/messages')) {
    // 已是完整请求路径，保持原样
  } else if (configuredPath.endsWith('/messages')) {
    configuredPath = `${configuredPath.slice(0, -'/messages'.length)}/v1/messages`
  } else if (configuredPath.endsWith('/v1')) {
    configuredPath = `${configuredPath}/messages`
  } else {
    configuredPath = `${configuredPath || ''}/v1/messages`
  }
  endpoint.pathname = configuredPath || '/v1/messages'
  endpoint.search = ''
  endpoint.hash = ''
  endpoint.username = ''
  endpoint.password = ''
  return endpoint.toString()
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

/** Anthropic 的 usage 只报输入与输出两栏；输出栏已含思考块，总量按两者之和回填。 */
function anthropicTokenUsage(usage: AnthropicUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const inputTokens = typeof usage.input_tokens === 'number' && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0
    ? usage.input_tokens : null
  const outputTokens = typeof usage.output_tokens === 'number' && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0
    ? usage.output_tokens : null
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
  }
}

/**
 * Anthropic Messages 要求 user/assistant 交替出现；相邻同角色的消息按段落合并，
 * system 消息抽出来走顶层 system 字段。空消息一律丢弃，端点不接受空 content。
 */
function toAnthropicTurns(messages: Array<{ role: string; content: string }>): {
  system: string | undefined
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    const content = message.content ?? ''
    if (message.role === 'system') {
      if (content.trim()) systemParts.push(content)
      continue
    }
    if (!content) continue
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user'
    const last = turns[turns.length - 1]
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${content}`
    } else {
      turns.push({ role, content })
    }
  }
  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: turns }
}

function assertVisibleStreamEvent(value: unknown): void {
  const record = (input: unknown): input is Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
  const invalid = () => { throw new Error('LLM_STREAM_INVALID') }
  if (!record(value)) return invalid()
  if ('error' in value) throw new Error('LLM_STREAM_PROVIDER_ERROR')
  if (value.type !== undefined && typeof value.type !== 'string') return invalid()
  if (value.delta !== undefined) {
    if (!record(value.delta)) return invalid()
    if (value.delta.type !== undefined && typeof value.delta.type !== 'string') return invalid()
    if (value.delta.text !== undefined && typeof value.delta.text !== 'string') return invalid()
    if (value.delta.thinking !== undefined && typeof value.delta.thinking !== 'string') return invalid()
  }
  if (value.usage !== undefined && !record(value.usage)) return invalid()
}

export class AnthropicProvider implements ILLMProvider {
  private normalizeStopReason(reason: string | null | undefined): LLMFinishReason {
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
    if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length'
    if (reason === 'refusal') return 'content_filter'
    return 'unknown'
  }

  /** 剥离网关在正文里内联输出的 <think> 段，与 OpenAI 兼容协议保持一致。 */
  private stripThinking(content: string): string {
    return content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .replace(/^[\s\S]*?<\/think>\s*/i, '')
      .replace(/<\/?think>/gi, '')
      .trim()
  }

  /**
   * x-api-key 是 Anthropic Messages 的标准鉴权头；同时带 Bearer 以兼容
   * 只认 Authorization 的 Anthropic 兼容网关，两者都取同一把 Key。
   * 跨源重定向只剥掉 Authorization、不剥 x-api-key，所以两处请求都带 redirect: 'error'。
   */
  private buildRequestHeaders(model: ModelProfile): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': model.apiKey,
      'Authorization': `Bearer ${model.apiKey}`,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }

  private buildRequestBody(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const { system, messages: turns } = toAnthropicTurns(messages)
    const body: Record<string, unknown> = {
      model: model.modelName,
      // Anthropic 要求 max_tokens 必填，且不接受 0。
      max_tokens: Math.max(1, opts.maxTokens ?? model.maxTokens),
      messages: turns,
      stream,
    }
    if (system !== undefined) body.system = system
    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature
    }
    // Anthropic Messages 没有 response_format 等价参数；JSON 输出依赖提示词约束。
    return body
  }

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const url = resolveAnthropicMessagesUrl(model.baseUrl)
      const body = this.buildRequestBody(model, messages, opts, false)

      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildRequestHeaders(model),
        body: JSON.stringify(body),
        signal: opts.signal,
        redirect: 'error',
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: res.status, body: text } }
      }

      const data = await res.json() as {
        content?: Array<{ type?: string; text?: string }>
        stop_reason?: string | null
        usage?: AnthropicUsage
      }

      const finalContent = this.stripThinking((data.content ?? [])
        .filter(block => typeof block?.text === 'string' && (block.type === undefined || block.type === 'text'))
        .map(block => block.text)
        .join(''))
      const finishReason = this.normalizeStopReason(data.stop_reason)
      const usage = anthropicTokenUsage(data.usage)

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
    let promptTokens: number | null = null
    let outputTokens: number | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let protocolError: string | undefined
    const fail = (error: string) => {
      const visibleCandidate = opts.visibleOnly ? visible.text : this.stripThinking(fullText)
      opts.onError(error, visibleCandidate || undefined, usage)
    }
    const recordUsage = (input: number | null, output: number | null) => {
      if (input !== null) promptTokens = input
      if (output !== null) outputTokens = output
      if (promptTokens === null && outputTokens === null) return
      usage = {
        promptTokens: promptTokens,
        completionTokens: outputTokens,
        totalTokens: promptTokens !== null && outputTokens !== null ? promptTokens + outputTokens : null,
      }
      opts.onUsageEvidence?.({
        usage: usage,
        // Anthropic 不单列思考 token；output_tokens 已含思考块。
        reasoningTokens: null,
        accounting: 'included-in-completion', totalIncludesReasoning: true, protocol: 'anthropic',
      })
    }

    try {
      const url = resolveAnthropicMessagesUrl(model.baseUrl)
      const body = this.buildRequestBody(model, messages, opts, true)

      const res = await transport.response(fetch(url, {
        method: 'POST',
        headers: this.buildRequestHeaders(model),
        body: JSON.stringify(body),
        signal: opts.signal,
        redirect: 'error',
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
      let eventChars = 0
      let sawMessageStop = false
      let finishReason: LLMFinishReason = 'unknown'
      let fatalError: string | null = null

      const processEvent = (data: string) => {
        if (fatalError || sawMessageStop) return
        const json = data.trim()
        if (!json) return

        let parsed: unknown
        try {
          parsed = JSON.parse(json)
          if (opts.visibleOnly) assertVisibleStreamEvent(parsed)
        } catch (error) {
          // 与 OpenAI 兼容协议一致：坏事件在两种模式下都终止流，不能丢掉中间的正文后仍报完成。
          fatalError = error instanceof Error && error.message === 'LLM_STREAM_PROVIDER_ERROR'
            ? 'LLM_STREAM_PROVIDER_ERROR' : 'LLM_STREAM_INVALID'
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

        const type = typeof payload.type === 'string' ? payload.type : ''
        if (type === 'ping') return

        if (type === 'message_start') {
          const message = payload.message
          if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
            const rawUsage = (message as Record<string, unknown>).usage
            if (rawUsage !== null && typeof rawUsage === 'object' && !Array.isArray(rawUsage)) {
              const input = (rawUsage as AnthropicUsage).input_tokens
              recordUsage(typeof input === 'number' ? input : null, null)
            }
          }
          return
        }

        if (type === 'message_delta') {
          const delta = payload.delta
          if (delta !== null && typeof delta === 'object' && !Array.isArray(delta)) {
            const stopReason = (delta as Record<string, unknown>).stop_reason
            if (stopReason !== undefined && stopReason !== null) {
              if (typeof stopReason !== 'string') {
                fatalError = 'LLM_STREAM_INVALID'
                return
              }
              finishReason = this.normalizeStopReason(stopReason)
            }
          }
          const rawUsage = payload.usage
          if (rawUsage !== null && typeof rawUsage === 'object' && !Array.isArray(rawUsage)) {
            const output = (rawUsage as AnthropicUsage).output_tokens
            recordUsage(null, typeof output === 'number' ? output : null)
          }
          return
        }

        if (type === 'message_stop') {
          sawMessageStop = true
          return
        }

        if (type !== 'content_block_delta') return

        const delta = payload.delta
        if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const deltaRecord = delta as Record<string, unknown>
        const deltaType = typeof deltaRecord.type === 'string' ? deltaRecord.type : ''

        if (deltaType === 'thinking_delta') {
          if (deltaRecord.thinking !== undefined && deltaRecord.thinking !== null && typeof deltaRecord.thinking !== 'string') {
            fatalError = 'LLM_STREAM_INVALID'
            return
          }
          const thinking = deltaRecord.thinking
          if (typeof thinking === 'string' && thinking) {
            if (opts.visibleOnly) {
              reasoning(thinking)
              return
            }
            if (!isThinking) {
              isThinking = true
              const openTag = '<think>\n'
              fullText += openTag
              opts.onChunk(openTag)
            }
            fullText += thinking
            opts.onChunk(thinking)
          }
          return
        }

        if (deltaType !== 'text_delta') return
        if (deltaRecord.text !== undefined && deltaRecord.text !== null && typeof deltaRecord.text !== 'string') {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        const text = deltaRecord.text
        if (typeof text !== 'string' || !text) return

        inBandReasoning.push(text)
        if (opts.visibleOnly) {
          const chunk = visible.push(text)
          if (chunk) { transport.output('visibleEvents'); opts.onChunk(chunk) }
          return
        }

        if (isThinking) {
          isThinking = false
          const closeTag = '\n</think>\n\n'
          fullText += closeTag
          opts.onChunk(closeTag)
        }
        transport.output('visibleEvents')
        fullText += text
        opts.onChunk(text)
      }

      const processLine = (line: string) => {
        if (line === '') {
          if (dataLines.length > 0) processEvent(dataLines.join('\n'))
          dataLines = []
          eventChars = 0
          return
        }
        if (line.startsWith(':')) return
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== 'data') return
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        // 每行多计一个字符：合并时的换行符，也让空 data 行同样计入上限。
        eventChars += value.length + 1
        if (eventChars > MAX_STREAM_EVENT_CHARS) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
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
          if (fatalError || sawMessageStop) break
        }
        lineBuffer = lineBuffer.slice(consumed)
        if (!fatalError && lineBuffer.length > MAX_STREAM_EVENT_CHARS) {
          fatalError = 'LLM_STREAM_INVALID'
          return
        }
        if (final && !fatalError && !sawMessageStop) {
          if (lineBuffer) processLine(lineBuffer)
          lineBuffer = ''
          processLine('')
        }
      }

      while (!fatalError && !sawMessageStop) {
        const { done, value } = await transport.read(reader)
        if (done) break
        processText(decoder.decode(value, { stream: true }))
      }

      if (!fatalError && !sawMessageStop) {
        processText(decoder.decode(), true)
      }

      if (fatalError) {
        transport.errorCode(fatalError === 'LLM_STREAM_PROVIDER_ERROR' ? 'PROVIDER_STREAM_ERROR' : 'STREAM_INVALID')
        protocolError = fatalError
        throw new Error(fatalError)
      }

      if (!sawMessageStop) {
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
      void reader?.cancel?.().catch(() => {})
      reader?.releaseLock?.()
    }
  }
}
