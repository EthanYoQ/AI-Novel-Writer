import type { FinalizationResult } from '../../electron/services/finalization-service'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { FinalizationSnapshot } from './finalization-snapshot'

interface VelaInvokeApi {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

function getVelaApi(): VelaInvokeApi {
  const api = (window as unknown as { velaAPI?: VelaInvokeApi }).velaAPI
  if (!api) throw new Error('不在 Electron 环境中，无法提交定稿')
  return api
}

/** 只接受已冻结快照；调用处不能把任意正文/目标路径塞给 retry。 */
export async function commitFinalizationSnapshot(
  snapshot: FinalizationSnapshot,
): Promise<FinalizationResult> {
  const currentSession = getActiveProjectSessionContext()
  if (!sameProjectSessionContext(snapshot.projectSession, currentSession)) {
    throw new Error('项目会话已变化，已拒绝提交旧定稿快照')
  }
  return getVelaApi().invoke(
    'finalization:commit',
    snapshot,
    snapshot.projectSession,
  ) as Promise<FinalizationResult>
}

/** 实体稿重试只带已提交的 finalizationId，正文和路径始终从 SQLite outbox 读取。 */
export async function retryFinalizationPublication(
  finalizationId: string,
  projectSession: ProjectSessionContext,
): Promise<FinalizationResult> {
  const currentSession = getActiveProjectSessionContext()
  if (!sameProjectSessionContext(projectSession, currentSession)) {
    throw new Error('项目会话已变化，已拒绝实体稿重试')
  }
  return getVelaApi().invoke(
    'finalization:retry',
    finalizationId,
    projectSession,
  ) as Promise<FinalizationResult>
}
