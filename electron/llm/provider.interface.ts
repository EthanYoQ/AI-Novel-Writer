import type {
  LLMFinishReason,
  LLMResponse as SharedLLMResponse,
  ModelProfile,
  TokenUsage,
} from '../../src/shared/ipc-channels'
import type { ProviderReasoningDirective } from '../../src/shared/reasoning-types'

/** A provider may report success only with explicit semantic stop evidence. */
export type LLMResponse = SharedLLMResponse

export interface LLMGenerateOptions {
  /** `undefined` means the provider must omit temperature from its payload. */
  temperature: number | undefined
  maxTokens: number
  /** Main-owner verified OpenAI total output cap, including reasoning. */
  outputTokenParameter?: 'max_completion_tokens'
  responseFormat?: { type: string }
  reasoning?: ProviderReasoningDirective
}

export interface LLMStreamOptions extends LLMGenerateOptions {
  signal: AbortSignal
  /** The durable owner receives only visible content, preserving its exact whitespace. */
  visibleOnly?: boolean
  /** Protocol metadata is evidence, not permission to release a reservation. */
  onUsageEvidence?: (evidence: ProviderUsageEvidence) => void
  onChunk: (chunk: string) => void
  /**
   * Signals transport termination and always carries provider-normalized model
   * completion evidence. `unknown` keeps text inspectable but is never proof
   * that a creative workflow may commit it.
   */
  onDone: (fullText: string, usage: TokenUsage | undefined, finishReason: LLMFinishReason) => void
  /** Optional content is the already-delivered visible candidate, never hidden reasoning. */
  onError: (error: string, content?: string, usage?: TokenUsage) => void
}

export interface ProviderUsageEvidence {
  usage: TokenUsage
  reasoningTokens: number | null
  accounting: 'included-in-completion' | 'separately-billed' | 'unknown'
  totalIncludesReasoning: boolean
  protocol: 'openai' | 'gemini'
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
