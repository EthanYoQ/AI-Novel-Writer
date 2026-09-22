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
  /** Ephemeral provider text only; never append it to a durable visible candidate. */
  onReasoning?: (chunk: string) => void
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

/** Mirrors the visible filter's tag boundary so split in-band thoughts remain private. */
export class InBandReasoningStream {
  private pending = ''
  private depth = 0

  constructor(private readonly onReasoning?: (chunk: string) => void) {}

  push(text: string): void {
    if (!this.onReasoning) return
    const input = this.pending + text
    const parts: string[] = []
    this.pending = ''
    let cursor = 0
    while (cursor < input.length) {
      const opening = input.indexOf('<', cursor)
      const end = opening < 0 ? input.length : opening
      if (this.depth > 0 && end > cursor) parts.push(input.slice(cursor, end))
      if (opening < 0) break
      cursor = opening
      const tail = input.slice(cursor, cursor + 8).toLowerCase()
      const tag = tail.startsWith('<think>') ? '<think>'
        : tail.startsWith('</think>') ? '</think>' : null
      if (tag) {
        this.depth = tag === '<think>' ? this.depth + 1 : Math.max(0, this.depth - 1)
        cursor += tag.length
        continue
      }
      if (['<think>', '</think>'].some(candidate => candidate.startsWith(tail))) {
        this.pending = input.slice(cursor)
        break
      }
      if (this.depth > 0) parts.push('<')
      cursor += 1
    }
    const reasoning = parts.join('')
    if (reasoning) this.onReasoning(reasoning)
  }
}
