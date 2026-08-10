import type {
  LLMFinishReason,
  LLMResponse as SharedLLMResponse,
  ModelProfile,
  TokenUsage,
} from '../../src/shared/ipc-channels'

export type LLMResponse = SharedLLMResponse

export interface LLMGenerateOptions {
  /** `undefined` means the provider must omit temperature from its payload. */
  temperature: number | undefined
  maxTokens: number
  responseFormat?: { type: string }
  thinking?: boolean
}

export interface LLMStreamOptions extends LLMGenerateOptions {
  signal: AbortSignal
  onChunk: (chunk: string) => void
  onDone: (fullText: string, usage?: TokenUsage, finishReason?: LLMFinishReason) => void
  onError: (error: string) => void
}

export interface ILLMProvider {
  /** 非流式生成 */
  generate(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions
  ): Promise<LLMResponse>

  /** 流式生成 */
  generateStream(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMStreamOptions
  ): Promise<void>
}
