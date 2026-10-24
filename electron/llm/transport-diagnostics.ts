import { safeTransportError, type GenerationTransportDiagnostics } from '../../src/shared/generation-contract'

/**
 * 一次流式请求的传输诊断：各 provider 共用同一份形状与上报节奏。
 * 只记阶段、计时、HTTP 状态和稳定码，不记任何报错原文。
 */
export class StreamTransportDiagnostics {
  private readonly started = performance.now()
  private notifiedAt = -Infinity
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
    const res = await request
    this.value.phase = 'response'
    if (Number.isInteger(res.status)) this.value.httpStatus = res.status
    this.notify(true)
    return res
  }

  streaming(): void {
    this.value.phase = 'stream'
  }

  async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    const result = await reader.read()
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
