import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { VisibleStreamFilter } from './visible-stream'

function assertVisibleStreamPayload(value: unknown): void {
  const record = (input: unknown): input is Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
  const invalid = () => { throw new Error('Gemini 响应流格式无效') }
  if (!record(value)) return invalid()
  if ('error' in value) throw new Error('Gemini 响应流报告错误')
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

export class GeminiProvider implements ILLMProvider {
  private applyReasoning(
    generationConfig: Record<string, unknown>,
    opts: LLMGenerateOptions,
  ): void {
    if (opts.reasoning?.adapter !== 'gemini-thinking-budget') return
    generationConfig.thinkingConfig = { thinkingBudget: opts.reasoning.thinkingBudget }
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
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', finishReason: 'error', error: `Gemini API 调用失败 (${res.status}): ${text}` }
      }

      const data = await res.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
          finishReason?: string | null
        }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const finishReason = this.normalizeFinishReason(data.candidates?.[0]?.finishReason)
      const usage = data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? null,
        completionTokens: data.usageMetadata.candidatesTokenCount ?? null,
        totalTokens: data.usageMetadata.totalTokenCount ?? null,
      } : undefined

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
        error: 'Gemini API 返回的文本未正常完成',
      }
    } catch (error) {
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    const visible = new VisibleStreamFilter()
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
        opts.onError(`Gemini API 调用失败 (${res.status}): ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取 Gemini 响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let usage: TokenUsage | undefined
      let buffer = ''
      let finishReason: LLMFinishReason = 'unknown'

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const json = line.slice(6).trim()
        if (!json) return
        try {
          const parsed = JSON.parse(json) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; thought?: boolean }> }
                finishReason?: string | null
            }>
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number }
          }
          if (opts.visibleOnly) assertVisibleStreamPayload(parsed)
          const candidate = parsed.candidates?.[0]
          if (candidate?.finishReason !== undefined) {
            finishReason = this.normalizeFinishReason(candidate.finishReason)
          }
          const content = opts.visibleOnly
            ? (candidate?.content?.parts ?? []).filter(part => part.thought === undefined || part.thought === false).map(part => typeof part.text === 'string' ? part.text : '').join('')
            : candidate?.content?.parts?.[0]?.text
          const chunk = opts.visibleOnly ? visible.push(content ?? '') : content
          if (chunk) {
            fullText += chunk
            opts.onChunk(chunk)
          }
          if (parsed.usageMetadata) {
            usage = {
              promptTokens: parsed.usageMetadata.promptTokenCount ?? null,
              completionTokens: parsed.usageMetadata.candidatesTokenCount ?? null,
              totalTokens: parsed.usageMetadata.totalTokenCount ?? null,
            }
            visibleUsage = usage
            opts.onUsageEvidence?.({ usage, reasoningTokens: parsed.usageMetadata.thoughtsTokenCount ?? null,
              accounting: 'separately-billed', totalIncludesReasoning: true, protocol: 'gemini' })
          }
        } catch (error) {
          if (opts.visibleOnly) throw error
          // Ignore non-data SSE lines and malformed keepalives.
        }
      }

      let streamEnded = false
      while (!streamEnded) {
        const { done, value } = await reader.read()
        streamEnded = done
        if (done) continue

        buffer += decoder.decode(value, { stream: true })
        const segments = buffer.split('\n')
        buffer = segments.pop() ?? ''
        for (const line of segments) processLine(line)
      }

      buffer += decoder.decode()
      if (buffer.trim()) processLine(buffer)

      opts.onDone(opts.visibleOnly ? visible.text : fullText, usage, finishReason)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成', opts.visibleOnly ? visible.text : undefined, visibleUsage)
      } else {
        opts.onError(String(error), opts.visibleOnly ? visible.text : undefined, visibleUsage)
      }
    }
  }
}
