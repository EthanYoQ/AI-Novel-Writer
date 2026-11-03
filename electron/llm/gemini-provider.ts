import { InBandReasoningStream, ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { VisibleStreamFilter } from './visible-stream'
import { StreamTransportDiagnostics } from './transport-diagnostics'
import { providerFailureCode } from './provider-context-length'

function assertVisibleStreamPayload(value: unknown): void {
  const record = (input: unknown): input is Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
  const invalid = () => { throw new Error('LLM_STREAM_INVALID') }
  if (!record(value)) return invalid()
  if ('error' in value) throw new Error('LLM_STREAM_PROVIDER_ERROR')
  if (value.candidates === undefined) return
  if (!Array.isArray(value.candidates)) return invalid()
  for (const candidate of value.candidates) {
    if (!record(candidate)) return invalid()
    if (candidate.finishReason !== undefined && candidate.finishReason !== null
      && typeof candidate.finishReason !== 'string') return invalid()
    if (candidate.content === undefined) continue
    if (!record(candidate.content)) return invalid()
    if (candidate.content.parts === undefined) continue
    if (!Array.isArray(candidate.content.parts)) return invalid()
    for (const part of candidate.content.parts) {
      if (!record(part)) return invalid()
      if (part.text !== undefined && typeof part.text !== 'string') return invalid()
      if (part.thought !== undefined && typeof part.thought !== 'boolean') return invalid()
    }
  }
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

/**
 * 交给调用记录的用量与 OpenAI 一致：输出含思考消耗（OpenAI 的 completion_tokens 本就含 reasoning_tokens）。
 * Gemini 的 candidatesTokenCount 只算正文，思考在 thoughtsTokenCount 里另报。
 */
function geminiTokenUsage(metadata: GeminiUsageMetadata): TokenUsage {
  // usageMetadata 是未校验的 JSON，只认非负整数；没报的分项按 0 计，报了却不是数字就整项不记。
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const part = (value: unknown) => value === undefined ? 0 : count(value)
  const candidates = part(metadata.candidatesTokenCount), thoughts = part(metadata.thoughtsTokenCount)
  const reported = metadata.candidatesTokenCount !== undefined || metadata.thoughtsTokenCount !== undefined
  return {
    promptTokens: count(metadata.promptTokenCount),
    completionTokens: reported && candidates !== null && thoughts !== null ? candidates + thoughts : null,
    totalTokens: count(metadata.totalTokenCount),
  }
}

export class GeminiProvider implements ILLMProvider {
  private applyReasoning(
    generationConfig: Record<string, unknown>,
    opts: LLMGenerateOptions,
  ): void {
    if (opts.reasoning?.adapter === 'gemini-thinking-budget') {
      generationConfig.thinkingConfig = { thinkingBudget: opts.reasoning.thinkingBudget }
    } else if (opts.reasoning?.adapter === 'gemini-thinking-level') {
      generationConfig.thinkingConfig = { thinkingLevel: opts.reasoning.thinkingLevel }
    }
  }

  private normalizeFinishReason(reason: string | null | undefined): LLMFinishReason {
    if (reason === 'STOP') return 'stop'
    if (reason === 'MAX_TOKENS') return 'length'
    if (reason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(reason)) {
      return 'content_filter'
    }
    return 'unknown'
  }

  private toGeminiContents(messages: Array<{ role: string; content: string }>) {
    let systemInstruction: string | undefined
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content
        continue
      }
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })
    }
    return { contents, systemInstruction }
  }
  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const baseUrl = model.baseUrl.replace(/\/$/, '')
      const url = `${baseUrl}/v1beta/models/${model.modelName}:generateContent`

      const { contents, systemInstruction } = this.toGeminiContents(messages)

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
      }
      if (opts.temperature !== undefined) {
        generationConfig.temperature = opts.temperature
      }
      if (opts.responseFormat?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json'
      }
      this.applyReasoning(generationConfig, opts)

      const body: Record<string, unknown> = {
        contents,
        generationConfig,
      }
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': model.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: res.status, body: text } }
      }

      const data = await res.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
          finishReason?: string | null
        }>
        usageMetadata?: GeminiUsageMetadata
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const finishReason = this.normalizeFinishReason(data.candidates?.[0]?.finishReason)
      const usage = data.usageMetadata ? geminiTokenUsage(data.usageMetadata) : undefined

      if (finishReason === 'stop') {
        return {
          success: true,
          content: text,
          usage,
          finishReason,
        }
      }

      return {
        success: false,
        content: text,
        usage,
        finishReason,
        error: 'LLM_RESPONSE_INCOMPLETE',
      }
    } catch (error) {
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    const transport = new StreamTransportDiagnostics(opts.onDiagnostics)
    const visible = new VisibleStreamFilter()
    const reasoning = (chunk: string) => { transport.output('reasoningEvents'); opts.onReasoning?.(chunk) }
    const inBandReasoning = new InBandReasoningStream(reasoning)
    let visibleUsage: TokenUsage | undefined
    try {
      const baseUrl = model.baseUrl.replace(/\/$/, '')
      const url = `${baseUrl}/v1beta/models/${model.modelName}:streamGenerateContent?alt=sse`

      const { contents, systemInstruction } = this.toGeminiContents(messages)

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
      }
      if (opts.temperature !== undefined) {
        generationConfig.temperature = opts.temperature
      }
      if (opts.responseFormat?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json'
      }
      this.applyReasoning(generationConfig, opts)

      const body: Record<string, unknown> = {
        contents,
        generationConfig,
      }
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] }
      }

      const res = await transport.response(fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': model.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      }))

      if (!res.ok) {
        transport.fail('HTTP_ERROR')
        opts.onError(await providerFailureCode(res, opts.signal))
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        transport.fail('RESPONSE_BODY_MISSING')
        opts.onError('LLM_STREAM_UNREADABLE')
        return
      }
      transport.streaming()

      const decoder = new TextDecoder()
      let fullText = ''
      let usage: TokenUsage | undefined
      let buffer = ''
      let finishReason: LLMFinishReason = 'unknown'

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const json = line.slice(6).trim()
        if (!json) return
        let parsed: {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; thought?: boolean }> }
            finishReason?: string | null
          }>
          usageMetadata?: GeminiUsageMetadata
        }
        try {
          parsed = JSON.parse(json)
          if (opts.visibleOnly) assertVisibleStreamPayload(parsed)
        } catch (error) {
          // Ignore non-data SSE lines and malformed keepalives unless the owner needs a valid stream.
          if (!opts.visibleOnly) return
          transport.errorCode(error instanceof Error && error.message === 'LLM_STREAM_PROVIDER_ERROR' ? 'PROVIDER_STREAM_ERROR' : 'STREAM_INVALID')
          throw error
        }
        try {
          const candidate = parsed.candidates?.[0]
          if (candidate?.finishReason !== undefined) {
            finishReason = this.normalizeFinishReason(candidate.finishReason)
          }
          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought === true) {
              if (part.text) reasoning(part.text)
            } else if (typeof part.text === 'string') {
              inBandReasoning.push(part.text)
            }
          }
          const content = (candidate?.content?.parts ?? []).filter(part => part.thought !== true)
            .map(part => typeof part.text === 'string' ? part.text : '').join('')
          const chunk = opts.visibleOnly ? visible.push(content ?? '') : content
          if (chunk) {
            transport.output('visibleEvents')
            fullText += chunk
            opts.onChunk(chunk)
          }
          if (parsed.usageMetadata) {
            const metadata = parsed.usageMetadata
            usage = geminiTokenUsage(metadata)
            visibleUsage = usage
            // 预算结算按 Gemini 的计费方式：正文与思考分开报，总量含思考。
            opts.onUsageEvidence?.({ usage: { promptTokens: metadata.promptTokenCount ?? null,
              completionTokens: metadata.candidatesTokenCount ?? null, totalTokens: metadata.totalTokenCount ?? null },
            reasoningTokens: metadata.thoughtsTokenCount ?? null,
            accounting: 'separately-billed', totalIncludesReasoning: true, protocol: 'gemini' })
          }
        } catch (error) {
          if (opts.visibleOnly) throw error
        }
      }

      let streamEnded = false
      while (!streamEnded) {
        const { done, value } = await transport.read(reader)
        streamEnded = done
        if (done) continue

        buffer += decoder.decode(value, { stream: true })
        const segments = buffer.split('\n')
        buffer = segments.pop() ?? ''
        for (const line of segments) processLine(line)
      }

      buffer += decoder.decode()
      if (buffer.trim()) processLine(buffer)

      transport.completed()
      opts.onDone(opts.visibleOnly ? visible.text : fullText, usage, finishReason)
    } catch (error) {
      transport.interrupted(error, opts.signal.aborted)
      if (opts.signal.aborted) {
        opts.onError('LLM_CANCELLED', opts.visibleOnly ? visible.text : undefined, visibleUsage)
      } else {
        opts.onError(transport.networkFailure ? 'LLM_STREAM_NETWORK_FAILED' : String(error), opts.visibleOnly ? visible.text : undefined, visibleUsage)
      }
    }
  }
}
