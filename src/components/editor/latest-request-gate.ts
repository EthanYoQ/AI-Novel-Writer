/**
 * 为同一资源的并发读取提供单调请求序号。
 *
 * 每次 begin 都会使之前的 token 失效，因此较早发起、较晚返回的请求
 * 无法覆盖较新的结果。
 */
export class LatestRequestGate {
  private latestRequestId = 0

  begin(): number {
    this.latestRequestId += 1
    return this.latestRequestId
  }

  isLatest(requestId: number): boolean {
    return requestId === this.latestRequestId
  }
}
