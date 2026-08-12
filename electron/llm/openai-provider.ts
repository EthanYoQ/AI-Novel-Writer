import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'

export class OpenAIProvider implements ILLMProvider {
  private normalizeFinishReason(reason: string | null | undefined): LLMFinishReason {
    if (reason === 'stop') return 'stop'
    if (reason === 'length') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    return 'unknown'
  }

  private stripThinking(content: string): string {
    return content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .replace(/^[\s\S]*?<\/think>\s*/i, '')
      .replace(/<\/?think>/gi, '')
      .trim()
  }

  private buildUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '')
    if (base.endsWith('/v1/chat/completions')) {
      return base
    }
    // 如果 baseUrl 已经带了完整 /v1/chat 路径，直接用
    if (base.endsWith('/v1/chat')) {
      return `${base}/completions`
    }
    if (base.endsWith('/v1')) {
      return `${base}/chat/completions`
    }
    // 否则补全完整路径
    return `${base}/v1/chat/completions`
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
      max_tokens: opts.maxTokens ?? model.maxTokens,
      stream,
    }

    // Temperature has already been resolved by generation-parameter-policy.
    // Never fall back to model.temperature here: undefined is an intentional
    // instruction to omit the field for provider/model combinations that own it.
    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature
    }

    if (opts.thinking) {
      if (isNovelAI) {
        body.enable_thinking = true
      } else {
        // thinking 参数直接放在请求体顶层（非 extra_body，那是 OpenAI SDK 层概念）
        body.thinking = { type: 'enabled' }
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

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const url = this.buildUrl(model.baseUrl)
      const body = this.buildRequestBody(model, messages, opts, false)

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', finishReason: 'error', error: `API 调用失败 (${res.status}): ${text}` }
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
        error: 'API 返回的文本未正常完成',
        usage,
      }
    } catch (error) {
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    try {
      const url = this.buildUrl(model.baseUrl)
      const body = this.buildRequestBody(model, messages, opts, true)

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        opts.onError(`API 调用失败 (${res.status}): ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let isThinking = false
      let buffer = ''
      let sawDone = false
      let finishReason: LLMFinishReason = 'unknown'
      let usage: TokenUsage | undefined

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return
        const json = line.slice(6).trim()
        if (json === '[DONE]') {
          sawDone = true
          return
        }
        if (!json) return
        try {
          const parsed = JSON.parse(json) as {
            choices?: Array<{
              delta: { content?: string, reasoning_content?: string }
              finish_reason?: string | null
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              total_tokens?: number
            }
          }
          const choice = parsed.choices?.[0]
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            finishReason = this.normalizeFinishReason(choice.finish_reason)
          }
          const delta = choice?.delta

          let emitChunk = ''

          // 如果存在思维链内容
          if (delta?.reasoning_content) {
            if (!isThinking) {
              isThinking = true
              emitChunk += '<think>\n'
            }
            emitChunk += delta.reasoning_content
          }

          // 如果开始输出正文
          if (delta?.content !== undefined && delta?.content !== null) {
            if (isThinking) {
              isThinking = false
              emitChunk += '\n</think>\n\n'
            }
            if (delta?.content) {
              emitChunk += delta.content
            }
          }

          if (emitChunk) {
            fullText += emitChunk
            opts.onChunk(emitChunk)
          }

          const reportedUsage = parsed.usage
          if (
            typeof reportedUsage?.prompt_tokens === 'number'
            && typeof reportedUsage.completion_tokens === 'number'
            && typeof reportedUsage.total_tokens === 'number'
          ) {
            usage = {
              promptTokens: reportedUsage.prompt_tokens,
              completionTokens: reportedUsage.completion_tokens,
              totalTokens: reportedUsage.total_tokens,
            }
          }
        } catch {
          // Ignore non-data SSE lines and malformed keepalives. A normal
          // completion still requires the explicit [DONE] marker below.
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
      if (buffer.trim()) {
        processLine(buffer)
      }

      if (!sawDone) {
        opts.onError('响应流在完成标记前结束，生成结果不完整')
        return
      }

      if (isThinking) {
        const closeTag = '\n</think>\n\n'
        fullText += closeTag
        opts.onChunk(closeTag)
      }

      opts.onDone(this.stripThinking(fullText), usage, finishReason)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }
}
