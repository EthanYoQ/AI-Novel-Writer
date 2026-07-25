import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { LatestRequestGate } from '../editor/latest-request-gate'

export interface LLMDataRequestTicket {
  requestId: number
  projectSession: ProjectSessionContext
}

/**
 * BottomPanel 模型统计的提交门禁：路径相同但 lease 已更新也必须视为过期。
 */
export class LLMDataRequestGate {
  private readonly requests = new LatestRequestGate()

  begin(projectSession: ProjectSessionContext): LLMDataRequestTicket {
    return { requestId: this.requests.begin(), projectSession }
  }

  isCurrent(
    ticket: LLMDataRequestTicket,
    currentProjectSession: ProjectSessionContext | null,
  ): boolean {
    return this.requests.isLatest(ticket.requestId)
      && sameProjectSessionContext(ticket.projectSession, currentProjectSession)
  }

  invalidate(): void {
    this.requests.begin()
  }
}
