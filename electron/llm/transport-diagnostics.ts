import { safeTransportError, type GenerationTransportDiagnostics } from '../../src/shared/generation-contract'

/**
 * 一次流式请求的传输诊断：各 provider 共用同一份形状与上报节奏。
 * 只记阶段、计时、HTTP 状态和稳定码，不记任何报错原文。
 */
export class StreamTransportDiagnostics {
  private readonly started = performance.now()
  private notifiedAt = -Infinity
  /** 请求或读流被传输层拒绝；provider 据此交出 LLM_STREAM_NETWORK_FAILED，而不是笼统的失败。 */
  networkFailure = false
  private readonly value: GenerationTransportDiagnostics = { startedAt: Date.now(), elapsedMs: 0,
    firstResponseMs: null, lastResponseMs: null, lastOutputMs: null, phase: 'request', visibleEvents: 0, reasoningEvents: 0 }

  constructor(private readonly onDiagnostics?: (diagnostics: GenerationTransportDiagnostics) => void) {
    this.notify()
  }

  private elapsed(): number {
    return Math.max(0, Math.round(performance.now() - this.started))
  }

  private notify(force = false): void {
    this.value.elapsedMs = this.elapsed()
    if (!force && !this.value.endReason && this.value.elapsedMs - this.notifiedAt < 250) return
    this.notifiedAt = this.value.elapsedMs
    try { this.onDiagnostics?.({ ...this.value }) } catch { /* Display metadata cannot change generation. */ }
  }

  async response(request: Promise<Response>): Promise<Response> {
    let res: Response
    try {
      res = await request
    } catch (error) {
      // undici 把连接、DNS、TLS 失败统一报成「fetch failed」；请求头或地址不合法另有报错，那是请求本身的问题。
      this.networkFailure = error instanceof TypeError && error.message === 'fetch failed'
      throw error
    }
    this.value.phase = 'response'
    if (Number.isInteger(res.status)) this.value.httpStatus = res.status
    this.notify(true)
    return res
  }

  streaming(): void {
    this.value.phase = 'stream'
  }

  async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    let result: ReadableStreamReadResult<Uint8Array>
    try {
      result = await reader.read()
    } catch (error) {
      this.networkFailure = (error as { name?: unknown } | null)?.name !== 'AbortError'
      throw error
    }
    if (!result.done && result.value.byteLength) {
      const elapsed = this.elapsed()
      const firstResponse = this.value.firstResponseMs === null
      this.value.firstResponseMs ??= elapsed
      this.value.lastResponseMs = elapsed
      this.notify(firstResponse)
    }
    return result
  }

  output(kind: 'visibleEvents' | 'reasoningEvents'): void {
    const firstOutput = this.value.lastOutputMs === null
    this.value[kind]++
    this.value.lastOutputMs = this.elapsed()
    this.notify(firstOutput)
  }

  /** 记下稳定码，随后由 interrupted 一并上报。 */
  errorCode(code: string): void {
    this.value.errorCode = code
  }

  /** 不经异常就结束的失败，例如 HTTP 错误或没有响应体。 */
  fail(code: string): void {
    this.value.endReason = 'failed'
    this.value.errorCode = code
    this.notify()
  }

  completed(): void {
    this.value.phase = 'complete'
    this.value.endReason = 'completed'
    this.notify()
  }

  interrupted(error: unknown, aborted: boolean): void {
    Object.assign(this.value, safeTransportError(error))
    this.value.endReason = aborted ? 'cancelled' : 'failed'
    this.notify()
  }
}
