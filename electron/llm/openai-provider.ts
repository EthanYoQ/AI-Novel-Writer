import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import { resolveOpenAIChatCompletionsUrl } from './openai-compatible-endpoint'
import { VisibleStreamFilter } from './visible-stream'

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

    if (opts.reasoning?.adapter === 'deepseek-v4-thinking' && model.provider === 'deepseek') {
      body.thinking = { type: opts.reasoning.thinking }
      if (opts.reasoning.thinking === 'enabled') {
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

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const url = resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider)
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
    let fullText = ''
    const visible = new VisibleStreamFilter()
    let usage: TokenUsage | undefined
    const fail = (error: string) => {
      const visibleCandidate = opts.visibleOnly ? visible.text : this.stripThinking(fullText)
      opts.onError(error, visibleCandidate || undefined, usage)
    }

    try {
      const url = resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider)
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
          fatalError = '响应流包含损坏的 JSON 数据'
          return
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fatalError = '响应流包含无效的 OpenAI 数据对象'
          return
        }
        const payload = parsed as Record<string, unknown>
        if (Object.hasOwn(payload, 'error')) {
          const providerError = payload.error
          const message = providerError !== null && typeof providerError === 'object'
            && typeof (providerError as Record<string, unknown>).message === 'string'
            ? (providerError as Record<string, unknown>).message
            : '供应商返回流式错误'
          fatalError = `供应商返回流式错误：${message}`
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
          fatalError = '响应流的 choices 类型无效'
          return
        }
        const rawChoice = payload.choices[0]
        if (rawChoice === undefined) return
        if (rawChoice === null || typeof rawChoice !== 'object' || Array.isArray(rawChoice)) {
          fatalError = '响应流的 choice 类型无效'
          return
        }
        const choice = rawChoice as Record<string, unknown>
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string') {
            fatalError = '响应流的 finish_reason 类型无效'
            return
          }
          finishReason = this.normalizeFinishReason(choice.finish_reason)
        }

        if (choice.delta === undefined) return
        if (choice.delta === null || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) {
          fatalError = '响应流的 delta 类型无效'
          return
        }
        const delta = choice.delta as Record<string, unknown>
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null
          && typeof delta.reasoning_content !== 'string') {
          fatalError = '响应流的 reasoning_content 类型无效'
          return
        }
        if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') {
          fatalError = '响应流的 content 类型无效'
          return
        }

        if (opts.visibleOnly) {
          if (typeof delta.content === 'string') {
            const chunk = visible.push(delta.content)
            if (chunk) opts.onChunk(chunk)
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
        const { done, value } = await reader.read()
        if (done) break
        processText(decoder.decode(value, { stream: true }))
      }

      if (!fatalError && !sawDone) {
        processText(decoder.decode(), true)
      }

      if (fatalError) {
        throw new Error(fatalError)
      }

      if (!sawDone) {
        throw new Error('响应流在完成标记前结束，生成结果不完整')
      }

      if (isThinking) {
        const closeTag = '\n</think>\n\n'
        opts.onChunk(closeTag)
        fullText += closeTag
      }

      opts.onDone(opts.visibleOnly ? visible.text : this.stripThinking(fullText), usage, finishReason)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        fail('已取消生成')
      } else {
        fail(String(error))
      }
    }
  }
}
