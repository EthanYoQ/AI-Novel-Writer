import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'

export class GeminiProvider implements ILLMProvider {
  private normalizeFinishReason(reason: string | null | undefined): LLMFinishReason {
    // Some Gemini-compatible endpoints omit finishReason. Their completed HTTP
    // response remains compatible with a normal STOP completion.
    if (reason === undefined || reason === null || reason === 'STOP') return 'stop'
    if (reason === 'MAX_TOKENS') return 'length'
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(reason)) {
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
        temperature: opts.temperature ?? model.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
      }
      if (opts.responseFormat?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json'
      }

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
        return { success: false, content: '', error: `Gemini API 调用失败 (${res.status}): ${text}` }
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
      const complete = finishReason === 'stop'
      const usage = data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? null,
        completionTokens: data.usageMetadata.candidatesTokenCount ?? null,
        totalTokens: data.usageMetadata.totalTokenCount ?? null,
      } : undefined

      return {
        success: complete,
        content: text,
        usage,
        finishReason,
        error: complete ? undefined : 'Gemini API 返回的文本未正常完成',
      }
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    try {
      const baseUrl = model.baseUrl.replace(/\/$/, '')
      const url = `${baseUrl}/v1beta/models/${model.modelName}:streamGenerateContent?alt=sse`

      const { contents, systemInstruction } = this.toGeminiContents(messages)

      const generationConfig: Record<string, unknown> = {
        temperature: opts.temperature ?? model.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
      }
      if (opts.responseFormat?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json'
      }

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
      let finishReason: LLMFinishReason = 'stop'

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const json = line.slice(6).trim()
        if (!json) return
        try {
          const parsed = JSON.parse(json) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> }
                finishReason?: string | null
            }>
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
          }
          const candidate = parsed.candidates?.[0]
          if (candidate?.finishReason !== undefined) {
            finishReason = this.normalizeFinishReason(candidate.finishReason)
          }
          const chunk = candidate?.content?.parts?.[0]?.text
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
          }
        } catch {
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

      opts.onDone(fullText, usage, finishReason)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }
}
